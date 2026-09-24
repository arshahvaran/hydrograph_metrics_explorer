// Day-of-year and calendar-year binning for the DOY climatology, annual
// heatmap, and spaghetti plots. Pure and exported so tests can pin the
// binning directly against applySubset output. The dates array MUST be the
// same frame the values came from (the displayed subset); binning subset
// values against the full-record dates once shifted every point as soon as a
// window, season, or resample was active (v1.11 regression).
//
// Bins are CALENDAR days on a 366-day calendar: Jan 1 = 1, Feb 29 = 60,
// Mar 1 = 61 and Dec 31 = 366 in every year. The ordinal day of year put
// every leap-year date after February one bin later than the same date in
// other years (and split each monthly-resampled month into two medians).
// Each (year, calendar day) cell holds ONE value: the mean of the finite
// samples stamped on that day, so sub-daily records are shown as daily means
// (the last sample of the day once stood for the whole day, and a missing
// last sample blanked it).

/** Days before each month on a leap-year calendar. */
const DAYS_BEFORE_MONTH = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];

/** Calendar day on a 366-day calendar (UTC): Feb 29 = 60, Mar 1 = 61 and
 *  Dec 31 = 366 in every year. */
export function calendarDay(ms: number): number {
  const d = new Date(ms);
  return DAYS_BEFORE_MONTH[d.getUTCMonth()] + d.getUTCDate();
}

/** True when the frame has more than one sample per calendar day. */
export function isSubDaily(stepMs: number): boolean {
  return stepMs > 0 && stepMs < 86_400_000;
}

/** One 366-slot row per UTC year; cell [calendarDay - 1] holds the mean of the
 *  finite values stamped on that day (null when there are none). */
export function binByYear(datesMs: ArrayLike<number>, y: ArrayLike<number | null>): Map<number, (number | null)[]> {
  const acc = new Map<number, { sum: Float64Array; count: Int32Array }>();
  const n = Math.min(datesMs.length, y.length);
  for (let i = 0; i < n; i++) {
    const v = y[i];
    const yr = new Date(datesMs[i]).getUTCFullYear();
    let a = acc.get(yr);
    if (!a) { a = { sum: new Float64Array(366), count: new Int32Array(366) }; acc.set(yr, a); }
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    const k = calendarDay(datesMs[i]) - 1;
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
