/** Missing-value token handling (§6.0) and NaN policies (§10.4). */

const BASE_TOKENS = new Set(['', 'na', 'nan', 'null', 'n/a', '-', '--', '---', 'none', 'missing']);

export interface MissingOptions {
  /** Treat -9999 / -999 sentinels as missing (default true, spec §6.0). */
  sentinels?: boolean;
}

/** Parse a raw cell into a number, mapping missing tokens to NaN. */
export function parseValue(raw: string | number | null | undefined, opts: MissingOptions = {}): number {
  const sentinels = opts.sentinels ?? true;
  if (raw === null || raw === undefined) return NaN;
  if (typeof raw === 'number') {
    if (sentinels && (raw === -9999 || raw === -999)) return NaN;
    return raw;
  }
  const s = raw.trim();
  if (BASE_TOKENS.has(s.toLowerCase())) return NaN;
  const v = Number(s.replace(/,/g, '')); // tolerate thousands separators
  if (!isFinite(v)) return NaN;
  if (sentinels && (v === -9999 || v === -999)) return NaN;
  return v;
}

export type NanPolicy = 'pairwise' | 'zero' | 'mean';

export interface Paired {
  obs: Float64Array;
  sim: Float64Array;
  /** Indices (into the original series) that survived pairing. */
  index: number[];
  /** Number of valid pairs actually used. */
  n: number;
}

/**
 * Apply a NaN policy to one (observed, simulated) pair (§10.4).
 * 'pairwise' (default): drop time steps where either value is missing — the
 * same semantics as HydroErr's default treatment, which our reference vectors pin.
 * 'zero' / 'mean': substitute per-series before computing.
 */
export function applyNanPolicy(obs: ArrayLike<number>, sim: ArrayLike<number>, policy: NanPolicy = 'pairwise'): Paired {
  const n = Math.min(obs.length, sim.length);

  if (policy === 'pairwise') {
    const index: number[] = [];
    for (let i = 0; i < n; i++) if (isFinite(obs[i]) && isFinite(sim[i])) index.push(i);
    const o = new Float64Array(index.length), s = new Float64Array(index.length);
    index.forEach((idx, k) => { o[k] = obs[idx]; s[k] = sim[idx]; });
    return { obs: o, sim: s, index, n: index.length };
  }

  const fill = (arr: ArrayLike<number>): Float64Array => {
    const out = new Float64Array(n);
    if (policy === 'zero') {
      for (let i = 0; i < n; i++) out[i] = isFinite(arr[i]) ? arr[i] : 0;
    } else {
      let sum = 0, c = 0;
      for (let i = 0; i < n; i++) if (isFinite(arr[i])) { sum += arr[i]; c++; }
      const m = c > 0 ? sum / c : 0;
      for (let i = 0; i < n; i++) out[i] = isFinite(arr[i]) ? arr[i] : m;
    }
    return out;
  };
  const index = Array.from({ length: n }, (_, i) => i);
  return { obs: fill(obs), sim: fill(sim), index, n };
}
