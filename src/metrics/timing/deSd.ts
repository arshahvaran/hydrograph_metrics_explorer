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

/**
 * One-to-one event matching with the most hits: Kuhn's augmenting-path
 * algorithm on the overlap graph, trying candidates nearest-peak first and
 * taking observed events in order of their nearest candidate. A greedy pass in
 * time order let an early observed event take the only candidate of a later
 * one (or a merged simulated event), which turned a true hit into a miss plus
 * a false alarm and paired floods tens of steps apart.
 */
function matchEvents(nObs: number, cand: number[][]): number[] {
  const simOf = new Array<number>(nObs).fill(-1);
  const obsOf = new Map<number, number>();
  const tryAssign = (a: number, seen: Set<number>): boolean => {
    for (const j of cand[a]) {
      if (seen.has(j)) continue;
      seen.add(j);
      const holder = obsOf.get(j);
      if (holder === undefined || tryAssign(holder, seen)) { simOf[a] = j; obsOf.set(j, a); return true; }
    }
    return false;
  };
  const order = Array.from({ length: nObs }, (_, a) => a).filter(a => cand[a].length > 0);
  for (const a of order) tryAssign(a, new Set<number>());
  return simOf;
}

/**
 * Series Distance (Ehret & Zehe, 2011), core form: events detected on both
 * series with the same absolute threshold; obs/sim events paired one to one by
 * window overlap (most hits, nearest peaks first); each pair compared on its
 * rise and recession at K equal relative positions in time. Timing is in time
 * steps of the record (`time`, the original step of every pair, keeps gaps on
 * the axis); amplitude is S − O in flow units, as in Ehret & Zehe (2011).
 */
export function seriesDistance(obs: Vec, sim: Vec, opt: EventOptions, matchTolerance: number, K = 20, time?: ArrayLike<number>): SdResult {
  const tt = (i: number) => (time ? time[i] : i);
  const { events: oe, threshold } = detectEvents(obs, opt);
  const se = detectEvents(sim, { ...opt, thresholdKind: 'absolute', thresholdValue: threshold }).events;

  const overlaps = (a: EventSpan, b: EventSpan) =>
    tt(a.start) - matchTolerance <= tt(b.end) && tt(b.start) - matchTolerance <= tt(a.end);

  const peakDist = (a: EventSpan, b: EventSpan) => Math.abs(tt(b.peakIdx) - tt(a.peakIdx));
  const cand = oe.map(a => se.map((_b, j) => j).filter(j => overlaps(a, se[j])).sort((x, y) => peakDist(a, se[x]) - peakDist(a, se[y]) || x - y));
  // observed events with a close candidate claim first; ties keep time order
  const priority = oe.map((a, i) => (cand[i].length ? peakDist(a, se[cand[i][0]]) : Infinity));
  const byPriority = oe.map((_a, i) => i).sort((x, y) => priority[x] - priority[y] || x - y);
  const simOfSorted = matchEvents(byPriority.length, byPriority.map(i => cand[i]));
  const pairs: [EventSpan, EventSpan][] = [];
  byPriority.forEach((i, k) => { if (simOfSorted[k] >= 0) pairs.push([oe[i], se[simOfSorted[k]]]); });
  pairs.sort((x, y) => x[0].start - y[0].start);

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
    note: 'Core SD: events paired one to one (most hits, nearest peaks first) and compared on rise and recession at equal relative position in time; amplitude S - O in flow units; occurrence is the event threat score.',
  };
}
