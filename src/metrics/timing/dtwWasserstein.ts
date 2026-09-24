// Wasserstein distances between hydrographs treated as unit-mass distributions
// of flow over TIME (Magyar & Sambridge, 2023): the time-axis reading, distinct
// from divergences on the marginal flow-value distribution: and Dynamic Time
// Warping with a Sakoe–Chiba band (Sakoe & Chiba, 1978).
//
// Time axis (design rule D1): every function takes an optional `t`, the time
// of each value in steps of the record (the original step index, or the
// timestamp divided by the detected step when date rows are absent from the
// file; see pairTimeAxis in registry.ts). When pairs are dropped (a missing
// value, a transform that cannot be evaluated, a date row that is not in the
// file) the survivors keep their true positions, so a gap never shortens a
// lag, a transport distance or a warp. Without `t` the values are taken as
// consecutive steps.

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
 * record (an event with zero flow at both ends). Otherwise W₁ can be smaller
 * or larger than k: an event on steady baseflow reads about k × (moving mass
 * share), while flow that enters or leaves at the ends of the record changes
 * the two totals and can read several times k (a year of the HYMOD sample
 * that ends on a flood rise reads 7.15 steps for a 1-step shift).
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
 * with zero flow at both ends of the record; otherwise it can be smaller or
 * larger (see W₁).
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
/** Largest number of DP cells (banded storage) one DTW pass fills; about
 *  50 MB of back-pointers. A record whose band needs more is aligned in two
 *  passes (dtwOnTimeAxis). */
export const DTW_CELL_BUDGET = 5e7;
/** Nodes of the optimal path that a record result keeps (dtwOnTimeAxis). The
 *  alignment plot draws at most about 160 ties; a path of one node per step,
 *  kept in every cached panel, once cost about 74 MB of heap per million
 *  steps. The statistics are always taken on the whole path. */
export const DTW_PATH_KEEP = 2000;

export interface DtwResult {
  /** Minimum accumulated |a − b| over every monotone path inside the band:
   *  the true optimum, whichever optimal path the tie rule picks. */
  distance: number;
  normalized: number;       // distance / pathLength
  meanAbsWarp: number;      // mean |t_i − t_j| along the chosen optimal path, in steps of t
  /** Share of the chosen path's nodes at the band limit (|t_i − t_j| = band).
   *  A large share means the band holds mean |warp| down. */
  edgeShare: number;
  /** The chosen optimal path, as indices into obs and sim. dtw() returns every
   *  node; dtwOnTimeAxis() keeps at most DTW_PATH_KEEP nodes spread evenly
   *  along it, the first and the last included. */
  path: [number, number][];
  pathLength: number;       // nodes of the whole path
  band: number;             // Sakoe–Chiba half-width used, in the units of t
}

const nanResult = (band: number): DtwResult => ({ distance: NaN, normalized: NaN, meanAbsWarp: NaN, edgeShare: NaN, path: [], pathLength: 0, band });

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

/** One DTW pass: the true optimal distance and the chosen path. */
interface DtwCore { distance: number; pi: Int32Array; pj: Int32Array; len: number }

const ALIGN_FAILED = 'DTW alignment failed on this record';

/**
 * DTW on explicit row ranges (row i may use columns lo[i] … hi[i]), local
 * cost |a − b|, monotone corner-anchored path. Null when a value is not
 * finite or the far corner cannot be reached.
 *
 * Tie rule. Many paths can share the minimum cost (flat or zero flow,
 * constant baseflow, quantised gauges), and the mean |warp| of an arbitrary
 * one would depend on the direction of time and on floating-point noise. The
 * path taken is the lexicographic minimum of (cost, path length, total
 * |t_i − t_j|), compared EXACTLY: each local cost is counted in whole quanta
 * of 2⁻³⁰ of the data range (fewer bits only when n + m exceeds 4 million, so
 * that every path sum stays an exact integer below 2⁵²), and the warp in
 * whole steps (1/1024 of a step for off-grid times). All three keys are
 * integers added along the path, so the comparisons are transitive, the DP
 * finds that minimum, and both series reversed in time give the same keys and
 * the same mean |warp|. The quantum follows the data range, so a change of
 * flow unit changes nothing but rounding noise, which moves a cost across a
 * quantum boundary with a probability of about 1e-7 per cell. The distance
 * reported is not the quantised one: a floating-point DP of the plain
 * minimum runs alongside and gives the true optimum (the chosen path costs at
 * most one quantum per node more).
 */
