import { useApp } from '../store/store'
import { frameFor } from './compute'

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const ms = (s: string) => Date.parse(s + 'T00:00:00Z');

/** Global analysis subset controls: contiguous window, recurring seasonal
 *  filter (DOY span, wraps across the new year), resample (spec §6/§9). */
export function AnalysisBar() {
  const ds = useApp(s => s.project.datasets.find(d => d.id === s.project.activeDatasetId) ?? null);
  const updateView = useApp(s => s.updateView);
  if (!ds) return null;
  const v = ds.view;
  const frame = frameFor(ds);
  const [d0, d1] = [ds.dates[0], ds.dates[ds.dates.length - 1]];

  return (
    <section className="card analysisbar">
      <div className="controls">
        <label>Window{' '}
          <input type="date" aria-label="window start" min={iso(d0)} max={iso(d1)}
            value={v.window ? iso(v.window[0]) : ''}
            onChange={e => {
              const t = e.target.value ? ms(e.target.value) : null;
              updateView({ window: t == null ? null : [t, v.window?.[1] ?? d1] });
            }} />
          –
          <input type="date" aria-label="window end" min={iso(d0)} max={iso(d1)}
            value={v.window ? iso(v.window[1]) : ''}
            onChange={e => {
              const t = e.target.value ? ms(e.target.value) : null;
              updateView({ window: t == null ? null : [v.window?.[0] ?? d0, t] });
            }} />
          {v.window && <button onClick={() => updateView({ window: null })} title="Clear window">×</button>}
        </label>
        <label>Season (DOY){' '}
          <input type="number" aria-label="season start day-of-year" min={1} max={366} style={{ width: '4.6em' }}
            value={v.season?.startDoy ?? ''} placeholder="start"
            onChange={e => {
              const n = Number(e.target.value);
              updateView({ season: e.target.value === '' ? null : { startDoy: Math.min(366, Math.max(1, n || 1)), endDoy: v.season?.endDoy ?? 366 } });
            }} />
          –
          <input type="number" aria-label="season end day-of-year" min={1} max={366} style={{ width: '4.6em' }}
            value={v.season?.endDoy ?? ''} placeholder="end"
            onChange={e => {
              const n = Number(e.target.value);
              updateView({ season: e.target.value === '' ? null : { startDoy: v.season?.startDoy ?? 1, endDoy: Math.min(366, Math.max(1, n || 366)) } });
            }} />
          {v.season && <button onClick={() => updateView({ season: null })} title="Clear season">×</button>}
        </label>
        <label>Resample{' '}
          <select value={v.resample} onChange={e => updateView({ resample: e.target.value as any })}>
            <option value="native">native ({ds.step.label})</option>
            <option value="daily">daily means</option>
            <option value="monthly">monthly means</option>
          </select>
        </label>
        <span className="muted">
          {frame.caption || 'full record'} · {frame.dates.length} steps in analysis
          {v.season && v.season.startDoy > v.season.endDoy ? ' (season wraps the new year)' : ''}
        </span>
      </div>
    </section>
  );
}
