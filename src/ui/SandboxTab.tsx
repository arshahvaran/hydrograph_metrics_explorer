import { useDeferredValue, useMemo, useRef, useState } from 'react'
import { useApp } from '../store/store'
import { PlotHost } from './PlotHost'
import { NumField } from './NumField'
import { useRunOutput, useSeriesOutput, useComputeError, perturb } from './compute'
import { decimateMinMax, decimationNote } from './decimate'
import { fmtNum, fmtStamp } from './format'
import { mean, stdPop } from '../metrics/support/stats'
import { OBSERVED_COLOR } from '../types'
import type { Dataset, SandboxState } from '../types'
import { UNITS } from '../units/registry'
import { transformNotes } from '../metrics/registry'

const CLASSICAL: [string, string, number][] = [['nse', 'NSE', 3], ['kge2009', 'KGE', 3], ['r', 'r', 3], ['r2', 'R²', 3], ['rmse', 'RMSE', 3], ['pbias', 'PBIAS %', 2]];
const TIMING: [string, string, number][] = [['w1', 'W₁ [steps]', 2], ['w2sq', 'W₂² [steps²]', 2], ['dtw_warp', 'DTW |warp| [steps]', 2], ['peak_lag_abs', 'Peak |lag| [steps]', 2], ['lag_best', 'Best-fit lag [steps]', 0], ['xwt_lag', 'XWT lag [steps]', 2]];

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
  }, [baseSeries]); // identity changes on dataset switch, target/mode change, AND unit conversion

  const deferred = useDeferredValue(JSON.stringify(sb));
  const perturbed = useMemo(
    () => perturb(baseSeries, JSON.parse(deferred) as SandboxState),
    [deferred, baseSeries],
  );
  // Slider positions share one coalesce tag: while the worker is busy with an
  // older position, every queued position but the newest is dropped, so the
  // readout follows the hand instead of trailing minutes behind it.
  const outLive = useSeriesOutput(ds, `sandbox|${sb.mode}|${target?.id ?? 'obs'}|${deferred}`, perturbed, `sandbox|${ds.id}`);
  const baselineSeries = useSeriesOutput(ds, 'sandbox-baseline-obs', sb.mode === 'synthetic' ? ds.observed.values : null);
  const baselineRun = useRunOutput(ds, sb.mode === 'synthetic' ? null : target);
  const computeError = useComputeError(ds);
  // retain the last completed panel (and baseline) so slider drags never blank the readout;
  // a new target simulation or mode is a different series, so its old panel is dropped
  // rather than shown under the new name (audit timing-sandbox-09)
  const lastOut = useRef<ReturnType<typeof Object> | null>(null) as React.MutableRefObject<any>;
  const lastBase = useRef<any>(null);
  const lastKey = useRef('');
  const targetKey = `${ds.id}|${sb.mode}|${target?.id ?? 'obs'}`;
  if (lastKey.current !== targetKey) { lastKey.current = targetKey; lastOut.current = null; lastBase.current = null; }
  if (outLive) lastOut.current = outLive;
  const out = outLive ?? lastOut.current;
  const baselineLive = sb.mode === 'synthetic' ? baselineSeries : baselineRun;
  if (baselineLive) lastBase.current = baselineLive;
  const baseline = baselineLive ?? lastBase.current;

  const set = (patch: Partial<SandboxState>) => updateSandbox(patch);
  const slider = (label: string, key: keyof SandboxState, min: number, max: number, step: number, fmt: (v: number) => string) => (
    <label className="sliderrow" key={key}>
      <span className="srtop"><span>{label}</span><code>{fmt(sb[key] as number)}</code></span>
      <input type="range" min={min} max={max} step={step} value={sb[key] as number}
        onChange={e => set({ [key]: Number(e.target.value) } as any)} />
    </label>
  );

  const dates = useMemo(() => ds.dates.map(m => fmtStamp(m, ds.step.ms)), [ds.dates, ds.step.ms]);
  if (!out || !baseline) {
    return (
      <div className="card"><h2>Perturbation sandbox</h2>
        {computeError
          ? <div className="error" role="alert">{computeError}</div>
          : <p className="muted">Computing metric panel in a background worker…</p>}
      </div>
    );
  }
  const clean = (v: ArrayLike<number>) => Array.from(v, x => (isFinite(x as number) ? (x as number) : null));
  const dObs = decimateMinMax(dates, clean(ds.observed.values));
  const dOrig = sb.mode === 'perturb' ? decimateMinMax(dates, clean(target.values)) : null;
  const dPert = decimateMinMax(dates, clean(perturbed));
  const factor = Math.max(dObs.factor, dPert.factor, dOrig?.factor ?? 1);

  const sweepRows: { lag: number; nse: number; w1: number }[] = out.extras.sweep?.rows ?? [];
  const bestLag: number = out.extras.sweep?.bestLag ?? NaN;

  return (
    <div>
      <section className="card">
        <h2>Perturbation sandbox <span className="muted">customize your hydrograph on purpose and watch how metrics change on-the-fly</span></h2>
        <div className="controls">
          <label>Base{' '}
            <select value={sb.mode} onChange={e => set({ mode: e.target.value as any })}>
              <option value="perturb">perturb a model simulation</option>
              <option value="synthetic">synthetic twin of observed</option>
            </select>
          </label>
          {sb.mode === 'perturb' && (
            <label>Simulation to perturb{' '}
              <select aria-label="Perturbation target simulation" value={target?.id} onChange={e => set({ targetRunId: e.target.value })}>
                {runs.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </label>
          )}
          <button onClick={() => set({ shiftSteps: 0, offset: 0, scale: 1, dampen: 0, noiseAmp: 0 })}>Reset</button>
        </div>
        <div className="slidergrid">
          {slider(`Shift Δt (steps of ${ds.step.label})`, 'shiftSteps', -30, 30, 1, v => `${v > 0 ? '+' : ''}${v}`)}
          {slider('Offset β', 'offset', -2 * baseStats.mean, 2 * baseStats.mean, baseStats.mean / 50 || 0.1, v => v.toFixed(2))}
          {slider('Scale γ (anomalies)', 'scale', 0, 3, 0.05, v => `${v.toFixed(2)}×`)}
          {slider('Dampen δ', 'dampen', 0, 1, 0.05, v => v.toFixed(2))}
          {slider('Noise ε amplitude', 'noiseAmp', 0, 2 * baseStats.std, baseStats.std / 25 || 0.1, v => v.toFixed(2))}
          <div className="sliderrow">
            <span className="srtop"><span>Noise type / seed</span><code>reproducible</code></span>
            <span className="srctrl">
              <select aria-label="Noise type" value={sb.noiseKind} onChange={e => set({ noiseKind: e.target.value as any })}>
                <option value="uniform">uniform</option><option value="gaussian">gaussian</option>
              </select>
              <NumField aria-label="Noise seed" value={sb.noiseSeed} min={0} max={2_147_483_647} integer style={{ width: '6em' }}
                label="Noise seed" onCommit={v => set({ noiseSeed: v })} />
            </span>
          </div>
        </div>
        <p className="muted">S′(t) = m + (B(t−Δt) − m)·γ·(1−δ) + β + ε, where B is the base series, m its mean; noise is reproducible from the seed.</p>
      </section>

      <section className="card">
        <h2>Hydrograph of the perturbed series <span className="muted">observed, original, and perturbed series update live as the controls change</span></h2>
        {factor > 1 && <p className="muted">{decimationNote(factor)}</p>}
        <PlotHost
          traces={[
            { x: dObs.x, y: dObs.y, name: 'Observed', type: 'scatter', mode: 'lines', line: { color: OBSERVED_COLOR, width: 2.2 } },
            ...(dOrig ? [{ x: dOrig.x, y: dOrig.y, name: `${target.name} (original)`, type: 'scatter', mode: 'lines', line: { color: target.color, width: 1, dash: 'dot' }, opacity: 0.4 }] : []),
            { x: dPert.x, y: dPert.y, name: 'Perturbed S′', type: 'scatter', mode: 'lines', line: { color: '#d95f02', width: 1.9 } },
          ]}
          layout={{ xaxis: { rangeslider: { visible: true }, title: 'Time', showline: false }, yaxis: { title: `Q [${UNITS[ds.targetUnit].label}]`, zeroline: true } }}
          height={380}
        />
      </section>

      <section className="card">
        <h2>Metrics comparison <span className="muted">performance of perturbed and original simulations against observed data</span></h2>
        {/* the Metrics-tab transform applies here too; under log KGE and PBIAS read n/a (tb-rev-03) */}
        {transformNotes(ds.view.transform).map(n => <div key={n} className="warning">{n}</div>)}
        <div className="twocol">
          <div className="tblscroll">
            <table className="grid">
              <thead><tr><th>Conventional</th><th>Perturbed series</th><th>Original series</th></tr></thead>
              <tbody>
                {CLASSICAL.map(([id, label, dg]) => (
                  <tr key={id}><td>{label}</td><td>{fmtNum(out.values[id], dg)}</td><td className="muted">{fmtNum(baseline.values[id], dg)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="tblscroll">
            <table className="grid">
              <thead><tr><th>⏱ Timing &amp; shape</th><th>Perturbed series</th><th>Original series</th></tr></thead>
              <tbody>
                {TIMING.map(([id, label, dg]) => (
                  <tr key={id} className="timingrow"><td>{label}</td><td>{fmtNum(out.values[id], dg)}</td><td className="muted">{fmtNum(baseline.values[id], dg)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
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
              ...(Number.isFinite(bestLag) ? [{ type: 'line', x0: bestLag, x1: bestLag, yref: 'paper', y0: 0, y1: 1, line: { color: '#1f77b4', dash: 'dash', width: 1 } }] : []),
              { type: 'line', x0: sb.shiftSteps, x1: sb.shiftSteps, yref: 'paper', y0: 0, y1: 1, line: { color: '#999', dash: 'dot', width: 1 } },
            ],
          }}
          height={330}
        />
        <p className="muted">Grey dotted line = the shift you injected; blue dashed = the lag the sweep recovers (best-fit lag {fmtNum(out.values.lag_best, 0)}).</p>
      </section>
    </div>
  );
}
