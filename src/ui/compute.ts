// Bridge between the store and the metrics engine.
// v1.0: subsetting (window/season/resample) is applied through a cached
// "frame", and the full metric panel is computed in a Web Worker so DTW /
// Wasserstein / XWT never block the UI (§18–19). Falls back to synchronous
// computation where Workers are unavailable (tests, very old browsers).
// v1.13: jobs go through a per-lane queue (one in flight, sandbox slider
// positions coalesced), a worker that fails rejects every job with a message
// instead of leaving a permanent spinner, and the output cache evicts by
// recency and never clears wholesale (a 90-simulation dataset once cleared
// the cache on every 81st panel and recomputed forever).

import { computeAll, type ComputeOutput, type ComputeCtx } from '../metrics/registry'
import { bootstrapCIs, type BootstrapResult } from '../metrics/bootstrap'
import { applySubset } from '../metrics/subset'
import { mulberry32, gaussian, mean } from '../metrics/support/stats'
import { useEffect, useState } from 'react'
import type { Dataset, Run, SandboxState } from '../types'

// ---------------------------------------------------------------- frames ----
export interface Frame {
  dates: number[];
  obs: Float64Array;
  step: { ms: number; label: string };
  caption: string;
  /** Map any native-index series through the same window/season/resample. */
  apply: (values: ArrayLike<number>) => Float64Array;
  key: string;
}

const frameCache = new Map<string, Frame>();
const areaKey = (ds: Dataset) => (ds.area ? `${ds.area.value}${ds.area.unit}` : 'noarea');

/** Full-record frame: analysis tabs always see the whole dataset. Subsetting
 *  is done in the Plots tab and materialised via commitSubsetDataset. */
export function frameFor(ds: Dataset): Frame {
  // targetUnit is part of the key: convertUnits rewrites the value arrays in
  // place under the same dataset id, and a unit-blind cache once served old-unit
  // observed values against new-unit simulations (catastrophic metric values).
  // ...and so is the catchment area: depth<->volume values depend on it (audit compute-08)
  const key = ['full', ds.id, ds.dates.length, ds.targetUnit, areaKey(ds)].join('|');
  const hit = frameCache.get(key);
  if (hit) return hit;
  const frame: Frame = {
    dates: ds.dates,
    obs: Float64Array.from(ds.observed.values as ArrayLike<number>),
    step: { ms: ds.step.ms, label: ds.step.label },
    caption: '',
    key,
    apply: (values) => Float64Array.from(values as ArrayLike<number>),
  };
  if (frameCache.size > 40) frameCache.clear();
  frameCache.set(key, frame);
  return frame;
}

/** Subset preview for the Plots tab only (window / season / resample). */
export function subsetFrameFor(ds: Dataset): Frame {
  const v = ds.view;
  // The dataset id sits second in every frame key (after the frame kind) so
  // the cache eviction below can tell which dataset a cached panel belongs to.
  const key = ['subset', ds.id, ds.dates.length, ds.targetUnit, areaKey(ds), JSON.stringify(v.window), JSON.stringify(v.season), v.resample].join('|');
  const hit = frameCache.get(key);
  if (hit) return hit;
  const base = applySubset(ds.dates, [ds.observed.values], v, ds.step);
  const frame: Frame = {
    dates: base.dates, obs: base.obs, step: base.step, caption: base.caption, key,
    apply: (values) => applySubset(ds.dates, [values], v, ds.step).obs,
  };
  if (frameCache.size > 40) frameCache.clear();
  frameCache.set(key, frame);
  return frame;
}

// ------------------------------------------------------------- async core ---
type Lane = 'panel' | 'boot';
type Job = { resolve: (o: unknown) => void; reject: (e: unknown) => void; onProgress?: (p: number) => void };
interface Queued { id: number; msg: Record<string, unknown>; job: Job; coalesce?: string }

export const WORKER_STALE_MESSAGE = 'The background computation could not run; this page is likely running a stale copy of the tool. Reload the page and try again.';

/** A queued job that a newer job with the same coalesce tag made pointless
 *  (a sandbox slider position the user has already moved past), or a
 *  bootstrap the user switched off. Quiet: never shown, never logged. */
export class SupersededError extends Error {
  constructor(message = 'superseded') { super(message); this.name = 'SupersededError'; }
}

