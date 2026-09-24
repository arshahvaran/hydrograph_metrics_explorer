// Diagnostic Efficiency (Schwemmle, Demand & Weiler, 2021): semantics mirror
// the authors' diag-eff 1.1 package exactly (verified against executed outputs
// in tests/timing.test.ts): descending FDC sort, zero-diff → zero bias, non-finite
// bias terms dropped, Simpson integration on a uniform (0,1) grid, and the
// package's small-value artefact zeroing. And Series Distance in the spirit of
// Ehret & Zehe (2011): matched-event rise/recession comparison at equal relative
// position, reported as separate occurrence / amplitude / timing components.

import { mean, pearson, simpsonUniform, type Vec } from '../support/stats'
import { detectEvents, type EventOptions, type EventSpan } from './events'

// ---------------- Diagnostic Efficiency ----------------
export interface DeResult {
  de: number;               // optimum 0, grows with error
  brelMean: number;         // constant error (mean relative FDC bias)
  bArea: number;            // dynamic error (area of residual FDC bias)
  temporalR: number;        // timing (Pearson r of the time series); 0 when undefined, as diag-eff
  rUndefined: boolean;      // r could not be computed (a constant series) and was set to 0
  phi: number;              // polar angle from arctan2(brelMean, bArea·bDir); full diag-eff form
  phiFdc: number;           // arctan2(brelMean, bArea) without the direction sign (fixture-pinned)
  nonPerennial: boolean;    // observed contains zeros/negatives; DE assumptions violated
}

const zeroArtefact = (v: number, tol = 0.001) => (Math.abs(v) < tol ? 0 : v);

function brelSorted(obs: Vec, sim: Vec): Float64Array {
  const o = Float64Array.from(obs as ArrayLike<number>).sort().reverse();
  const s = Float64Array.from(sim as ArrayLike<number>).sort().reverse();
  const out: number[] = [];
  for (let i = 0; i < o.length; i++) {
    const diff = s[i] - o[i];
    const b = diff === 0 ? 0 : diff / o[i];
    if (isFinite(b)) out.push(b);
  }
  return Float64Array.from(out);
}

export function diagnosticEfficiency(obs: Vec, sim: Vec): DeResult {
  let nonPerennial = false;
  for (let i = 0; i < obs.length; i++) if (!(obs[i] > 0)) { nonPerennial = true; break; }

  const brel = brelSorted(obs, sim);
  const brelMean = zeroArtefact(mean(brel));

  const rawMean = mean(brel);                    // residual uses the un-zeroed mean
  const res = Float64Array.from(brel, v => v - rawMean);
  const absRes = Float64Array.from(res, Math.abs);
  const bArea = zeroArtefact(simpsonUniform(absRes, 0, 1));

  // diag-eff calc_temp_cor: an undefined correlation (a constant series) is set to 0
  const r0 = pearson(obs, sim);
  const rUndefined = !Number.isFinite(r0);
  const temporalR = rUndefined ? 0 : r0;
  const de = Math.sqrt(brelMean ** 2 + bArea ** 2 + (temporalR - 1) ** 2);

  // polar angle: direction from Simpson halves of the residual bias curve
  const mid = Math.floor(res.length / 2);
  // diag-eff zeroes |b| < 0.001 in both halves before choosing the direction,
  // so rounding residue does not decide the plotted angle
  const bHf = zeroArtefact(simpsonUniform(res.slice(0, mid), 0, 0.5));
  const bLf = zeroArtefact(simpsonUniform(res.slice(mid), 0.5, 1));
  let bDir = 0;
  if ((bHf > 0 && bLf < 0) || (bHf === 0 && bLf < 0) || (bHf > 0 && bLf === 0)) bDir = -1;
  else if ((bHf < 0 && bLf > 0) || (bHf === 0 && bLf > 0) || (bHf < 0 && bLf === 0)) bDir = 1;
  const capPi = (v: number) => { let p = zeroArtefact(v); if (p > 3.1414) p = 3.1414; return p; };
  const phi = capPi(Math.atan2(brelMean, bArea * bDir));
  const phiFdc = capPi(Math.atan2(brelMean, bArea));

  return { de, brelMean, bArea, temporalR, rUndefined, phi, phiFdc, nonPerennial };
}

// ---------------- Series Distance ----------------
export interface SdResult {
  occurrence: number;        // threat score ∈ [0,1], optimum 1
  meanAmplitudeErr: number;  // mean amplitude offset S − O over matched segments, in flow units, optimum 0
  meanTimingErr: number;     // mean timing offset (steps, signed; + = sim late), optimum 0
  meanAbsTimingErr: number;
  matchedEvents: number;
  /** Peak times (original steps) of each matched pair, observed then simulated. */
  pairedPeaks: [number, number][];
  /** Observed and simulated events detected: the same event set as the event metrics. */
  obsEvents: number;
  simEvents: number;
  /** Detected events (observed + simulated) whose start or end borders missing steps. */
  gapEdges: number;
  /** Matched events (observed + simulated) that contain missing steps. */
  gapSpans: number;
  /** Events in overlap groups larger than SD_EXACT_MAX_EVENTS, paired greedily. */
  greedyEvents: number;
  note: string;
}

interface Segment { t: number[]; q: number[] }

/** Rise and recession of an event, with TIME (original step index `tt(i)`) as the
 *  abscissa, so removed rows inside an event keep their place on the time axis. */
