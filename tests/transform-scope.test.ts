/**
 * Regression tests for the transform scope (design rules D2 and D3):
 *  - compute-04 / eff-01 / norms-02: every dimensionless metric gives the same
 *    value in m3/s, L/s and cfs under each transform; under the log transform
 *    the metrics that are ratios to the level of the flows read n/a instead of
 *    out-of-range values (VE 7.58, PBIAS -280 %, negative NRMSE(mean)).
 *  - report-02: the best-value underline never picks the larger error.
 *  - de-sd-02, dtw-wass-03, fdc-03: DE, W1/W2^2 and the FDC signatures use the
 *    untransformed flows, so a transform leaves them unchanged.
 * FMM is excluded from the unit check: its published definition (Yilmaz et
 * al., 2008) divides by ln(median O), which depends on the unit under every
 * transform, including none.
 */
import { describe, it, expect } from 'vitest'
import { computeAll, REGISTRY, classicalValues } from '../src/metrics/registry'
import { applyTransform, LOCATION_DEPENDENT } from '../src/metrics/classical/catalogue'
import { bestIndex } from '../src/ui/compute'
import { defaultTimingConfig } from '../src/types'

type Tr = 'none' | 'log' | 'sqrt' | 'inverse'
const DAY = 86_400_000
const TRANSFORMS: Tr[] = ['none', 'sqrt', 'inverse', 'log']
const UNITS: [string, number][] = [['L/s', 1000], ['cfs', 35.314666721], ['1000 m3/s', 0.001]]

// the 730-day record of the compute-04 reproduction
const N = 730
const obs = new Float64Array(N), sim = new Float64Array(N)
for (let i = 0; i < N; i++) {
  const b = 3 + 2 * Math.sin((2 * Math.PI * i) / 365)
  obs[i] = b + 25 * Math.exp(-(((i % 45) - 15) ** 2) / 8)
  sim[i] = 0.8 * b + 22 * Math.exp(-(((i % 45) - 17) ** 2) / 10) + 0.3
}
const scale = (a: ArrayLike<number>, f: number) => Float64Array.from(a as ArrayLike<number>, v => v * f)
const ctx = (transform: Tr, n = N) => ({ nanPolicy: 'pairwise' as const, transform, timing: defaultTimingConfig(DAY, n) })
const same = (x: number, y: number, rel = 1e-9) =>
  (Number.isNaN(x) && Number.isNaN(y)) || Math.abs(x - y) <= rel * Math.max(1, Math.abs(x))

