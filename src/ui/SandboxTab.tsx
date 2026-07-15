import { useDeferredValue, useMemo, useRef, useState } from 'react'
import { useApp } from '../store/store'
import { PlotHost } from './PlotHost'
import { useRunOutput, useSeriesOutput, perturb } from './compute'
import { fmtNum } from './format'
import { mean, stdPop } from '../metrics/support/stats'
import { OBSERVED_COLOR } from '../types'
import type { Dataset, SandboxState } from '../types'
import { UNITS } from '../units/registry'

const CLASSICAL: [string, string, number][] = [['nse', 'NSE', 3], ['kge2009', 'KGE', 3], ['r', 'r', 3], ['rmse', 'RMSE', 3], ['pbias', 'PBIAS %', 2]];
const TIMING: [string, string, number][] = [['w1', 'W₁ [steps]', 2], ['w2sq', 'W₂² [steps²]', 2], ['dtw_warp', 'DTW |warp| [steps]', 2], ['peak_lag_abs', 'Peak |lag| [steps]', 2], ['lag_best', 'Best-fit lag [steps]', 0], ['xwt_lag', 'XWT lag [steps]', 2]];

const PRESETS: { name: string; hint: string; patch: Partial<SandboxState> }[] = [
  { name: 'Double penalty (+5 shift)', hint: 'Pure timing error: NSE/KGE collapse, Wasserstein reads the 5-step lag exactly.', patch: { shiftSteps: 5, offset: 0, scale: 1, dampen: 0, noiseAmp: 0 } },
  { name: 'Bias blindness', hint: 'Constant offset: r and R² stay perfect while PBIAS and KGE-β move.', patch: { shiftSteps: 0, scale: 1, dampen: 0, noiseAmp: 0, offset: NaN /* set to 20% of mean at click */ } },
  { name: 'Variance damping', hint: 'Peaks flattened toward the mean: α and FDC signatures react, bias metrics sleep.', patch: { shiftSteps: 0, offset: 0, scale: 1, dampen: 0.5, noiseAmp: 0 } },
  { name: 'Noise', hint: 'Seeded white noise: correlation degrades smoothly; timing metrics stay near zero.', patch: { shiftSteps: 0, offset: 0, scale: 1, dampen: 0, noiseAmp: NaN /* 0.5σ at click */ } },
];

export function SandboxTab() {
  const ds = useApp(s => s.project.datasets.find(d => d.id === s.project.activeDatasetId) ?? null);
  if (!ds) return null;
  return <SandboxTabInner ds={ds} />;
}