function segments(x: Vec, e: EventSpan, tt: (i: number) => number): { rise: Segment; rec: Segment } {
  const rise: Segment = { t: [], q: [] }, rec: Segment = { t: [], q: [] };
  for (let i = e.start; i <= e.peakIdx; i++) { rise.t.push(tt(i)); rise.q.push(x[i]); }
  for (let i = e.peakIdx; i <= e.end; i++) { rec.t.push(tt(i)); rec.q.push(x[i]); }
  return { rise, rec };
}

/** (t, q) at relative position u in [0,1] of the segment's DURATION (linear
 *  interpolation in time), so gaps do not distort where "the middle" is. */
function atRel(seg: Segment, u: number): { t: number; q: number } {
  const n = seg.t.length;
  if (n === 1) return { t: seg.t[0], q: seg.q[0] };
  const t = seg.t[0] + u * (seg.t[n - 1] - seg.t[0]);
  let i = 0;
  while (i < n - 2 && seg.t[i + 1] < t) i++;
  const span = seg.t[i + 1] - seg.t[i];
  const f = span > 0 ? Math.min(1, Math.max(0, (t - seg.t[i]) / span)) : 0;
  return { t, q: seg.q[i] + f * (seg.q[i + 1] - seg.q[i]) };
}

/** Overlap groups (connected components of the overlap graph) with more events
 *  than this, observed plus simulated, are paired greedily; the exact
 *  assignment costs O(N^3) in the group size N. */
export const SD_EXACT_MAX_EVENTS = 400;

/** A candidate pair: observed event o and simulated event s overlap; d is the
 *  distance between their peaks in time steps. */
interface Edge { o: number; s: number; d: number }

/**
 * All (observed, simulated) event pairs whose windows, each widened by the
 * tolerance, overlap in time. The events of each series are disjoint and in
 * time order, so the partners of an observed event are a contiguous run of
 * simulated events and one sweep finds every pair in O(N + pairs).
 */
function overlapEdges(oe: EventSpan[], se: EventSpan[], tol: number, tt: (i: number) => number): Edge[] {
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
function matchEvents(nObs: number, nSim: number, edges: Edge[]): { simOf: Int32Array; greedyEvents: number } {
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

/**
 * Series Distance (Ehret & Zehe, 2011), core form: events detected on both
 * series with the same absolute threshold, on the record's time axis (`time`,
 * the time-step position of every pair, as for the event metrics, so both use
 * the same event set and a data gap ends an event); obs/sim events paired one
 * to one by window overlap (the most hits, then the least total peak distance);
 * each pair compared on its rise and recession at K equal relative positions in
 * time. Timing is in time steps of the record; amplitude is S − O in flow
 * units, as in Ehret & Zehe (2011).
 */
export function seriesDistance(obs: Vec, sim: Vec, opt: EventOptions, matchTolerance: number, K = 20, time?: ArrayLike<number>): SdResult {
  const tt = (i: number) => (time ? time[i] : i);
  const { events: oe, threshold } = detectEvents(obs, opt, time);
  const se = detectEvents(sim, { ...opt, thresholdKind: 'absolute', thresholdValue: threshold }, time).events;

  const { simOf, greedyEvents } = matchEvents(oe.length, se.length, overlapEdges(oe, se, matchTolerance, tt));
  const pairs: [EventSpan, EventSpan][] = [];
  oe.forEach((a, i) => { if (simOf[i] >= 0) pairs.push([a, se[simOf[i]]]); });

  // D1: an event edge next to missing steps is the gap, not a threshold
  // crossing; a matched event that contains missing steps is interpolated
  // across them in time.
  const gapBefore = (i: number) => i > 0 && tt(i) - tt(i - 1) > 1;
  const edgeAtGap = (e: EventSpan, n: number) => gapBefore(e.start) || (e.end + 1 < n && gapBefore(e.end + 1));
  const spansGap = (e: EventSpan) => { for (let i = e.start + 1; i <= e.end; i++) if (gapBefore(i)) return true; return false; };
  const gapEdges = oe.filter(e => edgeAtGap(e, obs.length)).length + se.filter(e => edgeAtGap(e, sim.length)).length;
  const gapSpans = pairs.reduce((k, [a, b]) => k + (spansGap(a) ? 1 : 0) + (spansGap(b) ? 1 : 0), 0);

  const hits = pairs.length;
  const misses = oe.length - hits;
  const falseAlarms = se.length - hits;
  const occurrence = hits + misses + falseAlarms > 0 ? hits / (hits + misses + falseAlarms) : NaN;

  const ampErrs: number[] = [], timeErrs: number[] = [];
  for (const [a, b] of pairs) {
    const sa = segments(obs, a, tt), sb = segments(sim, b, tt);
    for (const part of ['rise', 'rec'] as const) {
      for (let k = 0; k <= K; k++) {
        const u = k / K;
        const po = atRel(sa[part], u), ps = atRel(sb[part], u);
        ampErrs.push(ps.q - po.q);
        timeErrs.push(ps.t - po.t);
      }
    }
  }
  return {
    occurrence,
    meanAmplitudeErr: ampErrs.length ? mean(ampErrs) : NaN,
    meanTimingErr: timeErrs.length ? mean(timeErrs) : NaN,
    meanAbsTimingErr: timeErrs.length ? mean(timeErrs.map(Math.abs)) : NaN,
    matchedEvents: hits,
    pairedPeaks: pairs.map(([a, b]) => [tt(a.peakIdx), tt(b.peakIdx)] as [number, number]),
    obsEvents: oe.length,
    simEvents: se.length,
    gapEdges,
    gapSpans,
    greedyEvents,
    note: 'Core SD: events paired one to one (the most hits, then the least total peak distance) and compared on rise and recession at equal relative position in time; amplitude S - O in flow units; occurrence is the event threat score.',
  };
}