function dtwCore(obs: Vec, sim: Vec, to: ArrayLike<number>, ts: ArrayLike<number>, lo: Int32Array, hi: Int32Array): DtwCore | null {
  const n = obs.length, m = sim.length;
  if (n < 1 || m < 1 || lo[0] !== 0 || hi[n - 1] !== m - 1) return null;
  let cells = 0, width = 0;
  for (let i = 0; i < n; i++) { const c = Math.max(0, hi[i] - lo[i] + 1); cells += c; if (c > width) width = c; }
  if (cells > 2 ** 31 - 1) throw new Error('DTW band too wide for this record');

  let vLo = Infinity, vHi = -Infinity, intTime = true;
  for (let i = 0; i < n; i++) {
    const v = obs[i];
    if (!Number.isFinite(v)) return null;
    if (v < vLo) vLo = v;
    if (v > vHi) vHi = v;
    if (intTime && !Number.isInteger(to[i])) intTime = false;
  }
  for (let j = 0; j < m; j++) {
    const v = sim[j];
    if (!Number.isFinite(v)) return null;
    if (v < vLo) vLo = v;
    if (v > vHi) vHi = v;
    if (intTime && !Number.isInteger(ts[j])) intTime = false;
  }
  const bits = Math.max(8, Math.min(30, 52 - Math.ceil(Math.log2(n + m))));
  const range = vHi - vLo;
  const perQ = range > 0 && Number.isFinite(range) ? 2 ** bits / range : 0;
  const perW = intTime ? 1 : 1024;

  const off = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) off[i + 1] = off[i] + Math.max(0, hi[i] - lo[i] + 1);
  const move = new Uint8Array(off[n]);     // 0 = start or unreachable, 1 = diag, 2 = up (i−1), 3 = left (j−1)
  // per row: quantised cost C, length L, warp W (the tie keys), float cost F
  let pC = new Float64Array(width), pL = new Float64Array(width), pW = new Float64Array(width), pF = new Float64Array(width);
  let cC = new Float64Array(width), cL = new Float64Array(width), cW = new Float64Array(width), cF = new Float64Array(width);
  const INF = Infinity;
  let pLo = 0, pHi = -1;

  for (let i = 0; i < n; i++) {
    const jLo = lo[i], jHi = hi[i];
    const rowOff = off[i];
    const oi = obs[i], ti = to[i];
    for (let j = jLo; j <= jHi; j++) {
      const k = j - jLo;
      const e = Math.abs(oi - sim[j]);
      const eq = Math.round(e * perQ);
      const dt = Math.abs(ti - ts[j]);
      const dw = perW === 1 ? dt : Math.round(dt * perW);
      if (i === 0 && j === 0) { cC[k] = eq; cL[k] = 1; cW[k] = dw; cF[k] = e; move[rowOff + k] = 0; continue; }
      let bC = INF, bL = INF, bW = INF, bF = INF, mv = 0;
      // candidates in a fixed order (diagonal, up, left); a later one wins
      // only if its (C, L, W) is strictly smaller: exact integer comparisons
      if (i > 0 && j - 1 >= pLo && j - 1 <= pHi) {
        const x = j - 1 - pLo;
        if (pC[x] !== INF) { bC = pC[x]; bL = pL[x]; bW = pW[x]; mv = 1; }
        if (pF[x] < bF) bF = pF[x];
      }
      if (i > 0 && j >= pLo && j <= pHi) {
        const x = j - pLo;
        const C = pC[x];
        if (C !== INF && (C < bC || (C === bC && (pL[x] < bL || (pL[x] === bL && pW[x] < bW))))) { bC = C; bL = pL[x]; bW = pW[x]; mv = 2; }
        if (pF[x] < bF) bF = pF[x];
      }
      if (k > 0) {
        const x = k - 1;
        const C = cC[x];
        if (C !== INF && (C < bC || (C === bC && (cL[x] < bL || (cL[x] === bL && cW[x] < bW))))) { bC = C; bL = cL[x]; bW = cW[x]; mv = 3; }
        if (cF[x] < bF) bF = cF[x];
      }
      if (mv === 0) { cC[k] = INF; cL[k] = INF; cW[k] = INF; cF[k] = INF; move[rowOff + k] = 0; continue; }
      cC[k] = eq + bC; cL[k] = bL + 1; cW[k] = bW + dw; cF[k] = e + bF;
      move[rowOff + k] = mv;
    }
    [pC, cC] = [cC, pC]; [pL, cL] = [cL, pL]; [pW, cW] = [cW, pW]; [pF, cF] = [cF, pF];
    pLo = jLo; pHi = jHi;
  }
  const distance = pF[m - 1 - lo[n - 1]];
  if (!Number.isFinite(distance)) return null;

  // backtrack; a monotone path visits at most n + m − 1 cells, so a longer
  // walk means the move table was never filled and the record cannot be aligned
  const cap = n + m - 1;
  const pi = new Int32Array(cap), pj = new Int32Array(cap);
  let len = 0, i = n - 1, j = m - 1;
  for (;;) {
    if (len >= cap) throw new Error(ALIGN_FAILED);
    pi[len] = i; pj[len] = j; len++;
    if (i === 0 && j === 0) break;
    if (j < lo[i] || j > hi[i]) throw new Error(ALIGN_FAILED);
    const mv = move[off[i] + j - lo[i]];
    if (mv === 1) { i--; j--; }
    else if (mv === 2) { i--; }
    else if (mv === 3) { j--; }
    else throw new Error(ALIGN_FAILED);
  }
  const ri = pi.slice(0, len).reverse(), rj = pj.slice(0, len).reverse();
  return { distance, pi: ri, pj: rj, len };
}

