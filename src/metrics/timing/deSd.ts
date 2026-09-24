// Diagnostic Efficiency (Schwemmle, Demand & Weiler, 2021): semantics mirror
// the authors' diag-eff 1.1 package exactly (verified against executed outputs
// in tests/timing.test.ts): descending FDC sort, zero-diff → zero bias, non-finite
// bias terms dropped, Simpson integration on a uniform (0,1) grid, and the
// package's small-value artefact zeroing. And Series Distance in the spirit of
// Ehret & Zehe (2011): matched-event rise/recession comparison at equal relative
// position, reported as separate occurrence / amplitude / timing components.

import { mean, pearson, simpsonUniform, type Vec } from '../support/stats'
import { detectEvents, type EventOptions, type EventSpan } from './events'
import { overlapEdges, matchEvents, SD_EXACT_MAX_EVENTS } from './eventMatch'

export { SD_EXACT_MAX_EVENTS }

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