const workers: Partial<Record<Lane, Worker | null>> = {};
let seq = 0;
const jobs = new Map<number, Job>();
/** Jobs posted to the worker and not yet answered, per lane. */
const inFlight: Record<Lane, Set<number>> = { panel: new Set(), boot: new Set() };
/** Coalesce-tagged jobs held back while the lane is busy. */
const queues: Record<Lane, Queued[]> = { panel: [], boot: [] };

function failLane(lane: Lane, err: Error): void {
  for (const id of inFlight[lane]) { const job = jobs.get(id); jobs.delete(id); job?.reject(err); }
  inFlight[lane].clear();
  for (const q of queues[lane].splice(0)) q.job.reject(err);
}

function getWorker(lane: Lane): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (workers[lane]) return workers[lane]!;
  let worker: Worker | null = null;
  try {
    worker = new Worker(new URL('../metrics/worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent) => {
      const { id, out, error, progress } = e.data as { id: number; out?: unknown; error?: string; progress?: number };
      const job = jobs.get(id);
      if (!job) return;
      if (progress != null) { job.onProgress?.(progress); return; }
      jobs.delete(id);
      inFlight[lane].delete(id);
      if (error) job.reject(new Error(error)); else job.resolve(out);
      pump(lane);
    };
    worker.onerror = () => {
      // The worker could not start (typically a stale chunk URL after a
      // redeploy) or died mid-job (out of memory): every job on the lane
      // fails with a message, so no tab is left on a permanent spinner.
      workers[lane] = null;
      failLane(lane, new Error(WORKER_STALE_MESSAGE));
    };
  } catch { worker = null; }
  workers[lane] = worker;
  return worker;
}

function post(lane: Lane, q: Queued): void {
  const w = getWorker(lane);
  if (!w) { q.job.reject(new Error(WORKER_STALE_MESSAGE)); return; }
  inFlight[lane].add(q.id);
  jobs.set(q.id, q.job);
  try { w.postMessage({ id: q.id, ...q.msg }); }
  catch (e) { inFlight[lane].delete(q.id); jobs.delete(q.id); q.job.reject(e); }
}

/** Release the held jobs once the lane is idle: the newest job per coalesce
 *  tag is posted, the older ones (slider positions already moved past) are
 *  superseded without ever reaching the worker. */
function pump(lane: Lane): void {
  if (inFlight[lane].size || !queues[lane].length) return;
  const held = queues[lane].splice(0);
  const newest = new Map<string, Queued>();
  for (const q of held) if (q.coalesce) newest.set(q.coalesce, q);
  for (const q of held) {
    if (q.coalesce && newest.get(q.coalesce) !== q) { q.job.reject(new SupersededError()); continue; }
    post(lane, q);
  }
}

/** Untagged jobs go to the worker at once (it serves them in order); tagged
 *  jobs wait while anything is in flight so that a burst collapses to its
 *  last member. */
function enqueue<T>(lane: Lane, msg: Record<string, unknown>, coalesce?: string, onProgress?: (p: number) => void): Promise<T> {
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    const q: Queued = { id, msg, job: { resolve: resolve as (o: unknown) => void, reject, onProgress }, coalesce };
    if (coalesce && inFlight[lane].size) queues[lane].push(q);
    else post(lane, q);
  });
}

function computeAsync(obs: Float64Array, sim: Float64Array, ctx: ComputeCtx, coalesce?: string): Promise<ComputeOutput> {
  if (!getWorker('panel')) return Promise.resolve(computeAll(obs, sim, ctx));
  return enqueue<ComputeOutput>('panel', { task: 'panel', obs, sim, ctx }, coalesce);
}

function bootstrapAsync(obs: Float64Array, sim: Float64Array, ctx: ComputeCtx, onProgress: (p: number) => void): Promise<BootstrapResult> {
  if (!getWorker('boot')) return Promise.resolve(bootstrapCIs(obs, sim, { nanPolicy: ctx.nanPolicy, transform: ctx.transform }));
  return enqueue<BootstrapResult>('boot', { task: 'bootstrap', obs, sim, ctx, boot: { B: 500 } }, undefined, onProgress);
}

// ------------------------------------------------------------ bootstrap ----
const ciCache = new Map<string, BootstrapResult>();
const ciPending = new Map<string, Promise<BootstrapResult>>();
const ciProgress = new Map<string, number>();

/** Stop every running or queued bootstrap: the user unticked the box, and 500
 *  replicates per simulation should not keep a core busy for minutes. */
