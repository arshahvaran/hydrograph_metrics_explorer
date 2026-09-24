/**
 * Regression tests for the benchmark skill rows (design rule D4):
 *  - compute-05 / eff-02 / report-01 / samples-e2e-04: the benchmark is scored
 *    under the model's transform (it was always scored on raw flows);
 *  - compute-09 / eff-03: the benchmark is scored on the model's own pairs (it
 *    was scored on every observed step, the model only where sim existed);
 *  - compute-06 / eff-04 / report-06 / samples-e2e-05: the mean-flow benchmark
 *    scores KGE = 1 - sqrt(2) (Knoben et al., 2019), so "KGE skill vs mean" is
 *    defined (it was n/a for every dataset);
 *  - tb-rev-01: the three benchmarks follow ONE convention. Each is a flow
 *    series built from the observations of the evaluated pairs (mean flow,
 *    monthly mean flow, previous observation) and then transformed like the
 *    simulation. Before, the mean benchmark was the mean of the TRANSFORMED
 *    observations and the climatology the transformed monthly mean of ALL raw
 *    observations, so a climatology could score far below the mean it contains;
 *  - tb-rev-02: persistence has no forecast at the first step, which is dropped
 *    from both scores (it had a free zero error there);
 *  - tb-rev-05: the panel computed in the worker carries the skill of all three
 *    benchmarks, so the Metrics tab reads it instead of computing it on render.
 * The expected values come from an independent implementation in this file
 * (plain loops, no library metric functions).
 */
import { describe, it, expect } from 'vitest'
import { benchmarkSkill, computeAll } from '../src/metrics/registry'
import { defaultTimingConfig } from '../src/types'

type Tr = 'none' | 'log' | 'sqrt' | 'inverse'
type Kind = 'mean' | 'climatology' | 'persistence'
const DAY = 86_400_000
const KINDS: Kind[] = ['mean', 'climatology', 'persistence']

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
/** KGE of a constant forecast: r = 0 and alpha = 0 (Knoben et al., 2019), beta = mean(b)/mean(o) */
const kgeConstRef = (o: number[], b: number[]) => 1 - Math.sqrt(2 + (avg(b) / avg(o) - 1) ** 2)
const skillRef = (m: number, b: number) => Math.min(1, (m - b) / (1 - b))
/** the view transforms; the domains are Q >= 0 (sqrt) and Q + eps > 0 (log, inverse) */
const T = (tr: Tr, meanObs: number) => (v: number) => {
  const eps = 0.01 * meanObs
  if (tr === 'none') return v
  if (tr === 'sqrt') return v >= 0 ? Math.sqrt(v) : NaN
  if (tr === 'inverse') return v + eps > 0 ? 1 / (v + eps) : NaN
  return (v + eps) / meanObs > 0 ? Math.log((v + eps) / meanObs) : NaN
}
const month = (ms: number) => new Date(ms).getUTCMonth()
const datesFrom = (n: number, y = 2001) => Array.from({ length: n }, (_, i) => Date.UTC(y, 0, 1) + i * DAY)

/** Pairwise policy. Model pairs: obs and sim finite and inside the transform's
 *  domain (eps and the log reference from the observed mean of the finite
 *  pairs). Benchmark flow at each pair: the mean of the observations of those
 *  pairs, their monthly means, or the observation at the previous step (none
 *  at step 0). Both scores on the pairs where the transformed benchmark exists. */
function refSkill(obs: ArrayLike<number>, sim: ArrayLike<number>, kind: Kind, tr: Tr, dates: number[]) {
  const rows0: number[] = []
  for (let i = 0; i < obs.length; i++) if (Number.isFinite(obs[i]) && Number.isFinite(sim[i])) rows0.push(i)
  const f = T(tr, avg(rows0.map(i => obs[i])))
  const rows = rows0.filter(i => Number.isFinite(f(obs[i])) && Number.isFinite(f(sim[i])))
  let bench: (row: number) => number
  if (kind === 'mean') {
    const m = avg(rows.map(i => obs[i]))
    bench = () => m
  } else if (kind === 'climatology') {
    const sums = new Array(12).fill(0), counts = new Array(12).fill(0)
    for (const i of rows) { sums[month(dates[i])] += obs[i]; counts[month(dates[i])]++ }
    bench = row => sums[month(dates[row])] / counts[month(dates[row])]
  } else {
    bench = row => (row === 0 ? NaN : obs[row - 1])
  }
  const keep = rows.filter(i => Number.isFinite(f(bench(i))))
  const o = keep.map(i => f(obs[i])), s = keep.map(i => f(sim[i])), b = keep.map(i => f(bench(i)))
  const nseB = nseRef(o, b)
  const kgeB = kind === 'mean' ? kgeConstRef(o, b) : kgeRef(o, b)
  return { n: keep.length, nse: nseRef(o, s), kge: kgeRef(o, s), nseB, kgeB,
    nseSkill: skillRef(nseRef(o, s), nseB), kgeSkill: skillRef(kgeRef(o, s), kgeB) }
}

