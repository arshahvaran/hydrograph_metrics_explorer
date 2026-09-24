/**
 * FDC signatures follow the published equations (audit findings fdc-01,
 * fdc-02, fdc-04, samples-e2e-07).
 *  - FLV and FMS take plain ln Q (Yilmaz et al., 2008), with no epsilon shift:
 *    a uniform scaling S = c*O scores exactly 0, and the values equal an
 *    independent NumPy implementation of the published equations.
 *  - A flow <= 0 inside a log makes the signature n/a, and the panel says why.
 *  - FMM is the unit-free log ratio 100*ln(S_med/O_med): the same value and
 *    sign in every flow unit.
 *  - The FLV tooltip states the sign convention the formula produces.
 *  - The displayed equations are the ones the code evaluates.
 * Oracle values: scripts equivalent to the audit's scratch/fdc/ref.py
 * (fhv_y/flv_y/fms_y), run on the bundled samples with NumPy float64.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { applyNanPolicy } from '../src/ingest/missing'
import * as C from '../src/metrics/classical/catalogue'
import { byId, computeAll } from '../src/metrics/registry'
import { convertSeries } from '../src/units/convert'
import { defaultTimingConfig } from '../src/types'

function loadCsv(path: string) {
  const lines = readFileSync(path, 'utf8').trim().split(/\r?\n/)
  const header = lines[0].split(',')
  const cols = header.map(() => [] as number[])
  for (const ln of lines.slice(1)) {
    const c = ln.split(',')
    for (let j = 1; j < header.length; j++) cols[j].push(c[j] === undefined || c[j] === '' ? NaN : Number(c[j]))
  }
  return { cols, dates: lines.slice(1).map(l => Date.parse(l.split(',')[0] + 'T00:00:00Z')) }
}
const rel = (a: number, b: number, tol = 1e-9) => {
  expect(Number.isFinite(a)).toBe(true)
  expect(Math.abs(a - b)).toBeLessThanOrEqual(tol * Math.max(1, Math.abs(b)))
}
const hy = loadCsv('public/samples/sample_hymod_raven.csv')
const hyAll = applyNanPolicy(hy.cols[1], hy.cols[2], 'pairwise')          // 31 simulated zeros
const posIdx = Array.from(hyAll.obs.keys()).filter(i => hyAll.obs[i] > 0 && hyAll.sim[i] > 0)
const hyPos = { o: posIdx.map(i => hyAll.obs[i]), s: posIdx.map(i => hyAll.sim[i]) }
const warm = applyNanPolicy(hy.cols[1].slice(365), hy.cols[2].slice(365), 'pairwise')
const syn = loadCsv('public/samples/sample_synthetic.csv')
const T = defaultTimingConfig(86_400_000, 2190)

describe('fdc-01: FLV and FMS use plain ln Q, as published (no epsilon shift)', () => {
  it('a uniform scaling S = c*O scores exactly 0 for FLV and FMS', () => {
    const o = Array.from(hyAll.obs)
    for (const c of [0.5, 0.8, 1.25, 2]) {
      const s = o.map(v => c * v)
      expect(Math.abs(C.flv(o, s))).toBeLessThan(1e-9)
      expect(Math.abs(C.fms(o, s))).toBeLessThan(1e-9)
    }
  })
  it('FLV/FMS equal an independent NumPy implementation of Yilmaz et al. (2008)', () => {
    expect(hyPos.o.length).toBe(2037)
    rel(C.flv(hyPos.o, hyPos.s), -809.9974765600043)
    rel(C.fms(hyPos.o, hyPos.s), -16.36331890534901)
    rel(C.flv(warm.obs, warm.sim), -41.97994784484775)
    rel(C.fms(warm.obs, warm.sim), -24.95104579955079)
    rel(C.flv(syn.cols[1], syn.cols[3]), 40.63413945897086)
    rel(C.fms(syn.cols[1], syn.cols[3]), -20.322677028806115)
    rel(C.fms(hyAll.obs, hyAll.sim), -15.363864989543577)
    rel(C.fhv(hyAll.obs, hyAll.sim), -31.928415237656807)
  })
  it('zero flows in the low segment leave FLV n/a, and the panel note says why', () => {
    expect(C.flv(hyAll.obs, hyAll.sim)).toBeNaN()
    const out = computeAll(hy.cols[1], hy.cols[2], { nanPolicy: 'pairwise', transform: 'none', timing: T, heavy: false })
    expect(out.values.flv).toBeNaN()
    expect(Number.isFinite(out.values.fms)).toBe(true)
    const note = out.notes.find(n => n.includes('%BiasFLV'))
    expect(note).toBeDefined()
    expect(note).toMatch(/31 simulated/)
    expect(note).not.toMatch(/FMS|FMM/)
  })
  it('an intermittent record: FLV, FMS and FMM n/a once the logged flows reach 0', () => {
    const o = Array.from({ length: 100 }, (_, i) => (i < 75 ? 0 : i - 74))   // 75 % zero flow
    const s = o.map(v => 0.8 * v)
    expect(C.flv(o, s)).toBeNaN()
    expect(C.fms(o, s)).toBeNaN()
    expect(C.fmm(o, s)).toBeNaN()
    const note = C.fdcLogNote(o, s)
    expect(note).toMatch(/%BiasFLV/)
    expect(note).toMatch(/%BiasFMS/)
    expect(note).toMatch(/%BiasFMM/)
    expect(C.fdcLogNote(hyPos.o, hyPos.s)).toBeNull()
  })
})

describe('fdc-02: %BiasFMM is unit-free and keeps its sign in every unit', () => {
  it('same value in m3/s, L/s, ft3/s, ML/day and mm/interval (app unit engine)', () => {
    const area = { value: 1944, unit: 'km2' as const }
    const vals: number[] = []
    for (const to of ['m3s', 'ls', 'cfs', 'MLday', 'mm_step'] as const) {
      const ctx = { from: 'm3s' as const, to, area, stepMs: 86_400_000, monthly: false, dates: hy.dates }
      const p = applyNanPolicy(convertSeries(hy.cols[1], ctx), convertSeries(hy.cols[2], ctx), 'pairwise')
      vals.push(C.fmm(p.obs, p.sim))
    }
    for (const v of vals) rel(v, 100 * Math.log(24.65745 / 16.3), 1e-9)   // simulated median above observed: positive
  })
  it('a halved median gives a negative FMM even when the observed median is below 1', () => {
    const o = Array.from({ length: 50 }, (_, i) => 0.2 + 0.03 * i)          // median 0.935
    const s = o.map(v => 0.5 * v)
    rel(C.fmm(o, s), 100 * Math.log(0.5), 1e-12)
    rel(C.fmm(o.map(v => v * 1000), s.map(v => v * 1000)), 100 * Math.log(0.5), 1e-12)
  })
})

describe('fdc-04: FLV sign convention in the tooltip matches the formula', () => {
  const n = 1000
  const ob = Array.from({ length: n }, (_, i) => 1 + 99 * (i / (n - 1)) ** 3)
  const p10 = [...ob].sort((a, b) => a - b)[100]
  it('lowest flows too low -> negative; too high -> positive (Yilmaz sign)', () => {
    rel(C.flv(ob, ob.map(v => (v < p10 ? 0.5 * v : v))), -109.78413270860514)
    rel(C.flv(ob, ob.map(v => (v < p10 ? p10 : v))), 16.869806190553426)
  })
  it('the tooltip says positive = too high/flat, negative = too low/steep', () => {
    const b = byId.get('flv')!.blurb
    expect(b).not.toMatch(/positive = simulated low flows too low/i)
    expect(b).toMatch(/positive[^.;]*too high/i)
    expect(b).toMatch(/negative[^.;]*too low/i)
  })
})

describe('samples-e2e-07: the displayed FDC equations are the ones evaluated', () => {
  it('no epsilon in the code, so none in the equations; FMM shows the log ratio', () => {
    for (const id of ['flv', 'fms', 'fmm']) expect(byId.get(id)!.equation).not.toMatch(/varepsilon/)
    expect(byId.get('fmm')!.equation).toMatch(/\\ln\\big\(\\tilde\{S\}\/\\tilde\{O\}\\big\)/)
    // synthetic sample, run_biased: the displayed FMS/FLV equations evaluated in NumPy
    rel(C.fms(syn.cols[1], syn.cols[3]), -20.322677028806115)
    rel(C.fmm(syn.cols[1], syn.cols[3]), 21.374364922043195)
  })
})
