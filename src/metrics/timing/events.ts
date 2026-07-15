// Event detection, per-event errors (§11.7), Gauch-style peak-timing (paper §4.5),
// and the interactive lag sweep (§11.9). Pure functions over paired arrays.

import { mean, stdPop, median, quantile, type Vec } from '../support/stats'
import { nse, kge2009, r as pearsonR } from '../classical/catalogue'
import { wasserstein1 } from './dtwWasserstein'

// ---------------- events ----------------
export interface EventSpan { start: number; end: number; peakIdx: number; peakQ: number }

export interface EventOptions {
  thresholdKind: 'percentile' | 'absolute';
  thresholdValue: number;    // percentile 0–100 or absolute in data units
  minDistance: number;       // merge events closer than this (steps)
  warmup: number;            // steps skipped at record start
}

export function detectEvents(x: Vec, opt: EventOptions): { events: EventSpan[]; threshold: number } {
  const thr = opt.thresholdKind === 'percentile' ? quantile(x, opt.thresholdValue / 100) : opt.thresholdValue;
  const spans: EventSpan[] = [];
  let i = Math.max(0, opt.warmup);
  const n = x.length;
  while (i < n) {
    if (x[i] > thr) {
      const start = i;
      while (i < n && x[i] > thr) i++;
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
    if (last && e.start - last.end < opt.minDistance) {
      last.end = e.end;
      if (e.peakQ > last.peakQ) { last.peakIdx = e.peakIdx; last.peakQ = e.peakQ; }
    } else merged.push({ ...e });
  }
  return { events: merged, threshold: thr };
}

export interface EventError {
  obs: EventSpan;
  peakLag: number;          // steps, positive = simulated peak late
  peakMagErrPct: number;    // 100·(simPeak − obsPeak)/obsPeak
  volumeErrPct: number;     // 100·(Σsim − Σobs)/Σobs over the obs event window
}

export interface EventReport {
  threshold: number;
  events: EventError[];
  hits: number; misses: number; falseAlarms: number;
  threat: number;                       // hits/(hits+misses+falseAlarms), optimum 1
  meanAbsPeakLag: number; medianPeakLag: number;
  meanVolumeErrPct: number;
  /** Mean signed peak-height error % across matched events (Table 2 per-event row). */
  meanPeakErrPct: number;
}

export function eventErrors(obs: Vec, sim: Vec, opt: EventOptions, matchTolerance: number): EventReport {
  const { events: obsEvents, threshold } = detectEvents(obs, opt);
  const simEvents = detectEvents(sim, { ...opt, thresholdKind: 'absolute', thresholdValue: threshold }).events;

  const errors: EventError[] = obsEvents.map(e => {
    const lo = Math.max(0, e.start - matchTolerance);
    const hi = Math.min(sim.length - 1, e.end + matchTolerance);
    let pk = lo;
    for (let j = lo; j <= hi; j++) if (sim[j] > sim[pk]) pk = j;
    let vo = 0, vs = 0;
    for (let j = e.start; j <= e.end; j++) { vo += obs[j]; vs += sim[j]; }
    return {
      obs: e,
      peakLag: pk - e.peakIdx,
      peakMagErrPct: 100 * (sim[pk] - e.peakQ) / e.peakQ,
      volumeErrPct: 100 * (vs - vo) / vo,
    };
  });

  // hit/miss/false-alarm bookkeeping by window overlap (± tolerance)
  const overlaps = (a: EventSpan, b: EventSpan) =>
    a.start - matchTolerance <= b.end && b.start - matchTolerance <= a.end;
  const hitSim = new Set<number>();
  let hits = 0;
  for (const oe of obsEvents) {
    const j = simEvents.findIndex((se, k) => !hitSim.has(k) && overlaps(oe, se));
    if (j >= 0) { hits++; hitSim.add(j); }
  }
  const misses = obsEvents.length - hits;
  const falseAlarms = simEvents.length - hitSim.size;
  const lags = errors.map(e => e.peakLag);
  return {
    threshold, events: errors, hits, misses, falseAlarms,
    threat: hits + misses + falseAlarms > 0 ? hits / (hits + misses + falseAlarms) : NaN,
    meanAbsPeakLag: lags.length ? mean(lags.map(Math.abs)) : NaN,
    medianPeakLag: lags.length ? median(lags) : NaN,
    meanVolumeErrPct: errors.length ? mean(errors.map(e => e.volumeErrPct)) : NaN,
    meanPeakErrPct: errors.length ? mean(errors.map(e => e.peakMagErrPct)) : NaN,
  };
}

// ---------------- Gauch et al. (2021) peak-timing ----------------
export interface PeakMatch { tObs: number; tSim: number; lag: number; obsQ: number; simQ: number }
export interface PeakTimingResult {
  /** Obs peaks whose best sim match clamped at the window edge (excluded). */
  unresolved: number;
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
 * Peak-timing per Gauch et al. (2021): observed peaks are local maxima with
 * prominence > threshold (default σ of observed) separated by ≥ minDistance
 * steps; each is matched to the largest simulated value inside ±window steps;
 * the headline score is the mean |lag|.
 */
export function peakTiming(
  obs: Vec, sim: Vec,
  opts: { prominence?: 'auto' | number; minDistance?: number; window: number },
): PeakTimingResult {
  const n = obs.length;
  const promThr = opts.prominence === undefined || opts.prominence === 'auto' ? stdPop(obs) : opts.prominence;
  const minDist = opts.minDistance ?? 100;

  const candidates: number[] = [];
  for (let i = 1; i < n - 1; i++) {
    if (obs[i] > obs[i - 1] && obs[i] >= obs[i + 1] && prominence(obs, i) > promThr) candidates.push(i);
  }
  // enforce min separation, keeping the highest peaks first
  const keep: number[] = [];
  for (const p of [...candidates].sort((a, b) => obs[b] - obs[a])) {
    if (keep.every(q => Math.abs(q - p) >= minDist)) keep.push(p);
  }
  keep.sort((a, b) => a - b);

  // QA-011b: an argmax sitting ON the window boundary while the simulation is
  // still rising beyond it means the true peak lies outside the window. The
  // old code reported the clamped boundary lag as truth — a confidently wrong
  // number. Such pairs are UNRESOLVED: excluded from the means and counted.
  const peaks: PeakMatch[] = [];
  let unresolved = 0;
  for (const t of keep) {
    const lo = Math.max(0, t - opts.window), hi = Math.min(n - 1, t + opts.window);
    let m = lo;
    for (let j = lo; j <= hi; j++) if (sim[j] > sim[m]) m = j;
    const clampedLo = m === lo && lo > 0 && sim[lo - 1] > sim[lo];
    const clampedHi = m === hi && hi < n - 1 && sim[hi + 1] > sim[hi];
    if (clampedLo || clampedHi) { unresolved++; continue; }
    peaks.push({ tObs: t, tSim: m, lag: m - t, obsQ: obs[t], simQ: sim[m] });
  }

  return {
    meanAbsLag: peaks.length ? mean(peaks.map(p => Math.abs(p.lag))) : NaN,
    meanSignedLag: peaks.length ? mean(peaks.map(p => p.lag)) : NaN,
    peaks,
    unresolved,
    prominenceUsed: promThr,
    window: opts.window,
  };
}

// ---------------- lag sweep (§11.9) ----------------
export interface LagSweepRow { lag: number; nse: number; kge: number; r: number; w1: number }

/** Positive lag = simulation late: obs[t] is paired with sim[t + lag]. */
export function lagSweep(obs: Vec, sim: Vec, lo = -30, hi = 30): { rows: LagSweepRow[]; bestLag: number } {
  const rows: LagSweepRow[] = [];
  for (let L = lo; L <= hi; L++) {
    const o: number[] = [], s: number[] = [];
    for (let t = 0; t < obs.length; t++) {
      const j = t + L;
      if (j >= 0 && j < sim.length) { o.push(obs[t]); s.push(sim[j]); }
    }
    rows.push({
      lag: L,
      nse: nse(o, s),
      kge: kge2009(o, s).value,
      r: pearsonR(o, s),
      w1: wasserstein1(o, s),
    });
  }
  let best = rows[0];
  for (const row of rows) if (row.nse > best.nse) best = row;
  return { rows, bestLag: best.lag };
}