export function cancelBootstrap(): void {
  if (!ciPending.size && !inFlight.boot.size && !queues.boot.length) return;
  const w = workers.boot;
  if (w) { try { w.terminate(); } catch { /* already gone */ } workers.boot = null; }
  failLane('boot', new SupersededError('cancelled'));
  ciPending.clear();
  ciProgress.clear();
}

function startBootstrap(key: string, frame: Frame, ds: Dataset, run: Run): void {
  ciProgress.set(key, 0);
  const p = bootstrapAsync(frame.obs, frame.apply(run.values), ctxFor(ds, frame), pct => { ciProgress.set(key, pct); notify(); })
    .then(res => { if (ciCache.size > 40) ciCache.clear(); ciCache.set(key, res); ciPending.delete(key); notify(); return res; })
    .catch(err => {
      ciPending.delete(key);
      if (!(err instanceof SupersededError)) { errors.set(key, describe(err)); console.error('bootstrap failed', err); notify(); }
      throw err;
    });
  p.catch(() => { /* surfaced through the error map */ });
  ciPending.set(key, p);
}

/** CI panels for all runs (single hook: stable order regardless of run count). */
export function useBootstrapCIsAll(ds: Dataset, runs: Run[], enabled: boolean): { results: (BootstrapResult | null)[]; progress: number } {
  useRecompute();
  useEffect(() => { if (!enabled) cancelBootstrap(); }, [enabled]);
  if (!enabled) return { results: runs.map(() => null), progress: 0 };
  const frame = frameFor(ds);
  let pmin = 1;
  const results = runs.map(run => {
    const key = `${settingsKey(ds, frame)}|ci:${run.id}`;
    const hit = ciCache.get(key);
    if (hit) return hit;
    if (errors.has(key)) return null;
    if (!ciPending.has(key)) startBootstrap(key, frame, ds, run);
    pmin = Math.min(pmin, ciProgress.get(key) ?? 0);
    return null;
  });
  return { results, progress: results.every(r => r) ? 1 : pmin };
}

/** 95% block-bootstrap CIs for the classical rows; null while running. */
export function useBootstrapCIs(ds: Dataset, run: Run, enabled: boolean): { res: BootstrapResult | null; progress: number } {
  useRecompute();
  useEffect(() => { if (!enabled) cancelBootstrap(); }, [enabled]);
  const frame = frameFor(ds);
  const key = `${settingsKey(ds, frame)}|ci:${run.id}`;
  if (!enabled) return { res: null, progress: 0 };
  const hit = ciCache.get(key);
  if (hit) return { res: hit, progress: 1 };
  if (errors.has(key)) return { res: null, progress: 0 };
  if (!ciPending.has(key)) startBootstrap(key, frame, ds, run);
  return { res: null, progress: ciProgress.get(key) ?? 0 };
}

// --------------------------------------------------------------- caching ----
const CACHE_CAP = 200;
const outCache = new Map<string, ComputeOutput>();
const pending = new Map<string, Promise<ComputeOutput>>();
/** Panels that failed, by key; a failed key is never re-requested (the same
 *  settings would fail again), the tabs show the message instead. */
const errors = new Map<string, string>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(fn => fn());

/** Compute context of a dataset on a frame. The DTW band is a count of the
 *  dataset's steps (design rule D6); on a resampled Plots-tab frame it is
 *  converted to the frame's step (±24 hourly steps are ±1 daily step, not
 *  ±24 days), at least 1 step. */
export function ctxFor(ds: Dataset, frame: Frame): ComputeCtx {
  const timing = ds.view.timingConfig;
  const stepRatio = ds.step.ms > 0 && frame.step.ms > 0 ? ds.step.ms / frame.step.ms : 1;
  const dtwBand = stepRatio === 1 ? timing.dtwBand : Math.max(1, Math.round(timing.dtwBand * stepRatio));
  return {
    nanPolicy: ds.view.nanPolicy,
    transform: ds.view.transform,
    timing: dtwBand === timing.dtwBand ? timing : { ...timing, dtwBand },
    datesMs: frame.dates,
  };
}

function settingsKey(ds: Dataset, frame: Frame): string {
  return [frame.key, ds.view.nanPolicy, ds.view.transform, JSON.stringify(ds.view.timingConfig), ds.targetUnit].join('|');
}

/** Dataset id carried by a cache key (second field of every frame key). */
const dsOf = (key: string): string => key.split('|')[1] ?? '';

