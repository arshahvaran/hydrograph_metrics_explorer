// Analysis subsetting per webtool_v3.md: contiguous window → recurring
// seasonal filter (calendar-day span, wrapping across the new year when
// start > end) → optional resample. Runs before the NaN policy / transform in
// the metric pipeline so every tab sees the same subset.
//
// v1.14 (audit):
// - The window is a span of whole UTC days: the end date is kept up to the
//   end of that day, as the caption says (subset-03).
// - A season keeps only its own steps. Out-of-season steps are not rows of
//   the selection (nor of a dataset made from it), so no NaN policy can fill
//   them (review of subset-04: a zero policy once filled 825 out-of-season
//   rows with (0, 0) pairs). The dates still count them as time, so the
//   metrics on the date-based time axis (timePositions: peak timing, events,
//   Series Distance, lag sweep) never treat the last day of one season and
//   the first day of the next as adjacent steps (DESIGN D1). Row-based uses
//   (the persistence benchmark, plot lines) see adjacent rows, as for any
//   record with absent dates.
// - Season bounds are days of a 365-day year: DOY 60 is 1 March in every
//   year and 29 February counts as DOY 59, with 28 February (subset-05).
// - Resampling pairs before it aggregates: every bin averages the observed
//   series and every simulation over the same steps, those valid in all of
//   them, and a bin needs at least half of its steps; depths per step are
//   summed, scaled to the whole bin from those steps (DESIGN D5, compute-02,
//   compute-03, subset-01, subset-02). Bins left empty are not rows.
// - A resample to a step that is not coarser than the native step is a
//   no-op and claims nothing (subset-08).
// - A native subset carries the step detected on its own span, so a window
//   over the daily part of a daily-then-hourly record is daily (subset-07).

import type { UnitId, ViewState } from '../types'
import { UNITS } from '../units/registry'
import { detectStep } from '../units/stepDetect'

export interface SubsetOptions {
  /** The values are depths accumulated over each native step (mm / interval).
   *  A resampled bin then holds the depth over the new interval (the sum of
   *  the native depths), not a mean depth per native step. */
  perStepDepth?: boolean;
}

/** Step of a selection: the native step (re-detected on the selected span)
 *  or the new daily / calendar-monthly step of a resample. */
export interface SubsetStep { ms: number; label: string; irregular: boolean }

/** How the bins of a resample were filled. */
export interface BinCounts {
  /** 'day' or 'month'. */
  unit: string;
  /** Bins that met the coverage rule (the rows of the resampled series). */
  kept: number;
  /** Kept bins with fewer valid steps than the whole interval (scaled, for depths). */
  partial: number;
  /** Bins with selected steps that failed the coverage rule (not rows). */
  empty: number;
}

export interface SubsetResult {
  dates: number[];
  obs: Float64Array;
  sims: Float64Array[];
  /** Effective step after resampling, for timing-axis captions and the commit. */
  step: SubsetStep;
  /** Human caption fragment, e.g. "window 2001-03-01–2004-09-30 · season DOY 305–59 (1 Nov–28 Feb, …) · monthly means …". */
  caption: string;
  /** Rows (native) or bins (resampled) of the selection (= dates.length). */
  shown: number;
  /** True when the values were aggregated to a new, coarser step. */
  resampled: boolean;
  /** Bin counts of a resample; null for a native selection. */
  bins: BinCounts | null;
}

/** The selection, prepared once for a date index and its series. */
export interface Subsetter {
  dates: number[];
  obs: Float64Array;
  step: SubsetStep;
  caption: string;
  shown: number;
  resampled: boolean;
  bins: BinCounts | null;
  /** Map any native-index series through the same selection. Under
   *  resampling a bin is the mean (or, for depths per step, the scaled
   *  total) over exactly the steps where the observed series and every
   *  simulation given to makeSubsetter are valid, so each resampled observed
   *  value matches each simulation's. A series lacking one of those steps
   *  (one not given to makeSubsetter) gets NaN there. */
  apply: (values: ArrayLike<number>) => Float64Array;
}

const DAY = 86_400_000;
/** A resampled bin needs at least this share of its native steps valid in
 *  every series (DESIGN D5 coverage rule). */
export const MIN_BIN_COVERAGE = 0.5;

/** Ordinal day of the UTC year, 1-based; 29 February is 60 in a leap year. */
export function doyUTC(ms: number): number {
  const d = new Date(ms);
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.floor((ms - start) / DAY) + 1; // 1-based
}

