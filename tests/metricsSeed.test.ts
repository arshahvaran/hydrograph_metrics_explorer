import { describe, it, expect } from 'vitest'
import fixture from './fixtures/reference_vectors.json'
import { applyNanPolicy } from '../src/ingest/missing'
import { nse, kge2009, rmse, r as pearsonR, pbias, c2m } from '../src/metrics/classical/catalogue'

type Fx = typeof fixture
const F = fixture as Fx & Record<string, any>

const num = (s: string | number) => typeof s === 'number' ? s : Number(s)
const series = (name: string) => {
  const s = (F.series as any)[name]
  const parse = (a: string[]) => a.map(v => (v === 'NaN' ? NaN : Number(v)))
  return { obs: parse(s.obs), sim: parse(s.sim) }
}
const close = (a: number, b: number, tol = 1e-10) =>
  expect(Math.abs(a - b)).toBeLessThanOrEqual(tol * Math.max(1, Math.abs(b)))

const CASES = ['tiny6', 'nan8', 'synth730_shift3', 'synth730_offset',
  'synth730_scale', 'synth730_dampen', 'synth730_noise', 'synth730_combo'] as const

describe('seed metrics vs executed HydroErr 2.0.0 reference values', () => {
  for (const name of CASES) {
    it(`${name}: NSE, KGE-2009, RMSE, r match to <=1e-10 rel`, () => {
      const { obs, sim } = series(name)
      const p = applyNanPolicy(obs, sim, 'pairwise')
      const ref = (F.results as any)[name]['HydroErr_2.0.0']
      close(nse(p.obs, p.sim), num(ref.nse))
      close(kge2009(p.obs, p.sim).value, num(ref.kge_2009))
      close(rmse(p.obs, p.sim), num(ref.rmse))
      close(pearsonR(p.obs, p.sim), num(ref.pearson_r))
    })
  }
})

describe('seed metrics vs executed hydroeval 0.1.0 reference values', () => {
  it('tiny6: PBIAS sign convention and C2M(NSE)', () => {
    const { obs, sim } = series('tiny6')
    const p = applyNanPolicy(obs, sim, 'pairwise')
    const he = (F.results as any).tiny6['hydroeval_0.1.0']
    close(pbias(p.obs, p.sim), num(he.pbias), 1e-12)
    close(c2m(nse(p.obs, p.sim)), num(he.nse_c2m))
  })
  it('synth730_offset: positive offset gives negative PBIAS (over-estimation) while r stays ~1', () => {
    const { obs, sim } = series('synth730_offset')
    const p = applyNanPolicy(obs, sim, 'pairwise')
    const he = (F.results as any).synth730_offset['hydroeval_0.1.0']
    close(pbias(p.obs, p.sim), num(he.pbias))
    expect(pbias(p.obs, p.sim)).toBeLessThan(0)
    expect(pearsonR(p.obs, p.sim)).toBeGreaterThan(0.999999)
  })
})

describe('double-penalty pin: pure +3-step shift', () => {
  it('lag sweep truth reproduces at lag 0 and best lag +3 (NSE exactly 1)', () => {
    const { obs, sim } = series('synth730_shift3')
    const sweep = (F as any).lag_sweep_truth_synth730_shift3 as { lag: number; nse: string }[]
    // Advance sim by L steps (positive lag = sim late) and score the overlap.
    const at = (L: number) => {
      const o: number[] = [], s: number[] = []
      for (let t = 0; t < obs.length; t++) {
        const j = t + L
        if (j >= 0 && j < sim.length) { o.push(obs[t]); s.push(sim[j]) }
      }
      return nse(o, s)
    }
    for (const row of sweep) close(at(row.lag), num(row.nse))
    const best = sweep.reduce((a, b) => (num(b.nse) > num(a.nse) ? b : a))
    expect(best.lag).toBe(3)
    close(at(3), 1, 1e-12)
  })
})
