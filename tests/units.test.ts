import { describe, it, expect } from 'vitest'
import { convertSeries, areaToKm2 } from '../src/units/convert'

describe('unit engine (Appendix B)', () => {
  it('volumetric factors are exact', () => {
    expect(convertSeries([1], { from: 'cfs', to: 'm3s' })[0]).toBe(0.0283168)
    expect(convertSeries([1], { from: 'ls', to: 'm3s' })[0]).toBe(0.001)
    expect(convertSeries([1], { from: 'MGD', to: 'm3s' })[0]).toBe(0.0438126)
  })
  it('round-trips preserve full float precision', () => {
    const v = convertSeries(convertSeries([12.345], { from: 'm3s', to: 'acftday' }), { from: 'acftday', to: 'm3s' })[0]
    expect(Math.abs(v - 12.345)).toBeLessThan(1e-12)
  })
  it('depth -> volume uses Q = D*A*1000/dt', () => {
    const q = convertSeries([10], { from: 'mm_step', to: 'm3s', area: { value: 250, unit: 'km2' }, stepMs: 86400_000 })[0]
    expect(q).toBeCloseTo((10 * 250 * 1000) / 86400, 12)
    const q2 = convertSeries([1], { from: 'in_day', to: 'm3s', area: { value: 100, unit: 'km2' }, stepMs: 3600_000 })[0]
    expect(q2).toBeCloseTo((25.4 * 100 * 1000) / 86400, 12)  // per-day rate regardless of step
  })
  it('monthly depth uses the actual days in each month', () => {
    const jan = Date.UTC(2023, 0, 15), feb = Date.UTC(2023, 1, 15)
    const q = convertSeries([31, 28], {
      from: 'mm_step', to: 'm3s', monthly: true, dates: [jan, feb],
      area: { value: 100, unit: 'km2' },
    })
    expect(q[0]).toBeCloseTo((31 * 100 * 1000) / (31 * 86400), 10)
    expect(q[1]).toBeCloseTo((28 * 100 * 1000) / (28 * 86400), 10)
  })
  it('volume -> depth inverts', () => {
    const mm = convertSeries([(10 * 250 * 1000) / 86400], { from: 'm3s', to: 'mm_step', area: { value: 250, unit: 'km2' }, stepMs: 86400_000 })[0]
    expect(mm).toBeCloseTo(10, 12)
  })
  it('area factors are exact', () => {
    expect(areaToKm2(1, 'mi2')).toBe(2.589988)
    expect(areaToKm2(1, 'ha')).toBe(0.01)
    expect(areaToKm2(1, 'acre')).toBe(0.00404686)
  })
  it('guards: dimensionless vs flow refuses; depth without area refuses', () => {
    expect(() => convertSeries([1], { from: 'dimensionless', to: 'm3s' })).toThrow()
    expect(() => convertSeries([1], { from: 'mm_step', to: 'm3s', stepMs: 86400_000 })).toThrow(/area/i)
  })
  it('NaN passes through untouched', () => {
    const out = convertSeries([NaN, 1], { from: 'cfs', to: 'm3s' })
    expect(out[0]).toBeNaN(); expect(out[1]).toBe(0.0283168)
  })
})
