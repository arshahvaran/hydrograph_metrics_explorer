// Memoised bridge between the store and the metrics engine, plus the sandbox
// perturbation model (§13): S′(t) = m + (B(t−Δt) − m)·γ·(1−δ) + β + ε.

import { computeAll, type ComputeOutput } from '../metrics/registry'
import { mulberry32, gaussian, mean } from '../metrics/support/stats'
import type { Dataset, Run, SandboxState } from '../types'

const cache = new Map<string, ComputeOutput>();

function viewKey(ds: Dataset): string {
  const v = ds.view;
  return [ds.id, v.nanPolicy, v.transform, JSON.stringify(v.timingConfig), ds.dates.length, ds.targetUnit].join('|');
}

/** Full metric panel for one run, cached against the settings that affect it. */
export function computeForRun(ds: Dataset, run: Run): ComputeOutput {
  const key = `${viewKey(ds)}|${run.id}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const out = computeAll(ds.observed.values, run.values, {
    nanPolicy: ds.view.nanPolicy,
    transform: ds.view.transform,
    timing: ds.view.timingConfig,
    datesMs: ds.dates,
  });
  if (cache.size > 60) cache.clear();
  cache.set(key, out);
  return out;
}

/** Metric panel for an arbitrary series (sandbox), uncached. */
export function computeForSeries(ds: Dataset, series: ArrayLike<number>): ComputeOutput {
  return computeAll(ds.observed.values, series, {
    nanPolicy: ds.view.nanPolicy,
    transform: ds.view.transform,
    timing: ds.view.timingConfig,
    datesMs: ds.dates,
  });
}

/**
 * Apply the sandbox perturbation to a base series.
 * Positive shift = later; γ scales anomalies about the mean; δ dampens toward
 * the mean; β adds a constant; ε is seeded uniform or gaussian noise.
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
