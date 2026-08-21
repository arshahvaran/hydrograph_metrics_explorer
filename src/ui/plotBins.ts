// Day-of-year and calendar-year binning for the DOY climatology, annual
// heatmap, and spaghetti plots. Pure and exported so tests can pin the
// binning directly against applySubset output. The dates array MUST be the
// same frame the values came from (the displayed subset); binning subset
// values against the full-record dates once shifted every point as soon as a
// window, season, or resample was active (v1.11 regression).

import { doyUTC } from '../metrics/subset'

/** Group non-null values by UTC day of year (1-based; Feb 29 = 60). */
export function binByDoy(datesMs: number[], y: (number | null)[]): Map<number, number[]> {
  const byDoy = new Map<number, number[]>();
  y.forEach((v, i) => {
    if (v === null) return;
    const doy = doyUTC(datesMs[i]);
    const arr = byDoy.get(doy);
    if (arr) arr.push(v); else byDoy.set(doy, [v]);
  });
  return byDoy;
}

/** One 366-slot row per UTC year; cell [doy-1] holds the value stamped on that
 *  day (the last sample of a day wins for sub-daily records). */
export function binByYear(datesMs: number[], y: (number | null)[]): Map<number, (number | null)[]> {
  const byYear = new Map<number, (number | null)[]>();
  y.forEach((v, i) => {
    const yr = new Date(datesMs[i]).getUTCFullYear();
    if (!byYear.has(yr)) byYear.set(yr, Array(366).fill(null));
    byYear.get(yr)![doyUTC(datesMs[i]) - 1] = v;
  });
  return byYear;
}
