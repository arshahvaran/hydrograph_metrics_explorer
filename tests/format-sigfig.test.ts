/**
 * Audit findings norms-04 and report-03: fixed-decimal display printed a
 * non-zero error (MSE 3.8e-4, MdSE 6.9e-5, RMSE 0.0025) as "0.000" or "0.003",
 * the optimum or one significant figure. fmtNum now keeps fixed decimals from
 * 0.1 upward and shows significant figures below that, in exponent form below
 * 1e-3, so a non-zero value never reads as zero.
 */
import { describe, it, expect } from 'vitest'
import fixture from './fixtures/reference_vectors.json'
import { computeAll } from '../src/metrics/registry'
import { fmtNum } from '../src/ui/format'
import { defaultTimingConfig } from '../src/types'

const F = fixture as any
const ser = (name: string) => {
  const p = (a: string[]) => a.map(v => (v === 'NaN' ? NaN : Number(v)))
  return { o: p(F.series[name].obs), s: p(F.series[name].sim) }
}
const T = defaultTimingConfig(86_400_000, 730)
const shownAsZero = (s: string) => /^-?0(\.0*)?$/.test(s)
/** The display parses back to the value within the rounding of its digits. */
const faithful = (v: number, s: string, relTol: number) =>
  expect(Math.abs(Number(s) - v)).toBeLessThanOrEqual(relTol * Math.abs(v))

describe('norms-04: a non-zero MSE/MdSE never displays as the optimum 0.000', () => {
  it('synth730_noise in m3/s instead of L/s', () => {
    const { o, s } = ser('synth730_noise')
    const v = computeAll(o.map(x => x / 1000), s.map(x => x / 1000), { nanPolicy: 'pairwise', transform: 'none', timing: T, heavy: false }).values
    for (const id of ['mse', 'mdse', 'rmse', 'mae', 'mdae']) {
      expect(v[id]).toBeGreaterThan(0)
      const txt = fmtNum(v[id], 3)
      expect(shownAsZero(txt)).toBe(false)
      faithful(v[id], txt, 5e-3)                 // three significant figures
    }
    expect(fmtNum(v.mse, 3)).toMatch(/^\d\.\d\de-\d+$/)
  })
  it('small magnitudes: significant figures below 0.1, exponent below 1e-3', () => {
    expect(fmtNum(3.82e-4, 3)).toBe('3.82e-4')
    expect(fmtNum(6.94e-5, 3)).toBe('6.94e-5')
    expect(fmtNum(0.0195, 3)).toBe('0.0195')
    expect(fmtNum(0.00254, 3)).toBe('0.00254')
    expect(fmtNum(-0.0123, 3)).toBe('-0.0123')
    expect(fmtNum(0.004, 2)).toBe('0.0040')
    expect(fmtNum(-0.0004, 2)).toBe('-4.0e-4')
    expect(fmtNum(0.04, 1)).toBe('0.040')
  })
  it('ordinary magnitudes and exact zero keep fixed decimals', () => {
    expect(fmtNum(0, 3)).toBe('0.000')
    expect(fmtNum(-0, 3)).toBe('0.000')
    expect(fmtNum(0.915, 3)).toBe('0.915')
    expect(fmtNum(0.1, 3)).toBe('0.100')
    expect(fmtNum(12.3456, 2)).toBe('12.35')
    expect(fmtNum(-0.25, 2)).toBe('-0.25')
    expect(fmtNum(3, 0)).toBe('3')
    expect(fmtNum(NaN, 3)).toBe('n/a')
  })
})

describe('report-03: ~1 m3/s river, errors of a few 1e-4', () => {
  it('MSE and MdSE of two runs show distinct non-zero values; RMSE keeps three significant figures', () => {
    const n = 730
    const q = Array.from({ length: n }, (_, i) => 0.8 + 0.3 * Math.sin((2 * Math.PI * i) / 365) + 1.5 * Math.exp(-(((i % 40) - 15) ** 2) / 10))
    const a = q.map((v, i) => v * 1.012 + 0.002 * Math.sin(i)), b = q.map(v => v * 0.985 - 0.004)
    const ctx = { nanPolicy: 'pairwise' as const, transform: 'none' as const, timing: T, heavy: false }
    const va = computeAll(q, a, ctx).values, vb = computeAll(q, b, ctx).values
    for (const id of ['mse', 'mdse']) {
      const ta = fmtNum(va[id], 3), tb = fmtNum(vb[id], 3)
      expect(shownAsZero(ta)).toBe(false)
      expect(shownAsZero(tb)).toBe(false)
      expect(ta).not.toBe(tb)
    }
    faithful(va.rmse, fmtNum(va.rmse, 3), 5e-3)
  })
})