// ---- data: the 3-year record of the compute-09 reproduction -------------------
const N = 3 * 365
const dates = datesFrom(N)
const obs = new Float64Array(N), sim = new Float64Array(N)
for (let i = 0; i < N; i++) {
  const seas = 20 + 15 * Math.sin((2 * Math.PI * i) / 365)
  obs[i] = seas + 60 * Math.exp(-(((i % 60) - 20) ** 2) / 18) + 2 * Math.sin(i * 1.7)
  sim[i] = 0.9 * seas + 1.1 * 60 * Math.exp(-(((i % 60) - 22) ** 2) / 18) + 1.5
}
const simGaps = Float64Array.from(sim)
for (let i = 0; i < 120; i++) simGaps[i] = NaN
for (let y = 1; y < 3; y++) for (let i = 365 * y + 60; i < 365 * y + 90; i++) simGaps[i] = NaN

const ctx = (transform: Tr, datesMs: number[] = dates) => ({ nanPolicy: 'pairwise' as const, transform, datesMs })
const full = (transform: Tr, s: ArrayLike<number> = sim) =>
  computeAll(obs, s, { ...ctx(transform), timing: defaultTimingConfig(DAY, N), heavy: false })

describe('mean-flow benchmark: KGE_bench = 1 - sqrt(2) with no transform (compute-06, eff-04, report-06, samples-e2e-05)', () => {
  it('default settings: KGE skill vs mean is (KGE + sqrt(2) - 1)/sqrt(2), not n/a', () => {
    const r = benchmarkSkill(obs, sim, 'mean', ctx('none'))
    const kge = full('none').values.kge2009
    expect(r.kgeBench).toBeCloseTo(1 - Math.SQRT2, 12)
    expect(r.kge).toBe(kge)
    expect(r.kgeSkill).toBeCloseTo((kge + Math.SQRT2 - 1) / Math.SQRT2, 12)
    expect(r.nseBench).toBe(0)
    expect(r.nseSkill).toBe(full('none').values.nse)
  })

  it('the mean is taken over the model pairs, so the value holds for a simulation with gaps', () => {
    const r = benchmarkSkill(obs, simGaps, 'mean', ctx('none'))
    const m = full('none', simGaps)
    expect(r.n).toBe(m.n)
    expect(r.kgeBench).toBeCloseTo(1 - Math.SQRT2, 12)
    expect(r.nseBench).toBe(0)
    expect(r.kgeSkill).toBeCloseTo((m.values.kge2009 + Math.SQRT2 - 1) / Math.SQRT2, 12)
  })

  it('tb-rev-01: under a transform the benchmark is the transformed mean flow, scored like any benchmark', () => {
    for (const tr of ['sqrt', 'inverse', 'log'] as const) {
      const r = benchmarkSkill(obs, simGaps, 'mean', ctx(tr))
      const ref = refSkill(obs, simGaps, 'mean', tr, dates)
      expect(r.n, tr).toBe(full(tr, simGaps).n)
      expect(r.nseBench, tr).toBeCloseTo(ref.nseB, 10)
      // the transformed mean flow is not the mean of the transformed flows (Jensen)
      expect(r.nseBench, tr).toBeLessThan(0)
      expect(r.nseSkill, tr).toBeCloseTo(ref.nseSkill, 10)
      if (tr === 'log') expect(r.kgeSkill).toBeNaN()   // KGE is n/a on log flows
      else {
        expect(r.kgeBench, tr).toBeCloseTo(ref.kgeB, 10)
        expect(r.kgeSkill, tr).toBeCloseTo(ref.kgeSkill, 10)
      }
    }
  })
})

