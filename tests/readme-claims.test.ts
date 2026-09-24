/**
 * README claims about validation and the Metrics panel match the code and the
 * executed reference outputs (audit findings claims-03, claims-04, norms-05,
 * compute-13, eff-05, report-13). The numbers the README states are
 * recomputed here from tests/fixtures/reference_vectors.json, so a change in
 * agreement or coverage fails this test until the README follows.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import fixture from './fixtures/reference_vectors.json'
import { applyNanPolicy } from '../src/ingest/missing'
import * as C from '../src/metrics/classical/catalogue'
import { REGISTRY } from '../src/metrics/registry'

const RAW = readFileSync('README.md', 'utf8')
const flat = (t: string) => t.replace(/\r?\n\s*/g, ' ')
const README = flat(RAW)
const PARAS = RAW.split(/\r?\n\s*\r?\n/).map(flat)
const VALIDATION = flat(RAW.slice(RAW.indexOf('## Technical validation'), RAW.indexOf('## How to cite')))
const F = fixture as any
const num = (v: any) => (typeof v === 'number' ? v : Number(v))
const CASES = Object.keys(F.series)
const series = (name: string) => {
  const parse = (a: string[]) => a.map(v => (v === 'NaN' ? NaN : Number(v)))
  const p = applyNanPolicy(parse(F.series[name].obs), parse(F.series[name].sim), 'pairwise')
  return { o: p.obs, s: p.sim }
}
type Fn = (o: any, s: any) => number
// registry id -> [HydroErr key, HME function] (tests/classical.test.ts)
const HYDROERR: Record<string, [string, Fn]> = {
  me: ['me', C.me], mae: ['mae', C.mae], mdae: ['mdae', C.mdae], mse: ['mse', C.mse], rmse: ['rmse', C.rmse],
  mde: ['mde', C.mde], mdse: ['mdse', C.mdse], mape: ['mape', C.mape], maape: ['maape', C.maape],
  smape: ['smape2', C.smape], mapd: ['mapd', (o, s) => C.mapd(o, s) / 100], mase: ['mase', C.mase],
  nrmse_mean: ['nrmse_mean', C.nrmseMean], nrmse_range: ['nrmse_range', C.nrmseRange], nrmse_iqr: ['nrmse_iqr', C.nrmseIqr],
  r: ['pearson_r', C.r], r2: ['r_squared', C.r2], spearman: ['spearman_r', C.spearman],
  d: ['d', C.d], d1: ['d1', C.d1], dr: ['dr', C.dr], drel: ['drel', C.drel], lm_index: ['lm_index', C.lmIndex],
  nse: ['nse', C.nse], nse_mod: ['nse_mod', C.nseMod], nse_rel: ['nse_rel', C.nseRel], ve: ['ve', C.ve],
  kge2009: ['kge_2009', (o, s) => C.kge2009(o, s).value], kge2012: ['kge_2012', (o, s) => C.kge2012(o, s).value],
}
const HYDROEVAL_ONLY = ['pbias', 'kgenp']
const DIAG_EFF = ['de', 'de_const', 'de_dyn']
const EXECUTED = new Set([...Object.keys(HYDROERR), ...HYDROEVAL_ONLY, ...DIAG_EFF])

describe('claims-03: which metrics have an executed reference, and Hydrostats', () => {
  it('README counts match the registry and the tested set', () => {
    for (const id of EXECUTED) expect(REGISTRY.some(m => m.id === id)).toBe(true)
    expect(Object.keys(HYDROERR).length).toBe(29)
    expect(VALIDATION).toContain(`compares ${EXECUTED.size} of the ${REGISTRY.length} metrics`)
    expect(VALIDATION).toContain(`HydroErr 2.0.0** (${Object.keys(HYDROERR).length} metrics)`)
    expect(VALIDATION).toContain(`The other ${REGISTRY.length - EXECUTED.size} metrics have no executed reference`)
    const untested = REGISTRY.filter(m => !EXECUTED.has(m.id))
    expect(untested.filter(m => m.timing).length).toBe(15)
    expect(VALIDATION).toContain('the 15 other timing and shape metrics')
  })
  it('Hydrostats is not claimed as executed, and the generator never imports it', () => {
    const gen = readFileSync('scripts/generate_reference_vectors.py', 'utf8')
    expect(gen).not.toMatch(/^\s*(import|from)\s+hydrostats/im)
    expect(VALIDATION).not.toMatch(/outputs of HydroErr 2\.0\.0, Hydrostats/)
    expect(VALIDATION).toContain('Hydrostats 1.0.0 re-exports these HydroErr functions, so it is not executed separately')
  })
})

