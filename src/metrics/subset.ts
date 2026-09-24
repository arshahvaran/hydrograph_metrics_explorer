// Analysis subsetting per webtool_v3.md: contiguous window → recurring
// seasonal filter (calendar-day span, wrapping across the new year when
// start > end) → optional resample. Runs before the NaN policy / transform in
// the metric pipeline so every tab sees the same subset.
//
// v1.14 (audit):
// - The window is a span of whole UTC days: the end date is kept up to the
//   end of that day, as the caption says (subset-03).
// - A season keeps the time axis. Out-of-season steps stay in the frame as
//   missing values, so step-based timing metrics, the persistence benchmark
//   and the plot modes never treat the last day of one season and the first
//   day of the next as adjacent steps (DESIGN D1, subset-04).
// - Season bounds are days of a 365-day year: DOY 60 is 1 March in every
//   year and 29 February counts as DOY 59, with 28 February (subset-05).
// - Resampling averages each simulation over exactly the steps that the
//   observed bin covers; depths per step are summed (DESIGN D5,
//   compute-02, compute-03, subset-01, subset-02).
// - A resample to a step that is not coarser than the native step is a
//   no-op and claims nothing (subset-08).

import type { UnitId, ViewState } from '../types'
import { UNITS } from '../units/registry'

export interface SubsetOptions {
  /** The values are depths accumulated over each native step (mm / interval).
   *  A resampled bin then holds the depth over the new interval (the sum of
   *  the native depths), not a mean depth per native step. */
  perStepDepth?: boolean;
}

export interface SubsetResult {
  dates: number[];
  obs: Float64Array;
  sims: Float64Array[];
  /** Effective step after resampling (ms + label), for timing-axis captions. */
  step: { ms: number; label: string };
  /** Human caption fragment, e.g. "window 2001-03-01–2004-09-30 · season DOY 305–59 (1 Nov–28 Feb, …) · monthly means". */
  caption: string;
  /** Rows (native) or bins (resampled) that belong to the selection. The
   *  out-of-season steps that are kept as gaps are not counted. */
  shown: number;
  /** True when the values were aggregated to a new, coarser step. */
  resampled: boolean;
}

/** The selection, prepared once for a date index and an observed series. */
export interface Subsetter {
  dates: number[];
  obs: Float64Array;
  step: { ms: number; label: string };
  caption: string;
  shown: number;
  resampled: boolean;
  /** Map any native-index series through the same selection. Under
   *  resampling a bin is the mean (or, for depths per step, the total) over
   *  exactly the steps the observed bin covers; a bin where the series lacks
   *  one of those steps is NaN, so a pair never compares different days. */
  apply: (values: ArrayLike<number>) => Float64Array;
}

const DAY = 86_400_000;

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
 * Prepare window → season → resample for a date index and its observed
 * series. The window keeps whole UTC days. A season marks the out-of-season
 * steps as missing values and keeps them (the frame is trimmed to the first
 * and last in-season step). Resampling builds one bin per calendar day or
 * month from the first to the last selected step; the bin timestamp is the
 * bin start (UTC). An observed bin is the mean of the finite observed values
 * of its selected steps; every other series is averaged over exactly those
 * steps (see Subsetter.apply). Depths per step are summed instead: the mean
 * over the valid steps times the number of native steps in the new interval,
 * which is the plain sum when no step is missing.
 */