describe('benchmark under the model transform (compute-05, eff-02, report-01, samples-e2e-04)', () => {
  for (const kind of ['persistence', 'climatology'] as const) {
    for (const tr of ['none', 'sqrt', 'inverse', 'log'] as const) {
      it(`${kind}, transform ${tr}`, () => {
        const r = benchmarkSkill(obs, sim, kind, ctx(tr))
        const ref = refSkill(obs, sim, kind, tr, dates)
        expect(r.n).toBe(ref.n)
        expect(r.nse).toBeCloseTo(ref.nse, 12)
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
    const ref = refSkill(obs, sim, 'persistence', 'inverse', dates)
    expect(Math.sign(r.nseSkill)).toBe(Math.sign(ref.nseSkill))
    expect(r.nseSkill).toBeCloseTo(ref.nseSkill, 10)
  })
})

describe('tb-rev-01: one convention for the three benchmarks', () => {
  // the reviewer's record: 730 days of sharp monthly-periodic events on a low base flow
  const n2 = 730, d2 = datesFrom(n2)
  const o2 = Float64Array.from({ length: n2 }, (_, i) => 1 + 50 * Math.exp(-(((i % 30) - 5) ** 2) / 2))
  const s2 = Float64Array.from({ length: n2 }, (_, i) => 0.9 + 45 * Math.exp(-(((i % 30) - 6) ** 2) / 2.5))

  for (const tr of ['none', 'sqrt', 'inverse', 'log'] as const) {
    it(`${tr}: every benchmark matches the reference, and the climatology never scores below the mean flow it contains`, () => {
      const res = Object.fromEntries(KINDS.map(k => [k, benchmarkSkill(o2, s2, k, ctx(tr, d2))])) as Record<Kind, ReturnType<typeof benchmarkSkill>>
      for (const k of KINDS) {
        const ref = refSkill(o2, s2, k, tr, d2)
        expect(res[k].n, k).toBe(ref.n)
        expect(res[k].nseBench, k).toBeCloseTo(ref.nseB, 10)
        expect(res[k].nseSkill, k).toBeCloseTo(ref.nseSkill, 10)
      }
      // before: inverse NSE_bench(climatology) = -3.11 against 0 for the mean, so
      // the model looked more skilful against the climatology (0.928) than
      // against the mean flow (0.706)
      expect(res.climatology.nseBench).toBeGreaterThanOrEqual(res.mean.nseBench)
      expect(res.climatology.nseSkill).toBeLessThanOrEqual(res.mean.nseSkill)
      if (tr !== 'log') expect(res.climatology.kgeSkill).toBeLessThanOrEqual(res.mean.kgeSkill)
    })
  }

  it('observations the transform drops do not enter the mean or the climatology', () => {
    // every 7th observation is -1: sqrt drops those pairs; they must not pull the benchmarks down
    const n3 = 60, d3 = datesFrom(n3)
    const clean = Float64Array.from({ length: n3 }, (_, i) => 5 + 3 * Math.sin(i / 4) + (i > 30 ? 2 : 0))
    const dirty = Float64Array.from(clean, (v, i) => (i % 7 === 3 ? -1 : v))
    const holed = Float64Array.from(clean, (v, i) => (i % 7 === 3 ? NaN : v))
    const s3 = Float64Array.from(clean, v => 0.95 * v + 0.2)
    for (const k of ['mean', 'climatology'] as const) {
      const a = benchmarkSkill(dirty, s3, k, ctx('sqrt', d3))
      const b = benchmarkSkill(holed, s3, k, ctx('sqrt', d3))
      const ref = refSkill(dirty, s3, k, 'sqrt', d3)
      expect(a.n, k).toBe(ref.n)
      expect(a.nseBench, k).toBeCloseTo(ref.nseB, 10)
      // eps and the log reference come from the NaN-policy pairs, so compare in the benchmark space
      expect(a.nseBench, k).toBeCloseTo(b.nseBench, 10)
      expect(a.nseSkill, k).toBeCloseTo(b.nseSkill, 10)
    }
  })

  it('observations where the simulation is missing do not enter the mean or the climatology', () => {
    const o4 = Float64Array.from(obs)
    for (let i = 0; i < 120; i++) o4[i] = 1000 + i      // only rows where simGaps is missing
    for (const k of ['mean', 'climatology'] as const) {
      for (const tr of ['none', 'sqrt'] as const) {
        const a = benchmarkSkill(o4, simGaps, k, ctx(tr))
        const b = benchmarkSkill(obs, simGaps, k, ctx(tr))
        if (tr === 'none') { expect(a.nseSkill, k).toBe(b.nseSkill); expect(a.kgeSkill, k).toBe(b.kgeSkill) }
        else expect(a.nseSkill, `${k} ${tr}`).toBeCloseTo(refSkill(o4, simGaps, k, tr, dates).nseSkill, 10)
      }
    }
  })
})

describe('tb-rev-02: persistence has no forecast at the first step', () => {
  // the reviewer's recession with a cold-start error at step 0
  const O = [100, 20, 12, 10, 9, 8.5, 8, 7.8, 7.5, 7.2, 7, 6.9, 6.8, 6.7, 6.6]
  const S = O.map((v, i) => (i === 0 ? 60 : 1.05 * v))
  const dd = datesFrom(O.length)

  it('step 0 is dropped from both scores (it had a free zero error there)', () => {
    const r = benchmarkSkill(O, S, 'persistence', ctx('none', dd))
    expect(r.n).toBe(14)
    const o = O.slice(1), s = S.slice(1), b = O.slice(0, -1)
    expect(r.nse).toBeCloseTo(nseRef(o, s), 12)
    expect(r.nseBench).toBeCloseTo(nseRef(o, b), 12)
    expect(r.nseBench).toBeCloseTo(-38.64, 2)
    expect(r.nseSkill).toBeCloseTo(skillRef(nseRef(o, s), nseRef(o, b)), 12)
    expect(r.nseSkill).toBeGreaterThan(0.999)
  })

  it('a benchmark value that is missing drops that pair from both scores, never from one', () => {
    const o = Float64Array.from(obs); o[500] = NaN        // persistence is missing at row 501
    const r = benchmarkSkill(o, sim, 'persistence', ctx('none'))
    const ref = refSkill(o, sim, 'persistence', 'none', dates)
    expect(r.n).toBe(N - 3)                               // rows 0, 500 (no obs) and 501 (no benchmark)
    expect(r.n).toBe(ref.n)
    expect(r.nse).toBeCloseTo(ref.nse, 12)
    expect(r.nseSkill).toBeCloseTo(ref.nseSkill, 10)
  })

  it('substitute-0 policy: persistence of the filled observations, and step 0 is dropped, not filled', () => {
    const o = Float64Array.from(obs); o[500] = NaN
    const r = benchmarkSkill(o, sim, 'persistence', { ...ctx('none'), nanPolicy: 'zero' })
    expect(r.n).toBe(N - 1)
    const oz = Array.from(o, v => (Number.isFinite(v) ? v : 0))
    const oo = oz.slice(1), ss = Array.from(sim).slice(1), bb = oz.slice(0, -1)
    expect(r.nse).toBeCloseTo(nseRef(oo, ss), 12)
    expect(r.nseBench).toBeCloseTo(nseRef(oo, bb), 12)
  })
})

describe('benchmark on the model pairs (compute-09, eff-03)', () => {
  for (const kind of ['persistence', 'climatology'] as const) {
    it(`${kind}: simulation missing for 180 days; the benchmark is scored on the same pairs`, () => {
      const r = benchmarkSkill(obs, simGaps, kind, ctx('none'))
      const m = full('none', simGaps)
      const ref = refSkill(obs, simGaps, kind, 'none', dates)
      expect(m.n).toBe(N - 180)
      expect(r.n).toBe(ref.n)
      expect(r.nse).toBeCloseTo(ref.nse, 12)
      expect(r.nseSkill).toBeCloseTo(ref.nseSkill, 10)
      expect(r.kgeSkill).toBeCloseTo(ref.kgeSkill, 10)
    })
  }
})

describe('tb-rev-05: the panel carries the benchmark skill of all three benchmarks', () => {
  for (const tr of ['none', 'inverse', 'log'] as const) {
    it(`computeAll returns what benchmarkSkill returns, transform ${tr}`, () => {
      const out = full(tr, simGaps)
      for (const k of KINDS) {
        const b = benchmarkSkill(obs, simGaps, k, ctx(tr))
        const p = out.benchmark?.[k]
        expect(p, k).toBeDefined()
        expect(p!.n, k).toBe(b.n)
        expect(p!.nseSkill, k).toBe(b.nseSkill)
        expect(Object.is(p!.kgeSkill, b.kgeSkill), k).toBe(true)
      }
    })
  }

  it('the panel skill of the mean benchmark uses the panel NSE and KGE', () => {
    const out = full('none')
    expect(out.benchmark!.mean.nseSkill).toBe(out.values.nse)
    expect(out.benchmark!.mean.kgeSkill).toBeCloseTo((out.values.kge2009 + Math.SQRT2 - 1) / Math.SQRT2, 12)
  })
})