describe('real agreement and tolerances (claims-03, norms-05, claims-04)', () => {
  it('largest difference below 2e-14 relative; ME and PBIAS within 1.3e-15 absolute', () => {
    let maxRel = 0, maxAbsMePbias = 0
    // ME and PBIAS: values near zero (|ref| < 0.01) come from cancellation, so
    // their agreement is stated in absolute terms; elsewhere relative.
    const take = (id: string, m: number, r: number) => {
      if ((id === 'me' || id === 'pbias') && Math.abs(r) < 0.01) maxAbsMePbias = Math.max(maxAbsMePbias, Math.abs(m - r))
      else if (r !== 0) maxRel = Math.max(maxRel, Math.abs(m - r) / Math.abs(r))
      else expect(m).toBe(0)
    }
    for (const name of CASES) {
      const { o, s } = series(name)
      const he = F.results[name]['HydroErr_2.0.0'], hv = F.results[name]['hydroeval_0.1.0']
      for (const [id, [key, f]] of Object.entries(HYDROERR)) take(id, f(o, s), num(he[key]))
      take('pbias', C.pbias(o, s), num(hv.pbias))
    }
    expect(maxRel).toBeLessThan(2e-14)
    expect(maxAbsMePbias).toBeLessThanOrEqual(1.3e-15)
    expect(VALIDATION).toContain('below 2×10⁻¹⁴ relative, apart from ME and PBIAS')
    expect(VALIDATION).toContain('agree to 1.3×10⁻¹⁵ absolute')
  })
  it('norms-05: the log-error family differs from HydroErr by the stated 5 % to 410 %', () => {
    const rels: number[] = []
    for (const name of CASES) {
      const { o, s } = series(name)
      const he = F.results[name]['HydroErr_2.0.0']
      for (const [key, f] of [['mle', C.mle], ['male', C.male], ['msle', C.msle], ['rmsle', C.rmsle]] as [string, Fn][]) {
        const r = num(he[key]); if (Math.abs(r) > 1e-12) rels.push(Math.abs(f(o, s) - r) / Math.abs(r))
      }
    }
    const lo = Math.round(100 * Math.min(...rels)), hi = Math.round(100 * Math.max(...rels))
    expect([lo, hi]).toEqual([5, 410])
    expect(VALIDATION).toContain(`by ${lo} % to ${hi} % on the fixtures`)
    expect(VALIDATION).toContain('MLE, MALE, MSLE, RMSLE')
    expect(VALIDATION).toContain('log1p')
    expect(readFileSync('src/metrics/classical/catalogue.ts', 'utf8')).not.toMatch(/verified value-for-value/)
  })
  it('claims-04: the KGEnp tie exception states the event_tri numbers', () => {
    const { o, s } = series('event_tri')
    const hv = F.results.event_tri['hydroeval_0.1.0']
    const k = C.kgenp(o, s).value
    const pct = (a: number, b: number) => (100 * Math.abs(a - b) / b).toFixed(1)
    expect(VALIDATION).toContain(`differ by ${pct(k, num(hv.kgenp.kgenp))} % (KGEnp ${k.toFixed(4)} against ${num(hv.kgenp.kgenp).toFixed(4)})`)
    expect(VALIDATION).toContain(`by ${pct(C.c2m(k), num(hv.kgenp_c2m))} % in C2M form`)
    const tiedObs = series('event_tri').o.filter(v => v === 1).length
    expect(VALIDATION).toContain(`${tiedObs} of the 60 observed flows sit at the baseflow`)
  })
})

describe('compute-13 / eff-05 / report-13(b): no bounded C2M forms in the Metrics panel', () => {
  it('the panel has no C2M rows, and the README says C2M is used only in the ranking', () => {
    expect(REGISTRY.some(m => /c2m/i.test(m.id) || /C2M/.test(m.label))).toBe(false)
    const metrics = PARAS.find(p => p.startsWith('**Metrics.**'))!
    expect(metrics).toContain('63-metric panel')
    expect(metrics).not.toMatch(/C2M/)
    expect(README).not.toContain('bounded C2M forms')
    expect(README).toContain('is used only inside this ranking; the Metrics panel shows the efficiencies themselves')
  })
})
