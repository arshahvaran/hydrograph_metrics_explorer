import { describe, it, expect } from 'vitest'
import fixture from './fixtures/reference_vectors.json'
import { applyNanPolicy } from '../src/ingest/missing'
import * as C from '../src/metrics/classical/catalogue'

const F = fixture as any
const num = (v: string | number) => (typeof v === 'number' ? v : Number(v))
const series = (name: string) => {
  const s = F.series[name]
  const parse = (a: string[]) => a.map((v: string) => (v === 'NaN' ? NaN : Number(v)))
  const p = applyNanPolicy(parse(s.obs), parse(s.sim), 'pairwise')
  return { o: p.obs, s: p.sim }
}
const close = (a: number, b: number, tol = 1e-9) => {
  expect(Number.isFinite(a)).toBe(true)
  expect(Math.abs(a - b)).toBeLessThanOrEqual(tol * Math.max(1, Math.abs(b)))
}

// my function -> executed HydroErr 2.0.0 key
const MAP: [keyof typeof C, string][] = [
  ['me', 'me'], ['mae', 'mae'], ['mdae', 'mdae'], ['mse', 'mse'], ['rmse', 'rmse'],
  ['mde', 'mde'], ['mdse', 'mdse'], ['mle', 'mle'], ['male', 'male'], ['msle', 'msle'], ['rmsle', 'rmsle'],
  ['mape', 'mape'], ['maape', 'maape'], ['smape', 'smape2'], ['mase', 'mase'],
  ['nrmseMean', 'nrmse_mean'], ['nrmseRange', 'nrmse_range'], ['nrmseIqr', 'nrmse_iqr'],
  ['r', 'pearson_r'], ['r2', 'r_squared'], ['spearman', 'spearman_r'],
  ['d', 'd'], ['d1', 'd1'], ['dr', 'dr'], ['drel', 'drel'], ['lmIndex', 'lm_index'],
  ['nse', 'nse'], ['nseMod', 'nse_mod'], ['nseRel', 'nse_rel'], ['ve', 've'],
]

const CASES = ['tiny6', 'nan8', 'synth730_shift3', 'synth730_offset', 'synth730_scale', 'synth730_dampen', 'synth730_noise', 'synth730_combo']

describe('classical catalogue vs executed HydroErr 2.0.0 (every implemented metric, every fixture series)', () => {
  for (const name of CASES) {
    it(name, () => {
      const { o, s } = series(name)
      const ref = F.results[name]['HydroErr_2.0.0']
      for (const [fn, key] of MAP) {
        const mine = (C[fn] as (a: any, b: any) => number)(o, s)
        close(mine, num(ref[key]))
      }
      close(C.kge2009(o, s).value, num(ref.kge_2009))
      close(C.kge2012(o, s).value, num(ref.kge_2012))
    })
  }
})

describe('vs executed hydroeval 0.1.0 (PBIAS sign, KGEnp, C2M family, MARE)', () => {
  for (const name of CASES) {
    it(name, () => {
      const { o, s } = series(name)
      const he = F.results[name]['hydroeval_0.1.0']
      close(C.pbias(o, s), num(he.pbias), 1e-9)
      close(C.mare(o, s), num(he.mare))
      close(C.c2m(C.nse(o, s)), num(he.nse_c2m))
      close(C.c2m(C.kge2009(o, s).value), num(he.kge_c2m))
      close(C.c2m(C.kge2012(o, s).value), num(he.kgeprime_c2m))
      // hydroeval breaks Spearman ties by numpy's unstable quicksort order;
      // ours are stable-by-index — identical when there are no ties, ≤1e-5 with.
      close(C.c2m(C.kgenp(o, s).value), num(he.kgenp_c2m), 1e-5)
    })
  }
})

describe('metrics without an executable oracle: pinned identities', () => {
  it('RSR = RMSE/σ, α, β-NSE, KGE″ reduce correctly on a known pair', () => {
    const { o, s } = series('tiny6')
    close(C.rsr(o, s), C.rmse(o, s) / Math.sqrt(o.reduce((a, v) => a + (v - 5.7) ** 2, 0) / o.length))
    // identical series ⇒ perfection
    close(C.kge2021(o, o).value, 1, 1e-12)
    close(C.alphaRatio(o, o), 1, 1e-12)
    expect(Math.abs(C.betaNse(o, o))).toBeLessThan(1e-12)
  })
  it('FDC signatures: exact zero for identical series; FHV sign tracks peak bias', () => {
    const { o } = series('synth730_shift3')
    close(C.fhv(o, o), 0, 1e-12); close(C.flv(o, o), 0, 1e-12)
    close(C.fms(o, o), 0, 1e-12); close(C.fmm(o, o), 0, 1e-12)
    const inflated = Array.from(o, v => v * 1.2)
    expect(C.fhv(o, inflated)).toBeGreaterThan(0)
  })
  it('benchmark skill: model at optimum ⇒ 1, model at benchmark ⇒ 0', () => {
    close(C.skill(1, -0.2, 1), 1, 1e-12)
    close(C.skill(-0.2, -0.2, 1), 0, 1e-12)
  })
})
