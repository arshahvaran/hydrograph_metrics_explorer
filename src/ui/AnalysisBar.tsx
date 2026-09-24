import { useEffect, useState } from 'react'
import { useApp } from '../store/store'
import { subsetFrameFor } from './compute'
import { isPerStepDepth, resampleAvailable } from '../metrics/subset'
import type { Dataset, ViewState } from '../types'

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const ms = (s: string) => Date.parse(s + 'T00:00:00Z');
/** A whole day of year in [1, 365], or null for an empty, half-typed or out-of-range entry. */
const doyOf = (s: string): number | null => {
  if (s.trim() === '') return null;
  const n = Number(s);
  return Number.isInteger(n) && n >= 1 && n <= 365 ? n : null;
};

/** What a field shows while the user types. The stored bound changes only on
 *  a complete, valid entry. An empty or half-typed field (a date input reports
 *  '' while one of its segments is retyped) leaves both stored bounds as they
 *  are, and leaving the field shows the stored value again. Only the x
 *  buttons clear a whole selection (audit subset-06). */
function useDraft(stored: string): [string, (s: string) => void, () => void] {
  const [draft, setDraft] = useState(stored);
  useEffect(() => { setDraft(stored); }, [stored]);
  return [draft, setDraft, () => setDraft(stored)];
}

/** Subset controls for the Plots tab: contiguous window of whole days,
 *  recurring seasonal filter (days of a 365-day year, wraps across the new
 *  year), resample. "Use this data" materialises the selection as a new
 *  dataset. */
export function AnalysisBar() {
  const ds = useApp(s => s.project.datasets.find(d => d.id === s.project.activeDatasetId) ?? null);
  if (!ds) return null;
  return <AnalysisBarInner key={ds.id} ds={ds} />;
}

function AnalysisBarInner({ ds }: { ds: Dataset }) {
  const updateView = useApp(s => s.updateView);
  const commitSubsetDataset = useApp(s => s.commitSubsetDataset);
  const v = ds.view;
  const frame = subsetFrameFor(ds);
  const [d0, d1] = [ds.dates[0], ds.dates[ds.dates.length - 1]];
  const [ws, setWs, resetWs] = useDraft(v.window ? iso(v.window[0]) : '');
  const [we, setWe, resetWe] = useDraft(v.window ? iso(v.window[1]) : '');
  const [ss, setSs, resetSs] = useDraft(v.season ? String(v.season.startDoy) : '');
  const [se, setSe, resetSe] = useDraft(v.season ? String(v.season.endDoy) : '');
  const depth = isPerStepDepth(ds.targetUnit);
  const agg = depth ? 'totals' : 'means';
  const canDaily = resampleAvailable('daily', ds.step);
  const canMonthly = resampleAvailable('monthly', ds.step);
  const resampling = v.resample !== 'native' && resampleAvailable(v.resample, ds.step);
  // The new dataset's step: the resample step, or the step detected on the
  // selected span (a window over a daily stretch of an hourly record is daily).
  const stepChanged = (!!v.window || !!v.season || resampling) && (frame.step.ms !== ds.step.ms || frame.step.label !== ds.step.label);

  return (
    <section className="card analysisbar">
      <div className="controls">
        <label>Custom window{' '}
          <input type="date" aria-label="window start" min={iso(d0)} max={iso(d1)}
            value={ws} onBlur={resetWs}
            onChange={e => {
              setWs(e.target.value);
              const t = ms(e.target.value);
              if (Number.isFinite(t)) updateView({ window: [t, v.window?.[1] ?? d1] });
            }} />
          –
          <input type="date" aria-label="window end" min={iso(d0)} max={iso(d1)}
            value={we} onBlur={resetWe}
            onChange={e => {
              setWe(e.target.value);
              const t = ms(e.target.value);
              if (Number.isFinite(t)) updateView({ window: [v.window?.[0] ?? d0, t] });
            }} />
          {v.window && <button onClick={() => updateView({ window: null })} title="Clear window" aria-label="Clear analysis window">×</button>}
        </label>
        <label title="Days of a 365-day year: 60 is 1 March in every year, and 29 February counts with 28 February (day 59).">Season (DOY){' '}
          <input type="number" aria-label="season start day-of-year" min={1} max={365} style={{ width: '5.8em' }}
            value={ss} placeholder="start" onBlur={resetSs}
            onChange={e => {
              setSs(e.target.value);
              const n = doyOf(e.target.value);
              if (n != null) updateView({ season: { startDoy: n, endDoy: v.season?.endDoy ?? 365 } });
            }} />
          –
          <input type="number" aria-label="season end day-of-year" min={1} max={365} style={{ width: '5.8em' }}
            value={se} placeholder="end" onBlur={resetSe}
            onChange={e => {
              setSe(e.target.value);
              const n = doyOf(e.target.value);
              if (n != null) updateView({ season: { startDoy: v.season?.startDoy ?? 1, endDoy: n } });
            }} />
          {v.season && <button onClick={() => updateView({ season: null })} title="Clear season" aria-label="Clear seasonal filter">×</button>}
        </label>
        <label>Resample{' '}
          <select aria-label="Resample" value={v.resample}
            title={depth
              ? 'Depths per interval are summed to depths per day or month. A step counts only where the observed series and every simulation all have a value, so every series uses the same steps. A day or month needs at least half of its steps; its total is the mean of those steps times the steps in the whole day or month, so a partial day or month (a gap, or the edge of the window or season) is scaled to the whole interval. A day or month with fewer steps is left out.'
              : 'A step counts only where the observed series and every simulation all have a value, so every series is averaged over the same steps. A day or month needs at least half of its steps; one with fewer is left out.'}
            onChange={e => updateView({ resample: e.target.value as ViewState['resample'] })}>
            <option value="native">native ({ds.step.label})</option>
            <option value="daily" disabled={!canDaily}>daily {agg}</option>
            <option value="monthly" disabled={!canMonthly}>monthly {agg}</option>
          </select>
        </label>
        <span className="muted">
          {frame.caption || 'full record'} · {frame.shown} steps shown
          {v.season && v.season.startDoy > v.season.endDoy ? ' (season wraps the new year)' : ''}
        </span>
        <button className="primary" title="Add this subset as a new dataset"
          disabled={!v.window && !v.season && !resampling}
          onClick={() => commitSubsetDataset()}>Use this data →</button>
      </div>
      {(v.season || (frame.bins?.empty ?? 0) > 0) && (
        <p className="muted">{v.season ? 'Out-of-season steps are' : 'Days or months left empty are'} not part of the plots or of the new dataset, so no NaN policy fills them. The dates keep the time between the steps kept: peak timing, events, Series Distance, DTW, W₁, W₂² and the lag sweep count it as time.</p>
      )}
      {stepChanged && (
        <p className="muted">The new dataset keeps the analysis settings. Its time step is {frame.step.label}, not {ds.step.label}, so timing settings counted in steps (peak-match window, event spacing, warm-up, wavelet scales, DTW band) take the defaults for the new step.{depth && resampling ? ' An absolute event threshold or peak prominence also takes its default, because the values become totals.' : ''}</p>
      )}
    </section>
  );
}
