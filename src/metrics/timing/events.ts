// Event detection, per-event errors (§11.7), Gauch-style peak-timing (paper §4.5),
// and the interactive lag sweep (§11.9). Pure functions over paired arrays.
//
// Time axis (audit rule D1). Every function takes an optional `pos`: the
// native time-step position of each array element (strictly increasing
// integers, see timeAxis.ts). The metric panel drops the steps where either
// series is missing, so the arrays can have holes in time; lags, search
// windows, peak separations, event spans and the lag shift are all measured on
// `pos`, never on array positions, so a gap of G steps is not counted as one
// step. Without `pos` the arrays are taken as gap-free (pos[k] = k). Returned
// indices (event spans, tObs, tSim) stay array indices into the inputs; the
// panel's pairedIndex maps them to dataset rows.

import { mean, stdPop, median, quantile, type Vec } from '../support/stats'
import { nse, kge2009, r as pearsonR } from '../classical/catalogue'
import { matchEvents, overlapEdges } from './eventMatch'

type Positions = ArrayLike<number> | undefined;
const at = (pos: Positions) => (pos ? (k: number) => pos[k] : (k: number) => k);

// ---------------- events ----------------
export interface EventSpan { start: number; end: number; peakIdx: number; peakQ: number }

export interface EventOptions {
  thresholdKind: 'percentile' | 'absolute';
  thresholdValue: number;    // percentile 0–100 or absolute in data units
  minDistance: number;       // merge events closer than this (steps)
  warmup: number;            // steps skipped at record start
}

/** Threshold events. A span is a run of consecutive time steps above the
 *  threshold, so a gap in the record ends it; spans closer than minDistance
 *  steps are then merged. The warm-up skips the first `warmup` time steps. */
export function detectEvents(x: Vec, opt: EventOptions, pos?: ArrayLike<number>): { events: EventSpan[]; threshold: number } {
  const P = at(pos);
  const thr = opt.thresholdKind === 'percentile' ? quantile(x, opt.thresholdValue / 100) : opt.thresholdValue;
  const spans: EventSpan[] = [];
  const n = x.length;
  let i = 0;
  while (i < n && P(i) < opt.warmup) i++;
  while (i < n) {
    if (x[i] > thr) {
      const start = i;
      i++;
      while (i < n && x[i] > thr && P(i) === P(i - 1) + 1) i++;
      const end = i - 1;
      let pk = start;
      for (let j = start; j <= end; j++) if (x[j] > x[pk]) pk = j;
      spans.push({ start, end, peakIdx: pk, peakQ: x[pk] });
    } else i++;
  }
  // merge events separated by less than minDistance
  const merged: EventSpan[] = [];
  for (const e of spans) {
    const last = merged[merged.length - 1];
    if (last && P(e.start) - P(last.end) < opt.minDistance) {
      last.end = e.end;
      if (e.peakQ > last.peakQ) { last.peakIdx = e.peakIdx; last.peakQ = e.peakQ; }
    } else merged.push({ ...e });
  }
  return { events: merged, threshold: thr };
}

/** Last index of the run of values equal to x[a] that starts at a, stays
 *  inside [a, hi] and has no gap in time. */
function runEnd(x: Vec, a: number, hi: number, P: (k: number) => number): number {
  let b = a;
  while (b + 1 <= hi && x[b + 1] === x[a] && P(b + 1) === P(b) + 1) b++;
  return b;
}

/** True when the maximal run x[a..b] is provably a local maximum in time:
 *  the time steps just before and after it are present and not higher. A
 *  neighbour that is missing (a gap, or the record edge) or higher (the series
 *  still rising beyond a search window) leaves the peak unresolved. */
function isLocalMax(x: Vec, a: number, b: number, P: (k: number) => number): boolean {
  const n = x.length;
  const leftOk = a - 1 >= 0 && P(a - 1) === P(a) - 1 && !(x[a - 1] > x[a]);
  const rightOk = b + 1 <= n - 1 && P(b + 1) === P(b) + 1 && !(x[b + 1] > x[b]);
  return leftOk && rightOk;
}

export interface EventError {
  obs: EventSpan;
  /** Time steps, positive = simulated peak late. NaN when the simulation is
   *  flat inside the search window (no peak to match) or its peak cannot be
   *  resolved (see EventReport.unresolved). */
  peakLag: number;
  /** 100·(simPeak − obsPeak)/obsPeak; NaN when the peak is unresolved. */
  peakMagErrPct: number;
  volumeErrPct: number;     // 100·(Σsim − Σobs)/Σobs over the obs event window (+ = over)
  /** The observed event has an overlapping simulated event (a hit). The
   *  summary means use matched events only; a miss has no simulated event. */
  matched: boolean;
}