function describe(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg === WORKER_STALE_MESSAGE) return msg;
  return `Metrics could not be computed for this simulation: ${msg}.`;
}

/** Insert with recency-based eviction. Victims, in order: panels of other
 *  datasets (oldest first), then this dataset's sandbox series, then anything
 *  oldest. The active dataset's own simulation panels therefore stay cached
 *  while it is being viewed, whatever its simulation count. */
function remember(key: string, out: ComputeOutput): void {
  outCache.delete(key);
  outCache.set(key, out);
  if (outCache.size <= CACHE_CAP) return;
  const ds = dsOf(key);
  const evict = (pick: (k: string) => boolean): boolean => {
    for (const k of outCache.keys()) {
      if (!pick(k)) continue;
      outCache.delete(k);
      if (outCache.size <= CACHE_CAP) return true;
    }
    return false;
  };
  if (evict(k => dsOf(k) !== ds)) return;
  if (evict(k => k.includes('|series:'))) return;
  evict(() => true);
}

function request(key: string, make: () => Promise<ComputeOutput>): ComputeOutput | null {
  const hit = outCache.get(key);
  if (hit) return hit;
  if (errors.has(key)) return null;
  if (!pending.has(key)) {
    const p = make().then(out => {
      remember(key, out);
      pending.delete(key);
      notify();
      return out;
    }).catch(err => {
      pending.delete(key);
      if (!(err instanceof SupersededError)) { errors.set(key, describe(err)); console.error('compute failed', err); notify(); }
      throw err;
    });
    p.catch(() => { /* surfaced through the error map */ });
    pending.set(key, p);
  }
  return null;
}

/** Await-style access (report generator, ranking). */
export async function computeForRunAsync(ds: Dataset, run: Run): Promise<ComputeOutput> {
  const frame = frameFor(ds);
  const key = `${settingsKey(ds, frame)}|run:${run.id}`;
  const hit = outCache.get(key);
  if (hit) return hit;
  const out = await (pending.get(key) ?? computeAsync(frame.obs, frame.apply(run.values), ctxFor(ds, frame)));
  remember(key, out);
  return out;
}

/** Synchronous access used by unit tests and non-React callers. */
export function computeForRun(ds: Dataset, run: Run): ComputeOutput {
  const frame = frameFor(ds);
  const key = `${settingsKey(ds, frame)}|run:${run.id}`;
  const hit = outCache.get(key);
  if (hit) return hit;
  const out = computeAll(frame.obs, frame.apply(run.values), ctxFor(ds, frame));
  remember(key, out);
  return out;
}

/** First recorded failure among a dataset's panels and CIs under its
 *  current settings, or null. Tabs show this instead of their pending card,
 *  so a failed computation ends in a message rather than a spinner. Scoped
 *  to the settings key: a failure under one band or transform once stayed on
 *  the Metrics tab after a later job under other settings had succeeded,
 *  until the page was reloaded. `frame` names the frame whose panels are
 *  meant (the alignment plot computes on the subset frame). */
export function computeErrorFor(ds: Dataset, frame: Frame = frameFor(ds)): string | null {
  const prefix = `${settingsKey(ds, frame)}|`;
  for (const [k, msg] of errors) if (k.startsWith(prefix)) return msg;
  return null;
}

// ----------------------------------------------------------------- hooks ----
function useRecompute(): void {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force(x => x + 1);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);
}

/** Hook form of computeErrorFor. */
export function useComputeError(ds: Dataset, frame?: Frame): string | null {
  useRecompute();
  return computeErrorFor(ds, frame);
}

/** Metric panel for a committed run; null while the worker is busy (or run is null). */
export function useRunOutput(ds: Dataset, run: Run | null): ComputeOutput | null {
  useRecompute();
  if (!run) return null;
  const frame = frameFor(ds);
  const key = `${settingsKey(ds, frame)}|run:${run.id}`;
  return request(key, () => computeAsync(frame.obs, frame.apply(run.values), ctxFor(ds, frame)));
}

/** Metric panel computed on the Plots-tab subset frame (window / season /
 *  resample), for the DTW alignment plot: the alignment must be computed on
 *  exactly the series being displayed, or the ties join the wrong rows.
 *  Analysis tabs keep using the full-record frame (useRunOutput). */
