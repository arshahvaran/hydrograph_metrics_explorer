/**
 * Round 12 regressions, engine side:
 *  - DOY climatology / annual heatmap / spaghetti binning must use the subset
 *    frame's own dates. The old code indexed the full-record dates with
 *    subset-frame row numbers, so any active window, season, or resample
 *    binned every value onto the wrong day and year (a window starting
 *    2001-07-01 put its first value on DOY 1). Pinned here against the real
 *    applySubset plus the extracted binByDoy/binByYear helpers with
 *    hand-computed (doy, year, value) expectations.
 *  - fmtStamp keeps the time part for sub-daily steps and the date-only form
 *    for daily and coarser steps.
 *  - fmtNum never renders a minus sign on a value that displays as zero.
 */
import { describe, it, expect } from 'vitest'
import { applySubset, doyUTC } from '../src/metrics/subset'
import { binByDoy, binByYear } from '../src/ui/plotBins'
import { fmtNum, fmtStamp } from '../src/ui/format'

const DAY = 86_400_000;
const STEP = { ms: DAY, label: '1d' };
// Two non-leap years, one sample per day; each value IS its own day of year,
// so a correctly binned bucket holds only values equal to its key.
const start = Date.UTC(2001, 0, 1);
const N = 730;
const dates = Array.from({ length: N }, (_, i) => start + i * DAY);
const obs = Float64Array.from(dates, ms => doyUTC(ms));
const clean = (v: ArrayLike<number>) => Array.from(v, x => (isFinite(x as number) ? (x as number) : null));