const CUM = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Day of a 365-day calendar year (1 = 1 Jan, 60 = 1 Mar, 365 = 31 Dec in
 *  every year); 29 February shares DOY 59 with 28 February. Season bounds
 *  are read on this calendar so that one DOY is one calendar day in leap and
 *  common years alike. */
export function calendarDoy(ms: number): number {
  const d = new Date(ms);
  const m = d.getUTCMonth(), day = d.getUTCDate();
  return m === 1 && day === 29 ? 59 : CUM[m] + day;
}

/** "1 Nov" for a 365-day-calendar DOY. */
export function calendarDayLabel(doy: number): string {
  const x = Math.min(365, Math.max(1, Math.floor(doy)));
  let m = 11;
  while (CUM[m] >= x) m--;
  return `${x - CUM[m]} ${MONTH[m]}`;
}

const clampDoy = (x: number) => Math.min(365, Math.max(1, x));

function inSeason(doy: number, s: { startDoy: number; endDoy: number }): boolean {
  const a = clampDoy(s.startDoy), b = clampDoy(s.endDoy);
  return a <= b
    ? doy >= a && doy <= b
    : doy >= a || doy <= b; // wraps across the new year
}

/** True for a depth accumulated over each time step (mm / interval), which
 *  resampling must sum; rates (flows, in / day) are averaged. */
export function isPerStepDepth(unit: UnitId): boolean {
  const u = UNITS[unit];
  return !!u && u.kind === 'depth' && u.interval === 'step';
}

/** Whether resampling to `mode` aggregates anything at this native step:
 *  daily needs a sub-daily record, monthly a record finer than a month. */
