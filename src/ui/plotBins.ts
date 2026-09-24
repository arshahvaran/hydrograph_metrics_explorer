// Day-of-year and calendar-year binning for the DOY climatology, annual
// heatmap, and spaghetti plots. Pure and exported so tests can pin the
// binning directly against applySubset output. The dates array MUST be the
// same frame the values came from (the displayed subset); binning subset
// values against the full-record dates once shifted every point as soon as a
// window, season, or resample was active (v1.11 regression).
//
// Bins are days of the 365-day calendar of the Season filter (calendarDoy in
// src/metrics/subset.ts, the same function): Jan 1 = 1, Mar 1 = 60 and
// Dec 31 = 365 in every year, and Feb 29 is pooled with Feb 28 (day 59).
// The ordinal day of year put every leap-year date after February one bin
// later than the same date in other years (and split each monthly-resampled
// month into two medians). A 366-slot calendar (Mar 1 = 61) then left day 60
// empty in three years of four (a false gap in every common-year spaghetti
// line, an empty heatmap column, a one-year median on Feb 29) and numbered
// days one higher than the Season fields after February.
// Each (year, day) cell holds ONE value: the mean of the finite samples
// stamped on that day (on Feb 28 and Feb 29 together in a leap year), so
// sub-daily records are shown as daily means (the last sample of the day
// once stood for the whole day, and a missing last sample blanked it).

import { calendarDoy } from '../metrics/subset'

/** Days in the plotted year (the 365-day calendar of calendarDoy). */
export const DOY_SLOTS = 365;

/** First day of each month on that calendar (1 Jan = 1, 1 Feb = 32, 1 Mar = 60, ...). */
export const MONTH_START_DOYS: number[] = Array.from({ length: 12 }, (_, m) => calendarDoy(Date.UTC(2001, m, 1)));

/** True when the frame has more than one sample per calendar day. */
export function isSubDaily(stepMs: number): boolean {
  return stepMs > 0 && stepMs < 86_400_000;
}

/** One 365-slot row per UTC year; cell [calendarDoy - 1] holds the mean of the
 *  finite values stamped on that day (null when there are none). */
export function binByYear(datesMs: ArrayLike<number>, y: ArrayLike<number | null>): Map<number, (number | null)[]> {
  const acc = new Map<number, { sum: Float64Array; count: Int32Array }>();
  const n = Math.min(datesMs.length, y.length);
  for (let i = 0; i < n; i++) {
    const v = y[i];
    const yr = new Date(datesMs[i]).getUTCFullYear();
    let a = acc.get(yr);
    if (!a) { a = { sum: new Float64Array(DOY_SLOTS), count: new Int32Array(DOY_SLOTS) }; acc.set(yr, a); }
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    const k = calendarDoy(datesMs[i]) - 1;
    a.sum[k] += v; a.count[k]++;
  }
  const byYear = new Map<number, (number | null)[]>();
  for (const [yr, a] of acc) {
    byYear.set(yr, Array.from(a.sum, (s, k) => (a.count[k] > 0 ? s / a.count[k] : null)));
  }
  return byYear;
}

/** Daily values (see binByYear) grouped by calendar day across years, in year
 *  order. Days without a finite value contribute nothing. */
export function binByDoy(datesMs: ArrayLike<number>, y: ArrayLike<number | null>): Map<number, number[]> {
  const byYear = binByYear(datesMs, y);
  const byDoy = new Map<number, number[]>();
  for (const yr of [...byYear.keys()].sort((a, b) => a - b)) {
    byYear.get(yr)!.forEach((v, k) => {
      if (v === null) return;
      const arr = byDoy.get(k + 1);
      if (arr) arr.push(v); else byDoy.set(k + 1, [v]);
    });
  }
  return byDoy;
}
