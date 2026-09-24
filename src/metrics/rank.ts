// Composite priority-metric ranking (spec §14, AC13).
// Efficiencies with known [-inf,1] ranges are normalised via C2M = E/(2−E)
// (bounded (−1,1]) then mapped to [0,1]; naturally bounded skill scores are
// min–max scaled across runs; error/target-zero/target-one metrics are scored
// by closeness to the optimum, min–max scaled across runs (relative ranking).
// Composite = weighted mean of per-metric scores; ties broken by name order.

import { arrMin, arrMax } from './support/stats'
import { byId, C2M_APPLICABLE } from './registry'
import { c2m } from './classical/catalogue'

export interface RankInput { runName: string; values: Record<string, number> }
export interface RankRow {
  runName: string;
  perMetric: Record<string, number>; // score in [0,1], NaN if unavailable
  composite: number;
  rank: number;
}

function minMax(xs: number[]): (v: number) => number {
  const fin = xs.filter(isFinite);
  if (!fin.length) return () => NaN;
  const lo = arrMin(fin), hi = arrMax(fin);
  if (hi - lo < 1e-15) return v => (isFinite(v) ? 1 : NaN); // all equal → all best
  return v => (isFinite(v) ? (v - lo) / (hi - lo) : NaN);
}

export function scoreMetric(id: string, raw: number[]): number[] {
  const meta = byId.get(id);
  if (!meta) return raw.map(() => NaN);
  if (meta.direction === 'max') {
    const vals = C2M_APPLICABLE.has(id) ? raw.map(v => (c2m(v) + 1) / 2) : raw.slice();
    const s = minMax(vals);
    return vals.map(s);
  }
  // min / zero / one → distance to optimum, smaller is better
  const opt = meta.direction === 'one' ? 1 : 0;
  const dist = raw.map(v => (isFinite(v) ? Math.abs(v - opt) : NaN));
  const fin = dist.filter(isFinite);
  if (!fin.length) return dist.map(() => NaN);
  const lo = arrMin(fin), hi = arrMax(fin);
  if (hi - lo < 1e-15) return dist.map(d => (isFinite(d) ? 1 : NaN)); // all equally good
  return dist.map(d => (isFinite(d) ? 1 - (d - lo) / (hi - lo) : NaN));
}

/** Composites closer than this are a tie and share a rank. */
export const TIE_TOL = 1e-9;

/** Metrics that measure a time offset; DE (its timing term is a correlation)
 *  and the per-event magnitude errors carry the timing flag but do not. */
export const SHIFT_TOLERANT_IDS = new Set(['peak_lag_abs', 'peak_lag_signed', 'event_lag', 'lag_best', 'sd_time',
  'dtw_warp', 'w1', 'w2sq', 'xwt_lag']);   // not dtw_dist: an amplitude mismatch after warping, blind to the offset

export function rankRuns(inputs: RankInput[], priorities: { id: string; weight: number }[]): RankRow[] {
  const active = priorities.filter(p => p.weight > 0);
  const perMetricScores = new Map<string, number[]>();
  for (const p of active) {
    const sc = scoreMetric(p.id, inputs.map(i => i.values[p.id] ?? NaN));
    // Every run is scored on the same metrics: when a metric is available for
    // some runs, a run on which it cannot be computed (a flat simulation has no
    // KGE or peak timing) scores 0, the worst, instead of being compared on a
    // smaller set; a metric no run has is left out for all of them.
    if (sc.some(v => isFinite(v))) perMetricScores.set(p.id, sc.map(v => (isFinite(v) ? v : 0)));
    else perMetricScores.set(p.id, sc);
  }
  const rows: RankRow[] = inputs.map((inp, i) => {
    const perMetric: Record<string, number> = {};
    let acc = 0, wsum = 0;
    for (const p of active) {
      const sc = perMetricScores.get(p.id)![i];
      perMetric[p.id] = sc;
      if (isFinite(sc)) { acc += p.weight * sc; wsum += p.weight; }
    }
    return { runName: inp.runName, perMetric, composite: wsum ? acc / wsum : NaN, rank: 0 };
  });
  // a missing composite sorts last; 0 is a valid (worst) composite, not missing
  const key = (c: number) => (Number.isFinite(c) ? c : -Infinity);
  const order = rows.map((_, i) => i).sort((a, b) => {
    const ka = key(rows[a].composite), kb = key(rows[b].composite);
    if (Math.abs(ka - kb) > TIE_TOL && ka !== kb) return kb - ka;
    return rows[a].runName.localeCompare(rows[b].runName);
  });
  // tied composites share a rank (1, 1, 3): no run is called better than an equal one
  order.forEach((idx, pos) => {
    const prev = pos > 0 ? rows[order[pos - 1]] : null;
    const tied = prev && Number.isFinite(prev.composite) && Number.isFinite(rows[idx].composite)
      && Math.abs(prev.composite - rows[idx].composite) <= TIE_TOL;
    rows[idx].rank = tied ? prev!.rank : pos + 1;
  });
  return rows;
}

/** Default priorities when the user hasn't picked any (§14). */
export const DEFAULT_PRIORITIES = [
  { id: 'nse', weight: 1 }, { id: 'kge2009', weight: 1 },
  { id: 'w1', weight: 1 }, { id: 'peak_lag_abs', weight: 1 },
];
