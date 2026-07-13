import { useApp } from '../store/store'
import { useRunOutputs, frameFor } from './compute'
import { rankRuns, DEFAULT_PRIORITIES } from '../metrics/rank'
import { REGISTRY, byId } from '../metrics/registry'
import { fmtNum } from './format'

const CANDIDATES = REGISTRY.filter(m =>
  ['nse', 'kge2012', 'kge2009', 'r2', 've', 'dr', 'lognse', 'rmse', 'pbias',
   'peak_lag_abs', 'w1', 'dtw_warp', 'de', 'event_threat', 'lag_best', 'xwt_lag'].includes(m.id));

/** Compare runs: priority-metric composite ranking + recommendation (spec §14, AC13). */
export function CompareTab() {
  const ds = useApp(s => s.project.datasets.find(d => d.id === s.project.activeDatasetId) ?? null);
  const updateView = useApp(s => s.updateView);
  if (!ds) return null;
  const runs = ds.runs.filter(r => r.visible);
  const outputs = useRunOutputs(ds, runs);
  const frame = frameFor(ds);

  if (runs.length < 2) {
    return <section className="card"><h2>Compare runs</h2>
      <p className="muted">Add at least two visible model runs to rank them. The ranking uses your priority metrics, with efficiencies normalised through the bounded C2M form so no single unbounded score dominates.</p></section>;
  }
  if (outputs.some(o => o === null)) {
    return <section className="card"><h2>Compare runs</h2><p className="muted">Computing metric panels in a background worker…</p></section>;
  }

  const priorities = ds.view.priorityMetrics.length ? ds.view.priorityMetrics : DEFAULT_PRIORITIES;

  const rows = rankRuns(
    runs.map((r, i) => ({ runName: r.name, values: outputs[i]!.values })),
    priorities,
  );
  const order = rows.map((_, i) => i).sort((a, b) => rows[a].rank - rows[b].rank);
  const winner = rows[order[0]];
  const winnerRun = runs[order[0]];
  const contributors = priorities
    .map(p => ({ id: p.id, sc: winner.perMetric[p.id] }))
    .filter(c => isFinite(c.sc))
    .sort((a, b) => b.sc - a.sc)
    .slice(0, 2)
    .map(c => byId.get(c.id)?.label ?? c.id);

  const setWeight = (id: string, weight: number) => {
    const cur = priorities.filter(p => p.id !== id);
    updateView({ priorityMetrics: weight > 0 ? [...cur, { id, weight }] : cur });
  };

  return (
    <div>
      <section className="card">
        <h2>Priority metrics <span className="muted">— tick what matters for your application; weights are relative</span></h2>
        <div className="prigrid">
          {CANDIDATES.map(m => {
            const p = priorities.find(x => x.id === m.id);
            return (
              <label key={m.id} className="prirow">
                <input type="checkbox" checked={!!p} onChange={e => setWeight(m.id, e.target.checked ? 1 : 0)} />
                <span>{m.timing ? '⏱ ' : ''}{m.label}</span>
                {p && <input type="number" min={0} step={0.5} value={p.weight} style={{ width: '4.2em' }}
                  aria-label={`weight for ${m.label}`}
                  onChange={e => setWeight(m.id, Math.max(0, Number(e.target.value)))} />}
              </label>
            );
          })}
        </div>
        <p className="muted">Scores per metric are in [0,1] relative to the runs being compared: unbounded efficiencies pass through C2M = E/(2−E) first; error and timing metrics score by closeness to their optimum. Composite = weighted mean. Subset: {frame.caption || 'full record'}.</p>
      </section>

      <section className="card">
        <h2>Ranking</h2>
        <div className="mapscroll"><table className="grid" aria-label="Composite ranking of runs">
          <thead>
            <tr><th>Rank</th><th>Run</th>
              {priorities.map(p => <th key={p.id}>{byId.get(p.id)?.timing ? '⏱ ' : ''}{byId.get(p.id)?.label ?? p.id}<br /><span className="muted">raw · score ×{p.weight}</span></th>)}
              <th>Composite</th></tr>
          </thead>
          <tbody>
            {order.map(i => (
              <tr key={runs[i].id} className={rows[i].rank === 1 ? 'timingrow' : ''}>
                <td>{rows[i].rank}</td>
                <td style={{ color: runs[i].color, fontWeight: 600 }}>{runs[i].name}</td>
                {priorities.map(p => (
                  <td key={p.id}>
                    {fmtNum(outputs[i]!.values[p.id], byId.get(p.id)?.digits ?? 3)}
                    {' · '}
                    <strong>{isFinite(rows[i].perMetric[p.id]) ? rows[i].perMetric[p.id].toFixed(2) : '—'}</strong>
                  </td>
                ))}
                <td className={rows[i].rank === 1 ? 'best' : ''}>{isFinite(rows[i].composite) ? rows[i].composite.toFixed(3) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
        <div className="callout">
          <strong>Recommended run: <span style={{ color: winnerRun.color }}>{winner.runName}</span></strong>
          {' '}— composite {winner.composite.toFixed(3)} across {priorities.length} priority metrics
          {contributors.length ? <>; strongest on {contributors.join(' and ')}</> : null}.
          {priorities.some(p => byId.get(p.id)?.timing)
            ? ' Timing-aware metrics are included, so this ranking rewards getting events at the right time, not just the right average.'
            : ' Tip: add a timing-aware metric (⏱) so the ranking cannot be won by a magnitude-only fit.'}
        </div>
      </section>
    </div>
  );
}