export function makeSubsetter(
  dates: number[],
  obsValues: ArrayLike<number> | null,
  view: Pick<ViewState, 'window' | 'season' | 'resample'>,
  nativeStep: { ms: number; label: string },
  opts: SubsetOptions = {},
): Subsetter {
  const n = dates.length;
  // A window picked end-before-start is treated as the span between the two
  // days (QA: reversed window must not silently empty the frame).
  const win = view.window
    ? { lo: floorDay(Math.min(view.window[0], view.window[1])), hi: floorDay(Math.max(view.window[0], view.window[1])) + DAY }
    : null;
  const rows: number[] = [];
  const sel: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const t = dates[i];
    if (win && (t < win.lo || t >= win.hi)) continue;
    rows.push(i);
    sel.push(!view.season || inSeason(calendarDoy(t), view.season));
  }
  // Trim the out-of-season steps before the first and after the last selected step.
  let f = 0, l = rows.length - 1;
  while (f <= l && !sel[f]) f++;
  while (l >= f && !sel[l]) l--;
  const tRows = f <= l ? rows.slice(f, l + 1) : [];
  const tSel = f <= l ? sel.slice(f, l + 1) : [];

  const capParts: string[] = [];
  if (win) capParts.push(`window ${iso(win.lo)}–${iso(win.hi - DAY)}`);
  if (view.season) {
    const a = clampDoy(view.season.startDoy), b = clampDoy(view.season.endDoy);
    capParts.push(`season DOY ${a}–${b} (${calendarDayLabel(a)}–${calendarDayLabel(b)}, out-of-season steps kept as gaps)`);
  }

  const mode = view.resample ?? 'native';
  const resample = mode !== 'native' && tRows.length > 0 && resampleAvailable(mode, nativeStep);

  if (!resample) {
    const pick = (s: ArrayLike<number>) => {
      const out = new Float64Array(tRows.length);
      for (let k = 0; k < tRows.length; k++) out[k] = tSel[k] ? Number(s[tRows[k]]) : NaN;
      return out;
    };
    return {
      dates: tRows.map(i => dates[i]),
      obs: obsValues ? pick(obsValues) : new Float64Array(tRows.length),
      step: { ms: nativeStep.ms, label: nativeStep.label },
      caption: capParts.join(' · '),
      shown: tSel.filter(Boolean).length,
      resampled: false,
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
  // Every bin from the first to the last selected step, so the resampled
  // axis is regular (empty and out-of-season bins are NaN, not dropped).
  const selRows = tRows.filter((_, k) => tSel[k]);
  const binStarts: number[] = [];
  const binIdx = new Map<number, number>();
  const lastKey = binKey(dates[selRows[selRows.length - 1]]);
  for (let k = binKey(dates[selRows[0]]); k <= lastKey; k = nextBin(k)) { binIdx.set(k, binStarts.length); binStarts.push(k); }
  const members: number[][] = binStarts.map(() => []);
  for (const i of selRows) members[binIdx.get(binKey(dates[i]))!].push(i);
  // Native steps per new interval, for depths per step.
  const perBin = binStarts.map(k => (nextBin(k) - k) / nativeStep.ms);
  const total = opts.perStepDepth === true;

  // Steps of each bin where the observed value exists: the sample every
  // series is averaged over (pairwise deletion BEFORE aggregation, D5).
  const ref: number[][] | null = obsValues
    ? members.map(m => m.filter(i => Number.isFinite(Number(obsValues[i]))))
    : null;

  const agg = (s: ArrayLike<number>, bi: number, use: number[]): number => {
    if (!use.length) return NaN;
    let sum = 0;
    for (const i of use) {
      const v = Number(s[i]);
      if (!Number.isFinite(v)) return NaN;   // lacks a step the observed bin has
      sum += v;
    }
    const mean = sum / use.length;
    return total ? mean * perBin[bi] : mean;
  };
  const apply = (s: ArrayLike<number>) => {
    const out = new Float64Array(binStarts.length);
    for (let bi = 0; bi < binStarts.length; bi++) {
      out[bi] = agg(s, bi, ref ? ref[bi] : members[bi].filter(i => Number.isFinite(Number(s[i]))));
    }
    return out;
  };

  capParts.push(`${mode} ${total ? 'totals' : 'means'}`);
  return {
    dates: binStarts,
    obs: obsValues ? apply(obsValues) : new Float64Array(binStarts.length),
    step: mode === 'monthly' ? { ms: 30 * DAY, label: '1mo' } : { ms: DAY, label: '1d' },
    caption: capParts.join(' · '),
    shown: members.filter(m => m.length > 0).length,
    resampled: true,
    apply,
  };
}

/**
 * Apply window → season → resample to the shared date index and any number of
 * value series (observed first). Every series after the first is resampled
 * over the steps where the first one is finite (see makeSubsetter).
 */
export function applySubset(
  dates: number[],
  series: ArrayLike<number>[],
  view: Pick<ViewState, 'window' | 'season' | 'resample'>,
  nativeStep: { ms: number; label: string },
  opts: SubsetOptions = {},
): SubsetResult {
  const sub = makeSubsetter(dates, series[0] ?? null, view, nativeStep, opts);
  return {
    dates: sub.dates,
    obs: sub.obs,
    sims: series.slice(1).map(sub.apply),
    step: sub.step,
    caption: sub.caption,
    shown: sub.shown,
    resampled: sub.resampled,
  };
}
