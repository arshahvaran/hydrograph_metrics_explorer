/**
 * Plots audit regressions, engine side:
 *  - plots-05: binByYear gives one value per (year, calendar day): the mean of
 *    the finite samples stamped on that day, so a sub-daily flood peak is
 *    kept in the daily mean and a missing last sample no longer blanks the
 *    day. binByDoy pools those daily values across years.
 *  - plots-06: bins use calendar days, so leap years do not shift every date
 *    after February by one bin. Since the repair (plots-06-r1/r2) this is the
 *    365-day calendar of the Season filter (calendarDoy: Mar 1 = 60 in every
 *    year, Feb 29 pooled with Feb 28); see tests/plots-repair.test.ts.
 *  - plots-11: min/max display decimation keeps a break (null) wherever the
 *    record has missing values, even when the gap is shorter than a bucket.
 *  - plots-07 / plots-08: tracesToCsv writes heatmap cells (z) and polar
 *    points (r, theta, marker colour), not index pairs or a bare header.
 */
import { describe, it, expect } from 'vitest'
import { binByDoy, binByYear } from '../src/ui/plotBins'
import { calendarDoy } from '../src/metrics/subset'
import { decimateMinMax } from '../src/ui/decimate'
import { tracesToCsv } from '../src/ui/PlotHost'

const DAY = 86_400_000, HOUR = 3_600_000;

describe('calendar-day bins (plots-06)', () => {
  it('Mar 1 is 60 and Dec 31 is 365 in common and leap years alike (365-day calendar)', () => {
    expect(calendarDoy(Date.UTC(2001, 0, 1))).toBe(1);
    expect(calendarDoy(Date.UTC(2001, 1, 28))).toBe(59);
    expect(calendarDoy(Date.UTC(2004, 1, 29))).toBe(59);
    expect(calendarDoy(Date.UTC(2001, 2, 1))).toBe(60);
    expect(calendarDoy(Date.UTC(2004, 2, 1))).toBe(60);
    expect(calendarDoy(Date.UTC(2001, 11, 31))).toBe(365);
    expect(calendarDoy(Date.UTC(2004, 11, 31))).toBe(365);
  });

  it('daily 2001-2008: each bin holds one calendar date only (Feb 29 with Feb 28)', () => {
    const dates: number[] = [];
    for (let t = Date.UTC(2001, 0, 1); t < Date.UTC(2009, 0, 1); t += DAY) dates.push(t);
    // value = month + day / 100, so a bin that mixes dates holds mixed values
    const y = dates.map(t => new Date(t).getUTCMonth() + 1 + new Date(t).getUTCDate() / 100);
    const b = binByDoy(dates, y);
    const feb = b.get(59)!;                                   // Feb 28, and Feb 29 in 2004 and 2008
    expect(feb.length).toBe(8);
    feb.forEach((v, k) => expect(v).toBeCloseTo(k === 3 || k === 7 ? 2.285 : 2.28, 12));
    expect(b.get(60)).toEqual(Array(8).fill(3 + 1 / 100));    // Mar 1, every year
    expect(b.get(364)).toEqual(Array(8).fill(12 + 30 / 100)); // Dec 30
    expect(b.get(365)).toEqual(Array(8).fill(12 + 31 / 100)); // Dec 31
    expect(b.has(366)).toBe(false);
    const byYear = binByYear(dates, y);
    expect(byYear.get(2001)![59]).toBe(3 + 1 / 100);          // column 60 = Mar 1
    expect(byYear.get(2004)![59]).toBe(3 + 1 / 100);
    expect(byYear.get(2001)![58]).toBe(2 + 28 / 100);
    expect(byYear.get(2004)![58]).toBeCloseTo(2.285, 12);     // mean of Feb 28 and Feb 29
  });
});

describe('daily aggregation of sub-daily records (plots-05)', () => {
  it('hourly: each cell is the mean of the finite samples of that day; nulls are skipped', () => {
    const dates: number[] = [], y: (number | null)[] = [];
    for (let i = 0; i < 72; i++) {
      const h = i % 24, d = Math.floor(i / 24);
      dates.push(Date.UTC(2003, 0, 1) + i * HOUR);
      let v: number | null = 1;
      if (d === 0 && h === 12) v = 50;
      if (d === 1) v = 2 + h / 100;
      if (d === 1 && h === 23) v = null;
      y.push(v);
    }
    const row = binByYear(dates, y).get(2003)!;
    expect(row[0]).toBeCloseTo(73 / 24, 12);
    expect(row[1]).toBeCloseTo(2.11, 12);
    expect(row[2]).toBe(1);
    expect(row[3]).toBeNull();
    const byDoy = binByDoy(dates, y);
    expect(byDoy.get(1)!.length).toBe(1);             // one daily value, not 24 samples
    expect(byDoy.get(1)![0]).toBeCloseTo(73 / 24, 12);
  });

  it('a day with no finite sample stays empty', () => {
    const dates = [0, 1, 2].map(h => Date.UTC(2003, 0, 1, h));
    expect(binByYear(dates, [null, null, null]).get(2003)![0]).toBeNull();
    expect(binByDoy(dates, [null, null, null]).size).toBe(0);
  });
});