/** Statistics of the whole chosen path and a path of at most `keep` nodes. */
function summarise(c: DtwCore, to: ArrayLike<number>, ts: ArrayLike<number>, w: number, keep: number): DtwResult {
  const lim = w - 1e-9 * Math.max(1, w);
  let warp = 0, edge = 0;
  for (let k = 0; k < c.len; k++) {
    const d = Math.abs(to[c.pi[k]] - ts[c.pj[k]]);
    warp += d;
    if (d >= lim) edge++;
  }
  let path: [number, number][];
  if (c.len <= keep) {
    path = new Array(c.len);
    for (let k = 0; k < c.len; k++) path[k] = [c.pi[k], c.pj[k]];
  } else {
    path = new Array(keep);
    for (let k = 0; k < keep; k++) { const x = Math.round(k * (c.len - 1) / (keep - 1)); path[k] = [c.pi[x], c.pj[x]]; }
  }
  return { distance: c.distance, normalized: c.distance / c.len, meanAbsWarp: warp / c.len, edgeShare: edge / c.len, path, pathLength: c.len, band: w };
}

/**
 * DTW with local cost |a − b|, a monotone corner-anchored path and a
 * Sakoe–Chiba band of half-width `band` time steps: cell (i, j) is allowed
 * when |t_i − t_j| ≤ band. `t` is the time of each pair (shared by obs and
 * sim, which must then have equal length); without it the index is the time
 * and the band widens to |n − m| so the corner stays reachable.
 *
 * Storage is banded: only the allowed cells of each row are kept, so memory
 * is O(n × band), not O(n × m). The tie rule is described at dtwCore.
 *
 * Mean |warp| can never exceed the band: a lag longer than the band reads as
 * the band or less (edgeShare tells how much of the path runs along the band
 * limit). A pure shift of k ≤ band steps costs only at the record edges, and
 * mean |warp| is below k: the path starts and ends on the diagonal (corner
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
  const { lo, hi } = bandRows(to, ts, w);
  const c = dtwCore(obs, sim, to, ts, lo, hi);
  return c ? summarise(c, to, ts, w, Infinity) : nanResult(w);
}

/** How dtwOnTimeAxis aligned a record:
 *  - 'full': one full-resolution pass within the band (the usual case);
 *  - 'narrow': the band needed more than the cell budget; the reported
 *    alignment is the exact one within ±narrowBand steps (the widest band
 *    that fits one pass), which the corridor alignment did not beat, or the
 *    only one that fitted;
 *  - 'corridor': as 'narrow', but the cheaper alignment was the one found at
 *    full resolution within the band and a corridor around an alignment of
 *    block means (FastDTW);
 *  - 'blocks': last resort when no full-resolution pass fits: DTW on means of
 *    `decim` consecutive pairs. */
