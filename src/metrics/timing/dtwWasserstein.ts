// Wasserstein distances between hydrographs treated as unit-mass distributions
// of flow over TIME (Magyar & Sambridge, 2023): the time-axis reading, distinct
// from divergences on the marginal flow-value distribution: and Dynamic Time
// Warping with a Sakoe–Chiba band (Sakoe & Chiba, 1978).
//
// Time axis (design rule D1): every function takes an optional `t`, the
// original step index of each value. When pairs are dropped (a missing value,
// a transform that cannot be evaluated) the survivors keep their true
// positions, so a gap never shortens a lag, a transport distance or a warp.
// Without `t` the values are taken as consecutive steps.

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

/** Why a series cannot be read as a mass distribution over time (W₁, W₂²):
 *  the count of negative values, or a total of zero. Null when it can. */
export function massIssue(x: Vec): { negative: number; zeroTotal: boolean } | null {
  let neg = 0, s = 0;
  for (let i = 0; i < x.length; i++) {
    if (x[i] < 0) neg++;
    else s += x[i];
  }
  if (neg > 0) return { negative: neg, zeroTotal: false };
  if (!(s > 0)) return { negative: 0, zeroTotal: true };
  return null;
}

/**
 * W₁ between the two normalised hydrographs, in steps:
 * W₁ = Σ_k |P(t_k) − S(t_k)| (t_{k+1} − t_k), where P and S are the cumulative
 * mass curves and t the time of each value (scipy.stats.wasserstein_distance
 * with support t and weights obs, sim).
 * A pure shift of k steps gives W₁ = k only when all the mass moves inside the
 * record (an event with zero flow at both ends). Mass that does not move
 * (baseflow) or that leaves the window lowers it: about k × (moving mass share).
 */
export function wasserstein1(obs: Vec, sim: Vec, t?: ArrayLike<number>): number {
  const p = massNormalise(obs), q = massNormalise(sim);
  if (!p || !q || p.length !== q.length) return NaN;
  if (t && t.length !== p.length) return NaN;
  let cp = 0, cq = 0, w = 0;
  for (let i = 0; i < p.length - 1; i++) {   // last CDF point is 1 for both
    cp += p[i]; cq += q[i];
    w += Math.abs(cp - cq) * (t ? t[i + 1] - t[i] : 1);
  }
  return w;
}

/**
 * W₂² via the inverse-CDF (quantile) representation:
 * W₂² = ∫₀¹ (F_o⁻¹(u) − F_s⁻¹(u))² du, support = time in steps (`t`, or the
 * index when `t` is absent). Equals k² for a pure shift of k steps of an event
 * with zero flow at both ends of the record; smaller otherwise (see W₁).
 */
export function wasserstein2sq(obs: Vec, sim: Vec, t?: ArrayLike<number>): number {
  const p = massNormalise(obs), q = massNormalise(sim);
  if (!p || !q) return NaN;
  if (t && (t.length !== p.length || t.length !== q.length)) return NaN;
  let i = 0, j = 0;         // current support points (indices)
  let cp = p[0], cq = q[0]; // cumulative masses at those points
  let u = 0, acc = 0;
  while (i < p.length && j < q.length) {
    const next = Math.min(cp, cq);
    const d = t ? t[i] - t[j] : i - j;
    acc += d * d * (next - u);
    u = next;
    if (cp <= cq) { i++; if (i < p.length) cp += p[i]; else cp = Infinity; }
    else { j++; if (j < q.length) cq += q[j]; else cq = Infinity; }
    if (u >= 1 - 1e-15) break;
  }
  return acc;
}

// ---------------- DTW ----------------

/** Band used when a caller passes a non-finite or negative one: the daily
 *  default (the peak-match window, 3 steps). */
export const DTW_DEFAULT_BAND = 3;
/** Largest number of DP cells (banded storage) DTW fills at full resolution;
 *  about 50 MB of back-pointers. Above it the record is block-averaged. */
export const DTW_CELL_BUDGET = 5e7;

export interface DtwResult {
  distance: number;         // accumulated |a − b| along the chosen optimal path
  normalized: number;       // distance / path length
  meanAbsWarp: number;      // mean |t_i − t_j| along the path, in steps of t
  path: [number, number][]; // optimal alignment, as indices into obs and sim
  band: number;             // Sakoe–Chiba half-width used, in the units of t
}

const nanResult = (band: number): DtwResult => ({ distance: NaN, normalized: NaN, meanAbsWarp: NaN, path: [], band });

/** Sanitise a band: a whole number of steps, at least 1; a non-finite or
 *  negative band (a hand-edited project file) falls back to the default. */
export function dtwBandSteps(band: number): number {
  return typeof band === 'number' && Number.isFinite(band) && band >= 0 ? Math.max(1, Math.round(band)) : DTW_DEFAULT_BAND;
}