export interface EventReport {
  threshold: number;
  events: EventError[];
  hits: number; misses: number; falseAlarms: number;
  threat: number;                       // hits/(hits+misses+false alarms), optimum 1
  /** Over matched events with a resolved peak. */
  meanAbsPeakLag: number; medianPeakLag: number;
  /** Mean volume error % over matched events. */
  meanVolumeErrPct: number;
  /** Mean signed peak-height error % across matched events with a resolved peak (Table 2 per-event row). */
  meanPeakErrPct: number;
  /** Observed events whose simulation was flat inside the search window. */
  flat?: number;
  /** Observed events whose peak (observed, or simulated in the search window)
   *  cannot be shown to be a local maximum: the simulated maximum sits on the
   *  window edge with the simulation still rising beyond it, or a peak sits
   *  next to missing values or the record edge. Lag and peak error are NaN. */
  unresolved?: number;
}

export function eventErrors(obs: Vec, sim: Vec, opt: EventOptions, matchTolerance: number, pos?: ArrayLike<number>): EventReport {
  const P = at(pos);
  const n = Math.min(obs.length, sim.length);
  const { events: obsEvents, threshold } = detectEvents(obs, opt, pos);
  const simEvents = detectEvents(sim, { ...opt, thresholdKind: 'absolute', thresholdValue: threshold }, pos).events;

  // Hit/miss/false-alarm bookkeeping by window overlap (± tolerance, in time
  // steps), one to one: the same matching as Series Distance (eventMatch.ts),
  // the most hits and then the least total peak distance, so the event
  // metrics and Series Distance pair the same events. A first-overlap pass
  // in time order gave as many hits but could mark the wrong observed event
  // as matched (a farther one), and then average its errors.
  const { simOf } = matchEvents(obsEvents.length, simEvents.length, overlapEdges(obsEvents, simEvents, matchTolerance, P));
  const hitSim = new Set<number>();
  const matched = obsEvents.map((_, i) => {
    if (simOf[i] >= 0) hitSim.add(simOf[i]);
    return simOf[i] >= 0;
  });
  const hits = matched.filter(Boolean).length;

  let flat = 0, unresolved = 0;
  const errors: EventError[] = obsEvents.map((e0, idx) => {
    // A flat-topped observed peak is dated at the middle of its plateau
    // (rounded down), as scipy.signal.find_peaks does; the simulated maximum
    // below follows the same rule, so identical series give lag 0.
    const oEnd = runEnd(obs, e0.peakIdx, e0.end, P);
    const e: EventSpan = { ...e0, peakIdx: Math.floor((e0.peakIdx + oEnd) / 2) };
    let lo = e.start, hi = e.end;
    while (lo - 1 >= 0 && P(lo - 1) >= P(e.start) - matchTolerance) lo--;
    while (hi + 1 <= n - 1 && P(hi + 1) <= P(e.end) + matchTolerance) hi++;
    let pk = lo, mn = lo;
    for (let j = lo; j <= hi; j++) { if (sim[j] > sim[pk]) pk = j; if (sim[j] < sim[mn]) mn = j; }
    // A plateau has no peak: the argmax would be the window edge, and a lag
    // read from it is an artefact of the window, not a timing error.
    const isFlat = sim[pk] === sim[mn];
    // A window-edge argmax with the simulation still rising beyond the window
    // (or with the step beyond it missing) is not the simulated peak; peak
    // timing (QA-011b) treats the same case as unresolved, and so does this.
    const sEnd = runEnd(sim, pk, hi, P);
    const resolved = !isFlat && isLocalMax(sim, pk, sEnd, P) && isLocalMax(obs, e0.peakIdx, oEnd, P);
    if (isFlat) flat++;
    else if (!resolved) unresolved++;
    const tSim = Math.floor((pk + sEnd) / 2);
    let vo = 0, vs = 0;
    for (let j = e.start; j <= e.end; j++) { vo += obs[j]; vs += sim[j]; }
    return {
      obs: e,
      peakLag: resolved ? P(tSim) - P(e.peakIdx) : NaN,
      peakMagErrPct: resolved || isFlat ? 100 * (sim[pk] - e.peakQ) / e.peakQ : NaN,
      volumeErrPct: 100 * (vs - vo) / vo,
      matched: matched[idx],
    };
  });

  const misses = obsEvents.length - hits;
  const falseAlarms = simEvents.length - hitSim.size;
  // Per-event errors are summarised over MATCHED events (paper Table 2: "for
  // each matched event"); a missed event has no simulated event, and the
  // largest sub-threshold value in its window is not a simulated peak. Misses
  // stay in the event table and are counted by the threat score.
  const hit = errors.filter(e => e.matched);
  const lags = hit.map(e => e.peakLag).filter(Number.isFinite);
  const peakErrs = hit.map(e => e.peakMagErrPct).filter(Number.isFinite);
  return {
    threshold, events: errors, hits, misses, falseAlarms,
    threat: hits + misses + falseAlarms > 0 ? hits / (hits + misses + falseAlarms) : NaN,
    meanAbsPeakLag: lags.length ? mean(lags.map(Math.abs)) : NaN,
    medianPeakLag: lags.length ? median(lags) : NaN,
    meanVolumeErrPct: hit.length ? mean(hit.map(e => e.volumeErrPct)) : NaN,
    meanPeakErrPct: peakErrs.length ? mean(peakErrs) : NaN,
    flat,
    unresolved,
  };
}