export type DtwMode = 'full' | 'narrow' | 'corridor' | 'blocks';

export interface DtwRecordResult extends DtwResult {
  mode: DtwMode;
  /** 1 when `path` indexes pairs (every mode but 'blocks'). In 'blocks', the
   *  block size B: `path` indexes blocks (block k starts at pair k·B) and
   *  `band` is in blocks (multiply by B for steps). */
  decim: number;
  /** The band of the reported alignment, in steps: the requested band, or
   *  narrowBand in 'narrow', or the band rounded up to whole blocks in 'blocks'. */
  bandSteps: number;
  /** The band that was asked for, in steps. */
  requestedBand: number;
  /** Block size of the coarse pass (0 when there was none). */
  coarseBlock: number;
  /** Half-width of the exact narrow pass (0 when there was none). */
  narrowBand: number;
}

/** Full-resolution rows of the corridor around a block path: every block
 *  within one block of a path cell (FastDTW radius 1; Salvador & Chan, 2007),
 *  intersected with the band. Null if a row is left empty. */
function corridorRows(cb: DtwCore, nb: number, B: number, n: number, bandLo: Int32Array, bandHi: Int32Array): { lo: Int32Array; hi: Int32Array; cells: number } | null {
  const bjLo = new Int32Array(nb).fill(nb), bjHi = new Int32Array(nb).fill(-1);
  for (let k = 0; k < cb.len; k++) {
    const bi = cb.pi[k], bj = cb.pj[k];
    if (bj < bjLo[bi]) bjLo[bi] = bj;
    if (bj > bjHi[bi]) bjHi[bi] = bj;
  }
  const lo = new Int32Array(n), hi = new Int32Array(n);
  let cells = 0;
  for (let bi = 0; bi < nb; bi++) {
    let cLo = bjLo[bi], cHi = bjHi[bi];
    if (bi > 0) { cLo = Math.min(cLo, bjLo[bi - 1]); cHi = Math.max(cHi, bjHi[bi - 1]); }
    if (bi + 1 < nb) { cLo = Math.min(cLo, bjLo[bi + 1]); cHi = Math.max(cHi, bjHi[bi + 1]); }
    const jLo = Math.max(0, cLo - 1) * B;
    const jHi = Math.min(n, (Math.min(nb - 1, cHi + 1) + 1) * B) - 1;
    for (let i = bi * B; i < Math.min(n, (bi + 1) * B); i++) {
      const a = Math.max(jLo, bandLo[i]), b = Math.min(jHi, bandHi[i]);
      if (a > b) return null;
      lo[i] = a; hi[i] = b;
      cells += b - a + 1;
    }
  }
  return { lo, hi, cells };
}

/**
 * DTW of a paired record on its time axis (`t`, the time of each pair in
 * steps), band in steps (design rule D6). One full-resolution pass whenever
 * the banded table fits `cellBudget` (mode 'full').
 *
 * Otherwise two full-resolution alignments, each within the budget, and the
 * cheaper one is reported (both are admissible paths inside the band, so the
 * smaller distance is the closer to the banded optimum):
 *  - 'narrow': the exact alignment within ±R steps, R the widest band that
 *    fits one pass; exact for every lag up to R;
 *  - 'corridor': both series block-AVERAGED over B consecutive pairs (never
 *    point-sampled; block times are the mean time of their pairs, the band is
 *    rounded up to whole blocks) and aligned, then the full-resolution series
 *    aligned inside the band AND a corridor one block either side of that
 *    coarse path (FastDTW radius 1); it can find lags longer than R.
 * Block means alone are not enough: those of a series shifted by less than B
 * are not a shifted copy of the block means, so block DTW reads such a lag as
 * amplitude error; and a coarse path can settle on an alignment that is
 * cheap only at the block scale (a record repeated with a period read at the
 * coarse scale as a lag of whole periods), which the narrow pass guards
 * against. Only when neither full-resolution pass fits does the block result
 * stand (mode 'blocks', decim = B).
 *
 * The result keeps a thinned path (DTW_PATH_KEEP) and the statistics of the
 * whole one.
 */
