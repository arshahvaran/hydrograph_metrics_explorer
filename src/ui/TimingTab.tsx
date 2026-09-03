import { useMemo, useState } from 'react'
import type { Dataset } from '../types'
import { UNITS } from '../units/registry'
import { OBSERVED_COLOR, defaultTimingConfig, TIMING_RANGES } from '../types'
import { useApp } from '../store/store'
import { PlotHost } from './PlotHost'
import { NumField } from './NumField'
import { useRunOutputs, useComputeError, frameFor } from './compute'
import { csvLine, download, fmtDate, fmtNum } from './format'
import { byId } from '../metrics/registry'

/** Exactly the timing block of the Metrics tab's essentials preset (13). */
const SUMMARY_IDS = ['sd_occ', 'sd_amp', 'sd_time', 'dtw_warp', 'dtw_dist', 'xwt_lag', 'w1', 'peak_lag_abs', 'peak_lag_signed', 'event_peak', 'event_vol', 'event_lag', 'de'];

export const NO_VISIBLE_RUNS_MESSAGE = 'No simulation is visible for this dataset. Make at least one simulation visible to see timing metrics.';

/** Lower bound of the DE-polar colour axis. The reference tool (diag-eff) fixes the
 *  axis to [0, 1], but real runs cluster near r = 1, where a full-range magma ramp
 *  paints every marker the same near-black (author round 6: Sample 2 runs looked
 *  identical although r = 0.974 vs 1.000). We keep cmax = 1 and float cmin one 0.05
 *  grid step below the worst finite r in view, clamped to [-1, 0.9]: the span is
 *  never narrower than 0.1, no marker sits at the extreme yellow, anticorrelated
 *  runs stay representable, and the colourbar states the working range honestly. */
export function deColorFloor(rValues: number[]): number {
  const finite = rValues.filter(Number.isFinite);
  if (!finite.length) return 0;
  const lo = Math.min(...finite);
  return Math.max(-1, Math.min(Math.floor(lo * 20) / 20 - 0.05, 0.9));
}

export function TimingTab() {
  const ds = useApp(s => s.project.datasets.find(d => d.id === s.project.activeDatasetId) ?? null);
  if (!ds) return null;
  return <TimingTabInner ds={ds} />;
}

/** Signed lag cell text; a flat simulation has no peak and reads n/a. */
const lagText = (lag: number): string => (Number.isFinite(lag) ? `${lag > 0 ? '+' : ''}${lag}` : 'n/a');

