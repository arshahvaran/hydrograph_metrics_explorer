import { useMemo, useState } from 'react'
import { useApp } from '../store/store'
import { PlotHost } from './PlotHost'
import { computeForRun } from './compute'
import { fmtNum, fmtDate } from './format'
import { byId } from '../metrics/registry'

const SUMMARY_IDS = ['peak_lag_abs', 'peak_lag_signed', 'event_threat', 'event_lag', 'event_vol', 'lag_best', 'de', 'de_const', 'de_dyn', 'sd_occ', 'sd_amp', 'sd_time', 'dtw_warp', 'w1', 'w2sq', 'xwt_lag'];

export function TimingTab() {
  const ds = useApp(s => s.project.datasets.find(d => d.id === s.project.activeDatasetId) ?? null);
  const updateTiming = useApp(s => s.updateTiming);
  const [eventRunIdx, setEventRunIdx] = useState(0);
  if (!ds) return null;

  const t = ds.view.timingConfig;
  const runs = ds.runs.filter(r => r.visible);
  const outputs = runs.map(r => computeForRun(ds, r));
  const stepLabel = ds.step.label;

  const sweepTraces = useMemo(() => {
    const tr: any[] = [];
    runs.forEach((r, i) => {
      const rows = outputs[i].extras.sweep?.rows ?? [];
      tr.push({ x: rows.map(x => x.lag), y: rows.map(x => x.nse), name: `${r.name} NSE`, type: 'scatter', mode: 'lines', line: { color: r.color, width: 2 } });
      tr.push({ x: rows.map(x => x.lag), y: rows.map(x => x.w1), name: `${r.name} W₁`, yaxis: 'y2', type: 'scatter', mode: 'lines', line: { color: r.color, width: 1.5, dash: 'dot' } });
    });
    return tr;
  }, [ds, runs.map(r => r.id).join(), JSON.stringify(t), ds.view.nanPolicy, ds.view.transform]);

  const sweepShapes = runs.map((r, i) => ({
    type: 'line', x0: outputs[i].extras.sweep?.bestLag, x1: outputs[i].extras.sweep?.bestLag,
    yref: 'paper', y0: 0, y1: 1, line: { color: r.color, width: 1, dash: 'dash' },
  }));

  const xwtTraces = runs.map((r, i) => {
    const rows = outputs[i].extras.xwt?.byScale ?? [];
    return { x: rows.map(x => x.meanLag), y: rows.map(x => x.period), name: r.name, type: 'scatter', mode: 'lines+markers', marker: { size: 5, color: r.color }, line: { color: r.color, width: 2 }, connectgaps: false };
  });

  const polarTraces = [{
    type: 'scatterpolar', mode: 'markers+text', showlegend: false,
    r: runs.map((_r, i) => outputs[i].extras.de?.de ?? NaN),
    theta: runs.map((_r, i) => ((outputs[i].extras.de?.phi ?? 0) * 180) / Math.PI),
    text: runs.map(r => r.name), textposition: 'top center',
    marker: {
      size: 15, line: { color: '#ffffff', width: 1.5 },
      color: runs.map((_r, i) => outputs[i].extras.de?.temporalR ?? NaN),
      colorscale: 'Plasma', reversescale: true, cmin: 0, cmax: 1,
      colorbar: { title: { text: 'timing r' }, thickness: 12, len: 0.75, x: 1.06 },
    },
  }];

  const evOut = outputs[Math.min(eventRunIdx, outputs.length - 1)];
  const evRun = runs[Math.min(eventRunIdx, runs.length - 1)];

  return (
    <div>
      <section className="card">
        <h2>Timing &amp; shape configuration <span className="muted">(applies to every timing metric, live)</span></h2>
        <div className="controls">
          <label>Event threshold{' '}
            <select value={t.eventThreshold.kind} onChange={e => updateTiming({ eventThreshold: { ...t.eventThreshold, kind: e.target.value as any } })}>
              <option value="percentile">percentile of obs</option>
              <option value="absolute">absolute</option>
            </select>{' '}
            <input type="number" value={t.eventThreshold.value} style={{ width: '5.5em' }}
              onChange={e => updateTiming({ eventThreshold: { ...t.eventThreshold, value: Number(e.target.value) } })} />
          </label>
          <label>Min event gap <input type="number" min={1} value={t.eventMinDistance} style={{ width: '4em' }}
            onChange={e => updateTiming({ eventMinDistance: Number(e.target.value) })} /> steps</label>
          <label>Warm-up <input type="number" min={0} value={t.eventWarmup} style={{ width: '4.5em' }}
            onChange={e => updateTiming({ eventWarmup: Number(e.target.value) })} /> steps</label>
          <label>Peak window ± <input type="number" min={1} value={t.peakMatchTolerance} style={{ width: '4em' }}
            onChange={e => updateTiming({ peakMatchTolerance: Number(e.target.value) })} /> steps</label>
          <label title="Peaks must rise this far above surroundings; auto = σ of observed">Prominence{' '}
            <select value={t.peakProminence === 'auto' ? 'auto' : 'custom'}
              onChange={e => updateTiming({ peakProminence: e.target.value === 'auto' ? 'auto' : 0 })}>
              <option value="auto">auto (σ obs)</option><option value="custom">custom</option>
            </select>
            {t.peakProminence !== 'auto' &&
              <input type="number" value={t.peakProminence} style={{ width: '5em' }}
                onChange={e => updateTiming({ peakProminence: Number(e.target.value) })} />}
          </label>
          <label>DTW band <input type="number" min={1} max={50} value={Math.round(t.dtwBandFraction * 100)} style={{ width: '4em' }}
            onChange={e => updateTiming({ dtwBandFraction: Number(e.target.value) / 100 })} /> % of n</label>
        </div>
      </section>

      <section className="card">
        <h2>Timing summary <span className="muted">(lags in steps of {stepLabel})</span></h2>
        <div className="mapscroll"><table className="grid">
          <thead><tr><th>Measure</th><th>optimum</th>{runs.map(r => <th key={r.id} style={{ color: r.color }}>{r.name}</th>)}</tr></thead>
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
            <tr title="Hits / misses / false alarms of threshold events">
              <td>Events hit / miss / false</td><td className="muted">n/0/0</td>
              {outputs.map((o, i) => <td key={runs[i].id}>{o.extras.events ? `${o.extras.events.hits} / ${o.extras.events.misses} / ${o.extras.events.falseAlarms}` : '—'}</td>)}
            </tr>
            <tr title="Share of the cross-wavelet plane (inside the cone of influence) above the 95 % red-noise level">
              <td>XWT significant fraction</td><td className="muted">—</td>
              {outputs.map((o, i) => <td key={runs[i].id}>{fmtNum((o.extras.xwt?.fracSignificant ?? NaN) * 100, 1)} %</td>)}
            </tr>
          </tbody>
        </table></div>
      </section>

      <section className="card">
        <h2>Lag sweep <span className="muted">— NSE (solid, left) and W₁ (dotted, right) as the simulation is shifted; dashed line = best-fit lag</span></h2>
        <PlotHost
          traces={sweepTraces}
          layout={{
            xaxis: { title: `lag [steps of ${stepLabel}] — positive = simulation late`, dtick: 5, zeroline: true },
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
          <h2>Cross-wavelet lag by scale <span className="muted">— significant, in-cone regions only</span></h2>
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
          <p className="muted">Read like the paper's timing-error-by-scale panel: fast scales at the top, slow at the bottom. Gaps = no significant common power at that scale.</p>
        </section>

        <section className="card">
          <h2>Diagnostic-efficiency polar <span className="muted">(Schwemmle et al., 2021)</span></h2>
          <PlotHost
            traces={polarTraces}
            layout={{
              polar: {
                radialaxis: { rangemode: 'tozero' },
                angularaxis: { thetaunit: 'degrees', dtick: 45, rotation: 90, direction: 'counterclockwise' },
              },
              margin: { t: 36, r: 70, l: 40, b: 36 },
              showlegend: false, hovermode: 'closest',
            }}
            height={330}
          />
          <p className="muted">As in the paper's diagnostic polar figure: radius = DE (0 at the centre is perfect), the top half is constant positive offset (B̄rel &gt; 0), the bottom half constant negative offset, left/right = dynamic high-vs-low-flow error; marker colour is the timing term r (yellow = mismatch → purple = match).</p>
        </section>
      </div>

      <section className="card">
        <h2>Events{' '}
          <select value={eventRunIdx} onChange={e => setEventRunIdx(Number(e.target.value))}>
            {runs.map((r, i) => <option key={r.id} value={i}>{r.name}</option>)}
          </select>{' '}
          <span className="muted">threshold {fmtNum(evOut.extras.events?.threshold, 2)} {ds.targetUnit} · tolerance ±{t.peakMatchTolerance} steps</span>
        </h2>
        <div className="mapscroll"><table className="grid">
          <thead><tr><th>#</th><th>window</th><th>obs peak [{ds.targetUnit}]</th><th>peak lag</th><th>peak mag err %</th><th>volume err %</th></tr></thead>
          <tbody>
            {(evOut.extras.events?.events ?? []).slice(0, 40).map((e, i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                <td>{fmtDate(ds.dates[e.obs.start])} → {fmtDate(ds.dates[e.obs.end])}</td>
                <td>{fmtNum(e.obs.peakQ, 2)}</td>
                <td>{e.peakLag > 0 ? '+' : ''}{e.peakLag}</td>
                <td>{fmtNum(e.peakMagErrPct, 1)}</td>
                <td>{fmtNum(e.volumeErrPct, 1)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
        {(evOut.extras.events?.events.length ?? 0) === 0 && <p className="warning">No events above the current threshold for {evRun?.name}. Lower the percentile above.</p>}
      </section>
    </div>
  );
}
