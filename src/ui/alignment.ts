// Tie segments for the DTW alignment plot.
// The DTW path indexes the arrays the metric engine actually aligned: pairwise
// NaN compaction first (missing.ts), then 1/decim decimation for long records
// (registry.ts). Both mappings must be undone before drawing, or the grey ties
// connect the wrong dates and values. Regression-pinned in tests/alignment.test.ts.

import type { ComputeOutput } from '../metrics/registry'

export interface AlignmentTies {
  /** Plotly line-with-gaps encoding: [xO, xS, null, xO, xS, null, ...] */
  x: (string | null)[];
  y: (number | null)[];
  /** Number of ties actually drawn (after display thinning). */
  ties: number;
}

/**
 * Map every drawn tie back to original frame rows.
 * `dates`, `obsY`, `simY` must be the SAME frame the metric panel was computed
 * on (the Plots-tab subset frame). `maxTies` thins the path for display.
 */
export function dtwTies(
  out: ComputeOutput,
  dates: string[],
  obsY: (number | null)[],
  simY: (number | null)[],
  maxTies = 160,
): AlignmentTies {
  const res = out.extras.dtw;
  const path = res?.path ?? [];
  const decim = res?.decim ?? 1;
  const idx = out.pairedIndex;
  const x: (string | null)[] = [];
  const y: (number | null)[] = [];
  const step = Math.max(1, Math.floor(path.length / maxTies));
  let ties = 0;
  for (let k = 0; k < path.length; k += step) {
    const [pi, pj] = path[k];
    // decimated space -> compacted-pair space -> original frame rows
    const io = idx ? idx[pi * decim] : pi * decim;
    const jo = idx ? idx[pj * decim] : pj * decim;
    if (io === undefined || jo === undefined) continue;
    x.push(dates[io] ?? null, dates[jo] ?? null, null);
    y.push(obsY[io] ?? null, simY[jo] ?? null, null);
    ties++;
  }
  return { x, y, ties };
}
