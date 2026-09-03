/** Missing-value token handling (§6.0) and NaN policies (§10.4). */

const BASE_TOKENS = new Set(['', 'na', 'nan', 'null', 'n/a', '-', '--', '---', 'none', 'missing']);

export interface MissingOptions {
  /** A user-declared no-data value (e.g. -999). null = nothing is treated as missing. */
  missingValue?: number | null;
  /** The column is known to use the comma as its decimal mark (see detectCommaDecimal). */
  commaDecimal?: boolean;
}

/** Strict decimal grammar after separator normalisation: digits, one optional
 *  decimal point, optional exponent. Rejects the forms Number() would accept
 *  silently (hex "0x10", binary, octal, "Infinity", whitespace-only). */
const DECIMAL_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** Parse a raw cell into a number, mapping missing tokens to NaN. */
/**
 * Locale-aware numeric cell parsing (QA-005). Rules, in order:
 *  - both "." and "," present: the LAST separator is the decimal mark, the
 *    other is a thousands separator ("1.234,5" -> 1234.5; "1,234.5" -> 1234.5);
 *  - only "," present, column known to be comma-decimal: the comma is the
 *    decimal mark whatever follows it ("1,234" -> 1.234);
 *  - only "," present otherwise: strict thousands grouping ("1,234,567") is
 *    treated as thousands; a single comma otherwise is a decimal mark
 *    ("3,5" -> 3.5); anything else ("1,23,45") is invalid;
 *  - only "." present: standard JS parsing (dot is always decimal: the
 *    anglophone default; "1.234" is 1.234, not 1234);
 *  - scientific notation passes through untouched; hex and other non-decimal
 *    forms are invalid.
 */
export function parseNumericCell(raw: string, commaDecimal = false): number {
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
    if (commaDecimal) {
      if (t.split(',').length !== 2) return NaN;
      s = t.replace(',', '.');
    } else if (/^[+-]?\d{1,3}(,\d{3})+$/.test(t)) s = t.split(',').join('');
    else if (t.split(',').length === 2) s = t.replace(',', '.');
    else return NaN;
  }
  if (!DECIMAL_RE.test(s)) return NaN;
  return Number(s);
}

/**
 * Decide, per column, whether the comma is a decimal mark. A cell such as
 * "1,23" or "0,5" (one comma, no dot, and not exactly three digits after the
 * comma) cannot be a thousands group, so the whole column is comma-decimal
 * and "1,234" in the same column reads 1.234, not 1234 (which would be a
 * silent thousand-fold error on the rows that happen to have three decimals).
 */
export function detectCommaDecimal(rows: string[][], col: number): boolean {
  for (let i = 0; i < rows.length; i++) {
    const c = rows[i][col];
    if (!c || c.indexOf(',') < 0 || c.indexOf('.') >= 0) continue;
    const t = c.trim();
    if (/^[+-]?\d+,\d+$/.test(t) && !/,\d{3}$/.test(t)) return true;
  }
  return false;
}

export function parseValue(raw: string | number | null | undefined, opts: MissingOptions = {}): number {
  const missingValue = opts.missingValue ?? null;
  if (raw === null || raw === undefined) return NaN;
  if (typeof raw === 'number') {
    if (missingValue !== null && raw === missingValue) return NaN;
    return raw;
  }
  const s = raw.trim();
  if (BASE_TOKENS.has(s.toLowerCase())) return NaN;
  const v = parseNumericCell(s, opts.commaDecimal === true);
  if (!isFinite(v)) return NaN;
  if (missingValue !== null && v === missingValue) return NaN;
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
 * 'pairwise' (default): drop time steps where either value is missing: the
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
