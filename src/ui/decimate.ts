import { LIMITS } from '../ingest/limits'

export interface Decimated<X> { x: X[]; y: (number | null)[]; factor: number }

/**
 * Display-only reduction of a long series: the record is cut into buckets and
 * each bucket keeps its minimum and its maximum (in time order), so every
 * peak and trough survives while the point count stays near `maxPoints`.
 * The first and last points are always kept. Missing values stay visible:
 * wherever the record has a missing value between two kept points, a null is
 * kept at the first missing step, so the line breaks there exactly as it
 * does at full resolution (a gap shorter than a bucket once vanished and the
 * line was drawn across it). That adds at most one point per gap. Metrics
 * never see this: only the SVG traces do, which at a million points took a
 * browser 13 seconds per draw and were drawn twice (range slider). Below
 * `maxPoints` the input is returned unchanged.
 */
export function decimateMinMax<X>(x: X[], y: (number | null)[], maxPoints: number = LIMITS.plotPoints): Decimated<X> {
  const n = y.length;
  if (n <= maxPoints) return { x, y, factor: 1 };
  const isGap = (v: number | null | undefined) => v === null || v === undefined || !Number.isFinite(v);
  // nullsUpTo[i] = number of missing values in y[0 .. i-1]; built only when
  // the record has a gap at all.
  let nullsUpTo: Int32Array | null = null;
  for (let i = 0; i < n; i++) {
    if (!isGap(y[i])) continue;
    nullsUpTo = new Int32Array(n + 1);
    for (let j = 0; j < n; j++) nullsUpTo[j + 1] = nullsUpTo[j] + (isGap(y[j]) ? 1 : 0);
    break;
  }
  const buckets = Math.max(1, Math.floor(maxPoints / 2));
  const size = n / buckets;
  const xs: X[] = [], ys: (number | null)[] = [];
  let last = -1; // index of the last point pushed
  const push = (i: number) => {
    if (nullsUpTo && last >= 0 && nullsUpTo[i] - nullsUpTo[last + 1] > 0) {
      // a missing value lies strictly between the last kept point and i:
      // keep a break at the first one (binary search on the prefix count)
      let lo = last + 1, hi = i - 1;
      const base = nullsUpTo[last + 1];
      while (lo < hi) { const mid = (lo + hi) >> 1; if (nullsUpTo[mid + 1] > base) hi = mid; else lo = mid + 1; }
      xs.push(x[lo]); ys.push(null);
    }
    xs.push(x[i]); ys.push(isGap(y[i]) ? null : y[i]);
    last = i;
  };
  push(0);
  for (let b = 0; b < buckets; b++) {
    const lo = Math.floor(b * size), hi = Math.min(n, Math.floor((b + 1) * size));
    let iMin = -1, iMax = -1, vMin = Infinity, vMax = -Infinity;
    for (let i = lo; i < hi; i++) {
      const v = y[i];
      if (isGap(v)) continue;
      if ((v as number) < vMin) { vMin = v as number; iMin = i; }
      if ((v as number) > vMax) { vMax = v as number; iMax = i; }
    }
    if (iMin < 0) continue; // an empty bucket: the break is kept by the next push
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