/** Row ranges of the band: for row i, the columns j with |ts_j − to_i| ≤ w. */
function bandRows(to: ArrayLike<number>, ts: ArrayLike<number>, w: number): { lo: Int32Array; hi: Int32Array; cells: number } {
  const n = to.length, m = ts.length;
  const lo = new Int32Array(n), hi = new Int32Array(n);
  const eps = 1e-9 * Math.max(1, w);
  let a = 0, b = -1, cells = 0;
  for (let i = 0; i < n; i++) {
    while (a < m && ts[a] < to[i] - w - eps) a++;
    if (b < a - 1) b = a - 1;
    while (b + 1 < m && ts[b + 1] <= to[i] + w + eps) b++;
    lo[i] = a; hi[i] = b;
    cells += Math.max(0, b - a + 1);
  }
  return { lo, hi, cells };
}

const identity = (n: number): Float64Array => Float64Array.from({ length: n }, (_, i) => i);

/**
 * DTW with local cost |a − b|, a monotone corner-anchored path and a
 * Sakoe–Chiba band of half-width `band` time steps: cell (i, j) is allowed
 * when |t_i − t_j| ≤ band. `t` is the time of each pair (shared by obs and
 * sim, which must then have equal length); without it the index is the time
 * and the band widens to |n − m| so the corner stays reachable.
 *
 * Storage is banded: only the allowed cells of each row are kept, so memory
 * is O(n × band), not O(n × m).
 *
 * Tie rule. Many paths can share the minimum cost (flat or zero flow,
 * constant baseflow, quantised gauges); the mean |warp| of an arbitrary one
 * would depend on the direction of time and on floating-point noise. The
 * path taken is the lexicographic minimum of (cost, path length, total warp):
 * among alignments whose costs agree within 1e-10 of the data range per
 * step (below any hydrological meaning, above rounding), the one with the fewest
 * warping (non-diagonal) moves, then the least total |t_i − t_j|. All three
 * are additive along the path, so the DP finds that minimum, and it is the
 * same when both series are reversed in time.
 *
 * A pure shift of k ≤ band steps costs only at the record edges, and mean
 * |warp| is below k: the path starts and ends on the diagonal (corner
 * anchoring), so the stretches before the first and after the last feature
 * of the hydrograph read less than k.
 */
export function dtw(obs: Vec, sim: Vec, band = DTW_DEFAULT_BAND, t?: ArrayLike<number>): DtwResult {
  const n = obs.length, m = sim.length;
  let w = dtwBandSteps(band);
  if (t && (t.length !== n || n !== m)) return nanResult(w);
  if (!t) w = Math.max(w, Math.abs(n - m));
  if (n < 2 || m < 2) return nanResult(w);
  const to = t ?? identity(n), ts = t ?? identity(m);
  const { lo, hi, cells } = bandRows(to, ts, w);
  if (lo[0] !== 0 || hi[n - 1] !== m - 1) return nanResult(w);
  if (cells > 2 ** 31 - 1) throw new Error('DTW band too wide for this record');

  // Tolerance under which two accumulated costs count as equal: 1e-10 of the
  // data range per step of the path (invariant to an additive constant, such
  // as a flow-unit change under the log transform, and proportional to a
  // multiplicative one), plus the rounding floor of |a − b| at the magnitude
  // of the values. Differences this small carry no hydrological meaning, but
  // they flip an exact comparison between floating-point representations.
  let maxAbs = 0, lo0 = Infinity, hi0 = -Infinity;
  for (let i = 0; i < n; i++) { const v = obs[i]; maxAbs = Math.max(maxAbs, Math.abs(v)); lo0 = Math.min(lo0, v); hi0 = Math.max(hi0, v); }
  for (let j = 0; j < m; j++) { const v = sim[j]; maxAbs = Math.max(maxAbs, Math.abs(v)); lo0 = Math.min(lo0, v); hi0 = Math.max(hi0, v); }
  const range = Number.isFinite(hi0 - lo0) ? hi0 - lo0 : 0;
  const tol = (n + m) * (1e-10 * range + 16 * Number.EPSILON * maxAbs);

  const off = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) off[i + 1] = off[i] + Math.max(0, hi[i] - lo[i] + 1);
  const move = new Uint8Array(off[n]);     // 0 = start, 1 = diag, 2 = up (i−1), 3 = left (j−1)
  let width = 0;
  for (let i = 0; i < n; i++) width = Math.max(width, hi[i] - lo[i] + 1);
  let pC = new Float64Array(width), pL = new Float64Array(width), pW = new Float64Array(width);
  let cC = new Float64Array(width), cL = new Float64Array(width), cW = new Float64Array(width);
  const INF = Infinity;

  for (let i = 0; i < n; i++) {
    const jLo = lo[i], jHi = hi[i];
    const pLo = i > 0 ? lo[i - 1] : 0, pHi = i > 0 ? hi[i - 1] : -1;
    const rowOff = off[i];
    for (let j = jLo; j <= jHi; j++) {
      const k = j - jLo;
      const cost = Math.abs(obs[i] - sim[j]);
      const dw = Math.abs(to[i] - ts[j]);
      if (i === 0 && j === 0) { cC[k] = cost; cL[k] = 1; cW[k] = dw; move[rowOff + k] = 0; continue; }
      let bC = INF, bL = INF, bW = INF, mv = 0;
      // candidates in a fixed order (diagonal, up, left); a later one wins
      // only if it is strictly better under the tie rule
      for (let c = 1; c <= 3; c++) {
        let C: number, L: number, W: number;
        if (c === 1) {
          if (i === 0 || j - 1 < pLo || j - 1 > pHi) continue;
          C = pC[j - 1 - pLo]; L = pL[j - 1 - pLo]; W = pW[j - 1 - pLo];
        } else if (c === 2) {
          if (i === 0 || j < pLo || j > pHi) continue;
          C = pC[j - pLo]; L = pL[j - pLo]; W = pW[j - pLo];
        } else {
          if (j - 1 < jLo) continue;
          C = cC[k - 1]; L = cL[k - 1]; W = cW[k - 1];
        }
        if (C === INF) continue;
        if (mv === 0) { bC = C; bL = L; bW = W; mv = c; continue; }
        if (C < bC - tol || (C <= bC + tol && (L < bL || (L === bL && W < bW)))) {
          bC = C; bL = L; bW = W; mv = c;
        }
      }
      if (mv === 0) { cC[k] = INF; cL[k] = INF; cW[k] = INF; move[rowOff + k] = 0; continue; }
      cC[k] = cost + bC; cL[k] = bL + 1; cW[k] = bW + dw;
      move[rowOff + k] = mv;
    }
    [pC, cC] = [cC, pC]; [pL, cL] = [cL, pL]; [pW, cW] = [cW, pW];
  }
  const distance = pC[m - 1 - lo[n - 1]];
  if (!Number.isFinite(distance)) return nanResult(w);

  // backtrack; a monotone path visits at most n + m − 1 cells, so a longer
  // walk means the move table was never filled and the record cannot be aligned
  const path: [number, number][] = [];
  let i = n - 1, j = m - 1;
  const limit = n + m;
  while (path.length <= limit && i >= 0 && j >= 0) {
    path.push([i, j]);
    if (i === 0 && j === 0) break;
    if (j < lo[i] || j > hi[i]) break;
    const mv = move[off[i] + j - lo[i]];
    if (mv === 1) { i--; j--; }
    else if (mv === 2) { i--; }
    else if (mv === 3) { j--; }
    else break;
  }
  const last = path[path.length - 1];
  if (!last || last[0] !== 0 || last[1] !== 0) throw new Error('DTW alignment failed on this record');
  path.reverse();

  let warp = 0;
  for (const [a, b] of path) warp += Math.abs(to[a] - ts[b]);
  return { distance, normalized: distance / path.length, meanAbsWarp: warp / path.length, path, band: w };
}

