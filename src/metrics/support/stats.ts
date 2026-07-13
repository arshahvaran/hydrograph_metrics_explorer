// Shared numeric helpers. Conventions match the reference libraries where it
// matters for verification: population std (ddof 0), NumPy-style linear
// interpolation for quantiles, SciPy-style Simpson integration on a uniform grid.

export type Vec = ArrayLike<number>;

export function mean(a: Vec): number {
  let s = 0; for (let i = 0; i < a.length; i++) s += a[i];
  return s / a.length;
}

export function stdPop(a: Vec, m = mean(a)): number {
  let s = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - m; s += d * d; }
  return Math.sqrt(s / a.length);
}

export function sum(a: Vec): number {
  let s = 0; for (let i = 0; i < a.length; i++) s += a[i];
  return s;
}

export function sortedAsc(a: Vec): Float64Array {
  return Float64Array.from(a as ArrayLike<number>).sort();
}

export function median(a: Vec): number {
  const s = sortedAsc(a); const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : 0.5 * (s[n / 2 - 1] + s[n / 2]);
}

/** NumPy default ('linear') quantile. q in [0,1]. */
export function quantile(a: Vec, q: number): number {
  const s = sortedAsc(a); const n = s.length;
  if (n === 0) return NaN;
  const pos = (n - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return s[lo];
  return s[lo] + (pos - lo) * (s[hi] - s[lo]);
}

/** Ordinal ranks 0..n-1 = argsort of argsort (ties broken by index), as hydroeval's kgenp. */
export function ranksOrdinal(a: Vec): Float64Array {
  const n = a.length;
  const idx = Array.from({ length: n }, (_, i) => i).sort((i, j) => a[i] - a[j] || i - j);
  const r = new Float64Array(n);
  idx.forEach((orig, rank) => { r[orig] = rank; });
  return r;
}

/** Average ranks 1..n with ties averaged (classical Spearman). */
export function ranksAverage(a: Vec): Float64Array {
  const n = a.length;
  const idx = Array.from({ length: n }, (_, i) => i).sort((i, j) => a[i] - a[j] || i - j);
  const r = new Float64Array(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && a[idx[j + 1]] === a[idx[i]]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k]] = avg;
    i = j + 1;
  }
  return r;
}

export function pearson(x: Vec, y: Vec): number {
  const mx = mean(x), my = mean(y);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < x.length; i++) {
    const a = x[i] - mx, b = y[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  // sqrt(dx)·sqrt(dy), NOT sqrt(dx·dy): the product underflows to a 1-ulp
  // denormal for tiny-magnitude data, and sqrt of that garbage produced
  // plausible-looking correlations (r = 0.707 for identical arrays).
  const den = Math.sqrt(dx) * Math.sqrt(dy);
  // QA-012: a numerically-constant series (one-ulp summation noise) must not
  // yield a plausible-looking correlation for an undefined statistic.
  const sx = Math.sqrt(dx / x.length), sy = Math.sqrt(dy / y.length);
  if (den === 0 || sx <= Math.abs(mx) * 1e-12 || sy <= Math.abs(my) * 1e-12) return NaN;
  // Cauchy–Schwarz: |num| ≤ den, with equality iff the series are perfectly
  // (anti)correlated. Rounding can leak an ulp either way, so the equality
  // case is snapped exactly and the rest clamped (as scipy does).
  if (Math.abs(num) >= den) return Math.sign(num);
  return Math.max(-1, Math.min(1, num / den));
}

/**
 * Composite Simpson's rule on a uniform grid spanning [x0, x1] with y.length
 * points, matching scipy.integrate.simps for even-length arrays (Cartwright
 * end correction on the last interval).
 */
export function simpsonUniform(y: Vec, x0: number, x1: number): number {
  const n = y.length;
  if (n < 2) return 0;
  const h = (x1 - x0) / (n - 1);
  if (n === 2) return (h / 2) * (y[0] + y[1]);
  let result = 0;
  const applySimpson = (start: number, stop: number) => { // stop-start even # of intervals
    let s = y[start] + y[stop];
    for (let i = start + 1; i < stop; i++) s += (i - start) % 2 === 1 ? 4 * y[i] : 2 * y[i];
    return (h / 3) * s;
  };
  if ((n - 1) % 2 === 0) {
    result = applySimpson(0, n - 1);
  } else {
    // Even number of samples: composite Simpson over the first n−1 samples
    // (an even count of intervals) plus SciPy's Cartwright correction for the
    // final interval (equal-spacing form).
    result = applySimpson(0, n - 2);
    result += h * ((5 / 12) * y[n - 1] + (2 / 3) * y[n - 2] - (1 / 12) * y[n - 3]);
  }
  return result;
}

/** Deterministic 32-bit PRNG (mulberry32) for seedable sandbox noise. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box–Muller on a uniform PRNG. */
export function gaussian(rng: () => number): () => number {
  let spare: number | null = null;
  return function () {
    if (spare !== null) { const v = spare; spare = null; return v; }
    let u = 0, v = 0, s = 0;
    do { u = 2 * rng() - 1; v = 2 * rng() - 1; s = u * u + v * v; } while (s === 0 || s >= 1);
    const f = Math.sqrt(-2 * Math.log(s) / s);
    spare = v * f;
    return u * f;
  };
}

/** QA-013: spread-based Math.min/max blow the call stack past ~125k elements
 *  (V8 argument limit). Loop-based extrema for data-sized arrays. */
export function arrMin(a: ArrayLike<number>): number {
  let m = Infinity;
  for (let i = 0; i < a.length; i++) if (a[i] < m) m = a[i];
  return m;
}
export function arrMax(a: ArrayLike<number>): number {
  let m = -Infinity;
  for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i];
  return m;
}