// ---------------- Gauch et al. (2021) peak-timing ----------------
export interface PeakMatch { tObs: number; tSim: number; lag: number; obsQ: number; simQ: number }
export interface PeakTimingResult {
  /** Obs peaks whose best sim match clamped at the window edge (excluded). */
  unresolved: number;
  /** Obs peaks whose simulation was flat inside the window (excluded). */
  flat?: number;
  /** Obs peaks skipped because their ±window runs past the start or end of the
   *  record or spans missing values (Gauch et al., 2021, reference code). */
  skipped?: number;
  meanAbsLag: number;       // paper headline
  meanSignedLag: number;    // "timing bias" (secondary)
  peaks: PeakMatch[];
  prominenceUsed: number;
  window: number;
}

/** Topographic prominence of a local maximum (scipy-compatible definition). */
function prominence(x: Vec, p: number): number {
  const n = x.length;
  let leftMin = x[p];
  for (let i = p - 1; i >= 0; i--) {
    if (x[i] > x[p]) break;
    if (x[i] < leftMin) leftMin = x[i];
  }
  let rightMin = x[p];
  for (let i = p + 1; i < n; i++) {
    if (x[i] > x[p]) break;
    if (x[i] < rightMin) rightMin = x[i];
  }
  return x[p] - Math.max(leftMin, rightMin);
}

/**
 * Peak-timing per Gauch et al. (2021; reference code: neuralhydrology
 * mean_peak_timing): observed peaks are local maxima (a flat top is dated at
 * its middle, as scipy.signal.find_peaks does) with prominence > threshold
 * (default σ of observed), separated by ≥ minDistance time steps (Gauch: 100);
 * each is matched to the largest simulated value inside ±window time steps;
 * the headline score is the mean |lag|. A peak whose window runs past the
 * record or spans missing values is skipped, as in the reference code.
 */
export function peakTiming(
  obs: Vec, sim: Vec,
  opts: { prominence?: 'auto' | number; minDistance?: number; window: number },
  pos?: ArrayLike<number>,
): PeakTimingResult {
  const P = at(pos);
  const n = Math.min(obs.length, sim.length);
  const W = opts.window;
  const promThr = opts.prominence === undefined || opts.prominence === 'auto' ? stdPop(obs) : opts.prominence;
  const minDist = opts.minDistance ?? 100;

  // Local maxima as scipy's _local_maxima_1d: a rise, then an optional flat
  // top, then a fall; the peak is the middle of the flat top (rounded down).
  const candidates: number[] = [];
  let i = 1;
  while (i < n - 1) {
    if (obs[i - 1] < obs[i]) {
      let ahead = i + 1;
      while (ahead < n - 1 && obs[ahead] === obs[i]) ahead++;
      if (obs[ahead] < obs[i]) {
        const mid = Math.floor((i + ahead - 1) / 2);
        if (prominence(obs, mid) > promThr) candidates.push(mid);
        i = ahead;
      }
    }
    i++;
  }
  // enforce min separation (in time steps), keeping the highest peaks first
  const keep: number[] = [];
  for (const p of [...candidates].sort((a, b) => obs[b] - obs[a])) {
    if (keep.every(q => Math.abs(P(q) - P(p)) >= minDist)) keep.push(p);
  }
  keep.sort((a, b) => a - b);

  // QA-011b: an argmax sitting ON the window boundary while the simulation is
  // still rising beyond it means the true peak lies outside the window. The
  // old code reported the clamped boundary lag as truth: a confidently wrong
  // number. Such pairs are UNRESOLVED: excluded from the means and counted.
  const peaks: PeakMatch[] = [];
  let unresolved = 0, flat = 0, skipped = 0;
  for (const t of keep) {
    const lo = t - W, hi = t + W;
    // The window must lie inside the record and contain no missing step:
    // the reference code skips such peaks ("NaNs that were removed ... would
    // result in windows that span too much time").
    if (lo < 0 || hi > n - 1 || P(hi) - P(lo) !== 2 * W) { skipped++; continue; }
    let m = lo, mn = lo;
    for (let j = lo; j <= hi; j++) { if (sim[j] > sim[m]) m = j; if (sim[j] < sim[mn]) mn = j; }
    // A flat simulation inside the window (a damped or scaled-to-zero series)
    // has no peak; the argmax would land on the window edge and report the
    // window itself as a lag. Such peaks are counted, not matched.
    if (sim[m] === sim[mn]) { flat++; continue; }
    const mEnd = runEnd(sim, m, hi, P);
    // Inside the window the run is a maximum by construction; at the window
    // edge the step beyond must exist and must not be higher.
    if (!isLocalMax(sim, m, mEnd, P)) { unresolved++; continue; }
    const tSim = Math.floor((m + mEnd) / 2);
    peaks.push({ tObs: t, tSim, lag: P(tSim) - P(t), obsQ: obs[t], simQ: sim[tSim] });
  }

  return {
    meanAbsLag: peaks.length ? mean(peaks.map(p => Math.abs(p.lag))) : NaN,
    meanSignedLag: peaks.length ? mean(peaks.map(p => p.lag)) : NaN,
    peaks,
    unresolved,
    flat,
    skipped,
    prominenceUsed: promThr,
    window: opts.window,
  };
}