export interface DtwRecordResult extends DtwResult {
  /** 1 at full resolution; otherwise the block size B: DTW ran on means of B
   *  consecutive pairs, `path` indexes blocks (block k starts at pair k·B)
   *  and `band` is in blocks (multiply by B for steps). */
  decim: number;
  /** The band actually applied, in steps (a multiple of B in block mode). */
  bandSteps: number;
}

/**
 * DTW of a paired record on its time axis (`t`, the original step index of
 * each pair), band in steps. Full resolution whenever the banded table fits
 * `cellBudget`; otherwise both series are block-AVERAGED over B consecutive
 * pairs (never point-sampled, so every value still counts), block times are
 * the mean step index of their pairs, the band is rounded up to a multiple
 * of B, and warps stay in native steps with a resolution of about B steps.
 */
export function dtwOnTimeAxis(obs: Vec, sim: Vec, t: ArrayLike<number>, band: number, cellBudget = DTW_CELL_BUDGET): DtwRecordResult {
  const n = obs.length;
  const w = dtwBandSteps(band);
  if (n !== sim.length || n !== t.length) return { ...nanResult(w), decim: 1, bandSteps: w };
  if (bandRows(t, t, w).cells <= cellBudget) return { ...dtw(obs, sim, w, t), decim: 1, bandSteps: w };
  // smallest block size whose table fits, from the no-gap estimate (gaps only
  // remove cells), then checked on the actual block times
  let B = 2;
  while (Math.ceil(n / B) * (2 * Math.ceil(w / B) + 2) > cellBudget) B++;
  for (;;) {
    const nb = Math.ceil(n / B);
    const ob = new Float64Array(nb), sb = new Float64Array(nb), tb = new Float64Array(nb);
    for (let k = 0; k < nb; k++) {
      const a = k * B, b = Math.min(n, a + B);
      let so = 0, ss = 0, st = 0;
      for (let x = a; x < b; x++) { so += obs[x]; ss += sim[x]; st += t[x]; }
      ob[k] = so / (b - a); sb[k] = ss / (b - a); tb[k] = st / (b - a);
    }
    const bb = Math.ceil(w / B), wEff = bb * B;
    if (nb < 2 || bandRows(tb, tb, wEff).cells <= cellBudget) {
      const r = dtw(ob, sb, wEff, tb);
      return { ...r, band: bb, decim: B, bandSteps: wEff };
    }
    B++;
  }
}
