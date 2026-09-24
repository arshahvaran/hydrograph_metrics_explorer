import { useApp } from '../store/store'
import type { Dataset } from '../types'
import { useRunOutputs, frameFor, useComputeError } from './compute'
import { rankRuns, DEFAULT_PRIORITIES, SHIFT_TOLERANT_IDS } from '../metrics/rank'
import { REGISTRY, byId, transformNotes, rankingOmissionNote } from '../metrics/registry'
import { fmtNum } from './format'

/** Priority candidates: the previous shortlist restricted to metrics that are in
 *  the essentials preset (author round 7); a governance test pins this subset. */
export const CANDIDATE_IDS = ['nse', 'kge2009', 'r2', 've', 'rmse', 'pbias',
  'peak_lag_abs', 'w1', 'dtw_warp', 'de', 'xwt_lag'] as const;
const CANDIDATES = REGISTRY.filter(m => (CANDIDATE_IDS as readonly string[]).includes(m.id));

/** Compare simulations: priority-metric composite ranking + recommendation (spec §14, AC13). */
export function CompareTab() {
  const ds = useApp(s => s.project.datasets.find(d => d.id === s.project.activeDatasetId) ?? null);
  if (!ds) return null;
  return <CompareTabInner ds={ds} />;
}

function CompareTabInner({ ds }: { ds: Dataset }) {
  const updateView = useApp(s => s.updateView);
  const runs = ds.runs.filter(r => r.visible);
  const outputs = useRunOutputs(ds, runs);
  const computeError = useComputeError(ds);
  const frame = frameFor(ds);

  if (runs.length < 2) {
    return <section className="card"><h2>Compare simulations</h2>
      <p className="muted">Add at least two visible model simulations to rank them. The ranking uses your priority metrics, with efficiencies normalised through the bounded C2M form so no single unbounded score dominates.</p></section>;
  }
  if (outputs.some(o => o === null)) {
    return <section className="card"><h2>Compare simulations</h2>
      {computeError
        ? <div className="error" role="alert">{computeError}</div>
        : <p className="muted">Computing metric panels in a background worker…</p>}
    </section>;
  }

  const priorities = ds.view.priorityMetrics.length ? ds.view.priorityMetrics : DEFAULT_PRIORITIES;
  const activePriorities = priorities.filter(p => p.weight > 0);

  const rows = rankRuns(
    runs.map((r, i) => ({ runName: r.name, values: outputs[i]!.values })),
    priorities,
  );
  const order = rows.map((_, i) => i).sort((a, b) => rows[a].rank - rows[b].rank);
  const winner = rows[order[0]];
  const winnerRun = runs[order[0]];
  // every run sharing rank 1: a tie is reported as a tie, not as a recommendation
  const leaders = order.filter(i => rows[i].rank === 1 && isFinite(rows[i].composite));
  // "strongest on": metrics where the winner is the best of the runs, and not at the floor
  const contributors = activePriorities
    .map(p => ({ id: p.id, sc: winner.perMetric[p.id], top: Math.max(...rows.map(r => (isFinite(r.perMetric[p.id]) ? r.perMetric[p.id] : -Infinity))) }))
    .filter(c => isFinite(c.sc) && c.sc > 0 && c.sc >= c.top - 1e-9)
    .sort((a, b) => b.sc - a.sc)
    .slice(0, 2)
    .map(c => byId.get(c.id)?.label ?? c.id);
  const hasShiftTolerant = activePriorities.some(p => SHIFT_TOLERANT_IDS.has(p.id));
  // the metrics the composite actually averages: one that no simulation has
  // (KGE on log flows) is left out, and the notes below say so (tb-rev-03)
  const ranked = activePriorities.filter(p => rows.some(r => isFinite(r.perMetric[p.id])));
  const omission = rankingOmissionNote(priorities, runs.map((_, i) => outputs[i]!.values), ds.view.transform);

  const setWeight = (id: string, weight: number) => {
    updateView({ priorityMetrics: priorities.map(p => (p.id === id ? { ...p, weight } : p)) });
  };
  const addMetric = (id: string) => {
    if (priorities.some(p => p.id === id)) return;
    updateView({ priorityMetrics: [...priorities, { id, weight: 1 }] });
  };
  const removeMetric = (id: string) => {
    updateView({ priorityMetrics: priorities.filter(p => p.id !== id) });
  };

  return (
    <div>
      <section className="card">
        <h2>Priority metrics <span className="muted">select the metrics that matter for your application, then enter the relative weights</span></h2>
        <div className="twocol">
          <div className="prigrid">
            {CANDIDATES.map(m => {
              const picked = priorities.some(p => p.id === m.id);
              return (
                <label key={m.id} className="prirow">
                  <input type="checkbox" checked={picked}
                    onChange={e => (e.target.checked ? addMetric(m.id) : removeMetric(m.id))} />
                  <span>{m.timing ? '⏱ ' : ''}{m.label}</span>
                </label>
              );
            })}
          </div>
          <div>
            <div className="tblscroll">
              <table className="grid" aria-label="Selected priority metrics and weights">
                <thead><tr><th>Metric</th><th>Weight</th><th><span className="vh">Remove</span></th></tr></thead>
                <tbody>
                  {priorities.map(p => (
                    <tr key={p.id}>
                      <td>{byId.get(p.id)?.timing ? '⏱ ' : ''}{byId.get(p.id)?.label ?? p.id}</td>
                      <td><input type="number" min={0} step={0.5} value={p.weight} style={{ width: '4.5em' }}
                        aria-label={`weight for ${byId.get(p.id)?.label ?? p.id}`}
                        onChange={e => { const w = Number(e.target.value); setWeight(p.id, Number.isFinite(w) ? Math.max(0, w) : 0); }} /></td>
                      <td><button aria-label={`remove ${byId.get(p.id)?.label ?? p.id}`} title="Remove"
                        onClick={() => removeMetric(p.id)}>✕</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
        <p className="muted">How scoring works: for each selected metric, every simulation gets a score between 0 and 1 relative to the others in this comparison. The simulation closest to that metric's ideal value scores 1, the furthest scores 0, and the rest fall in between. Whether the ideal is high (NSE, KGE, R²), zero (RMSE, W₁, lags), or a balance point (PBIAS at 0) is handled automatically. The composite is the weighted average of these scores, so higher is always better. A metric that cannot be computed for a simulation (for example peak timing on a flat line) scores 0 for it, so every simulation is compared on the same metrics; equal composites share a rank. Unbounded efficiencies pass through the bounded C2M form first so no single score dominates. Subset: {frame.caption || 'full record'}.</p>
      </section>

      <section className="card">
        <h2>Ranking</h2>
        {transformNotes(ds.view.transform).map(n => <div key={n} className="warning">{n}</div>)}
        {omission && <div className="warning" role="note">{omission}</div>}
        {activePriorities.length === 0 ? (
          <p className="muted">All weights are zero; give at least one metric a weight above zero to rank the simulations.</p>
        ) : (<>
        <div className="mapscroll"><table className="grid" aria-label="Composite ranking of simulations">
          <thead>
            <tr><th>Rank</th><th>Simulation</th>
              {activePriorities.map(p => <th key={p.id}>{byId.get(p.id)?.timing ? '⏱ ' : ''}{byId.get(p.id)?.label ?? p.id}<br /><span className="muted">value · score (weight {p.weight})</span></th>)}
              <th>Composite</th></tr>
          </thead>
          <tbody>
            {order.map(i => (
              <tr key={runs[i].id} className={rows[i].rank === 1 ? 'timingrow' : ''}>
                <td>{rows[i].rank}</td>
                <td style={{ color: runs[i].color }}>{runs[i].name}</td>
                {activePriorities.map(p => (
                  <td key={p.id}>
                    {fmtNum(outputs[i]!.values[p.id], byId.get(p.id)?.digits ?? 3)}
                    {' · '}
                    {isFinite(rows[i].perMetric[p.id]) ? rows[i].perMetric[p.id].toFixed(2) : 'n/a'}
                  </td>
                ))}
                <td className={rows[i].rank === 1 ? 'best' : ''}>{isFinite(rows[i].composite) ? rows[i].composite.toFixed(3) : 'n/a'}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
        {isFinite(winner.composite) ? (
        <div className="callout">
          {leaders.length > 1
            ? <strong>Tie between {leaders.map(i => runs[i].name).join(' and ')}</strong>
            : <strong>Recommended simulation: <span style={{ color: winnerRun.color }}>{winner.runName}</span></strong>}
          {' '}· composite {winner.composite.toFixed(3)} across {ranked.length} priority metric{ranked.length === 1 ? '' : 's'}
          {leaders.length === 1 && contributors.length ? <>; strongest on {contributors.join(' and ')}</> : null}.
          {hasShiftTolerant
            ? ' Shift-tolerant timing metrics are included, so this ranking rewards getting events at a more proper time, not just a more proper average.'
            : ' Tip: add a shift-tolerant timing metric (e.g. peak-timing lag, W₁ or DTW warp) so the ranking cannot be won by a magnitude-only fit.'}
        </div>
        ) : (
          <p className="muted">No composite could be computed: the selected priority metrics are unavailable for these simulations.</p>
        )}
        </>)}
      </section>
    </div>
  );
}
