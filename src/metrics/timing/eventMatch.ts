// One-to-one matching of observed and simulated events, shared by the event
// metrics (events.ts: hits, misses, false alarms and the matched events whose
// errors are averaged) and Series Distance (deSd.ts), so both use the same
// pairs: the most hits, then the least total peak distance.

import type { EventSpan } from './events'

/** Overlap groups (connected components of the overlap graph) with more events
 *  than this, observed plus simulated, are paired greedily; the exact
 *  assignment costs O(N^3) in the group size N. */
export const SD_EXACT_MAX_EVENTS = 400;

/** A candidate pair: observed event o and simulated event s overlap; d is the
 *  distance between their peaks in time steps. */
export interface Edge { o: number; s: number; d: number }

/**
 * All (observed, simulated) event pairs whose windows, each widened by the
 * tolerance, overlap in time. The events of each series are disjoint and in
 * time order, so the partners of an observed event are a contiguous run of
 * simulated events and one sweep finds every pair in O(N + pairs).
 */
export function overlapEdges(oe: EventSpan[], se: EventSpan[], tol: number, tt: (i: number) => number): Edge[] {
  const edges: Edge[] = [];
  let lo = 0;
  for (let i = 0; i < oe.length; i++) {
    const a = oe[i], from = tt(a.start) - tol, to = tt(a.end) + tol;
    while (lo < se.length && tt(se[lo].end) < from) lo++;
    for (let j = lo; j < se.length && tt(se[j].start) <= to; j++) {
      edges.push({ o: i, s: j, d: Math.abs(tt(se[j].peakIdx) - tt(a.peakIdx)) });
    }
  }
  return edges;
}

/**
 * Minimum-cost perfect assignment on a square N x N cost matrix (row-major),
 * Kuhn-Munkres with potentials, O(N^3), no recursion. Infinite entries are
 * forbidden pairs; the caller guarantees that a finite assignment exists.
 * Returns the column of each row. Among equal-cost optima the result depends
 * only on the fixed row and column order (time order), so it is deterministic.
 */
function assignMinCost(N: number, a: Float64Array): Int32Array {
  const u = new Float64Array(N + 1), v = new Float64Array(N + 1);
  const p = new Int32Array(N + 1), way = new Int32Array(N + 1);
  const minv = new Float64Array(N + 1), used = new Uint8Array(N + 1);
  for (let i = 1; i <= N; i++) {
    p[0] = i;
    let j0 = 0;
    minv.fill(Infinity);
    used.fill(0);
    do {
      used[j0] = 1;
      const i0 = p[j0], row = (i0 - 1) * N;
      let delta = Infinity, j1 = -1;
      for (let j = 1; j <= N; j++) {
        if (used[j]) continue;
        const cur = a[row + j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      // cannot happen: every row has a finite dummy column
      if (j1 < 0) throw new Error('Series Distance: no finite event assignment');
      for (let j = 0; j <= N; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0 !== 0);
  }
  const colOf = new Int32Array(N);
  for (let j = 1; j <= N; j++) colOf[p[j] - 1] = j - 1;
  return colOf;
}

/**
 * One-to-one event matching: the most hits first, then the least total peak
 * distance (a minimum-cost maximum-cardinality matching on the overlap graph).
 *
 * The overlap graph is split into connected components (union-find). Each
 * component with nO observed and nS simulated events is solved exactly as a
 * square (nO + nS) assignment: an overlapping pair costs its peak distance in
 * time steps, a non-overlapping pair is forbidden, leaving an observed or a
 * simulated event unpaired (a pairing with a dummy) costs D, and dummy with
 * dummy costs 0. D exceeds the sum of all pair distances in the component, so
 * one more hit always outweighs any change in distance: the optimum has the
 * most hits and, among those, the least total distance.
 *
 * Kuhn's augmenting paths maximised hits only (an observed flood could be moved
 * to a simulated peak 20 steps away to free the one at its own step), and a
 * greedy pass in time order could lose hits. Components with more than
 * SD_EXACT_MAX_EVENTS events are paired greedily, nearest peaks first (ties by
 * observed, then simulated time order), and counted in greedyEvents.
 */
export function matchEvents(nObs: number, nSim: number, edges: Edge[]): { simOf: Int32Array; greedyEvents: number } {
  const parent = Int32Array.from({ length: nObs + nSim }, (_, k) => k);
  const find = (k: number): number => {
    while (parent[k] !== k) { parent[k] = parent[parent[k]]; k = parent[k]; }
    return k;
  };
  for (const e of edges) {
    const ra = find(e.o), rb = find(nObs + e.s);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
  const groups = new Map<number, Edge[]>();
  for (const e of edges) {
    const r = find(e.o);
    const g = groups.get(r);
    if (g) g.push(e); else groups.set(r, [e]);
  }

  const simOf = new Int32Array(nObs).fill(-1);
  let greedyEvents = 0;
  for (const comp of groups.values()) {
    const os = [...new Set(comp.map(e => e.o))].sort((x, y) => x - y);
    const ss = [...new Set(comp.map(e => e.s))].sort((x, y) => x - y);
    const nO = os.length, nS = ss.length, N = nO + nS;
    if (N > SD_EXACT_MAX_EVENTS) {
      greedyEvents += N;
      const taken = new Set<number>();
      for (const e of [...comp].sort((x, y) => x.d - y.d || x.o - y.o || x.s - y.s)) {
        if (simOf[e.o] < 0 && !taken.has(e.s)) { simOf[e.o] = e.s; taken.add(e.s); }
      }
      continue;
    }
    let total = 0;
    for (const e of comp) total += e.d;
    const D = total + 1;
    const a = new Float64Array(N * N).fill(Infinity);
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const obsRow = r < nO, simCol = c < nS;
        if (obsRow && !simCol) a[r * N + c] = D;          // observed event unpaired (miss)
        else if (!obsRow && simCol) a[r * N + c] = D;     // simulated event unpaired (false alarm)
        else if (!obsRow && !simCol) a[r * N + c] = 0;    // dummy with dummy
      }
    }
    const row = new Map(os.map((o, r) => [o, r] as const));
    const col = new Map(ss.map((s, c) => [s, c] as const));
    for (const e of comp) a[row.get(e.o)! * N + col.get(e.s)!] = e.d;
    const colOf = assignMinCost(N, a);
    for (let r = 0; r < nO; r++) {
      const c = colOf[r];
      if (c < nS && Number.isFinite(a[r * N + c])) simOf[os[r]] = ss[c];
    }
  }
  return { simOf, greedyEvents };
}
