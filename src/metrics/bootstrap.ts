// Block-bootstrap confidence intervals for the synchronous metric families
// (spec §21 v1.1 item, pulled into CP8 per the project checkpoint plan).
//
// Method: circular moving-block bootstrap on exactly the pairs the point
// estimate uses: the NaN policy, then the evaluation transform (applied once,
// with ε from the full record), then the drop of pairs the transform made
// non-finite, as in computeAll. Block length follows Politis & White (2004)
// with the Patton, Politis & White (2009) correction, computed on the error
// series S − O so that it grows with the persistence of the errors (a fixed
// n^(1/3) broke most of that dependence and the intervals under-covered);
// it is bounded to [3, n/4]. CIs are percentile intervals. MASE keeps the
// naive-forecast scale of the original ordered record: resampled blocks
// splice unrelated steps, which inflated a replicate's own scale.
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
  /** Set when no interval was computed: why, in user-facing words. */
  reason?: string;
}

/** Below this many valid pairs a block bootstrap cannot form enough distinct
 *  blocks and the intervals collapse to zero width (n = 2 once yielded exact
 *  CIs); above the upper cap the 500 replicates take minutes per simulation
 *  in the worker and cannot be interrupted. */
export const BOOTSTRAP_MIN_N = 30;
export const BOOTSTRAP_MAX_N = 100_000;

/** The former fixed rule, kept for callers that pass no series. */
export function defaultBlockLen(n: number): number {
  return Math.max(3, Math.round(Math.cbrt(n)));
}

/**
 * Automatic block length for the circular block bootstrap (Politis & White,
 * 2004; corrected by Patton, Politis & White, 2009), from the sample
 * autocovariances of `x`, with the flat-top lag window and their rule for the
 * bandwidth (c = 2, K_N = max(5, ⌈√log10 n⌉)). Bounded to [3, n/4].
 */
export function autoBlockLen(x: ArrayLike<number>): number {
  const n = x.length;
  const lo = 3, hi = Math.max(3, Math.floor(n / 4));
  if (n < 12) return lo;
  let m0 = 0; for (let i = 0; i < n; i++) m0 += x[i]; m0 /= n;
  const maxLag = Math.min(n - 1, Math.max(20, Math.ceil(Math.min(3 * Math.sqrt(n), n / 3))));
  const R = new Float64Array(maxLag + 1);
  for (let k = 0; k <= maxLag; k++) {
    let acc = 0; for (let i = k; i < n; i++) acc += (x[i] - m0) * (x[i - k] - m0);
    R[k] = acc / n;
  }
  if (!(R[0] > 0)) return lo;
  const rho = (k: number) => R[k] / R[0];
  const KN = Math.max(5, Math.ceil(Math.sqrt(Math.log10(n))));
  const crit = 2 * Math.sqrt(Math.log10(n) / n);
  // smallest m such that the next KN autocorrelations are all insignificant
  let mHat = maxLag;
  for (let m = 0; m + KN <= maxLag; m++) {
    let ok = true;
    for (let k = 1; k <= KN; k++) if (Math.abs(rho(m + k)) >= crit) { ok = false; break; }
    if (ok) { mHat = m; break; }
  }
  const M = Math.min(2 * Math.max(mHat, 1), maxLag);
  const lam = (t: number) => { const a = Math.abs(t); return a <= 0.5 ? 1 : a <= 1 ? 2 * (1 - a) : 0; };
  let G = 0, g0 = 0;
  for (let k = -M; k <= M; k++) {
    const w = lam(k / M), r = R[Math.abs(k)];
    G += w * Math.abs(k) * r;
    g0 += w * r;
  }
  const D = (4 / 3) * g0 * g0;                      // circular block bootstrap
  if (!(D > 0) || !Number.isFinite(G)) return lo;
  const b = Math.pow((2 * G * G) / D, 1 / 3) * Math.pow(n, 1 / 3);
  return Math.min(hi, Math.max(lo, Math.round(b)));
}

export function bootstrapCIs(
  obsRaw: ArrayLike<number>,
  simRaw: ArrayLike<number>,
  ctx: { nanPolicy: NanPolicy; transform: Transform },
  opts: BootstrapOptions = {},
): BootstrapResult {
  const paired0 = applyNanPolicy(obsRaw, simRaw, ctx.nanPolicy);
  // the transform is applied once, on the whole record (its ε from the full
  // observed mean), and pairs it makes non-finite are dropped: the same
  // sample the point estimate is computed on
  const tr = applyTransform(paired0.obs, paired0.sim, ctx.transform);
  const keep: number[] = [];
  for (let i = 0; i < tr.o.length; i++) if (Number.isFinite(tr.o[i]) && Number.isFinite(tr.s[i])) keep.push(i);
  const paired = { obs: Float64Array.from(keep, i => tr.o[i]), sim: Float64Array.from(keep, i => tr.s[i]) };
  const n = paired.obs.length;
  const B = opts.B ?? 500;
  const err = Float64Array.from({ length: n }, (_, i) => paired.sim[i] - paired.obs[i]);
  const L = opts.blockLen ?? autoBlockLen(err);
  // MASE scale: the one-step naive error of the ORIGINAL ordered record
  let naive = 0; for (let i = 1; i < n; i++) naive += Math.abs(paired.obs[i] - paired.obs[i - 1]);
  naive = n > 1 ? naive / (n - 1) : NaN;
  const alpha = opts.alpha ?? 0.05;
  const seed = opts.seed ?? 12345;
  const num = (v: number) => v.toLocaleString('en-US');
  if (n < BOOTSTRAP_MIN_N) {
    return { cis: {}, B: 0, blockLen: L, n, seed, reason: `Bootstrap CIs need at least ${BOOTSTRAP_MIN_N} valid pairs; this simulation has ${num(n)}.` };
  }
  if (n > BOOTSTRAP_MAX_N) {
    return { cis: {}, B: 0, blockLen: L, n, seed, reason: `Bootstrap CIs are available for records with up to ${num(BOOTSTRAP_MAX_N)} valid pairs; this record has ${num(n)}. Use an analysis window or resample to daily or monthly means first.` };
  }
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
    const { values } = classicalValues(ro, rs);
    values.mase = naive > 0 && Number.isFinite(values.mae) ? values.mae / naive : NaN;
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