describe('D3: dimensionless metrics do not depend on the flow unit (compute-04, eff-01, norms-02)', () => {
  const ids = REGISTRY.filter(m => !m.unitful && m.id !== 'fmm').map(m => m.id)
  for (const tr of TRANSFORMS) {
    it(`transform ${tr}: every dimensionless metric is the same in m3/s, L/s, cfs and 1000 m3/s`, () => {
      const base = computeAll(obs, sim, ctx(tr)).values
      for (const [unit, f] of UNITS) {
        const v = computeAll(scale(obs, f), scale(sim, f), ctx(tr)).values
        const changed = ids.filter(id => !same(base[id], v[id], 1e-7)).map(id => `${id}: ${base[id]} -> ${v[id]} (${unit})`)
        expect(changed).toEqual([])
      }
    })
  }

  it('the log transform is ln((Q + eps)/mean(obs)): identical values in every unit, zero at Q + eps = mean(obs)', () => {
    const o = [1, 2, 3, 6], s = [2, 2, 4, 5]
    const m = 3, eps = 0.03
    const t = applyTransform(o, s, 'log')
    o.forEach((q, i) => expect(t.o[i]).toBeCloseTo(Math.log((q + eps) / m), 14))
    const t2 = applyTransform(o.map(q => q * 1000), s.map(q => q * 1000), 'log')
    t.o.forEach((v, i) => expect(t2.o[i]).toBeCloseTo(v, 12))
    t.s.forEach((v, i) => expect(t2.s[i]).toBeCloseTo(v, 12))
    expect(t.note).toMatch(/ln\(\(Q \+ ε\)\/mean\(obs\)\)/)
  })

  it('under log, the location-dependent metrics read n/a with a note; NSE, KGE″ and the difference metrics stay', () => {
    const out = computeAll(obs, sim, ctx('log'))
    for (const id of LOCATION_DEPENDENT) expect(out.values[id], id).toBeNaN()
    for (const id of ['nse', 'kge2021', 'rmse', 'rsr', 'r', 'nrmse_range', 'beta_nse', 'alpha', 'lm_index', 'mase']) {
      expect(Number.isFinite(out.values[id]), id).toBe(true)
    }
    expect(out.notes.join('\n')).toMatch(/On log flows, NRMSE \(mean\).*read n\/a.*Santos et al\., 2018/)
    // the same sets are unchanged under sqrt and inverse, whose values have a natural zero
    for (const tr of ['sqrt', 'inverse'] as const) {
      const o2 = computeAll(obs, sim, ctx(tr))
      for (const id of LOCATION_DEPENDENT) expect(Number.isFinite(o2.values[id]), `${tr} ${id}`).toBe(true)
      expect(o2.notes.join('\n')).not.toMatch(/On log flows/)
    }
  })

  it('eff-01: a small catchment (mean flow about 1.2 m3/s) under log shows no VE above 1, no PBIAS beyond 100 %, and one KGE″ in every unit', () => {
    const f = 1.2 / (obs.reduce((a, v) => a + v, 0) / N)
    const o = scale(obs, f), s = scale(sim, f)
    const res = [1, 1000, 35.314666721].map(k => computeAll(scale(o, k), scale(s, k), ctx('log')).values)
    for (const v of res) {
      expect(Number.isNaN(v.ve) || v.ve <= 1).toBe(true)
      expect(Number.isNaN(v.pbias) || v.pbias <= 100).toBe(true)
      expect(v.kge2009).toBeNaN()
      expect(same(v.kge2021, res[0].kge2021, 1e-9)).toBe(true)
      expect(same(v.nse, res[0].nse, 1e-9)).toBe(true)
    }
  })

  it('norms-02: tiny6 under log gives no unit-dependent percentage error and no negative NRMSE(mean)', () => {
    const O = [4.7, 6, 10, 2.5, 4, 7], S = [5, 7, 9, 2, 4.5, 6.7]
    const t6 = { ...ctx('log', 6), heavy: false }
    const ids = ['nrmse_mean', 'mape', 'smape', 'maape', 'mapd']
    const base = computeAll(O, S, t6).values
    for (const k of [1000, 35.314666721]) {
      const v = computeAll(O.map(x => x * k), S.map(x => x * k), t6).values
      for (const id of ids) expect(same(base[id], v[id]), id).toBe(true)
      expect(same(base.rmse, v.rmse)).toBe(true)
    }
    for (const id of ids) expect(Number.isNaN(base[id]) || base[id] >= 0, id).toBe(true)
  })
})

describe('report-02: the underline picks the smaller error', () => {
  const n = 400
  const q = Array.from({ length: n }, (_, i) => 0.05 + 0.4 * Math.exp(-(((i % 50) - 20) ** 2) / 20) + 0.02 * Math.sin(i / 7))
  const good = q.map(v => v * 1.05), bad = q.map(v => v * 1.6 + 0.05)

  it('log transform with sub-unit flows: VE and NRMSE(mean) never underline the worse run', () => {
    const g = computeAll(q, good, ctx('log', n)).values, b = computeAll(q, bad, ctx('log', n)).values
    expect(bestIndex([g.nse, b.nse], 'max')).toBe(0)
    expect(bestIndex([g.rmse, b.rmse], 'min')).toBe(0)
    expect(bestIndex([g.ve, b.ve], 'max')).not.toBe(1)
    expect(bestIndex([g.nrmse_mean, b.nrmse_mean], 'min')).not.toBe(1)
    // untransformed, both are defined and the better run is underlined
    const g0 = computeAll(q, good, ctx('none', n)).values, b0 = computeAll(q, bad, ctx('none', n)).values
    expect(bestIndex([g0.ve, b0.ve], 'max')).toBe(0)
    expect(bestIndex([g0.nrmse_mean, b0.nrmse_mean], 'min')).toBe(0)
  })

  it("a 'min' metric is scored by its distance to 0, as the composite ranking does", () => {
    expect(bestIndex([-0.083, -0.287], 'min')).toBe(0)
    expect(bestIndex([0.3, 0.1], 'min')).toBe(1)
  })
})