export function dtwOnTimeAxis(obs: Vec, sim: Vec, t: ArrayLike<number>, band: number, cellBudget = DTW_CELL_BUDGET): DtwRecordResult {
  const n = obs.length;
  const w = dtwBandSteps(band);
  const base = { mode: 'full' as DtwMode, decim: 1, bandSteps: w, requestedBand: w, coarseBlock: 0, narrowBand: 0 };
  const failed: DtwRecordResult = { ...nanResult(w), ...base };
  if (n !== sim.length || n !== t.length || n < 2) return failed;
  const rows = bandRows(t, t, w);
  if (rows.cells <= cellBudget) {
    const c = dtwCore(obs, sim, t, t, rows.lo, rows.hi);
    return c ? { ...summarise(c, t, t, w, DTW_PATH_KEEP), ...base } : failed;
  }

  // the exact alignment within the widest band that fits one pass
  let narrow: DtwResult | null = null;
  let R = Math.min(w - 1, Math.floor((cellBudget / n - 1) / 2));
  while (R >= 1 && !narrow) {
    const nr = bandRows(t, t, R);
    if (nr.cells <= cellBudget) {
      const c = dtwCore(obs, sim, t, t, nr.lo, nr.hi);
      if (c) narrow = summarise(c, t, t, R, DTW_PATH_KEEP);
      break;
    }
    R--;
  }

  // the coarse pass on block means: the smallest block size whose table
  // fits, from the no-gap estimate (gaps only remove cells), then checked on
  // the actual block times; then the corridor around it at full resolution
  let B = 2;
  while (Math.ceil(n / B) * (2 * Math.ceil(w / B) + 2) > cellBudget) B++;
  let coarse: { c: DtwCore; tb: Float64Array; bb: number; wEff: number } | null = null;
  let corridor: DtwResult | null = null;
  for (;;) {
    const nb = Math.ceil(n / B);
    if (nb < 2) break;
    const ob = new Float64Array(nb), sb = new Float64Array(nb), tb = new Float64Array(nb);
    for (let k = 0; k < nb; k++) {
      const a = k * B, b = Math.min(n, a + B);
      let so = 0, ss = 0, st = 0;
      for (let x = a; x < b; x++) { so += obs[x]; ss += sim[x]; st += t[x]; }
      ob[k] = so / (b - a); sb[k] = ss / (b - a); tb[k] = st / (b - a);
    }
    const bb = Math.ceil(w / B), wEff = bb * B;
    const br = bandRows(tb, tb, wEff);
    if (br.cells > cellBudget) { B++; continue; }
    const cb = dtwCore(ob, sb, tb, tb, br.lo, br.hi);
    if (!cb) break;
    coarse = { c: cb, tb, bb, wEff };
    const cor = corridorRows(cb, nb, B, n, rows.lo, rows.hi);
    if (cor && cor.cells <= cellBudget) {
      const c = dtwCore(obs, sim, t, t, cor.lo, cor.hi);
      if (c) corridor = summarise(c, t, t, w, DTW_PATH_KEEP);
    }
    break;
  }
  const coarseBlock = coarse ? B : 0, narrowBand = narrow ? R : 0;
  // the exact narrow alignment stands unless the corridor one is materially
  // cheaper (the same path can differ in the last bits between passes)
  if (corridor && (!narrow || corridor.distance < narrow.distance * (1 - 1e-9))) {
    return { ...corridor, ...base, mode: 'corridor', coarseBlock, narrowBand };
  }
  if (narrow) return { ...narrow, ...base, mode: 'narrow', bandSteps: R, coarseBlock, narrowBand };
  if (coarse) {
    return { ...summarise(coarse.c, coarse.tb, coarse.tb, coarse.wEff, DTW_PATH_KEEP), ...base, band: coarse.bb, mode: 'blocks', decim: B, bandSteps: coarse.wEff, coarseBlock };
  }
  return failed;
}
