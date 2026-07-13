import { describe, it, expect } from 'vitest'
import { applySubset, doyUTC } from '../src/metrics/subset'

const DAY = 86_400_000;
const day = (iso: string) => Date.parse(iso + 'T00:00:00Z');
const range = (startIso: string, n: number) => Array.from({ length: n }, (_, i) => day(startIso) + i * DAY);
const step = { ms: DAY, label: '1d' };

describe('analysis subsetting (spec §6/§9)', () => {
  it('contiguous window keeps only in-range rows (inclusive)', () => {
    const dates = range('2001-01-01', 100);
    const vals = dates.map((_, i) => i);
    const r = applySubset(dates, [vals], { window: [day('2001-01-11'), day('2001-01-20')], season: null, resample: 'native' }, step);
    expect(r.dates.length).toBe(10);
    expect(r.obs[0]).toBe(10);
    expect(r.obs[9]).toBe(19);
    expect(r.caption).toContain('window 2001-01-11–2001-01-20');
  });

  it('seasonal filter wraps across the new year when startDoy > endDoy', () => {
    const dates = range('2001-01-01', 730); // two years
    const vals = dates.map(() => 1);
    const r = applySubset(dates, [vals], { window: null, season: { startDoy: 335, endDoy: 59 }, resample: 'native' }, step);
    // every kept day is Dec (DOY>=335) or Jan–Feb (DOY<=59)
    for (const ms of r.dates) {
      const d = doyUTC(ms);
      expect(d >= 335 || d <= 59).toBe(true);
    }
    // per non-leap year: Jan+Feb (59) + Dec (31) = 90; two full years = 180
    expect(r.dates.length).toBe(180);
  });

  it('window and season combine', () => {
    const dates = range('2001-01-01', 730);
    const vals = dates.map((_, i) => i);
    const r = applySubset(dates, [vals], {
      window: [day('2001-06-01'), day('2002-06-01')],
      season: { startDoy: 335, endDoy: 59 }, resample: 'native',
    }, step);
    expect(r.dates.every(ms => ms >= day('2001-06-01') && ms <= day('2002-06-01'))).toBe(true);
    expect(r.dates.every(ms => { const d = doyUTC(ms); return d >= 335 || d <= 59; })).toBe(true);
    expect(r.caption).toContain('window');
    expect(r.caption).toContain('season DOY 335–59');
  });

  it('monthly resample = calendar means of finite values, NaN-safe, relabelled 1mo', () => {
    const dates = range('2001-01-01', 62); // Jan (31) + Feb (28) + Mar 1–3
    const vals = dates.map((_, i) => (i < 31 ? 10 : i < 59 ? 20 : NaN));
    vals[3] = NaN; // one gap inside January
    const r = applySubset(dates, [vals], { window: null, season: null, resample: 'monthly' }, step);
    expect(r.dates.length).toBe(3);
    expect(r.obs[0]).toBeCloseTo(10, 12);   // mean of finite Jan values
    expect(r.obs[1]).toBeCloseTo(20, 12);
    expect(Number.isNaN(r.obs[2])).toBe(true); // March bin has no finite values
    expect(r.step.label).toBe('1mo');
    expect(new Date(r.dates[1]).toISOString().slice(0, 10)).toBe('2001-02-01');
  });
});
