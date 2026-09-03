import { LIMITS } from '../ingest/limits'

export interface Decimated<X> { x: X[]; y: (number | null)[]; factor: number }

/**
 * Display-only reduction of a long series: the record is cut into buckets and
 * each bucket keeps its minimum and its maximum (in time order), so every
 * peak and trough survives while the point count stays near `maxPoints`.
 * The first and last points are always kept; a bucket with no finite value
 * keeps one gap. Metrics never see this: only the SVG traces do, which at a
 * million points took a browser 13 seconds per draw and were drawn twice
 * (range slider). Below `maxPoints` the input is returned unchanged.
 */
export function decimateMinMax<X>(x: X[], y: (number | null)[], maxPoints: number = LIMITS.plotPoints): Decimated<X> {
  const n = y.length;
  if (n <= maxPoints) return { x, y, factor: 1 };
  const buckets = Math.max(1, Math.floor(maxPoints / 2));
  const size = n / buckets;
  const xs: X[] = [], ys: (number | null)[] = [];
  const push = (i: number) => { xs.push(x[i]); ys.push(y[i]); };
  push(0);
  for (let b = 0; b < buckets; b++) {
    const lo = Math.floor(b * size), hi = Math.min(n, Math.floor((b + 1) * size));
    let iMin = -1, iMax = -1, vMin = Infinity, vMax = -Infinity;
    for (let i = lo; i < hi; i++) {
      const v = y[i];
      if (v === null || v === undefined) continue;
      if (v < vMin) { vMin = v; iMin = i; }
      if (v > vMax) { vMax = v; iMax = i; }
    }
    if (iMin < 0) { if (lo > 0 && lo < n - 1) { xs.push(x[lo]); ys.push(null); } continue; }
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
