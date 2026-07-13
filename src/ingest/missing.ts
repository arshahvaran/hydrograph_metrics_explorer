/** Missing-value token handling (§6.0) and NaN policies (§10.4). */

const BASE_TOKENS = new Set(['', 'na', 'nan', 'null', 'n/a', '-', '--', '---', 'none', 'missing']);

export interface MissingOptions {
  /** Treat -9999 / -999 sentinels as missing (default true, spec §6.0). */
  sentinels?: boolean;
}

/** Parse a raw cell into a number, mapping missing tokens to NaN. */
/**
 * Locale-aware numeric cell parsing (QA-005). Rules, in order:
 *  - both "." and "," present: the LAST separator is the decimal mark, the
 *    other is a thousands separator ("1.234,5" -> 1234.5; "1,234.5" -> 1234.5);
 *  - only "," present: strict thousands grouping ("1,234,567") is treated as
 *    thousands; a single comma otherwise is a decimal mark ("3,5" -> 3.5);
 *    anything else ("1,23,45") is invalid;
 *  - only "." present: standard JS parsing (dot is always decimal — the
 *    anglophone default; "1.234" is 1.234, not 1234);
 *  - scientific notation passes through untouched.
 */
export function parseNumericCell(raw: string): number {
  const t = raw.trim();
  if (!t) return NaN;
  const c = t.lastIndexOf(','), d = t.lastIndexOf('.');
  let s = t;
  if (c >= 0 && d >= 0) {
    const dec = c > d ? ',' : '.';
    const thou = dec === ',' ? '.' : ',';
    if (t.split(dec).length !== 2) return NaN;        // two decimal marks -> garbage
    s = t.split(thou).join('');
    if (dec === ',') s = s.replace(',', '.');
  } else if (c >= 0) {
    if (/^[+-]?\d{1,3}(,\d{3})+$/.test(t)) s = t.split(',').join('');
    else if (t.split(',').length === 2) s = t.replace(',', '.');
    else return NaN;
  }
  return Number(s);
}

export function parseValue(raw: string | number | null | undefined, opts: MissingOptions = {}): number {
  const sentinels = opts.sentinels ?? true;
  if (raw === null || raw === undefined) return NaN;
  if (typeof raw === 'number') {
    if (sentinels && (raw === -9999 || raw === -999)) return NaN;
    return raw;
  }
  const s = raw.trim();
  if (BASE_TOKENS.has(s.toLowerCase())) return NaN;
  const v = parseNumericCell(s);
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