export function useSubsetRunOutput(ds: Dataset, run: Run | null): ComputeOutput | null {
  useRecompute();
  if (!run) return null;
  const frame = subsetFrameFor(ds);
  const key = `${settingsKey(ds, frame)}|run:${run.id}`;
  return request(key, () => computeAsync(frame.obs, frame.apply(run.values), ctxFor(ds, frame)));
}

/** Metric panels for all visible runs; null entries are still computing. */
export function useRunOutputs(ds: Dataset, runs: Run[]): (ComputeOutput | null)[] {
  useRecompute();
  const frame = frameFor(ds);
  return runs.map(run => {
    const key = `${settingsKey(ds, frame)}|run:${run.id}`;
    return request(key, () => computeAsync(frame.obs, frame.apply(run.values), ctxFor(ds, frame)));
  });
}

/** Metric panel for an arbitrary native-index series (sandbox); keyed by the
 *  caller. Jobs carrying the same `coalesce` tag replace one another in the
 *  queue, so a slider drag computes the latest position, not every position. */
export function useSeriesOutput(ds: Dataset, seriesKey: string, series: ArrayLike<number> | null, coalesce?: string): ComputeOutput | null {
  useRecompute();
  const frame = frameFor(ds);
  const key = `${settingsKey(ds, frame)}|series:${seriesKey}`;
  if (!series) return null;
  return request(key, () => computeAsync(frame.obs, frame.apply(series), ctxFor(ds, frame), coalesce));
}

/** Test infrastructure: guarantee cold-cache pending paths in DOM tests. */
export function __resetComputeCachesForTests(): void {
  outCache.clear(); pending.clear(); frameCache.clear(); errors.clear();
  ciCache.clear(); ciPending.clear(); ciProgress.clear();
  // forget the workers too, so a test can install its own Worker global
  for (const lane of ['panel', 'boot'] as Lane[]) { failLane(lane, new SupersededError('reset')); workers[lane] = null; }
}

/** Test infrastructure: the cached panel keys, oldest first. */
export function __cacheKeysForTests(): string[] {
  return [...outCache.keys()];
}

// ------------------------------------------------------------ perturbation --
/**
 * Sandbox model (§13): S′(t) = m + (B(t−Δt) − m)·γ·(1−δ) + β + ε, on the
 * native index (subsetting is applied downstream by the frame).
 */
export function perturb(base: ArrayLike<number>, s: SandboxState): Float64Array {
  const n = base.length;
  const finite: number[] = [];
  for (let i = 0; i < n; i++) if (isFinite(base[i])) finite.push(base[i]);
  const m = finite.length ? mean(finite) : 0;
  const rng = mulberry32(s.noiseSeed);
  const gauss = gaussian(rng);
  const out = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    const src = Math.min(n - 1, Math.max(0, t - s.shiftSteps));
    const b = base[src];
    if (!isFinite(b)) { out[t] = NaN; continue; }
    let v = m + (b - m) * s.scale * (1 - s.dampen) + s.offset;
    if (s.noiseAmp > 0) v += s.noiseKind === 'gaussian' ? s.noiseAmp * gauss() : s.noiseAmp * (2 * rng() - 1);
    out[t] = v;
  }
  return out;
}

/** Every run whose value ties the best one (the same score under bestIndex's
 *  rule, e.g. +2 and -2 steps for a target-zero metric), so ties are all marked. */
export function bestIndices(values: number[], direction: 'max' | 'min' | 'zero' | 'one'): Set<number> {
  const b = bestIndex(values, direction);
  const out = new Set<number>();
  if (b < 0) return out;
  values.forEach((v, i) => { if (isFinite(v) && bestIndex([v, values[b]], direction) === 0) out.add(i); });
  return out;
}

/** Best value of a row across runs, honouring the metric's direction. A
 *  'min' metric (optimum 0, range [0, ∞)) is scored by its distance to 0, as
 *  the composite ranking does (rank.ts scoreMetric): a value below 0 is out of
 *  range, not better, and once underlined the larger error. */
export function bestIndex(values: number[], direction: 'max' | 'min' | 'zero' | 'one'): number {
  let best = -1, bestScore = Infinity;
  values.forEach((v, i) => {
    if (!isFinite(v)) return;
    const score = direction === 'max' ? -v
      : direction === 'min' || direction === 'zero' ? Math.abs(v) : Math.abs(v - 1);
    if (score < bestScore) { bestScore = score; best = i; }
  });
  return best;
}
