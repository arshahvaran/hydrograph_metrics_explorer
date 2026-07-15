// Wasserstein distances between hydrographs treated as unit-mass distributions
// of flow over TIME (Magyar & Sambridge, 2023): the time-axis reading, distinct
// from divergences on the marginal flow-value distribution: and Dynamic Time
// Warping with a Sakoe–Chiba band (Sakoe & Chiba, 1978).

import type { Vec } from '../support/stats'

function massNormalise(x: Vec): Float64Array | null {
  let s = 0;
  for (let i = 0; i < x.length; i++) {
    if (x[i] < 0) return null;         // mass interpretation needs non-negative flow
    s += x[i];
  }
  if (s <= 0) return null;
  const p = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) p[i] = x[i] / s;
  return p;
}

/**
 * W₁ between the two normalised hydrographs, in *steps*:
 * W₁ = Σ_t |P(t) − S(t)| where P, S are the cumulative mass curves.
 * Under a pure interior shift of k steps, W₁ = k exactly.
 */
export function wasserstein1(obs: Vec, sim: Vec): number {
  const p = massNormalise(obs), q = massNormalise(sim);
  if (!p || !q || p.length !== q.length) return NaN;
  let cp = 0, cq = 0, w = 0;
  for (let i = 0; i < p.length - 1; i++) {   // last CDF point is 1 for both
    cp += p[i]; cq += q[i];
    w += Math.abs(cp - cq);
  }
  return w;
}

/**
 * W₂² via the inverse-CDF (quantile) representation:
 * W₂² = ∫₀¹ (F_o⁻¹(u) − F_s⁻¹(u))² du, support = time index in steps.
 * Under a pure interior shift of k steps, W₂² = k² (the "squared lag" of the paper).
 */
export function wasserstein2sq(obs: Vec, sim: Vec): number {
  const p = massNormalise(obs), q = massNormalise(sim);
  if (!p || !q) return NaN;
  let i = 0, j = 0;         // current support points (time indices)
  let cp = p[0], cq = q[0]; // cumulative masses at those points
  let u = 0, acc = 0;
  while (i < p.length && j < q.length) {
    const next = Math.min(cp, cq);
    const d = i - j;
    acc += d * d * (next - u);
    u = next;
    if (cp <= cq) { i++; if (i < p.length) cp += p[i]; else cp = Infinity; }
    else { j++; if (j < q.length) cq += q[j]; else cq = Infinity; }
    if (u >= 1 - 1e-15) break;
  }
  return acc;
}

// ---------------- DTW ----------------
export interface DtwResult {
  distance: number;         // accumulated |a − b| along the optimal path
  normalized: number;       // distance / path length
  meanAbsWarp: number;      // mean |i − j| along the path; the timing readout
  path: [number, number][]; // optimal alignment (decimate for display)
  band: number;
}

/**
 * Classic DTW with local cost |a − b|, monotone corner-anchored path,
 * Sakoe–Chiba band of half-width `band` (in steps).
 * Under a pure shift of k steps (k < band), meanAbsWarp ≈ k.
 */
export function dtw(obs: Vec, sim: Vec, bandFraction = 0.1): DtwResult {
  const n = obs.length, m = sim.length;
  const band = Math.max(1, Math.ceil(bandFraction * Math.max(n, m)), Math.abs(n - m));
  const INF = Infinity;

  // Rolling DP with full move matrix for backtracking (Uint8: 1=diag,2=up,3=left).
  const move = new Uint8Array(n * m);
  let prev = new Float64Array(m).fill(INF);
  let curr = new Float64Array(m).fill(INF);

  for (let i = 0; i < n; i++) {
    const jLo = Math.max(0, i - band), jHi = Math.min(m - 1, i + band);
    curr.fill(INF);
    for (let j = jLo; j <= jHi; j++) {
      const cost = Math.abs(obs[i] - sim[j]);
      if (i === 0 && j === 0) { curr[0] = cost; move[0] = 0; continue; }
      const dDiag = i > 0 && j > 0 ? prev[j - 1] : INF;
      const dUp = i > 0 ? prev[j] : INF;
      const dLeft = j > 0 ? curr[j - 1] : INF;
      let best = dDiag, mv = 1;
      if (dUp < best) { best = dUp; mv = 2; }
      if (dLeft < best) { best = dLeft; mv = 3; }
      curr[j] = cost + best;
      move[i * m + j] = mv;
    }
    [prev, curr] = [curr, prev];
  }
  const distance = prev[m - 1];

  // backtrack
  const path: [number, number][] = [];
  let i = n - 1, j = m - 1;
  while (true) {
    path.push([i, j]);
    if (i === 0 && j === 0) break;
    const mv = move[i * m + j];
    if (mv === 1) { i--; j--; }
    else if (mv === 2) { i--; }
    else { j--; }
  }
  path.reverse();

  let warp = 0;
  for (const [a, b] of path) warp += Math.abs(a - b);
  return { distance, normalized: distance / path.length, meanAbsWarp: warp / path.length, path, band };
}
