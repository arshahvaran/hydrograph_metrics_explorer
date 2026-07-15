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

export function rankRuns(inputs: RankInput[], priorities: { id: string; weight: number }[]): RankRow[] {
  const active = priorities.filter(p => p.weight > 0);
  const perMetricScores = new Map<string, number[]>();
  for (const p of active) {
    perMetricScores.set(p.id, scoreMetric(p.id, inputs.map(i => i.values[p.id] ?? NaN)));
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
  const order = rows.map((_, i) => i).sort((a, b) => {
    const d = (rows[b].composite || -Infinity) - (rows[a].composite || -Infinity);
    return d !== 0 ? d : rows[a].runName.localeCompare(rows[b].runName);
  });
  order.forEach((idx, pos) => { rows[idx].rank = pos + 1; });
  return rows;
}

/** Default priorities when the user hasn't picked any (§14). */
export const DEFAULT_PRIORITIES = [
  { id: 'nse', weight: 1 }, { id: 'kge2009', weight: 1 },
  { id: 'w1', weight: 1 }, { id: 'peak_lag_abs', weight: 1 },
];
