/**
 * Regression tests for the benchmark skill rows (design rule D4):
 *  - compute-05 / eff-02 / report-01 / samples-e2e-04: the benchmark is scored
 *    under the model's transform (it was always scored on raw flows);
 *  - compute-09 / eff-03: the benchmark is scored on the model's own pairs (it
 *    was scored on every observed step, the model only where sim existed);
 *  - compute-06 / eff-04 / report-06 / samples-e2e-05: the mean-flow benchmark
 *    scores KGE = 1 - sqrt(2) (Knoben et al., 2019), so "KGE skill vs mean" is
 *    defined (it was n/a for every dataset).
 * The expected values come from an independent implementation in this file
 * (plain loops, no library metric functions).
 */
import { describe, it, expect } from 'vitest'
import { benchmarkSkill, computeAll } from '../src/metrics/registry'
import { defaultTimingConfig } from '../src/types'

type Tr = 'none' | 'log' | 'sqrt' | 'inverse'
const DAY = 86_400_000

// ---- independent reference -------------------------------------------------
const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length
const sd = (a: number[]) => { const m = avg(a); return Math.sqrt(avg(a.map(v => (v - m) ** 2))) }
const nseRef = (o: number[], s: number[]) => {
  const m = avg(o)
  let num = 0, den = 0
  for (let i = 0; i < o.length; i++) { num += (s[i] - o[i]) ** 2; den += (o[i] - m) ** 2 }
  return 1 - num / den
}
const kgeRef = (o: number[], s: number[]) => {
  const mo = avg(o), ms = avg(s)
  let c = 0
  for (let i = 0; i < o.length; i++) c += (o[i] - mo) * (s[i] - ms)
  const r = c / o.length / (sd(o) * sd(s))
  return 1 - Math.sqrt((r - 1) ** 2 + (sd(s) / sd(o) - 1) ** 2 + (ms / mo - 1) ** 2)
}
const skillRef = (m: number, b: number) => Math.min(1, (m - b) / (1 - b))
const T = (tr: Tr, meanObs: number) => (v: number) => {
  const eps = 0.01 * meanObs
  return tr === 'none' ? v : tr === 'sqrt' ? Math.sqrt(v) : tr === 'inverse' ? 1 / (v + eps) : Math.log((v + eps) / meanObs)
}
/** model pairs (pairwise), benchmark on those rows, both transformed with the model's eps */
function refSkill(obs: ArrayLike<number>, sim: ArrayLike<number>, bench: (row: number) => number, tr: Tr) {
  const rows: number[] = []
  for (let i = 0; i < obs.length; i++) if (Number.isFinite(obs[i]) && Number.isFinite(sim[i])) rows.push(i)
  const f = T(tr, avg(rows.map(i => obs[i])))
  const keep = rows.filter(i => Number.isFinite(bench(i)))
  const o = keep.map(i => f(obs[i])), s = keep.map(i => f(sim[i])), b = keep.map(i => f(bench(i)))
  return { n: keep.length, nse: nseRef(o, s), kge: kgeRef(o, s), nseB: nseRef(o, b), kgeB: kgeRef(o, b),
    nseSkill: skillRef(nseRef(o, s), nseRef(o, b)), kgeSkill: skillRef(kgeRef(o, s), kgeRef(o, b)) }
}

// ---- data: the 3-year record of the compute-09 reproduction -------------------
const N = 3 * 365
const dates = Array.from({ length: N }, (_, i) => Date.UTC(2001, 0, 1) + i * DAY)
const obs = new Float64Array(N), sim = new Float64Array(N)
for (let i = 0; i < N; i++) {
  const seas = 20 + 15 * Math.sin((2 * Math.PI * i) / 365)
  obs[i] = seas + 60 * Math.exp(-(((i % 60) - 20) ** 2) / 18) + 2 * Math.sin(i * 1.7)
  sim[i] = 0.9 * seas + 1.1 * 60 * Math.exp(-(((i % 60) - 22) ** 2) / 18) + 1.5
}
const simGaps = Float64Array.from(sim)
for (let i = 0; i < 120; i++) simGaps[i] = NaN
for (let y = 1; y < 3; y++) for (let i = 365 * y + 60; i < 365 * y + 90; i++) simGaps[i] = NaN

const ctx = (transform: Tr) => ({ nanPolicy: 'pairwise' as const, transform, datesMs: dates })
const full = (transform: Tr, s: ArrayLike<number> = sim) =>
  computeAll(obs, s, { ...ctx(transform), timing: defaultTimingConfig(DAY, N), heavy: false })
const persistence = (row: number) => (row === 0 ? obs[0] : obs[row - 1])
const climatology = (() => {
  const sums = new Array(12).fill(0), counts = new Array(12).fill(0)
  for (let i = 0; i < N; i++) { const m = new Date(dates[i]).getUTCMonth(); sums[m] += obs[i]; counts[m]++ }
  return (row: number) => { const m = new Date(dates[row]).getUTCMonth(); return sums[m] / counts[m] }
})()

