// Bridge between the store and the metrics engine.
// v1.0: subsetting (window/season/resample) is applied through a cached
// "frame", and the full metric panel is computed in a Web Worker so DTW /
// Wasserstein / XWT never block the UI (§18–19). Falls back to synchronous
// computation where Workers are unavailable (tests, very old browsers).

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

/** Full-record frame: analysis tabs always see the whole dataset. Subsetting
 *  is done in the Plots tab and materialised via commitSubsetDataset. */
export function frameFor(ds: Dataset): Frame {
  // targetUnit is part of the key: convertUnits rewrites the value arrays in
  // place under the same dataset id, and a unit-blind cache once served old-unit
  // observed values against new-unit simulations (catastrophic metric values).
  const key = ['full', ds.id, ds.dates.length, ds.targetUnit].join('|');
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
  const key = [ds.id, ds.dates.length, ds.targetUnit, JSON.stringify(v.window), JSON.stringify(v.season), v.resample].join('|');
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
type Job = { resolve: (o: unknown) => void; reject: (e: unknown) => void; onProgress?: (p: number) => void };

const workers: Partial<Record<'panel' | 'boot', Worker | null>> = {};
let seq = 0;
const jobs = new Map<number, Job>();

function getWorker(lane: 'panel' | 'boot' = 'panel'): Worker | null {
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
      if (error) job.reject(new Error(error)); else job.resolve(out);
    };
    worker.onerror = () => { workers[lane] = null; /* subsequent calls fall back or respawn */ };
  } catch { worker = null; }
  workers[lane] = worker;
  return worker;
}

function computeAsync(obs: Float64Array, sim: Float64Array, ctx: ComputeCtx): Promise<ComputeOutput> {
  const w = getWorker();
  if (!w) return Promise.resolve(computeAll(obs, sim, ctx));
  const id = ++seq;
  return new Promise((resolve, reject) => {
    jobs.set(id, { resolve: resolve as (o: unknown) => void, reject });
    w.postMessage({ id, task: 'panel', obs, sim, ctx });
  });
}

function bootstrapAsync(obs: Float64Array, sim: Float64Array, ctx: ComputeCtx, onProgress: (p: number) => void): Promise<BootstrapResult> {
  const w = getWorker('boot');
  if (!w) return Promise.resolve(bootstrapCIs(obs, sim, { nanPolicy: ctx.nanPolicy, transform: ctx.transform }));
  const id = ++seq;
  return new Promise((resolve, reject) => {
    jobs.set(id, { resolve: resolve as (o: unknown) => void, reject, onProgress });
    w.postMessage({ id, task: 'bootstrap', obs, sim, ctx, boot: { B: 500 } });
  });
}

// ------------------------------------------------------------ bootstrap ----
const ciCache = new Map<string, BootstrapResult>();
const ciPending = new Map<string, Promise<BootstrapResult>>();
const ciProgress = new Map<string, number>();

/** CI panels for all runs (single hook: stable order regardless of run count). */
export function useBootstrapCIsAll(ds: Dataset, runs: Run[], enabled: boolean): { results: (BootstrapResult | null)[]; progress: number } {
  useRecompute();
  if (!enabled) return { results: runs.map(() => null), progress: 0 };
  const frame = frameFor(ds);
  let pmin = 1;
  const results = runs.map(run => {
    const key = `${settingsKey(ds, frame)}|ci:${run.id}`;
    const hit = ciCache.get(key);
    if (hit) return hit;
    if (!ciPending.has(key)) {
      ciProgress.set(key, 0);
      const p = bootstrapAsync(frame.obs, frame.apply(run.values), ctxFor(ds, frame), pct => { ciProgress.set(key, pct); notify(); })
        .then(res => { if (ciCache.size > 40) ciCache.clear(); ciCache.set(key, res); ciPending.delete(key); notify(); return res; })
        .catch(err => { ciPending.delete(key); console.error('bootstrap failed', err); throw err; });
      ciPending.set(key, p);
    }
    pmin = Math.min(pmin, ciProgress.get(key) ?? 0);
    return null;
  });
  return { results, progress: results.every(r => r) ? 1 : pmin };
}

