const HOUR = 3600_000;
const DAY = 24 * HOUR;

export interface StepInfo {
  ms: number;            // modal step (representative; 30·DAY for monthly)
  label: string;         // e.g. '1h', '6h', '1d', '1mo'
  irregular: boolean;    // true if a meaningful share of diffs disagree with the mode
  monthly: boolean;
}

/** A run of this many identical off-mode differences in a row is a second
 *  sampling regime (e.g. daily rows followed by hourly rows), not a gap. */
const REGIME_RUN = 3;

const daysInMonthUTC = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();

/**
 * Whole calendar months from a to b (k >= 1), or 0 when b is not k whole
 * months after a. Whole months keep the day of the month and the time of
 * day; month ends count as the same day (31 Jan → 28 Feb → 31 Mar), and so
 * does a day that the shorter month had to clip (30 Jan → 28 Feb → 30 Mar).
 */
function wholeMonthsApart(a: number, b: number): number {
  if (b - a < 28 * DAY) return 0;            // the shortest whole month is 28 days
  const da = new Date(a), db = new Date(b);
  if (((a % DAY) + DAY) % DAY !== ((b % DAY) + DAY) % DAY) return 0;
  const k = (db.getUTCFullYear() - da.getUTCFullYear()) * 12 + (db.getUTCMonth() - da.getUTCMonth());
  if (k < 1) return 0;
  const x = da.getUTCDate(), y = db.getUTCDate();
  const endA = x === daysInMonthUTC(da), endB = y === daysInMonthUTC(db);
  return x === y || (endA && y >= x) || (endB && x >= y) ? k : 0;
}

/**
 * Detect the sampling step as the mode of consecutive differences (§6.0).
 * Calendar-monthly data are recognised as '1mo' by calendar arithmetic:
 * nearly all consecutive dates are whole calendar months apart, mostly one
 * month (a jump of k months is k - 1 missing rows, as for fixed steps).
 * A fixed 28- or 30-day step is therefore '28d' / '30d', not a month.
 * Gaps are tolerated: they simply don't win the mode. A sustained run of a
 * coarser spacing (a change of sampling resolution) is flagged irregular.
 */
export function detectStep(datesMs: number[]): StepInfo {
  if (datesMs.length < 2) return { ms: DAY, label: '1d', irregular: false, monthly: false };

  const diffs: number[] = [];
  for (let i = 1; i < datesMs.length; i++) diffs.push(datesMs[i] - datesMs[i - 1]);

  // Monthly check first, on the calendar: > 90% of the differences are whole
  // months, and at least half of those are exactly one month (annual or
  // quarterly records are whole months apart too, but are not monthly).
  let whole = 0, one = 0;
  for (let i = 1; i < datesMs.length; i++) {
    const k = wholeMonthsApart(datesMs[i - 1], datesMs[i]);
    if (k >= 1) whole++;
    if (k === 1) one++;
  }
  if (whole / diffs.length > 0.9 && one >= 0.5 * whole) {
    return { ms: 30 * DAY, label: '1mo', irregular: (diffs.length - whole) / diffs.length > 0.05, monthly: true };
  }

  const counts = new Map<number, number>();
  for (const d of diffs) counts.set(d, (counts.get(d) ?? 0) + 1);
  let mode = diffs[0], best = 0;
  for (const [d, c] of counts) if (c > best || (c === best && d < mode)) { mode = d; best = c; }

  const offMode = diffs.filter(d => d !== mode).length;
  // Gaps that are exact multiples of the mode are missing rows, not irregularity.
  const trueIrregular = diffs.filter(d => d !== mode && d % mode !== 0).length;
  // ...unless the same off-mode multiple repeats row after row: that is a
  // stretch sampled at a coarser step (200 daily rows before 2400 hourly
  // rows once passed as a regular '1h' record, and a depth-per-interval
  // conversion then divided the daily depths by one hour).
  let run = 0, regime = false;
  for (let i = 0; i < diffs.length && !regime; i++) {
    run = diffs[i] !== mode ? (i > 0 && diffs[i] === diffs[i - 1] ? run + 1 : 1) : 0;
    if (run >= REGIME_RUN) regime = true;
  }

  let label: string;
  if (mode % DAY === 0) label = `${mode / DAY}d`;
  else if (mode % HOUR === 0) label = `${mode / HOUR}h`;
  else if (mode % 60_000 === 0) label = `${mode / 60_000}min`;
  else label = `${mode}ms`;

  return {
    ms: mode,
    label,
    irregular: regime || trueIrregular / diffs.length > 0.05 || offMode / diffs.length > 0.5,
    monthly: false,
  };
}
