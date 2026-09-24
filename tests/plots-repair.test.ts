/**
 * Plots repair after the adversarial review of the plots fixes, engine side.
 *
 *  - plots-11-r1: min/max display decimation must draw every point it keeps.
 *    A kept point whose neighbours in the output are both nulls is drawn as
 *    nothing by Plotly 'lines' (plotly.js 2.35: a moveto without a lineto),
 *    so a peak kept between two nulls vanished. Every kept point now has a
 *    neighbour in the output that is its true neighbour at full resolution
 *    (no missing step between them), the output stays within the point
 *    budget, and a million points stay fast.
 *  - plots-06-r1 / plots-06-r2: the day-of-year bins use the 365-day calendar
 *    of the Season filter (src/metrics/subset.ts calendarDoy): 1 Mar = 60 in
 *    every year and 29 Feb pooled with 28 Feb. The 366-slot calendar left
 *    slot 60 empty in common years (a false gap in every common-year
 *    spaghetti line, an empty heatmap column, a one-year median on 29 Feb)
 *    and numbered days one higher than the Season fields after February.
 */
import { describe, it, expect } from 'vitest'
import { decimateMinMax } from '../src/ui/decimate'
import { binByDoy, binByYear } from '../src/ui/plotBins'
import { calendarDoy } from '../src/metrics/subset'
import { mulberry32 } from '../src/metrics/support/stats'

const DAY = 86_400_000, HOUR = 3_600_000;
const isGap = (v: number | null | undefined) => v === null || v === undefined || !Number.isFinite(v);

/** Index of every output point in the input (x is the step index here). */
function drawCheck(y: (number | null)[], d: { x: number[]; y: (number | null)[] }) {
  const missingBetween = (a: number, b: number) => { for (let i = a + 1; i < b; i++) if (isGap(y[i])) return true; return false; };
  const hasFullResNeighbour = (i: number) => (i > 0 && !isGap(y[i - 1])) || (i < y.length - 1 && !isGap(y[i + 1]));
  let invisible = 0, invisibleWithNeighbour = 0, crossing = 0, kept = 0;
  for (let k = 0; k < d.x.length; k++) {
    if (d.y[k] === null) continue;
    kept++;
    const i = d.x[k];
    const left = k > 0 && d.y[k - 1] !== null && !missingBetween(d.x[k - 1], i);
    const right = k < d.x.length - 1 && d.y[k + 1] !== null && !missingBetween(i, d.x[k + 1]);
    if (!left && !right) { invisible++; if (hasFullResNeighbour(i)) invisibleWithNeighbour++; }
    if (k > 0 && d.y[k - 1] !== null && missingBetween(d.x[k - 1], i)) crossing++;
  }
  return { invisible, invisibleWithNeighbour, crossing, kept };
}

describe('decimation draws every point it keeps (plots-11-r1)', () => {
  it("the reviewer's case: a 500 m3/s peak between two single missing steps stays drawn", () => {
    const n = 200_000;
    const y: (number | null)[] = Array.from({ length: n }, (_, i) => 10 + 0.001 * (i % 8));
    y[100_004] = 500; y[100_002] = null; y[100_006] = null;
    const x = Array.from({ length: n }, (_, i) => i);
    const d = decimateMinMax(x, y);
    const k = d.x.indexOf(100_004);
    expect(k).toBeGreaterThan(0);
    expect(d.y[k]).toBe(500);
    // at least one output neighbour is a true full-resolution neighbour
    const drawnLeft = d.y[k - 1] !== null && d.x[k - 1] === 100_003;
    const drawnRight = d.y[k + 1] !== null && d.x[k + 1] === 100_005;
    expect(drawnLeft || drawnRight).toBe(true);
    // both gaps still break the line
    expect(d.x.filter((_, j) => d.y[j] === null)).toEqual([100_002, 100_006]);
    const c = drawCheck(y, d);
    expect(c.invisibleWithNeighbour).toBe(0);
    expect(c.crossing).toBe(0);
    expect(Math.max(...(d.y.filter(v => v !== null) as number[]))).toBe(500);
  });

  for (const frac of [0.05, 0.10]) {
    it(`1,000,000 points with ${frac * 100} % scattered missing steps: every kept point is drawn, within budget, fast`, () => {
      const n = 1_000_000, rnd = mulberry32(frac === 0.05 ? 7 : 11);
      const y: (number | null)[] = new Array(n);
      for (let i = 0; i < n; i++) y[i] = rnd() < frac ? null : 5 + 3 * Math.sin(i / 700) + rnd();
      y[654_321] = 99; y[654_320] = null; y[654_322] = 6;   // a peak right after a gap
      const x = Array.from({ length: n }, (_, i) => i);
      const t0 = performance.now();
      const d = decimateMinMax(x, y);
      const ms = performance.now() - t0;
      expect(d.y.length).toBeLessThanOrEqual(50_000 + 2);
      expect(d.x.every((v, k) => k === 0 || v > d.x[k - 1])).toBe(true);
      const c = drawCheck(y, d);
      expect(c.invisibleWithNeighbour).toBe(0);
      // only the first or last step may be a lone point (as at full resolution)
      expect(c.invisible).toBeLessThanOrEqual(2);
      expect(c.crossing).toBe(0);
      expect(c.kept).toBeGreaterThan(15_000);
      expect(d.x).toContain(654_321);
      expect(d.y[d.x.indexOf(654_321)]).toBe(99);
      expect(d.factor).toBeGreaterThan(20);
      expect(ms).toBeLessThan(1_500);
    }, 30_000);
  }

  it('a record without gaps gives the same points as plain bucket min/max', () => {
    const n = 100_000, maxPoints = 1000;
    const x = Array.from({ length: n }, (_, i) => i);
    const y = x.map(i => Math.sin(i / 50) + 0.3 * Math.sin(i / 7));
    const d = decimateMinMax(x, y, maxPoints);
    const ref: number[] = [0];
    const buckets = maxPoints / 2, size = n / buckets;
    for (let b = 0; b < buckets; b++) {
      const lo = Math.floor(b * size), hi = Math.min(n, Math.floor((b + 1) * size));
      let iMin = lo, iMax = lo;
      for (let i = lo; i < hi; i++) { if (y[i] < y[iMin]) iMin = i; if (y[i] > y[iMax]) iMax = i; }
      const a = Math.min(iMin, iMax), z = Math.max(iMin, iMax);
      if (a > 0 && a < n - 1) ref.push(a);
      if (z !== a && z > 0 && z < n - 1) ref.push(z);
    }
    ref.push(n - 1);
    expect(d.x).toEqual(ref);
    expect(d.factor).toBe(200);
  });

  it('a lone valid step between two missing steps is not chosen as an extreme (it draws nothing at full resolution either)', () => {
    const n = 1000;
    const y: (number | null)[] = Array.from({ length: n }, () => 1);
    y[500] = 50; y[499] = null; y[501] = null;
    const x = Array.from({ length: n }, (_, i) => i);
    const d = decimateMinMax(x, y, 100);
    expect(d.x).not.toContain(500);
    expect(drawCheck(y, d).invisible).toBe(0);
  });
});

