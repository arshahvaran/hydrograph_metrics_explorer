const HOUR = 3600_000;
const DAY = 24 * HOUR;

export interface StepInfo {
  ms: number;            // modal step (representative; 30·DAY for monthly)
  label: string;         // e.g. '1h', '6h', '1d', '1mo'
  irregular: boolean;    // true if intervals fall off the step grid, or the sampling step changes
  monthly: boolean;
}

/** A run of at least this many identical off-mode intervals in a row is a
 *  second sampling regime (e.g. daily rows followed by hourly rows), not a
 *  few missing readings (audit units-08; three alternate missing hours once
 *  flagged a whole hourly record irregular). */
const REGIME_RUN = 24;

/** Monthly data keep their place in the month. Two consecutive dates are
 *  whole calendar months apart when their month numbers differ by k >= 1
 *  and they sit at the same place in their months: the same day and time
 *  within one day, the same distance from the month end within one day
 *  (month ends, and a 30th clipped to 28 February), or the same fraction of
 *  the month within PAIR_FRACTION (CF mid-month stamps, which alternate
 *  between 12:00 and 00:00). */
const PAIR_FRACTION = 0.05;
/** ...and more than 90 % of the dates lie within this fraction of a month
 *  (about 3 days) of the record's mean place in the month, so a fixed 31-day
 *  step, which drifts through the month, is not monthly. */
const DRIFT_FRACTION = 0.1;

interface MonthPos { m: number; s: number; e: number; p: number }

/** Month number (year * 12 + month), days since the month start, days to the
 *  next month start, and the fraction of the month elapsed. */
function monthPos(t: number): MonthPos {
  const d = new Date(t);
  const y = d.getUTCFullYear(), mo = d.getUTCMonth();
  const a = Date.UTC(y, mo, 1), b = Date.UTC(y, mo + 1, 1);
  return { m: y * 12 + mo, s: (t - a) / DAY, e: (b - t) / DAY, p: (t - a) / (b - a) };
}

/** Circular distance between two fractions of a month. */
const circ = (a: number, b: number) => { const x = Math.abs(a - b) % 1; return Math.min(x, 1 - x); };

const samePlace = (a: MonthPos, b: MonthPos) =>
  Math.abs(a.s - b.s) <= 1 || Math.abs(a.e - b.e) <= 1 || circ(a.p, b.p) <= PAIR_FRACTION;

/**
 * Calendar-monthly test: more than 90 % of the intervals are k >= 1 whole
 * calendar months (see samePlace), whatever the day of the month; a k > 1 is
 * k - 1 missing months. Two dates in the same month (k = 0), which a fixed
 * 28- or 30-day step produces every few months, are not a whole month apart.
 * The record is coarser than monthly (bimonthly, quarterly, annual) when at
 * least 90 % of the k values are multiples of one g in 2..12.
 */
function calendarMonthly(dates: number[]): { monthly: boolean; offGrid: number } {
  const n = dates.length;
  const pos = dates.map(monthPos);
  let sx = 0, sy = 0;
  for (const q of pos) { const a = 2 * Math.PI * q.p; sx += Math.cos(a); sy += Math.sin(a); }
  const ref = ((Math.atan2(sy, sx) / (2 * Math.PI)) % 1 + 1) % 1;
  if (Math.hypot(sx, sy) < 1e-9 * n || pos.filter(q => circ(q.p, ref) <= DRIFT_FRACTION).length <= 0.9 * n) {
    return { monthly: false, offGrid: n - 1 };
  }
  const ks: number[] = [];
  for (let i = 1; i < n; i++) {
    const k = pos[i].m - pos[i - 1].m;
    if (k >= 1 && samePlace(pos[i - 1], pos[i])) ks.push(k);
  }
  const offGrid = n - 1 - ks.length;
  if (ks.length <= 0.9 * (n - 1)) return { monthly: false, offGrid };
  for (let g = 2; g <= 12; g++) {
    if (ks.filter(k => k % g === 0).length >= 0.9 * ks.length) return { monthly: false, offGrid };
  }
  return { monthly: true, offGrid };
}

/**
 * Detect the sampling step as the mode of consecutive differences (§6.0).
 * Calendar-monthly data are recognised as '1mo' by their place in the month
 * (see calendarMonthly), so stamps on the 1st, the 15th, the 28th, month
 * ends and CF mid-month stamps are all monthly, and missing months are
 * missing rows. A fixed 28- or 30-day step is '28d' / '30d'.
 *
 * Irregular means that intervals fall off the step grid (more than 5 % of
 * them are not whole multiples of the step) or that the sampling step
 * changes (a run of REGIME_RUN identical coarser intervals). Missing steps
 * alone never make a record irregular.
 */
export function detectStep(datesMs: number[]): StepInfo {
  if (datesMs.length < 2) return { ms: DAY, label: '1d', irregular: false, monthly: false };

  const diffs: number[] = [];
  for (let i = 1; i < datesMs.length; i++) diffs.push(datesMs[i] - datesMs[i - 1]);

  // Monthly check first, on the calendar (only when nearly every interval is
  // at least 20 days, so long sub-daily records skip the calendar work).
  if (diffs.filter(d => d >= 20 * DAY).length > 0.9 * diffs.length) {
    const m = calendarMonthly(datesMs);
    if (m.monthly) return { ms: 30 * DAY, label: '1mo', irregular: m.offGrid / diffs.length > 0.05, monthly: true };
  }

  const counts = new Map<number, number>();
  for (const d of diffs) counts.set(d, (counts.get(d) ?? 0) + 1);
  let mode = diffs[0], best = 0;
  for (const [d, c] of counts) if (c > best || (c === best && d < mode)) { mode = d; best = c; }

  // Intervals that are whole multiples of the mode are missing rows, not irregularity.
  const offGrid = diffs.filter(d => d % mode !== 0).length;
  // ...unless the same coarser interval repeats row after row: that is a
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
    irregular: regime || offGrid / diffs.length > 0.05,
    monthly: false,
  };
}
