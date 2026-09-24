/**
 * Audit findings norms-03 (MAAPE at zero flows) and corr-02 (R² and wR²
 * tooltips on an inverted hydrograph).
 */
import { describe, it, expect } from 'vitest'
import * as C from '../src/metrics/classical/catalogue'
import { byId, computeAll } from '../src/metrics/registry'
import { defaultTimingConfig } from '../src/types'

const T = defaultTimingConfig(86_400_000, 400)
const run = (o: number[], s: number[]) => computeAll(o, s, { nanPolicy: 'pairwise', transform: 'none', timing: T, heavy: false }).values

describe('norms-03: MAAPE is defined at zero flows, as its tooltip says', () => {
  it('a correctly simulated zero-flow step (O = S = 0) counts as zero error, as in sMAPE', () => {
    const o = [0, 2, 4, 3, 0, 1], s = [0, 2.2, 3.5, 3.3, 0, 1.1]
    const expected = (3 * Math.atan(0.1) + Math.atan(0.125)) / 6            // 0.0706
    expect(C.maape(o, s)).toBeCloseTo(expected, 14)
    expect(run(o, s).maape).toBeCloseTo(expected, 14)
    expect(run(o, s).smape).toBeCloseTo(6.984126984126985, 10)
  })
  it('O = 0 with S != 0 scores pi/2; the value stays in [0, pi/2]', () => {
    expect(C.maape([0, 1], [1, 1])).toBeCloseTo(Math.PI / 4, 14)
    expect(C.maape([0, 0], [3, 0.1])).toBeCloseTo(Math.PI / 2, 14)
  })
  it('an ephemeral record with many O = S = 0 days is finite', () => {
    let seed = 7
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    const o = Array.from({ length: 400 }, () => (rnd() < 0.4 ? 0 : 5 * rnd()))
    const s = o.map(v => (v === 0 ? 0 : v * (0.8 + 0.4 * rnd())))
    expect(o.filter(v => v === 0).length).toBeGreaterThan(100)
    const v = C.maape(o, s)
    expect(Number.isFinite(v)).toBe(true)
    expect(v).toBeGreaterThan(0)
    expect(v).toBeLessThan(Math.PI / 2)
  })
  it('the tooltip states the zero-flow convention', () => {
    const b = byId.get('maape')!.blurb
    expect(b).toMatch(/O = S = 0/)
    expect(b).toMatch(/HydroErr returns NaN/)
  })
})

describe('corr-02: R² and wR² ignore the sign of the relation, and the tooltips say so', () => {
  const O = Array.from({ length: 60 }, (_, t) => 10 + 8 * Math.sin((2 * Math.PI * t) / 30))
  const S = O.map(v => 20 - v)                                               // mirror about the mean
  it('an inverted hydrograph scores the optimum 1 for R² and wR²', () => {
    const v = run(O, S)
    expect(v.r).toBeCloseTo(-1, 12)
    expect(v.r2).toBeCloseTo(1, 12)
    expect(v.wr2).toBeCloseTo(1, 12)
    expect(v.nse).toBeCloseTo(-3, 10)
  })
  it('the wR² tooltip says it penalises |b| != 1 and ignores the sign', () => {
    const b = byId.get('wr2')!.blurb
    expect(b).not.toMatch(/penalised by regression slope ≠ 1/)
    expect(b).toMatch(/\|b\| ≠ 1/)
    expect(b).toMatch(/ignores the sign/)
    expect(b).toMatch(/inverted hydrograph/)
  })
  it('the R² tooltip says squaring drops the sign of r', () => {
    const b = byId.get('r2')!.blurb
    expect(b).toMatch(/drops the sign/)
    expect(b).toMatch(/r = −1/)
  })
})