describe('display decimation keeps data gaps (plots-11)', () => {
  it('a 5-step gap inside one 8-step bucket leaves a null at the gap', () => {
    const n = 200_000;
    const y: (number | null)[] = Array.from({ length: n }, (_, i) => Math.sin(i / 50));
    for (let i = 100_001; i < 100_006; i++) y[i] = null;
    const x = Array.from({ length: n }, (_, i) => i);
    const d = decimateMinMax(x, y);
    // 8 steps per bucket, 9 once the gap's break and neighbour push the
    // output past the budget and the buckets are widened (plots-11-r1)
    expect(d.factor).toBeGreaterThanOrEqual(8);
    expect(d.factor).toBeLessThanOrEqual(9);
    expect(d.y.length).toBeLessThanOrEqual(50_002);
    const nullsNear = d.x.filter((xx, k) => d.y[k] === null && xx >= 99_990 && xx <= 100_020);
    expect(nullsNear).toEqual([100_001]);             // at the first missing step
    expect(d.x.every((xx, k) => k === 0 || xx > d.x[k - 1])).toBe(true);
    // no null anywhere else: the rest of the record is continuous
    expect(d.y.filter(v => v === null).length).toBe(1);
  });

  it('a gap across a bucket boundary and a single missing step both break the line', () => {
    const n = 10_000;
    const y: (number | null)[] = Array.from({ length: n }, (_, i) => (i % 97) / 10);
    y[3_000] = null;                                  // one missing step
    for (let i = 5_998; i < 6_003; i++) y[i] = null;  // straddles buckets of 10 steps
    const x = Array.from({ length: n }, (_, i) => i);
    const d = decimateMinMax(x, y, 2_000);
    expect(d.factor).toBeGreaterThanOrEqual(10);
    expect(d.factor).toBeLessThanOrEqual(11);
    expect(d.y.length).toBeLessThanOrEqual(2_002);
    const nullAt = d.x.filter((_, k) => d.y[k] === null);
    expect(nullAt).toEqual([3_000, 5_998]);
    // every drawn segment lies between two finite samples with no missing step between them
    const crossesGap = d.x.some((xx, k) => {
      if (k === 0 || d.y[k] === null || d.y[k - 1] === null) return false;
      for (let i = d.x[k - 1]; i <= xx; i++) if (y[i] === null) return true;
      return false;
    });
    expect(crossesGap).toBe(false);
  });

  it('a record without gaps is unchanged by the gap rule', () => {
    const n = 100_000;
    const x = Array.from({ length: n }, (_, i) => i);
    const y = x.map(i => Math.sin(i / 50));
    const d = decimateMinMax(x, y, 1000);
    expect(d.y.every(v => v !== null)).toBe(true);
    expect(d.y.length).toBeLessThanOrEqual(1002);
  });
});

describe('tracesToCsv exports what is plotted (plots-07, plots-08)', () => {
  it('heatmap: one row per non-empty cell with x, y and the cell value z', () => {
    const csv = tracesToCsv([{ type: 'heatmap', name: 'observed', x: [1, 2, 3], y: [2003, 2004], z: [[5, null, 6], [7, 8, null]] }]);
    expect(csv.split('\n')).toEqual(['trace,x,y,z', 'observed,1,2003,5', 'observed,3,2003,6', 'observed,1,2004,7', 'observed,2,2004,8']);
  });

  it('polar: rows carry r, theta and the per-point label and marker colour', () => {
    const csv = tracesToCsv([
      { type: 'scatterpolar', name: 'Observed', r: [0], theta: [0], text: ['Observed'], marker: { color: '#1a1a1a' } },
      { type: 'scatterpolar', r: [0.158, 0.4], theta: [73.5, -20], text: ['Run A', 'Run B'], marker: { color: [0.9, 0.5], colorbar: { title: { text: 'timing r' } } } },
    ]);
    expect(csv.split('\n')).toEqual(['trace,r,theta_deg,timing r', 'Observed,0,0,', 'Run A,0.158,73.5,0.9', 'Run B,0.4,-20,0.5']);
  });

  it('cartesian traces keep the trace,x,y layout; meta.csvName overrides the legend name', () => {
    const csv = tracesToCsv([{ x: [1, 2], y: [3, null], name: 'a' }, { x: [1], y: [9], name: 'band', meta: { csvName: 'obs P25' } }]);
    expect(csv.split('\n')).toEqual(['trace,x,y', 'a,1,3', 'a,2,', 'obs P25,1,9']);
  });
});
