// Native time axis for the step-based timing metrics (audit rule D1).
//
// The metric panel drops every time step where the observed or the simulated
// value is missing (pairwise NaN policy). Lags, search windows, peak
// separations and event spans must still count time steps of the record, not
// positions in the compacted pair arrays: otherwise a gap of G missing steps
// counts as one step and every lag across it shrinks by G - 1.

import { detectStep } from '../../units/stepDetect'

/** Largest share of consecutive date differences that may fall off the
 *  detected step grid before the dates are ignored (the record is then treated
 *  as irregular and the row number is used as the time position). */
const OFF_GRID_TOLERANCE = 0.05;

const identity = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

/**
 * Time-step position of each of the first `n` rows of a record.
 *
 * Without dates, position = row number. With dates, position = number of
 * detected steps since the first row, so rows that are absent from the file
 * (dates skipped, not written as missing values) also count as time. Calendar-
 * monthly records count calendar months. If more than 5 % of the date
 * differences are not whole multiples of the detected step (an irregular
 * record), the row number is used, as before.
 */
export function timePositions(datesMs: ArrayLike<number> | undefined, n: number): number[] {
  if (!datesMs || datesMs.length < n || n < 2) return identity(Math.max(0, n));
  const d: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    d[i] = datesMs[i];
    if (!Number.isFinite(d[i]) || (i > 0 && d[i] <= d[i - 1])) return identity(n);
  }
  const step = detectStep(d);
  if (!(step.ms > 0)) return identity(n);
  const pos: number[] = new Array(n);
  pos[0] = 0;
  let offGrid = 0;
  for (let i = 1; i < n; i++) {
    let k: number;
    if (step.monthly) {
      const a = new Date(d[i - 1]), b = new Date(d[i]);
      k = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
    } else {
      const dt = d[i] - d[i - 1];
      k = Math.round(dt / step.ms);
      if (Math.abs(dt - k * step.ms) > 0.01 * step.ms) offGrid++;
    }
    if (k < 1) { offGrid++; k = 1; }
    pos[i] = pos[i - 1] + k;
  }
  return offGrid / (n - 1) > OFF_GRID_TOLERANCE ? identity(n) : pos;
}