function TimingTabInner({ ds }: { ds: Dataset }) {
  const updateTiming = useApp(s => s.updateTiming);
  const [eventRunIdx, setEventRunIdx] = useState(0);
  const [clampNote, setClampNote] = useState<string | null>(null);

  const t = ds.view.timingConfig;
  const [useDefaults, setUseDefaults] = useState(
    () => JSON.stringify(t) === JSON.stringify(defaultTimingConfig(ds.step.ms, ds.dates.length)));
  const runs = ds.runs.filter(r => r.visible);
  const rawOutputs = useRunOutputs(ds, runs);
  const computeError = useComputeError(ds);
  const frame = frameFor(ds);
  const outputs = rawOutputs.map(o => o!);  // guarded below; memos tolerate nulls
  const pending = rawOutputs.some(o => o === null);
  const stepLabel = frame.step.label;

  const sweepTraces = useMemo(() => {
    if (pending) return [] as any[];
    const tr: any[] = [];
    runs.forEach((r, i) => {
      const rows = outputs[i].extras.sweep?.rows ?? [];
      tr.push({ x: rows.map(x => x.lag), y: rows.map(x => x.nse), name: `${r.name} NSE`, type: 'scatter', mode: 'lines', line: { color: r.color, width: 2 } });
      tr.push({ x: rows.map(x => x.lag), y: rows.map(x => x.w1), name: `${r.name} W₁`, yaxis: 'y2', type: 'scatter', mode: 'lines', line: { color: r.color, width: 1.5, dash: 'dot' } });
    });
    return tr;
  }, [ds, pending, runs.map(r => r.id).join(), JSON.stringify(t), ds.view.nanPolicy, ds.view.transform]);

  if (!runs.length) {
    return <div className="card"><h2>Timing &amp; shape</h2><p className="warning" role="status">{NO_VISIBLE_RUNS_MESSAGE}</p></div>;
  }
  if (pending) {
    return (
      <div className="card"><h2>Timing &amp; shape</h2>
        {computeError
          ? <div className="error" role="alert">{computeError}</div>
          : <p className="muted">Computing timing metrics in a background worker…</p>}
      </div>
    );
  }

  const sweepShapes = runs.flatMap((r, i) => {
    const best = outputs[i].extras.sweep?.bestLag;
    if (!Number.isFinite(best)) return [];
    return [{ type: 'line', x0: best, x1: best, yref: 'paper', y0: 0, y1: 1, line: { color: r.color, width: 1, dash: 'dash' } }];
  });

  const xwtTraces = runs.map((r, i) => {
    const rows = outputs[i].extras.xwt?.byScale ?? [];
    return { x: rows.map(x => x.meanLag), y: rows.map(x => x.period), name: r.name, type: 'scatter', mode: 'lines+markers', marker: { size: 5, color: r.color }, line: { color: r.color, width: 2 }, connectgaps: false };
  });

  const polarR = runs.map((_r, i) => outputs[i].extras.de?.temporalR ?? NaN);
  const polarTraces = [{
    type: 'scatterpolar', mode: 'markers+text', showlegend: false, name: 'Observed',
    r: [0], theta: [0], text: ['Observed'], textposition: 'top center',
    marker: { size: 12, symbol: 'circle', color: OBSERVED_COLOR, line: { color: '#ffffff', width: 1.5 } },
  }, {
    type: 'scatterpolar', mode: 'markers+text', showlegend: false,
    r: runs.map((_r, i) => outputs[i].extras.de?.de ?? NaN),
    theta: runs.map((_r, i) => ((outputs[i].extras.de?.phi ?? 0) * 180) / Math.PI),
    text: runs.map(r => r.name), textposition: 'top center',
    marker: {
      size: 15, line: { color: '#ffffff', width: 1.5 },
      color: polarR,
      // Plasma, explicitly reversed to match the paper's figure: yellow at the
      // low end (timing mismatch), dark blue-purple at r = 1 (timing match).
      // Written out as stops so no renderer ambiguity around reversescale.
      colorscale: [[0, '#f0f921'], [0.25, '#f89441'], [0.5, '#cc4778'], [0.75, '#7e03a8'], [1, '#0d0887']],
      cmin: deColorFloor(polarR), cmax: 1,
      // Sized and centred to sit flush with the polar circle, in PIXELS so no
      // fraction-reference ambiguity: plot area = 330 height - (36+36) margins
      // = 258px; the circle inside it loses ~16px per side to the angular tick
      // labels, giving a 226px diameter. Vertically centred on the same middle.
      colorbar: { title: { text: 'timing r' }, thickness: 14, lenmode: 'pixels', len: 226, y: 0.5, yanchor: 'middle', x: 1.06 },
    },
  }];

  const evOut = outputs[Math.min(eventRunIdx, outputs.length - 1)];
  const evRun = runs[Math.min(eventRunIdx, runs.length - 1)];
  // Event indices live in the NaN-compacted paired arrays; pairedIndex maps
  // them back to dataset rows (a gap before an event once shifted every date
  // in this table by the number of missing values ahead of it).
  const rowOf = (i: number) => evOut.pairedIndex?.[i] ?? i;
  const dayAt = (i: number) => { const ms = ds.dates[rowOf(i)]; return Number.isFinite(ms) ? fmtDate(ms) : 'n/a'; };
  const n = ds.dates.length;
  const events = evOut.extras.events?.events ?? [];

  return (
    <div>
      <section className="card">
        <h2>Timing &amp; shape configuration <span className="muted">(applies to every timing metric, live)</span></h2>
        <label className="cfgdefault"><span className="switch"><input type="checkbox" checked={useDefaults} onChange={e => {
          const on = e.target.checked;
          setUseDefaults(on);
          if (on) { updateTiming(defaultTimingConfig(ds.step.ms, ds.dates.length)); setClampNote(null); }
        }} /><span className="knob" aria-hidden="true" /></span> Default settings (switch off to customise)</label>
        <fieldset className="cfgfields" disabled={useDefaults}>
        <div className="controls">
          <label>Event threshold{' '}
            <select value={t.eventThreshold.kind} onChange={e => updateTiming({ eventThreshold: { ...t.eventThreshold, kind: e.target.value as any } })}>
              <option value="percentile">percentile of obs</option>
              <option value="absolute">absolute</option>
            </select>{' '}
            <NumField value={t.eventThreshold.value} style={{ width: '5.5em' }} label="Event threshold" onClamp={setClampNote}
              min={t.eventThreshold.kind === 'percentile' ? TIMING_RANGES.eventPercentile[0] : -Number.MAX_VALUE}
              max={t.eventThreshold.kind === 'percentile' ? TIMING_RANGES.eventPercentile[1] : Number.MAX_VALUE}
              onCommit={v => updateTiming({ eventThreshold: { ...t.eventThreshold, value: v } })} />
          </label>
          <label>Min event gap <NumField value={t.eventMinDistance} min={TIMING_RANGES.eventMinDistance[0]} max={TIMING_RANGES.eventMinDistance[1]} integer unit="steps" style={{ width: '4em' }}
            label="Min event gap" onClamp={setClampNote} onCommit={v => updateTiming({ eventMinDistance: v })} /> steps</label>
          <label>Warm-up <NumField value={t.eventWarmup} min={0} max={Math.max(0, n - 2)} integer unit="steps" style={{ width: '4.5em' }}
            label="Warm-up" onClamp={setClampNote} onCommit={v => updateTiming({ eventWarmup: v })} /> steps</label>
          <label>Peak window ± <NumField value={t.peakMatchTolerance} min={TIMING_RANGES.peakMatchTolerance[0]} max={TIMING_RANGES.peakMatchTolerance[1]} integer unit="steps" style={{ width: '4em' }}
            label="Peak window" onClamp={setClampNote} onCommit={v => updateTiming({ peakMatchTolerance: v })} /> steps</label>
          <label title="Peaks must rise this far above surroundings; auto = σ of observed">Prominence{' '}
            <select value={t.peakProminence === 'auto' ? 'auto' : 'custom'}
              onChange={e => updateTiming({ peakProminence: e.target.value === 'auto' ? 'auto' : 0 })}>
              <option value="auto">auto (σ obs)</option><option value="custom">custom</option>
            </select>
            {t.peakProminence !== 'auto' &&
              <NumField value={t.peakProminence} min={0} max={Number.MAX_VALUE} style={{ width: '5em' }}
                label="Prominence" onClamp={setClampNote} onCommit={v => updateTiming({ peakProminence: v })} />}
          </label>
          <label>DTW band <NumField value={Math.round(t.dtwBandFraction * 100)} min={1} max={50} integer style={{ width: '4em' }}
            label="DTW band" onClamp={setClampNote} onCommit={v => updateTiming({ dtwBandFraction: v / 100 })} /> % of n</label>
        </div>
        </fieldset>
        {clampNote && !useDefaults && <p className="warning" role="status">{clampNote}</p>}
      </section>

      <section className="card">
        <h2>Timing summary <span className="muted">(lags in steps of {stepLabel})</span></h2>
        {outputs.flatMap(o => o.notes).filter((v, i, a) => a.indexOf(v) === i && /transform|flat|resolvable/.test(v)).map(nn => <div key={nn} className="warning">{nn}</div>)}
        <div className="mapscroll"><table className="grid" aria-label="Timing summary per simulation">
          <thead><tr><th>Measure</th><th>Optimum</th>{runs.map(r => <th key={r.id} style={{ color: r.color }}>{r.name}</th>)}</tr></thead>
          <tbody>
            {SUMMARY_IDS.map(id => {
              const m = byId.get(id)!;
              return (
                <tr key={id} title={m.blurb}>
                  <td>{m.label}</td><td className="muted">{m.optimum}</td>
                  {outputs.map((o, i) => <td key={runs[i].id}>{fmtNum(o.values[id], m.digits)}</td>)}
                </tr>
              );
            })}
          </tbody>
        </table></div>
      </section>

      <section className="card">
        <h2>Lag sweep <span className="muted">NSE (solid, left) and W₁ (dotted, right) as the simulation is shifted; dashed line = best-fit lag</span></h2>
        <PlotHost
          traces={sweepTraces}
          layout={{
            xaxis: { title: `lag [steps of ${stepLabel}] (positive = simulation late)`, dtick: 5, zeroline: true },
            yaxis: { title: 'NSE' },
            yaxis2: { title: 'W₁ [steps]', overlaying: 'y', side: 'right' },
            shapes: [
              ...sweepShapes,
              { type: 'line', x0: 0, x1: 0, yref: 'paper', y0: 0, y1: 1, line: { color: '#888', width: 1, dash: 'dot' } },
            ],
            annotations: [{ x: 0, yref: 'paper', y: 1.05, text: 'perfect alignment', showarrow: false, font: { size: 12 } }],
          }}
          height={360}
        />
      </section>

      <div className="twocol">
        <section className="card">
          <h2>Cross-wavelet lag by scale <span className="muted">significant regions, edge effects excluded</span></h2>
          <PlotHost
            traces={xwtTraces}
            layout={{
              xaxis: { title: 'power-weighted lag [steps] (+ = simulation late)', zeroline: false },
              yaxis: { title: `period [steps of ${stepLabel}]`, type: 'log', autorange: 'reversed' },
              hovermode: 'closest',
              shapes: [{ type: 'line', x0: 0, x1: 0, yref: 'paper', y0: 0, y1: 1, line: { color: '#888', width: 1, dash: 'dot' } }],
            }}
            height={330}
          />
          <p className="muted">Timing error by timescale: fast scales at the top, slow at the bottom. Gaps mean the two series share no significant common power at that scale.</p>
        </section>

        <section className="card">
          <h2>Diagnostic-efficiency polar <span className="muted">(Schwemmle et al., 2021)</span></h2>
          <PlotHost
            name={`${ds.name.replace(/[^\w-]+/g, '_')}_de_polar`}
            traces={polarTraces}
            layout={{
              polar: {
                radialaxis: { rangemode: 'tozero', dtick: 0.2 },
                angularaxis: { thetaunit: 'degrees', dtick: 45, rotation: 90, direction: 'counterclockwise' },
              },
              margin: { t: 36, r: 70, l: 40, b: 36 },
              showlegend: false, hovermode: 'closest',
            }}
            height={330}
          />
          <p className="muted">Radius = DE (0 at the centre is perfect; the observed record itself sits there). The top half indicates a constant positive offset (B̄rel &gt; 0), the bottom half a constant negative offset; left vs right separates dynamic high-flow from low-flow error. Marker colour is the timing term r, on a plasma scale where dark blue-purple marks 1 (timing match) and yellow marks the low end of the colourbar; the colour range adapts to the simulations in view so nearby r values stay distinguishable.</p>
        </section>
      </div>

      <section className="card">
        <h2>Events{' '}
          <select aria-label="Event report simulation" value={eventRunIdx} onChange={e => setEventRunIdx(Number(e.target.value))}>
            {runs.map((r, i) => <option key={r.id} value={i}>{r.name}</option>)}
          </select>{' '}
          <span className="muted">threshold {fmtNum(evOut.extras.events?.threshold, 2)} {UNITS[ds.targetUnit].label} · tolerance ±{t.peakMatchTolerance} steps</span>{' '}
          <button onClick={() => {
            const rows = [csvLine(['event', 'window_start', 'window_end', `obs_peak_${ds.targetUnit}`, 'peak_lag_steps', 'peak_mag_err_pct', 'volume_err_pct'])];
            events.forEach((e, i) => rows.push(csvLine([i + 1,
              dayAt(e.obs.start), dayAt(e.obs.end),
              e.obs.peakQ, Number.isFinite(e.peakLag) ? e.peakLag : 'n/a', e.peakMagErrPct, e.volumeErrPct])));
            download(`${ds.name.replace(/[^\w-]+/g, '_')}_events_${evRun.name.replace(/[^\w-]+/g, '_')}.csv`, rows.join('\n'), 'text/csv');
          }}>Export CSV</button>
        </h2>
        <div className="mapscroll"><table className="grid" aria-label="Detected events and per-event errors">
          <thead><tr><th>#</th><th>window</th><th>obs peak [{UNITS[ds.targetUnit].label}]</th><th>peak lag</th><th>peak mag err %</th><th>volume err %</th></tr></thead>
          <tbody>
            {events.slice(0, 40).map((e, i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                <td>{dayAt(e.obs.start)} → {dayAt(e.obs.end)}</td>
                <td>{fmtNum(e.obs.peakQ, 2)}</td>
                <td>{lagText(e.peakLag)}</td>
                <td>{fmtNum(e.peakMagErrPct, 1)}</td>
                <td>{fmtNum(e.volumeErrPct, 1)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
        {events.length > 40 && <p className="muted">Showing the first 40 of {events.length.toLocaleString('en-US')} events; Export CSV writes all of them.</p>}
        {events.length === 0 && <p className="warning">No events above the current threshold for {evRun?.name}. Lower the percentile above.</p>}
      </section>
    </div>
  );
}
