// Diagnostic Efficiency (Schwemmle, Demand & Weiler, 2021) — semantics mirror
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
  temporalR: number;        // timing (Pearson r of the time series)
  phi: number;              // polar angle from arctan2(brelMean, bArea·bDir) — full diag-eff form
  phiFdc: number;           // arctan2(brelMean, bArea) without the direction sign (fixture-pinned)
  nonPerennial: boolean;    // observed contains zeros/negatives — DE assumptions violated
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

  const temporalR = pearson(obs, sim);
  const de = Math.sqrt(brelMean ** 2 + bArea ** 2 + (temporalR - 1) ** 2);

  // polar angle: direction from Simpson halves of the residual bias curve
  const mid = Math.floor(res.length / 2);
  const bHf = simpsonUniform(res.slice(0, mid), 0, 0.5);
  const bLf = simpsonUniform(res.slice(mid), 0.5, 1);
  let bDir = 0;
  if ((bHf > 0 && bLf < 0) || (bHf === 0 && bLf < 0) || (bHf > 0 && bLf === 0)) bDir = -1;
  else if ((bHf < 0 && bLf > 0) || (bHf === 0 && bLf > 0) || (bHf < 0 && bLf === 0)) bDir = 1;
  const capPi = (v: number) => { let p = zeroArtefact(v); if (p > 3.1414) p = 3.1414; return p; };
  const phi = capPi(Math.atan2(brelMean, bArea * bDir));
  const phiFdc = capPi(Math.atan2(brelMean, bArea));

  return { de, brelMean, bArea, temporalR, phi, phiFdc, nonPerennial };
}

// ---------------- Series Distance ----------------
export interface SdResult {
  occurrence: number;        // threat score ∈ [0,1], optimum 1
  meanAmplitudeErrPct: number; // mean relative amplitude offset over matched segments, optimum 0
  meanTimingErr: number;     // mean timing offset (steps, signed; + = sim late), optimum 0
  meanAbsTimingErr: number;
  matchedEvents: number;
  note: string;
}

interface Segment { t: number[]; q: number[] }

function segments(x: Vec, e: EventSpan): { rise: Segment; rec: Segment } {
  const rise: Segment = { t: [], q: [] }, rec: Segment = { t: [], q: [] };
  for (let i = e.start; i <= e.peakIdx; i++) { rise.t.push(i); rise.q.push(x[i]); }
  for (let i = e.peakIdx; i <= e.end; i++) { rec.t.push(i); rec.q.push(x[i]); }
  return { rise, rec };
}

/** Linear interpolation of (t, q) at relative position u ∈ [0,1] along the segment. */
function atRel(seg: Segment, u: number): { t: number; q: number } {
  const n = seg.t.length;
  if (n === 1) return { t: seg.t[0], q: seg.q[0] };
  const pos = u * (n - 1);
  const i = Math.min(n - 2, Math.floor(pos));
  const f = pos - i;
  return { t: seg.t[i] + f * (seg.t[i + 1] - seg.t[i]), q: seg.q[i] + f * (seg.q[i + 1] - seg.q[i]) };
}

/**
 * Series Distance, core form: events detected on both series with the same
 * absolute threshold; obs/sim events matched by window overlap; each matched
 * pair compared on its rise and recession at K equal relative positions.
 * Full interactive segment supervision (Ehret & Zehe, 2011 §3.3) is a later
 * refinement; this core follows the paper's summary of the method.
 */
export function seriesDistance(obs: Vec, sim: Vec, opt: EventOptions, matchTolerance: number, K = 20): SdResult {
  const { events: oe, threshold } = detectEvents(obs, opt);
  const se = detectEvents(sim, { ...opt, thresholdKind: 'absolute', thresholdValue: threshold }).events;

  const overlaps = (a: EventSpan, b: EventSpan) =>
    a.start - matchTolerance <= b.end && b.start - matchTolerance <= a.end;

  const usedSim = new Set<number>();
  const pairs: [EventSpan, EventSpan][] = [];
  for (const a of oe) {
    let bestJ = -1, bestDist = Infinity;
    se.forEach((b, j) => {
      if (usedSim.has(j) || !overlaps(a, b)) return;
      const dd = Math.abs(b.peakIdx - a.peakIdx);
      if (dd < bestDist) { bestDist = dd; bestJ = j; }
    });
    if (bestJ >= 0) { usedSim.add(bestJ); pairs.push([a, se[bestJ]]); }
  }
  const hits = pairs.length;
  const misses = oe.length - hits;
  const falseAlarms = se.length - hits;
  const occurrence = hits + misses + falseAlarms > 0 ? hits / (hits + misses + falseAlarms) : NaN;

  const ampErrs: number[] = [], timeErrs: number[] = [];
  for (const [a, b] of pairs) {
    const sa = segments(obs, a), sb = segments(sim, b);
    for (const part of ['rise', 'rec'] as const) {
      for (let k = 0; k <= K; k++) {
        const u = k / K;
        const po = atRel(sa[part], u), ps = atRel(sb[part], u);
        if (po.q !== 0) ampErrs.push(100 * (ps.q - po.q) / po.q);
        timeErrs.push(ps.t - po.t);
      }
    }
  }
  return {
    occurrence,
    meanAmplitudeErrPct: ampErrs.length ? mean(ampErrs) : NaN,
    meanTimingErr: timeErrs.length ? mean(timeErrs) : NaN,
    meanAbsTimingErr: timeErrs.length ? mean(timeErrs.map(Math.abs)) : NaN,
    matchedEvents: hits,
    note: 'Core SD: matched events compared on rise/recession at equal relative position; occurrence is the event threat score.',
  };
}