describe('D2: FDC signatures, DE and W1/W2 use untransformed flows (fdc-03, de-sd-02, dtw-wass-03)', () => {
  it('fdc-03: S = 1.25 O gives FHV = +25 % under every transform and unit; FLV, FMS and FMM equal their untransformed values', () => {
    const s125 = scale(obs, 1.25)
    const none = computeAll(obs, s125, { ...ctx('none'), heavy: false }).values
    expect(none.fhv).toBeCloseTo(25, 9)
    for (const tr of TRANSFORMS) for (const k of [1, 1000, 0.001]) {
      const v = computeAll(scale(obs, k), scale(s125, k), { ...ctx(tr), heavy: false }).values
      expect(v.fhv, `${tr} x${k}`).toBeCloseTo(25, 9)
      for (const id of ['flv', 'fms']) expect(same(v[id], none[id], 1e-9), `${tr} x${k} ${id}`).toBe(true)
      if (k === 1) expect(same(v.fmm, none.fmm, 1e-12), `${tr} fmm`).toBe(true)
    }
  })

  it('fdc-03: the bootstrap block computes the FDC signatures on the untransformed pairs it is given', () => {
    const t = applyTransform(obs, sim, 'inverse')
    const a = classicalValues(t.o, t.s, { o: obs, s: sim }, 'inverse').values
    const none = classicalValues(obs, sim).values
    for (const id of ['fhv', 'flv', 'fms', 'fmm']) expect(a[id]).toBe(none[id])
  })

  it('de-sd-02: DE of a strictly positive record is the same under log and none, in m3/s and L/s, with no non-perennial note', () => {
    // 0.36 to 3.7 m3/s, simulation 10 % high everywhere and 3 steps late
    const o = scale(obs, 0.12), s = Float64Array.from(o, (_, i) => 1.1 * o[Math.max(0, i - 3)])
    const ref = computeAll(o, s, ctx('none')).values
    expect(ref.de_const).toBeGreaterThan(0)
    for (const k of [1, 1000]) {
      const out = computeAll(scale(o, k), scale(s, k), ctx('log'))
      for (const id of ['de', 'de_const', 'de_dyn']) expect(same(out.values[id], ref[id], 1e-9), `${id} x${k}`).toBe(true)
      expect(out.notes.join('\n')).not.toMatch(/has zero or negative flows/)
      expect(out.extras.de!.nonPerennial).toBe(false)
    }
  })

  it('dtw-wass-03: W1 and W2^2 under log equal the untransformed values in every unit (they were n/a in m3/s)', () => {
    const n = 365
    const q = Array.from({ length: n }, (_, t) => 0.3 + 5 * Math.exp(-((t - 150) ** 2) / 200) + 0.5 * Math.exp(-((t - 60) ** 2) / 50))
    const s = q.map((_, t) => q[Math.max(0, t - 3)])
    const ref = computeAll(q, s, ctx('none', n)).values
    expect(Number.isFinite(ref.w1)).toBe(true)
    for (const k of [1, 1000, 35.314666721]) {
      const v = computeAll(q.map(x => x * k), s.map(x => x * k), ctx('log', n)).values
      expect(same(v.w1, ref.w1, 1e-9), `w1 x${k}`).toBe(true)
      expect(same(v.w2sq, ref.w2sq, 1e-9), `w2sq x${k}`).toBe(true)
    }
  })

  it('the transform note names what the transform applies to and what uses untransformed flows', () => {
    const notes = computeAll(obs, sim, ctx('sqrt')).notes.join('\n')
    expect(notes).toMatch(/FDC signatures, Diagnostic Efficiency, W₁, W₂², event, peak-timing, Series Distance and lag-sweep metrics are computed on untransformed flows/)
    expect(computeAll(obs, sim, { ...ctx('sqrt'), heavy: false }).notes.join('\n')).toMatch(/computed on untransformed flows/)
    expect(computeAll(obs, sim, ctx('none')).notes.join('\n')).not.toMatch(/untransformed/)
  })
})