export function resampleAvailable(mode: ViewState['resample'], nativeStep: { ms: number; label: string }): boolean {
  if (mode === 'daily') return nativeStep.ms < DAY;
  if (mode === 'monthly') return nativeStep.label !== '1mo' && nativeStep.ms < 28 * DAY;
  return true;
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const floorDay = (ms: number) => Math.floor(ms / DAY) * DAY;

/**
 * Prepare window → season → resample for a date index and its series (the
 * observed series first, then every simulation). The window keeps whole UTC
 * days. A season keeps its own steps only; the others are left out (the
 * dates still show the time between seasons). Resampling builds one bin per
 * calendar day or month (bin timestamp = bin start, UTC) from the steps of
 * the selection. A step counts in a bin when the observed series and every
 * simulation are valid there (one shared pairing), and the bin is kept when
 * those steps are at least MIN_BIN_COVERAGE of the native steps in the whole
 * interval; the others are left out and counted as empty. Every series is
 * the mean over the counted steps; depths per step are that mean times the
 * native steps in the interval, i.e. the plain sum when no step is missing
 * and a total scaled to the whole interval when some are (partial bins).
 */
export function makeSubsetter(
  dates: number[],
  series: ArrayLike<number>[],
  view: Pick<ViewState, 'window' | 'season' | 'resample'>,
  nativeStep: { ms: number; label: string; irregular?: boolean },
  opts: SubsetOptions = {},
): Subsetter {
  const n = dates.length;
  // A window picked end-before-start is treated as the span between the two
  // days (QA: reversed window must not silently empty the frame).
  const win = view.window
    ? { lo: floorDay(Math.min(view.window[0], view.window[1])), hi: floorDay(Math.max(view.window[0], view.window[1])) + DAY }
    : null;
  // Rows of the window, and whether each is in season.
  const rows: number[] = [];
  const sel: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const t = dates[i];
    if (win && (t < win.lo || t >= win.hi)) continue;
    rows.push(i);
    sel.push(!view.season || inSeason(calendarDoy(t), view.season));
  }
  const selRows = rows.filter((_, k) => sel[k]);

  const capParts: string[] = [];
  if (win) capParts.push(`window ${iso(win.lo)}–${iso(win.hi - DAY)}`);
  if (view.season) {
    const a = clampDoy(view.season.startDoy), b = clampDoy(view.season.endDoy);
    capParts.push(`season DOY ${a}–${b} (${calendarDayLabel(a)}–${calendarDayLabel(b)}, out-of-season steps left out)`);
  }

  const mode = view.resample ?? 'native';
  const resample = mode !== 'native' && selRows.length > 0 && resampleAvailable(mode, nativeStep);
  const obsValues = series.length ? series[0] : null;

  if (!resample) {
    const pick = (s: ArrayLike<number>) => {
      const out = new Float64Array(selRows.length);
      for (let k = 0; k < selRows.length; k++) out[k] = Number(s[selRows[k]]);
      return out;
    };
    // The step of what is kept: detected on the selected span, out-of-season
    // steps included (they are time, not a coarser sampling).
    let step: SubsetStep = { ms: nativeStep.ms, label: nativeStep.label, irregular: nativeStep.irregular ?? false };
    if ((win || view.season) && selRows.length >= 2) {
      const f = rows.indexOf(selRows[0]), l = rows.lastIndexOf(selRows[selRows.length - 1]);
      const d = detectStep(rows.slice(f, l + 1).map(i => dates[i]));
      step = { ms: d.ms, label: d.label, irregular: d.irregular };
    }
    return {
      dates: selRows.map(i => dates[i]),
      obs: obsValues ? pick(obsValues) : new Float64Array(selRows.length),
      step,
      caption: capParts.join(' · '),
      shown: selRows.length,
      resampled: false,
      bins: null,
      apply: pick,
    };
  }

  const binKey = (ms: number) => {
    const d = new Date(ms);
    return mode === 'monthly'
      ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
      : Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  };
  const nextBin = (k: number) => {
    if (mode !== 'monthly') return k + DAY;
    const d = new Date(k);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  };
  // One shared pairing (DESIGN D5): a step counts when the observed series
  // and every simulation are valid there, so each resampled observed value
  // is paired with each simulation's over exactly the same steps.
  const valid = (i: number) => {
    for (const s of series) if (!Number.isFinite(Number(s[i]))) return false;
    return true;
  };
  // Selected steps per calendar bin, in time order.
  const binStart: number[] = [];
  const members: number[][] = [];
  for (const i of selRows) {
    const k = binKey(dates[i]);
    if (!binStart.length || binStart[binStart.length - 1] !== k) { binStart.push(k); members.push([]); }
    members[members.length - 1].push(i);
  }
  const total = opts.perStepDepth === true;
  const keptStart: number[] = [];
  const use: number[][] = [];
  const perBin: number[] = [];
  let partial = 0, empty = 0;
  for (let b = 0; b < binStart.length; b++) {
    const steps = (nextBin(binStart[b]) - binStart[b]) / nativeStep.ms;   // native steps in the whole interval
    const ok = members[b].filter(valid);
    if (ok.length === 0 || ok.length < MIN_BIN_COVERAGE * steps - 1e-9) { empty++; continue; }
    if (ok.length < steps - 1e-9) partial++;
    keptStart.push(binStart[b]); use.push(ok); perBin.push(steps);
  }

  const apply = (s: ArrayLike<number>) => {
    const out = new Float64Array(keptStart.length);
    for (let b = 0; b < keptStart.length; b++) {
      let sum = 0;
      for (const i of use[b]) sum += Number(s[i]);            // NaN when s lacks a counted step
      const m = sum / use[b].length;
      out[b] = total ? m * perBin[b] : m;
    }
    return out;
  };

  const unit = mode === 'monthly' ? 'month' : 'day';
  const counts: string[] = [];
  if (partial) counts.push(`${partial} of ${keptStart.length} ${unit}s partial`);
  if (empty) counts.push(`${empty} left empty`);
  capParts.push(`${mode} ${total ? 'totals' : 'means'} of the steps valid in every series (a ${unit} needs at least half of its steps`
    + (total ? `, and a ${unit} with missing steps is scaled to the whole ${unit}` : '')
    + (counts.length ? `; ${counts.join('; ')}` : '') + ')');
  return {
    dates: keptStart,
    obs: obsValues ? apply(obsValues) : new Float64Array(keptStart.length),
    step: mode === 'monthly' ? { ms: 30 * DAY, label: '1mo', irregular: false } : { ms: DAY, label: '1d', irregular: false },
    caption: capParts.join(' · '),
    shown: keptStart.length,
    resampled: true,
    bins: { unit, kept: keptStart.length, partial, empty },
    apply,
  };
}

/**
 * Apply window → season → resample to the shared date index and any number of
 * value series (observed first). All series are resampled over the steps
 * where every one of them is valid (see makeSubsetter).
 */
export function applySubset(
  dates: number[],
  series: ArrayLike<number>[],
  view: Pick<ViewState, 'window' | 'season' | 'resample'>,
  nativeStep: { ms: number; label: string; irregular?: boolean },
  opts: SubsetOptions = {},
): SubsetResult {
  const sub = makeSubsetter(dates, series, view, nativeStep, opts);
  return {
    dates: sub.dates,
    obs: sub.obs,
    sims: series.slice(1).map(sub.apply),
    step: sub.step,
    caption: sub.caption,
    shown: sub.shown,
    resampled: sub.resampled,
    bins: sub.bins,
  };
}