describe('mean-flow benchmark: KGE_bench = 1 - sqrt(2) (compute-06, eff-04, report-06, samples-e2e-05)', () => {
  it('default settings: KGE skill vs mean is (KGE + sqrt(2) - 1)/sqrt(2), not n/a', () => {
    const r = benchmarkSkill(obs, sim, 'mean', ctx('none'))
    const kge = full('none').values.kge2009
    expect(r.kgeBench).toBeCloseTo(1 - Math.SQRT2, 12)
    expect(r.kge).toBe(kge)
    expect(r.kgeSkill).toBeCloseTo((kge + Math.SQRT2 - 1) / Math.SQRT2, 12)
    expect(r.nseBench).toBe(0)
    expect(r.nseSkill).toBe(full('none').values.nse)
  })

  it('the mean is taken over the model pairs, so the value holds for a simulation with gaps and under sqrt/inverse', () => {
    for (const tr of ['none', 'sqrt', 'inverse'] as const) {
      const r = benchmarkSkill(obs, simGaps, 'mean', ctx(tr))
      const m = full(tr, simGaps)
      expect(r.n).toBe(m.n)
      expect(r.kgeBench).toBeCloseTo(1 - Math.SQRT2, 12)
      expect(r.nseBench).toBe(0)
      expect(r.kgeSkill).toBeCloseTo((m.values.kge2009 + Math.SQRT2 - 1) / Math.SQRT2, 12)
    }
  })

  it('under log, NSE skill vs mean is the log NSE and KGE skill is n/a, as KGE is', () => {
    const r = benchmarkSkill(obs, sim, 'mean', ctx('log'))
    expect(r.nseSkill).toBeCloseTo(full('log').values.nse, 12)
    expect(r.kgeSkill).toBeNaN()
  })
})

describe('benchmark under the model transform (compute-05, eff-02, report-01, samples-e2e-04)', () => {
  for (const [kind, bench] of [['persistence', persistence], ['climatology', climatology]] as const) {
    for (const tr of ['none', 'sqrt', 'inverse', 'log'] as const) {
      it(`${kind}, transform ${tr}`, () => {
        const r = benchmarkSkill(obs, sim, kind, ctx(tr))
        const ref = refSkill(obs, sim, bench, tr)
        expect(r.n).toBe(ref.n)
        expect(r.nse).toBeCloseTo(full(tr).values.nse, 12)
        expect(r.nseBench).toBeCloseTo(ref.nseB, 10)
        expect(r.nseSkill).toBeCloseTo(ref.nseSkill, 10)
        if (tr === 'log') expect(r.kgeSkill).toBeNaN()
        else {
          expect(r.kgeBench).toBeCloseTo(ref.kgeB, 10)
          expect(r.kgeSkill).toBeCloseTo(ref.kgeSkill, 10)
        }
      })
    }
  }

  it('inverse + persistence: the skill has the sign of the same-space comparison (the old rows flipped it)', () => {
    const r = benchmarkSkill(obs, sim, 'persistence', ctx('inverse'))
    const ref = refSkill(obs, sim, persistence, 'inverse')
    expect(Math.sign(r.nseSkill)).toBe(Math.sign(ref.nseSkill))
    expect(r.nseSkill).toBeCloseTo(ref.nseSkill, 10)
  })
})

describe('benchmark on the model pairs (compute-09, eff-03)', () => {
  for (const [kind, bench] of [['persistence', persistence], ['climatology', climatology]] as const) {
    it(`${kind}: simulation missing for 180 days; the benchmark is scored on the same ${N - 180} pairs`, () => {
      const r = benchmarkSkill(obs, simGaps, kind, ctx('none'))
      const m = full('none', simGaps)
      const ref = refSkill(obs, simGaps, bench, 'none')
      expect(m.n).toBe(N - 180)
      expect(r.n).toBe(m.n)
      expect(r.nse).toBe(m.values.nse)
      expect(r.nseSkill).toBeCloseTo(ref.nseSkill, 10)
      expect(r.kgeSkill).toBeCloseTo(ref.kgeSkill, 10)
    })
  }

  it('a benchmark value that is missing drops that pair from both scores, never from one', () => {
    const o = Float64Array.from(obs); o[500] = NaN        // persistence is missing at row 501
    const r = benchmarkSkill(o, sim, 'persistence', ctx('none'))
    const ref = refSkill(o, sim, row => (row === 0 ? o[0] : o[row - 1]), 'none')
    expect(r.n).toBe(N - 2)
    expect(r.n).toBe(ref.n)
    expect(r.nse).toBeCloseTo(ref.nse, 12)
    expect(r.nseSkill).toBeCloseTo(ref.nseSkill, 10)
  })

  it('substitute-0 policy: the benchmark is filled like a simulation and the model score matches its panel', () => {
    const o = Float64Array.from(obs); o[500] = NaN
    const r = benchmarkSkill(o, sim, 'persistence', { ...ctx('none'), nanPolicy: 'zero' })
    const m = computeAll(o, sim, { nanPolicy: 'zero', transform: 'none', timing: defaultTimingConfig(DAY, N), heavy: false })
    expect(r.n).toBe(N)
    expect(r.nse).toBe(m.values.nse)
    const oz = Array.from(o, v => (Number.isFinite(v) ? v : 0))
    const bz = oz.map((_, i) => (i === 0 ? oz[0] : Number.isFinite(o[i - 1]) ? oz[i - 1] : 0))
    expect(r.nseBench).toBeCloseTo(nseRef(oz, bz), 12)
  })
})