describe('tb-rev-04: the inverse transform drops flows outside its domain, as sqrt and log do', () => {
  // the reviewer's record: one simulated value of -1 (eps = 0.12, so Q + eps < 0)
  const n = 365
  const o = Float64Array.from({ length: n }, (_, i) => 10 + 30 * Math.exp(-(((i % 40) - 15) ** 2) / 10))
  const s = Float64Array.from({ length: n }, (_, i) => 9 + 28 * Math.exp(-(((i % 40) - 16) ** 2) / 10))
  const bad = Float64Array.from(s); bad[200] = -1

  it('a simulated flow of -1 is dropped with a note under inverse, sqrt and log alike', () => {
    for (const tr of ['inverse', 'sqrt', 'log'] as const) {
      const out = computeAll(o, bad, { ...ctx(tr, n), heavy: false })
      expect(out.n, tr).toBe(n - 1)
      expect(out.pairedIndex, tr).not.toContain(200)
      expect(out.notes, tr).toContain(`1 pair was excluded because it is not positive under the ${tr} transform.`)
    }
  })

  it('inverse: the scores equal those of the record without that pair (NSE once fell from 0.771 to -6.275)', () => {
    const keep = Array.from({ length: n }, (_, i) => i).filter(i => i !== 200)
    const eps = 0.01 * (o.reduce((a, b) => a + b, 0) / n)       // eps from the NaN-policy pairs, as the view does
    const f = (v: number) => 1 / (v + eps)
    const to = keep.map(i => f(o[i])), ts = keep.map(i => f(bad[i]))
    const m = to.reduce((a, b) => a + b, 0) / to.length
    let num = 0, den = 0
    to.forEach((v, k) => { num += (ts[k] - v) ** 2; den += (v - m) ** 2 })
    const out = computeAll(o, bad, { ...ctx('inverse', n), heavy: false })
    expect(out.values.nse).toBeCloseTo(1 - num / den, 12)
    expect(out.values.nse).toBeGreaterThan(0.7)
  })

  it('the inverse domain is Q + eps > 0, like log: monotone there, NaN outside', () => {
    const t = applyTransform([10, 0, -0.05, -0.1, -0.2, -1], [10, 10, 10, 10, 10, 10], 'inverse', 10)
    const eps = 0.1
    expect(t.o[0]).toBeCloseTo(1 / 10.1, 14)
    expect(t.o[1]).toBeCloseTo(1 / eps, 12)                     // zero flow: finite through eps
    expect(t.o[2]).toBeCloseTo(1 / 0.05, 12)                    // -eps < Q < 0: kept, above 1/eps (monotone)
    expect(t.o[3]).toBeNaN()                                    // Q + eps = 0
    expect(t.o[4]).toBeNaN()
    expect(t.o[5]).toBeNaN()
    const tl = applyTransform([10, 0, -0.05, -0.1, -0.2, -1], [10, 10, 10, 10, 10, 10], 'log', 10)
    expect(Array.from(t.o, Number.isFinite)).toEqual(Array.from(tl.o, Number.isFinite))
  })
})