/** 95% block-bootstrap CIs for the classical rows; null while running. */
export function useBootstrapCIs(ds: Dataset, run: Run, enabled: boolean): { res: BootstrapResult | null; progress: number } {
  useRecompute();
  const frame = frameFor(ds);
  const key = `${settingsKey(ds, frame)}|ci:${run.id}`;
  if (!enabled) return { res: null, progress: 0 };
  const hit = ciCache.get(key);
  if (hit) return { res: hit, progress: 1 };
  if (!ciPending.has(key)) {
    ciProgress.set(key, 0);
    const p = bootstrapAsync(frame.obs, frame.apply(run.values), ctxFor(ds, frame), pct => {
      ciProgress.set(key, pct);
      notify();
    }).then(res => {
      if (ciCache.size > 40) ciCache.clear();
      ciCache.set(key, res);
      ciPending.delete(key);
      notify();
      return res;
    }).catch(err => { ciPending.delete(key); console.error('bootstrap failed', err); throw err; });
    ciPending.set(key, p);
  }
  return { res: null, progress: ciProgress.get(key) ?? 0 };
}

// --------------------------------------------------------------- caching ----
const outCache = new Map<string, ComputeOutput>();
const pending = new Map<string, Promise<ComputeOutput>>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(fn => fn());

function ctxFor(ds: Dataset, frame: Frame): ComputeCtx {
  return {
    nanPolicy: ds.view.nanPolicy,
    transform: ds.view.transform,
    timing: ds.view.timingConfig,
    datesMs: frame.dates,
  };
}

function settingsKey(ds: Dataset, frame: Frame): string {
  return [frame.key, ds.view.nanPolicy, ds.view.transform, JSON.stringify(ds.view.timingConfig), ds.targetUnit].join('|');
}

function request(key: string, make: () => Promise<ComputeOutput>): ComputeOutput | null {
  const hit = outCache.get(key);
  if (hit) return hit;
  if (!pending.has(key)) {
    const p = make().then(out => {
      if (outCache.size > 80) outCache.clear();
      outCache.set(key, out);
      pending.delete(key);
      notify();
      return out;
    }).catch(err => { pending.delete(key); console.error('compute failed', err); throw err; });
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
  outCache.set(key, out);
  return out;
}

/** Synchronous access used by unit tests and non-React callers. */
export function computeForRun(ds: Dataset, run: Run): ComputeOutput {
  const frame = frameFor(ds);
  const key = `${settingsKey(ds, frame)}|run:${run.id}`;
  const hit = outCache.get(key);
  if (hit) return hit;
  const out = computeAll(frame.obs, frame.apply(run.values), ctxFor(ds, frame));
  outCache.set(key, out);
  return out;
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

/** Metric panel for a committed run; null while the worker is busy (or run is null). */
export function useRunOutput(ds: Dataset, run: Run | null): ComputeOutput | null {
  useRecompute();
  if (!run) return null;
  const frame = frameFor(ds);
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

/** Metric panel for an arbitrary native-index series (sandbox); keyed by the caller. */
export function useSeriesOutput(ds: Dataset, seriesKey: string, series: ArrayLike<number> | null): ComputeOutput | null {
  useRecompute();
  const frame = frameFor(ds);
  const key = `${settingsKey(ds, frame)}|series:${seriesKey}`;
  if (!series) return null;
  return request(key, () => computeAsync(frame.obs, frame.apply(series), ctxFor(ds, frame)));
}

/** Test infrastructure: guarantee cold-cache pending paths in DOM tests. */
export function __resetComputeCachesForTests(): void {
  outCache.clear(); pending.clear(); frameCache.clear();
  ciCache.clear(); ciPending.clear(); ciProgress.clear();
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

/** Best value of a row across runs, honouring the metric's direction. */
export function bestIndex(values: number[], direction: 'max' | 'min' | 'zero' | 'one'): number {
  let best = -1, bestScore = Infinity;
  values.forEach((v, i) => {
    if (!isFinite(v)) return;
    const score = direction === 'max' ? -v : direction === 'min' ? v
      : direction === 'zero' ? Math.abs(v) : Math.abs(v - 1);
    if (score < bestScore) { bestScore = score; best = i; }
  });
  return best;
}