// ---------------- lag sweep (§11.9) ----------------
export interface LagSweepRow { lag: number; nse: number; kge: number; r: number; w1: number }

/** Minimum overlap for a lag to be scored; shorter overlaps give NSE values
 *  that are noise, and a sweep of noise has no meaningful argmax. */
export const LAG_SWEEP_MIN_PAIRS = 10;

/** W₁ in time steps between two non-negative mass series placed on the time
 *  positions t (ascending): Σ |F_O − F_S| · Δt. On a gap-free support it is
 *  the same sum as wasserstein1(); across a gap the cumulative difference is
 *  carried over every missing step. */
function w1OnSupport(o: ArrayLike<number>, s: ArrayLike<number>, t: ArrayLike<number>): number {
  let so = 0, ss = 0;
  for (let i = 0; i < o.length; i++) {
    if (o[i] < 0 || s[i] < 0) return NaN;
    so += o[i]; ss += s[i];
  }
  if (so <= 0 || ss <= 0) return NaN;
  let co = 0, cs = 0, w = 0;
  for (let i = 0; i < o.length - 1; i++) {
    co += o[i] / so; cs += s[i] / ss;
    w += Math.abs(co - cs) * (t[i + 1] - t[i]);
  }
  return w;
}

/** Positive lag = simulation late: obs at time step p is paired with sim at
 *  time step p + lag, and a pair is used only when both values are finite
 *  (so a gap never pairs values from different distances). bestLag is NaN
 *  when no lag has a finite NSE (short or constant records) rather than the
 *  first lag of the sweep, and also when the NSE maximum lies outside the
 *  sweep: an argmax on the sweep edge with NSE still rising one step beyond
 *  it is the edge, not the offset (outOfRange = true). */
export function lagSweep(
  obs: ArrayLike<number>, sim: ArrayLike<number>, lo = -30, hi = 30, pos?: ArrayLike<number>,
): { rows: LagSweepRow[]; bestLag: number; outOfRange: boolean } {
  const P = at(pos);
  const n = Math.min(obs.length, sim.length, pos ? pos.length : Infinity);
  const score = (L: number): LagSweepRow => {
    const o: number[] = [], s: number[] = [], t: number[] = [];
    let j = 0;
    for (let k = 0; k < n; k++) {
      if (!Number.isFinite(obs[k])) continue;
      const target = P(k) + L;
      while (j < n && P(j) < target) j++;
      if (j >= n) break;
      if (P(j) === target && Number.isFinite(sim[j])) { o.push(obs[k]); s.push(sim[j]); t.push(P(k)); }
    }
    if (o.length < LAG_SWEEP_MIN_PAIRS) return { lag: L, nse: NaN, kge: NaN, r: NaN, w1: NaN };
    return { lag: L, nse: nse(o, s), kge: kge2009(o, s).value, r: pearsonR(o, s), w1: w1OnSupport(o, s, t) };
  };
  const rows: LagSweepRow[] = [];
  for (let L = lo; L <= hi; L++) rows.push(score(L));
  let best: LagSweepRow | null = null;
  for (const row of rows) if (Number.isFinite(row.nse) && (!best || row.nse > best.nse)) best = row;
  let outOfRange = false;
  if (best && (best.lag === lo || best.lag === hi)) {
    const beyond = score(best.lag === lo ? lo - 1 : hi + 1).nse;
    outOfRange = Number.isFinite(beyond) && beyond > best.nse;
  }
  return { rows, bestLag: best && !outOfRange ? best.lag : NaN, outOfRange };
}