function SandboxTabInner({ ds }: { ds: Dataset }) {
  const updateSandbox = useApp(s => s.updateSandbox);

  const sb = ds.view.sandbox;
  const runs = ds.runs;
  const target = runs.find(r => r.id === sb.targetRunId) ?? runs[0];
  const baseSeries = sb.mode === 'synthetic' ? ds.observed.values : target.values;
  const baseStats = useMemo(() => {
    const fin = Array.from(baseSeries as ArrayLike<number>).filter(isFinite);
    return { mean: mean(fin), std: stdPop(fin) };
  }, [ds.id, sb.mode, target?.id]);

  const deferred = useDeferredValue(JSON.stringify(sb));
  const perturbed = useMemo(
    () => perturb(baseSeries, JSON.parse(deferred) as SandboxState),
    [deferred, baseSeries],
  );
  const outLive = useSeriesOutput(ds, `sandbox|${sb.mode}|${target?.id ?? 'obs'}|${deferred}`, perturbed);
  const baselineSeries = useSeriesOutput(ds, 'sandbox-baseline-obs', sb.mode === 'synthetic' ? ds.observed.values : null);
  const baselineRun = useRunOutput(ds, sb.mode === 'synthetic' ? null : target);
  // retain the last completed panel so slider drags never blank the readout
  const lastOut = useRef<ReturnType<typeof Object> | null>(null) as React.MutableRefObject<any>;
  if (outLive) lastOut.current = outLive;
  const out = outLive ?? lastOut.current;
  const baseline = sb.mode === 'synthetic' ? baselineSeries : baselineRun;

  const set = (patch: Partial<SandboxState>) => updateSandbox(patch);
  const slider = (label: string, key: keyof SandboxState, min: number, max: number, step: number, fmt: (v: number) => string) => (
    <label className="sliderrow" key={key}>
      <span className="srtop"><span>{label}</span><code>{fmt(sb[key] as number)}</code></span>
      <input type="range" min={min} max={max} step={step} value={sb[key] as number}
        onChange={e => set({ [key]: Number(e.target.value) } as any)} />
    </label>
  );

  const dates = useMemo(() => ds.dates.map(m => new Date(m).toISOString().slice(0, 10)), [ds.dates]);
  if (!out || !baseline) {
    return <div className="card"><h2>Perturbation sandbox</h2><p className="muted">Computing metric panel in a background worker…</p></div>;
  }
  const clean = (v: ArrayLike<number>) => Array.from(v, x => (isFinite(x as number) ? (x as number) : null));

  const sweepRows: { lag: number; nse: number; w1: number }[] = out.extras.sweep?.rows ?? [];

  return (
    <div>
      <section className="card">
        <h2>Perturbation sandbox <span className="muted">break a hydrograph on purpose and watch which metrics notice (paper §6)</span></h2>
        <div className="controls">
          <label>Base{' '}
            <select value={sb.mode} onChange={e => set({ mode: e.target.value as any })}>
              <option value="perturb">perturb a model run</option>
              <option value="synthetic">synthetic twin of observed</option>
            </select>
          </label>
          {sb.mode === 'perturb' && (
            <label>Run{' '}
              <select aria-label="Perturbation target run" value={target?.id} onChange={e => set({ targetRunId: e.target.value })}>
                {runs.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </label>
          )}
          {PRESETS.map(p => (
            <button key={p.name} title={p.hint} onClick={() => {
              const patch = { ...p.patch };
              if (Number.isNaN(patch.offset as number)) patch.offset = +(0.2 * baseStats.mean).toFixed(3);
              if (Number.isNaN(patch.noiseAmp as number)) patch.noiseAmp = +(0.5 * baseStats.std).toFixed(3);
              set(patch);
            }}>{p.name}</button>
          ))}
          <button onClick={() => set({ shiftSteps: 0, offset: 0, scale: 1, dampen: 0, noiseAmp: 0 })}>Reset</button>
        </div>
        <div className="slidergrid">
          {slider(`Shift Δt (steps of ${ds.step.label})`, 'shiftSteps', -30, 30, 1, v => `${v > 0 ? '+' : ''}${v}`)}
          {slider('Offset β', 'offset', -2 * baseStats.mean, 2 * baseStats.mean, baseStats.mean / 50 || 0.1, v => v.toFixed(2))}
          {slider('Scale γ (anomalies)', 'scale', 0, 3, 0.05, v => `${v.toFixed(2)}×`)}
          {slider('Dampen δ', 'dampen', 0, 1, 0.05, v => v.toFixed(2))}
          {slider('Noise ε amplitude', 'noiseAmp', 0, 2 * baseStats.std, baseStats.std / 25 || 0.1, v => v.toFixed(2))}
          <div className="sliderrow">
            <span className="srtop"><span>Noise kind / seed</span><code>reproducible</code></span>
            <span className="srctrl">
              <select aria-label="Noise kind" value={sb.noiseKind} onChange={e => set({ noiseKind: e.target.value as any })}>
                <option value="uniform">uniform</option><option value="gaussian">gaussian</option>
              </select>
              <input aria-label="Noise seed" type="number" value={sb.noiseSeed} style={{ width: '6em' }} onChange={e => set({ noiseSeed: Number(e.target.value) })} />
            </span>
          </div>
        </div>
        <p className="muted">S′(t) = m + (B(t−Δt) − m)·γ·(1−δ) + β + ε, where B is the base series, m its mean; noise is reproducible from the seed.</p>
      </section>

      <section className="card">
        <h2>Who noticed? <span className="muted">perturbed series scored against observed (baseline in grey)</span></h2>
        <div className="twocol">
          <table className="grid">
            <thead><tr><th>Classical</th><th>value</th><th className="muted">baseline</th></tr></thead>
            <tbody>
              {CLASSICAL.map(([id, label, dg]) => (
                <tr key={id}><td>{label}</td><td><strong>{fmtNum(out.values[id], dg)}</strong></td><td className="muted">{fmtNum(baseline.values[id], dg)}</td></tr>
              ))}
            </tbody>
          </table>
          <table className="grid">
            <thead><tr><th>⏱ Timing &amp; shape</th><th>value</th><th className="muted">baseline</th></tr></thead>
            <tbody>
              {TIMING.map(([id, label, dg]) => (
                <tr key={id} className="timingrow"><td>{label}</td><td><strong>{fmtNum(out.values[id], dg)}</strong></td><td className="muted">{fmtNum(baseline.values[id], dg)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <PlotHost
          traces={[
            { x: dates, y: clean(ds.observed.values), name: 'Observed', type: 'scatter', mode: 'lines', line: { color: OBSERVED_COLOR, width: 2.2 } },
            ...(sb.mode === 'perturb' ? [{ x: dates, y: clean(target.values), name: `${target.name} (original)`, type: 'scatter', mode: 'lines', line: { color: target.color, width: 1, dash: 'dot' }, opacity: 0.4 }] : []),
            { x: dates, y: clean(perturbed), name: 'Perturbed S′', type: 'scatter', mode: 'lines', line: { color: '#d95f02', width: 1.9 } },
          ]}
          layout={{ xaxis: { rangeslider: { visible: true } }, yaxis: { title: `Q [${UNITS[ds.targetUnit].label}]` } }}
          height={380}
        />
      </section>

      <section className="card">
        <h2>Lag sweep of the perturbed series <span className="muted">NSE collapses off-lag; W₁ stays smooth and points at the shift</span></h2>
        <PlotHost
          traces={[
            { x: sweepRows.map(r => r.lag), y: sweepRows.map(r => r.nse), name: 'NSE', type: 'scatter', mode: 'lines', line: { color: '#1f77b4', width: 2.2 } },
            { x: sweepRows.map(r => r.lag), y: sweepRows.map(r => r.w1), name: 'W₁', yaxis: 'y2', type: 'scatter', mode: 'lines', line: { color: '#d95f02', width: 2, dash: 'dot' } },
          ]}
          layout={{
            xaxis: { title: 'lag [steps] (positive = simulation late)', zeroline: true, dtick: 5 },
            yaxis: { title: 'NSE' },
            yaxis2: { title: 'W₁ [steps]', overlaying: 'y', side: 'right' },
            shapes: [
              { type: 'line', x0: out.extras.sweep?.bestLag, x1: out.extras.sweep?.bestLag, yref: 'paper', y0: 0, y1: 1, line: { color: '#1f77b4', dash: 'dash', width: 1 } },
              { type: 'line', x0: sb.shiftSteps, x1: sb.shiftSteps, yref: 'paper', y0: 0, y1: 1, line: { color: '#999', dash: 'dot', width: 1 } },
            ],
          }}
          height={330}
        />
        <p className="muted">Grey dotted line = the shift you injected; blue dashed = the lag the sweep recovers (best-fit lag {out.values.lag_best}).</p>
      </section>
    </div>
  );
}
