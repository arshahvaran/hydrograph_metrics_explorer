import { LIMITS } from '../ingest/limits'

export interface Decimated<X> { x: X[]; y: (number | null)[]; factor: number }

/**
 * Display-only reduction of a long series: the record is cut into buckets and
 * each bucket keeps its minimum and its maximum (in time order), so every
 * peak and trough survives while the point count stays near `maxPoints`.
 * The first and last points are always kept. Metrics never see this: only
 * the SVG traces do, which at a million points took a browser 13 seconds per
 * draw and were drawn twice (range slider). Below `maxPoints` the input is
 * returned unchanged.
 *
 * Missing values: the output draws what the full-resolution line draws.
 *  - Wherever the record has a missing value between two kept points, a null
 *    is kept at the first missing step, so the line breaks there as at full
 *    resolution (a gap shorter than a bucket once vanished).
 *  - A kept point that follows a break (or starts the record) also keeps
 *    its true neighbour at full resolution (the step before it, else the
 *    step after it), so it is drawn as a segment. Plotly 'lines' draws
 *    nothing for a point with a null on both sides, and a peak kept between
 *    two breaks once vanished.
 *  - Extremes are chosen among the steps that a line can draw (a finite
 *    value with at least one finite neighbour). A lone value between two
 *    missing steps draws nothing at full resolution either.
 *  - A record with many gaps needs more points per bucket; the bucket count
 *    is then reduced until the output fits the budget (at most maxPoints + 2
 *    points, as for a record without gaps).
 * A record without gaps gives the same points as before (two per bucket).
 */
export function decimateMinMax<X>(x: X[], y: (number | null)[], maxPoints: number = LIMITS.plotPoints): Decimated<X> {
  const n = y.length;
  if (n <= maxPoints) return { x, y, factor: 1 };
  const ok = new Uint8Array(n); // 1 = finite value
  let missing = 0;
  for (let i = 0; i < n; i++) {
    const v = y[i];
    if (v !== null && v !== undefined && Number.isFinite(v)) ok[i] = 1; else missing++;
  }
  const limit = maxPoints + 2;
  let buckets = Math.max(1, Math.floor(maxPoints / 2));
  if (!missing) return minMaxPass(x, y, ok, null, buckets);
  // nullsUpTo[i] = number of missing values in y[0 .. i-1]
  const nullsUpTo = new Int32Array(n + 1);
  for (let j = 0; j < n; j++) nullsUpTo[j + 1] = nullsUpTo[j] + (ok[j] ? 0 : 1);
  // Each bucket emits at most 6 points (a break, a neighbour and a kept
  // point, twice) and the two ends at most 5, so `safe` buckets always fit.
  const safe = Math.max(1, Math.floor((maxPoints - 3) / 6));
  for (let attempt = 0; attempt < 5 && buckets > safe; attempt++) {
    const out = minMaxPass(x, y, ok, nullsUpTo, buckets);
    if (out.y.length <= limit) return out;
    // fewer, wider buckets, in proportion to the overshoot
    buckets = Math.max(safe, Math.min(buckets - 1, Math.floor((0.98 * buckets * maxPoints) / out.y.length)));
  }
  return minMaxPass(x, y, ok, nullsUpTo, safe);
}

function minMaxPass<X>(x: X[], y: (number | null)[], ok: Uint8Array, nullsUpTo: Int32Array | null, buckets: number): Decimated<X> {
  const n = y.length;
  const size = n / buckets;
  // a step a line can draw: finite, with a finite neighbour
  const drawable = (i: number) => ok[i] === 1 && ((i > 0 && ok[i - 1] === 1) || (i < n - 1 && ok[i + 1] === 1));
  const xs: X[] = [], ys: (number | null)[] = [];
  let last = -1; // index of the last point pushed
  const emit = (i: number, v: number | null) => { xs.push(x[i]); ys.push(v); last = i; };
  const push = (i: number) => {
    if (i <= last) return;
    if (nullsUpTo && last >= 0 && nullsUpTo[i] - nullsUpTo[last + 1] > 0) {
      // a missing value lies strictly between the last kept point and i:
      // keep a break at the first one (binary search on the prefix count)
      let lo = last + 1, hi = i - 1;
      const base = nullsUpTo[last + 1];
      while (lo < hi) { const mid = (lo + hi) >> 1; if (nullsUpTo[mid + 1] > base) hi = mid; else lo = mid + 1; }
      emit(lo, null);
    }
    if (!ok[i]) { emit(i, null); return; }
    if (nullsUpTo && (ys.length === 0 || ys[ys.length - 1] === null)) {
      // nothing drawable before i in the output (the start, or a break): keep
      // its full-resolution neighbour so it is drawn as a segment. The step
      // before lies after the break whenever it is finite.
      if (i > 0 && ok[i - 1] && i - 1 > last) { emit(i - 1, y[i - 1] as number); emit(i, y[i] as number); return; }
      if (i < n - 1 && ok[i + 1]) { emit(i, y[i] as number); emit(i + 1, y[i + 1] as number); return; }
    }
    emit(i, y[i] as number);
  };
  push(0);
  for (let b = 0; b < buckets; b++) {
    const lo = Math.floor(b * size), hi = Math.min(n, Math.floor((b + 1) * size));
    let iMin = -1, iMax = -1, vMin = Infinity, vMax = -Infinity;
    for (let i = lo; i < hi; i++) {
      if (!ok[i]) continue;
      if (nullsUpTo && !drawable(i)) continue;
      const v = y[i] as number;
      if (v < vMin) { vMin = v; iMin = i; }
      if (v > vMax) { vMax = v; iMax = i; }
    }
    if (iMin < 0) continue; // nothing drawable: the break is kept by the next push
    const a = Math.min(iMin, iMax), z = Math.max(iMin, iMax);
    if (a > 0 && a < n - 1) push(a);
    if (z !== a && z > 0 && z < n - 1) push(z);
  }
  push(n - 1);
  return { x: xs, y: ys, factor: Math.ceil(size) };
}

/** Caption fragment for a decimated trace set, or '' at full resolution. */
export const decimationNote = (factor: number): string =>
  factor > 1 ? `time-series drawn at reduced resolution (minimum and maximum of every ${factor} steps); metrics use every point` : '';
