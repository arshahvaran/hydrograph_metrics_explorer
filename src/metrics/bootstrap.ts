// Block-bootstrap confidence intervals for the synchronous metric families
// (spec §21 v1.1 item, pulled into CP8 per the project checkpoint plan).
//
// Method: circular moving-block bootstrap on the *paired* index (after the
// NaN policy), block length L = max(3, round(n^(1/3))) unless overridden,
// the standard rate that preserves short-range autocorrelation. Each
// replicate re-applies the evaluation transform (its ε depends on the
// resampled mean of O), then evaluates the classical block. CIs are
// percentile intervals.
//
// Timing-/shape-aware metrics are deliberately excluded: resampling blocks
// destroys the very time axis those metrics measure (a peak lag on a
// spliced series is meaningless). Their rows display "CI n/a" with this
// explanation: an honest statistical limitation, not an omission.

import { applyNanPolicy, type NanPolicy } from '../ingest/missing'
import { applyTransform, type Transform } from './classical/catalogue'
import { classicalValues } from './registry'
import { mulberry32 } from './support/stats'

export interface BootstrapOptions {
  B?: number;            // replicates (default 500)
  blockLen?: number;     // default max(3, round(n^(1/3)))
  alpha?: number;        // two-sided level (default 0.05 → 95% CI)
  seed?: number;         // default 12345 (reproducible reports)
  onProgress?: (done: number, total: number) => void;
}

export interface BootstrapResult {
  cis: Record<string, [number, number]>;
  B: number;
  blockLen: number;
  n: number;
  seed: number;
}

export function defaultBlockLen(n: number): number {
  return Math.max(3, Math.round(Math.cbrt(n)));
}

export function bootstrapCIs(
  obsRaw: ArrayLike<number>,
  simRaw: ArrayLike<number>,
  ctx: { nanPolicy: NanPolicy; transform: Transform },
  opts: BootstrapOptions = {},
): BootstrapResult {
  const paired = applyNanPolicy(obsRaw, simRaw, ctx.nanPolicy);
  const n = paired.obs.length;
  const B = opts.B ?? 500;
  const L = opts.blockLen ?? defaultBlockLen(n);
  const alpha = opts.alpha ?? 0.05;
  const seed = opts.seed ?? 12345;
  const rng = mulberry32(seed);

  const samples = new Map<string, number[]>();
  const ro = new Float64Array(n), rs = new Float64Array(n);
  const nBlocks = Math.ceil(n / L);

  for (let b = 0; b < B; b++) {
    let k = 0;
    for (let blk = 0; blk < nBlocks && k < n; blk++) {
      const start = Math.floor(rng() * n);
      for (let j = 0; j < L && k < n; j++, k++) {
        const idx = (start + j) % n;               // circular
        ro[k] = paired.obs[idx];
        rs[k] = paired.sim[idx];
      }
    }
    const { o, s } = applyTransform(ro, rs, ctx.transform);
    const { values } = classicalValues(o, s);
    for (const id in values) {
      let arr = samples.get(id);
      if (!arr) { arr = []; samples.set(id, arr); }
      arr.push(values[id]);
    }
    if (opts.onProgress && (b % 25 === 24 || b === B - 1)) opts.onProgress(b + 1, B);
  }

  const cis: Record<string, [number, number]> = {};
  const loQ = alpha / 2, hiQ = 1 - alpha / 2;
  for (const [id, arr] of samples) {
    const fin = arr.filter(isFinite).sort((a, z) => a - z);
    if (fin.length < arr.length * 0.8 || fin.length < 20) { cis[id] = [NaN, NaN]; continue; }
    const q = (p: number) => {
      const pos = p * (fin.length - 1);
      const i = Math.floor(pos), f = pos - i;
      return i + 1 < fin.length ? fin[i] * (1 - f) + fin[i + 1] * f : fin[i];
    };
    cis[id] = [q(loQ), q(hiQ)];
  }
  return { cis, B, blockLen: L, n, seed };
}