describe('DOY/heatmap/spaghetti binning follows the subset frame (round 12)', () => {
  it('mid-year window: every value bins to its true DOY, both years merge per day', () => {
    const frame = applySubset(dates, [obs], {
      window: [Date.UTC(2001, 6, 1), dates[N - 1]] as [number, number], season: null, resample: 'native',
    }, STEP);
    expect(doyUTC(frame.dates[0])).toBe(182);             // 2001-07-01
    expect(frame.obs[0]).toBe(182);
    const byDoy = binByDoy(frame.dates, clean(frame.obs));
    for (const [doy, vals] of byDoy) for (const v of vals) expect(v).toBe(doy);
    expect(byDoy.get(182)).toEqual([182, 182]);           // Jul 1 of 2001 and 2002
    expect(byDoy.get(181)).toEqual([181]);                // Jun 30 only from 2002
    expect(byDoy.get(1)).toEqual([1]);                    // Jan 1 only from 2002
    expect(byDoy.size).toBe(365);                         // no DOY 366 in non-leap years
  })

  it('wrapping season DOY 305-59: year rows hold exactly the in-season days', () => {
    const frame = applySubset(dates, [obs], {
      window: null, season: { startDoy: 305, endDoy: 59 }, resample: 'native',
    }, STEP);
    const byYear = binByYear(frame.dates, clean(frame.obs));
    expect([...byYear.keys()].sort()).toEqual([2001, 2002]);
    for (const y of [2001, 2002]) {
      const row = byYear.get(y)!;
      expect(row[0]).toBe(1);                             // Jan 1 kept
      expect(row[58]).toBe(59);                           // Feb 28 = DOY 59 kept
      expect(row[59]).toBeNull();                         // Mar 1 = DOY 60 filtered
      expect(row[303]).toBeNull();                        // Oct 31 = DOY 304 filtered
      expect(row[304]).toBe(305);                         // Nov 1 kept
      expect(row[364]).toBe(365);                         // Dec 31 kept
      expect(row[365]).toBeNull();                        // no day 366
      expect(row.filter(v => v !== null).length).toBe(120); // 59 + 61 in-season days
    }
    const byDoy = binByDoy(frame.dates, clean(frame.obs));
    expect([...byDoy.keys()].sort((a, b) => a - b)).toEqual([
      ...Array.from({ length: 59 }, (_, i) => i + 1),
      ...Array.from({ length: 61 }, (_, i) => i + 305),
    ]);
    for (const [doy, vals] of byDoy) expect(vals).toEqual([doy, doy]);
  })

  it('monthly resample: bins land on month-start DOYs with the hand-computed means', () => {
    const frame = applySubset(dates, [obs], { window: null, season: null, resample: 'monthly' }, STEP);
    expect(frame.dates.length).toBe(24);
    const monthStartDoys = [1, 32, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
    // mean of the DOY values inside month m = (first DOY + last DOY) / 2
    const monthMeans = [16, 45.5, 75, 105.5, 136, 166.5, 197, 228, 258.5, 289, 319.5, 350];
    const byYear = binByYear(frame.dates, clean(frame.obs));
    expect([...byYear.keys()].sort()).toEqual([2001, 2002]);
    for (const y of [2001, 2002]) {
      const row = byYear.get(y)!;
      expect(row.filter(v => v !== null).length).toBe(12);
      monthStartDoys.forEach((doy, m) => expect(row[doy - 1]).toBeCloseTo(monthMeans[m], 12));
    }
    const byDoy = binByDoy(frame.dates, clean(frame.obs));
    expect([...byDoy.keys()].sort((a, b) => a - b)).toEqual(monthStartDoys);
    monthStartDoys.forEach((doy, m) => expect(byDoy.get(doy)).toEqual([monthMeans[m], monthMeans[m]]));
  })

  it('window + wrapping season + monthly resample combined: six bins, exact triplets', () => {
    const frame = applySubset(dates, [obs], {
      window: [Date.UTC(2001, 6, 1), dates[N - 1]] as [number, number],
      season: { startDoy: 305, endDoy: 59 },
      resample: 'monthly',
    }, STEP);
    expect(frame.dates.length).toBe(6);                   // Nov01 Dec01 Jan02 Feb02 Nov02 Dec02
    const byYear = binByYear(frame.dates, clean(frame.obs));
    expect(byYear.get(2001)![304]).toBeCloseTo(319.5, 12); // Nov 2001 at DOY 305
    expect(byYear.get(2001)![334]).toBeCloseTo(350, 12);   // Dec 2001 at DOY 335
    expect(byYear.get(2002)![0]).toBeCloseTo(16, 12);      // Jan 2002 at DOY 1
    expect(byYear.get(2002)![31]).toBeCloseTo(45.5, 12);   // Feb 2002 at DOY 32
    expect(byYear.get(2002)![304]).toBeCloseTo(319.5, 12);
    expect(byYear.get(2002)![334]).toBeCloseTo(350, 12);
    expect(byYear.get(2001)!.filter(v => v !== null).length).toBe(2);
    expect(byYear.get(2002)!.filter(v => v !== null).length).toBe(4);
  })
})

describe('fmtStamp step-aware time stamps (round 12)', () => {
  const t = Date.UTC(2003, 0, 2, 7, 30, 15);
  it('daily and coarser steps keep the date-only form', () => {
    expect(fmtStamp(t, DAY)).toBe('2003-01-02');
    expect(fmtStamp(t, 30 * DAY)).toBe('2003-01-02');
  })
  it('sub-daily steps keep the time part', () => {
    expect(fmtStamp(t, 3_600_000)).toBe('2003-01-02 07:30');   // 1h
    expect(fmtStamp(t, 6 * 3_600_000)).toBe('2003-01-02 07:30'); // 6h
    expect(fmtStamp(t, 60_000)).toBe('2003-01-02 07:30');      // 1min
    expect(fmtStamp(t, 1_000)).toBe('2003-01-02 07:30:15');    // sub-minute keeps seconds
  })
  it('hourly stamps within one day are all distinct', () => {
    const stamps = Array.from({ length: 24 }, (_, h) => fmtStamp(Date.UTC(2003, 0, 1, h), 3_600_000));
    expect(new Set(stamps).size).toBe(24);
  })
})

describe('fmtNum never shows a signed zero (round 12)', () => {
  it('float round-off below display precision renders unsigned', () => {
    expect(fmtNum(-1e-16, 2)).toBe('0.00');
    expect(fmtNum(-1e-16, 3)).toBe('0.000');
  })
  it('a genuine small negative that rounds to zero drops the sign; past half a digit it keeps it', () => {
    expect(fmtNum(-0.004, 2)).toBe('0.00');
    expect(fmtNum(-0.006, 2)).toBe('-0.01');
  })
  it('zero digits and true zero are unaffected; genuine negatives keep the sign', () => {
    expect(fmtNum(-0.4, 0)).toBe('0');
    expect(fmtNum(0, 2)).toBe('0.00');
    expect(fmtNum(-0.25, 2)).toBe('-0.25');
    expect(fmtNum(NaN, 2)).toBe('n/a');
  })
})
