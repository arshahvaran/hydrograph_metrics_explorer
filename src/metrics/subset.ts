// Analysis subsetting per webtool_v3.md: contiguous window → recurring
// seasonal filter (day-of-year span, wrapping across the new year when
// start > end) → optional resample. Runs before the NaN policy / transform in
// the metric pipeline so every tab sees the same subset.

import type { ViewState } from '../types'

export interface SubsetResult {
  dates: number[];
  obs: Float64Array;
  sims: Float64Array[];
  /** Effective step after resampling (ms + label), for timing-axis captions. */
  step: { ms: number; label: string };
  /** Human caption fragment, e.g. "window 2001-03-01–2004-09-30 · season DOY 305–59 · monthly means". */
  caption: string;
}

const DAY = 86_400_000;

export function doyUTC(ms: number): number {
  const d = new Date(ms);
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.floor((ms - start) / DAY) + 1; // 1-based
}

function inSeason(doy: number, s: { startDoy: number; endDoy: number }): boolean {
  return s.startDoy <= s.endDoy
    ? doy >= s.startDoy && doy <= s.endDoy
    : doy >= s.startDoy || doy <= s.endDoy; // wraps across the new year
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Apply window → season → resample to the shared date index and any number of
 * value series (observed first). Resampling aggregates by calendar bin using
 * the mean of finite values; bins with no finite value yield NaN. The bin
 * timestamp is the bin start (UTC).
 */
export function applySubset(
  dates: number[],
  series: ArrayLike<number>[],
  view: Pick<ViewState, 'window' | 'season' | 'resample'>,
  nativeStep: { ms: number; label: string },
): SubsetResult {
  const n = dates.length;
  const keep: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = dates[i];
    if (view.window && (t < view.window[0] || t > view.window[1])) continue;
    if (view.season && !inSeason(doyUTC(t), view.season)) continue;
    keep.push(i);
  }

  const capParts: string[] = [];
  if (view.window) capParts.push(`window ${iso(view.window[0])}–${iso(view.window[1])}`);
  if (view.season) capParts.push(`season DOY ${view.season.startDoy}–${view.season.endDoy}`);

  const pick = (s: ArrayLike<number>) => {
    const out = new Float64Array(keep.length);
    for (let k = 0; k < keep.length; k++) out[k] = Number(s[keep[k]]);
    return out;
  };
  let outDates = keep.map(i => dates[i]);
  let outSeries = series.map(pick);
  let step = { ms: nativeStep.ms, label: nativeStep.label };

  const mode = view.resample ?? 'native';
  if (mode !== 'native' && outDates.length) {
    const binKey = (ms: number) => {
      const d = new Date(ms);
      return mode === 'monthly'
        ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
        : Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    };
    const bins = new Map<number, number[]>();          // binStart → row indices
    outDates.forEach((ms, i) => {
      const k = binKey(ms);
      const arr = bins.get(k);
      if (arr) arr.push(i); else bins.set(k, [i]);
    });
    const binStarts = [...bins.keys()].sort((a, b) => a - b);
    const agg = (s: Float64Array) => {
      const out = new Float64Array(binStarts.length);
      binStarts.forEach((k, bi) => {
        let sum = 0, c = 0;
        for (const i of bins.get(k)!) if (isFinite(s[i])) { sum += s[i]; c++; }
        out[bi] = c ? sum / c : NaN;
      });
      return out;
    };
    outSeries = outSeries.map(agg);
    outDates = binStarts;
    step = mode === 'monthly' ? { ms: 30 * DAY, label: '1mo' } : { ms: DAY, label: '1d' };
    capParts.push(mode === 'monthly' ? 'monthly means' : 'daily means');
  }

  return {
    dates: outDates,
    obs: outSeries[0],
    sims: outSeries.slice(1),
    step,
    caption: capParts.join(' · '),
  };
}