describe('day-of-year bins on the 365-day Season calendar (plots-06-r1, plots-06-r2)', () => {
  const days = (y0: number, y1: number) => {
    const out: number[] = [];
    for (let t = Date.UTC(y0, 0, 1); t < Date.UTC(y1 + 1, 0, 1); t += DAY) out.push(t);
    return out;
  };

  it('every date lands in the bin calendarDoy gives it (1 Mar = 60, 29 Feb with 28 Feb, 31 Dec = 365)', () => {
    const dates = days(2000, 2004);
    const byYear = binByYear(dates, dates.map(t => calendarDoy(t)));
    for (const [, row] of byYear) {
      expect(row.length).toBe(365);
      row.forEach((v, k) => expect(v).toBe(k + 1));   // cell k holds only dates with calendarDoy = k + 1
    }
    expect(calendarDoy(Date.UTC(2001, 2, 1))).toBe(60);
    expect(calendarDoy(Date.UTC(2004, 2, 1))).toBe(60);
    expect(calendarDoy(Date.UTC(2004, 1, 29))).toBe(59);
  });

  it('complete daily 2001-2004: no empty cell in any year, day 60 holds 1 March of all four years', () => {
    const dates = days(2001, 2004);
    const y = dates.map(t => {
      const d = new Date(t);
      return d.getUTCFullYear() - 2000 + (d.getUTCMonth() === 1 && d.getUTCDate() === 29 ? 0.5 : 0);
    });
    const byYear = binByYear(dates, y);
    for (const yr of [2001, 2002, 2003, 2004]) {
      const row = byYear.get(yr)!;
      expect(row.length).toBe(365);
      expect(row.every(v => v !== null)).toBe(true);    // no false gap on day 60
    }
    // 29 Feb 2004 (4.5) is pooled with 28 Feb 2004 (4) in the one cell of day 59
    expect(byYear.get(2004)![58]).toBeCloseTo(4.25, 12);
    expect(byYear.get(2004)![59]).toBe(4);              // 1 March 2004
    const byDoy = binByDoy(dates, y);
    expect(byDoy.size).toBe(365);
    expect(byDoy.get(60)).toEqual([1, 2, 3, 4]);        // 1 March, every year
    expect(byDoy.get(59)).toEqual([1, 2, 3, 4.25]);     // one value per year
    expect(byDoy.has(366)).toBe(false);
  });

  it('hourly: 28 and 29 February 2004 form one daily-mean cell', () => {
    const dates: number[] = [], y: number[] = [];
    for (let t = Date.UTC(2004, 1, 28); t < Date.UTC(2004, 2, 2); t += HOUR) {
      dates.push(t);
      y.push(new Date(t).getUTCDate() === 29 ? 3 : 1);
    }
    const row = binByYear(dates, y).get(2004)!;
    expect(row[58]).toBeCloseTo(2, 12);                 // mean of 24 x 1 and 24 x 3
    expect(row[59]).toBe(1);                            // 1 March
    expect(row.filter(v => v !== null).length).toBe(2);
  });
});
