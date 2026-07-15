import { useMemo, useState } from 'react'
import { useApp } from '../store/store'
import { PlotHost } from './PlotHost'
import { useRunOutput, subsetFrameFor } from './compute'
import { AnalysisBar } from './AnalysisBar'
import { quantile } from '../metrics/support/stats'
import { OBSERVED_COLOR } from '../types'
import { arrMax } from '../metrics/support/stats'
import { UNITS } from '../units/registry'
import type { Dataset } from '../types'

const PLOTS = [
  ['timeseries', 'Time series'], ['scatter', '1:1 scatter'], ['fdc', 'Flow duration'],
  ['qq', 'Q-Q'], ['doy', 'DOY climatology'], ['heatmap', 'Annual heatmap'],
  ['spaghetti', 'Spaghetti'], ['alignment', 'DTW alignment'],
] as const;

type Mode = 'none' | 'derivative' | 'cumulative' | 'fromMean';

function seriesOf(ds: Dataset, frame: { obs: Float64Array; apply: (v: ArrayLike<number>) => Float64Array }) {
  const clean = (v: ArrayLike<number>) => Array.from(v, x => (isFinite(x as number) ? (x as number) : null));
  return [
    { name: ds.observed.name || 'Observed', color: OBSERVED_COLOR, y: clean(frame.obs), width: 2.2, dash: 'solid' as const },
    ...ds.runs.filter(r => r.visible).map(r => ({ name: r.name, color: r.color, y: clean(frame.apply(r.values)), width: 1.7, dash: 'solid' as const })),
  ];
}

function applyMode(y: (number | null)[], mode: Mode, movAvg: number | null): (number | null)[] {
  let out = y.slice();
  if (movAvg && movAvg > 1) {
    const w = Math.floor(movAvg);
    out = out.map((_, i) => {
      let s = 0, c = 0;
      for (let k = Math.max(0, i - w + 1); k <= i; k++) { const v = out[k]; if (v !== null) { s += v; c++; } }
      return c ? s / c : null;
    });
  }
  if (mode === 'derivative') {
    out = out.map((v, i) => (i === 0 || v === null || out[i - 1] === null ? null : v - (out[i - 1] as number)));
  } else if (mode === 'cumulative') {
    let acc = 0;
    out = out.map(v => (v === null ? null : (acc += v)));
  } else if (mode === 'fromMean') {
    const fin = out.filter((v): v is number => v !== null);
    const m = fin.reduce((a, b) => a + b, 0) / (fin.length || 1);
    out = out.map(v => (v === null ? null : v - m));
  }
  return out;
}

const doyOf = (ms: number) => {
  const d = new Date(ms);
  return Math.floor((ms - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400_000) + 1;
};

export function PlotsTab() {
  const ds = useApp(s => s.project.datasets.find(d => d.id === s.project.activeDatasetId) ?? null);
  if (!ds) return null;
  return <PlotsTabInner ds={ds} />;
}

function PlotsTabInner({ ds }: { ds: Dataset }) {
  const [plot, setPlot] = useState<(typeof PLOTS)[number][0]>('timeseries');
  const [mode, setMode] = useState<Mode>('none');
  const [logY, setLogY] = useState(false);
  const [movAvg, setMovAvg] = useState<number>(0);
  const [threshold, setThreshold] = useState<string>('');
  const [focusIdx, setFocusIdx] = useState(0); // series selector for heatmap/spaghetti/alignment

  const frame = subsetFrameFor(ds);
  const dates = useMemo(() => frame.dates.map(m => new Date(m).toISOString().slice(0, 10)), [frame.key]);
  const alignRun = ds.runs.filter(r => r.visible)[Math.max(0, Math.min(focusIdx - 1, ds.runs.length - 1))] ?? ds.runs[0] ?? null;
  const alignOut = useRunOutput(ds, plot === 'alignment' ? alignRun : null);
  const all = useMemo(() => seriesOf(ds, frame), [ds, frame.key]);
  const unit = UNITS[ds.targetUnit].label;

  const { traces, layout, note } = useMemo(() => {
    const yTitle = `Q [${unit}]`;
    const L: any = { yaxis: { title: yTitle, type: logY ? 'log' : 'linear' } };
    const thr = Number(threshold);

    if (plot === 'timeseries') {
      const t = all.map(s => ({
        x: dates, y: applyMode(s.y, mode, movAvg || null), name: s.name, type: 'scatter', mode: 'lines',
        line: { color: s.color, width: s.width, dash: s.dash },
      }));
      L.xaxis = { rangeslider: { visible: true }, title: 'Time', showline: false };
      L.yaxis = { ...L.yaxis, zeroline: true };
      if (threshold && isFinite(thr) && mode === 'none') {
        L.shapes = [{ type: 'line', xref: 'paper', x0: 0, x1: 1, y0: thr, y1: thr, line: { color: '#888', dash: 'dot' } }];
      }
      const noteBits = [];
      if (mode !== 'none') noteBits.push(mode === 'fromMean' ? 'departure from mean' : mode);
      if (movAvg > 1) noteBits.push(`${movAvg}-step moving average`);
      return { traces: t, layout: L, note: noteBits.join(' + ') || null };
    }

    if (plot === 'scatter') {
      const obs = all[0].y;
      const finiteMax = arrMax(all.flatMap(s => s.y.filter((v): v is number => v !== null)));
      const t = all.slice(1).map(s => ({
        x: obs, y: s.y, name: s.name, type: 'scattergl', mode: 'markers',
        marker: { color: s.color, size: 4, opacity: 0.55 },
      }));
      t.push({ x: [0, finiteMax], y: [0, finiteMax], name: '1:1', type: 'scatter', mode: 'lines', line: { color: '#555', dash: 'dash', width: 1 } } as any);
      return { traces: t, layout: { xaxis: { title: `Observed [${unit}]`, showline: false, zeroline: true }, yaxis: { title: `Simulated [${unit}]`, scaleanchor: 'x', showline: false, zeroline: true }, hovermode: 'closest' }, note: null };
    }

    if (plot === 'fdc') {
      const t = all.map(s => {
        const v = s.y.filter((x): x is number => x !== null).sort((a, b) => b - a);
        const p = v.map((_, i) => (100 * (i + 1)) / (v.length + 1));
        return { x: p, y: v, name: s.name, type: 'scatter', mode: 'lines', line: { color: s.color, width: s.width, dash: s.dash } };
      });
      return { traces: t, layout: { xaxis: { title: 'Exceedance probability [%]' }, yaxis: { title: yTitle, type: 'log' }, hovermode: 'closest' }, note: 'Log(y) flow duration curves (Weibull plotting position)' };
    }

    if (plot === 'qq') {
      const qs = Array.from({ length: 99 }, (_, i) => (i + 1) / 100);
      const obs = all[0].y.filter((x): x is number => x !== null);
      const oq = qs.map(q => quantile(obs, q));
      const t = all.slice(1).map(s => {
        const sv = s.y.filter((x): x is number => x !== null);
        return { x: oq, y: qs.map(q => quantile(sv, q)), name: s.name, type: 'scatter', mode: 'lines+markers', marker: { size: 4 }, line: { color: s.color } };
      });
      const mx = arrMax(oq);
      t.push({ x: [0, mx], y: [0, mx], name: '1:1', type: 'scatter', mode: 'lines', line: { color: '#555', dash: 'dash', width: 1 } } as any);
      return { traces: t, layout: { xaxis: { title: `Observed quantiles [${unit}]`, showline: false, zeroline: true }, yaxis: { title: `Simulated quantiles [${unit}]`, scaleanchor: 'x', showline: false, zeroline: true }, hovermode: 'closest' }, note: null };
    }

    if (plot === 'doy') {
      const t: any[] = [];
      all.forEach((s, si) => {
        const byDoy = new Map<number, number[]>();
        s.y.forEach((v, i) => {
          if (v === null) return;
          const doy = doyOf(ds.dates[i]);
          if (!byDoy.has(doy)) byDoy.set(doy, []);
          byDoy.get(doy)!.push(v);
        });
        const doys = [...byDoy.keys()].sort((a, b) => a - b);
        const med = doys.map(dd => quantile(byDoy.get(dd)!, 0.5));
        if (si === 0) {
          const p25 = doys.map(dd => quantile(byDoy.get(dd)!, 0.25));
          const p75 = doys.map(dd => quantile(byDoy.get(dd)!, 0.75));
          t.push({ x: doys, y: p75, type: 'scatter', mode: 'lines', line: { width: 0 }, showlegend: false, hoverinfo: 'skip' });
          t.push({ x: doys, y: p25, type: 'scatter', mode: 'lines', line: { width: 0 }, fill: 'tonexty', fillcolor: 'rgba(26,26,26,0.12)', name: 'obs IQR', hoverinfo: 'skip' });
        }
        t.push({ x: doys, y: med, name: `${s.name} (median)`, type: 'scatter', mode: 'lines', line: { color: s.color, width: s.width, dash: s.dash } });
      });
      return { traces: t, layout: { xaxis: { title: 'Day of year', showline: false }, yaxis: { title: yTitle, type: logY ? 'log' : 'linear', zeroline: true } }, note: 'Medians by day of year; shaded band = observed interquartile range (IQR)' };
    }

    if (plot === 'heatmap' || plot === 'spaghetti') {
      const s = all[Math.min(focusIdx, all.length - 1)];
      const byYear = new Map<number, (number | null)[]>();
      s.y.forEach((v, i) => {
        const d = new Date(ds.dates[i]);
        const y = d.getUTCFullYear();
        if (!byYear.has(y)) byYear.set(y, Array(366).fill(null));
        byYear.get(y)![doyOf(ds.dates[i]) - 1] = v;
      });
      const years = [...byYear.keys()].sort((a, b) => a - b);
      if (plot === 'heatmap') {
        return {
          traces: [{ z: years.map(y => byYear.get(y)!), x: Array.from({ length: 366 }, (_, i) => i + 1), y: years, type: 'heatmap', colorscale: 'Rainbow', colorbar: { title: { text: unit, side: 'right' }, lenmode: 'pixels', len: 376, y: 0.5, yanchor: 'middle', thickness: 14, outlinewidth: 0 } }],
          layout: { xaxis: { title: 'Day of year' }, yaxis: { title: 'Year', dtick: 1 }, hovermode: 'closest' },
          note: `Annual regime of ${s.name}`,
        };
      }
      const t = years.map((y, i) => ({
        x: Array.from({ length: 366 }, (_, k) => k + 1), y: byYear.get(y)!, name: String(y), type: 'scatter', mode: 'lines',
        line: { color: i === years.length - 1 ? s.color : 'rgba(120,130,140,0.45)', width: i === years.length - 1 ? 2 : 1 },
      }));
      return { traces: t, layout: { xaxis: { title: 'Day of year', showline: false }, yaxis: { title: yTitle, type: logY ? 'log' : 'linear', zeroline: true }, hovermode: 'closest' }, note: `One line per year of ${s.name}; latest year highlighted in color` };
    }

    // alignment
    const run = alignRun!;
    if (!alignOut) return { traces: [], layout: {}, note: 'computing DTW alignment in a background worker…' };
    const path = alignOut.extras.dtw?.path ?? [];
    const paired = { o: all[0].y, s: all.find(a => a.name === run.name)?.y ?? all[1]?.y };
    const step = Math.max(1, Math.floor(path.length / 160));
    const cx: (string | null)[] = [], cy: (number | null)[] = [];
    for (let k = 0; k < path.length; k += step) {
      const [i, j] = path[k];
      cx.push(dates[i], dates[j], null);
      cy.push(paired.o[i] ?? null, paired.s?.[j] ?? null, null);
    }
    return {
      traces: [
        { x: dates, y: paired.o, name: 'Observed', type: 'scatter', mode: 'lines', line: { color: OBSERVED_COLOR, width: 2.2 } },
        { x: dates, y: paired.s, name: run.name, type: 'scatter', mode: 'lines', line: { color: run.color, width: 1.7 } },
        { x: cx, y: cy, name: 'DTW alignment', type: 'scatter', mode: 'lines', line: { color: 'rgba(150,150,160,0.5)', width: 1 }, hoverinfo: 'skip' },
      ],
      layout: { xaxis: { rangeslider: { visible: true }, title: 'Time', showline: false }, yaxis: { title: yTitle, zeroline: true } },
      note: `Optimal Sakoe-Chiba alignment (band ${alignOut.extras.dtw?.band} steps); mean |warp| ${alignOut.values.dtw_warp?.toFixed(2)} steps; grey ties connect matched points`,
    };
  }, [ds, plot, mode, logY, movAvg, threshold, focusIdx, dates, all, unit, frame.key, alignOut]);

  const needsFocus = plot === 'heatmap' || plot === 'spaghetti' || plot === 'alignment';

  return (
    <div>
      <AnalysisBar />
      <section className="card">
        <div className="controls">
          <span className="ctrl-label">Plot type:</span>
          {PLOTS.map(([id, label]) => (
            <button key={id} className={plot === id ? 'primary' : ''} onClick={() => setPlot(id)}>{label}</button>
          ))}
        </div>
        <div className="controls">
          {plot === 'timeseries' && (
            <>
              <label>View{' '}
                <select aria-label="Plot mode" value={mode} onChange={e => setMode(e.target.value as Mode)}>
                  <option value="none">values</option>
                  <option value="derivative">derivative (ΔQ)</option>
                  <option value="cumulative">cumulative</option>
                  <option value="fromMean">departure from mean</option>
                </select>
              </label>
              <label>Moving avg <input type="number" min={0} max={90} value={movAvg} style={{ width: '4em' }} onChange={e => setMovAvg(Number(e.target.value))} /> steps</label>
              <label>Threshold <input type="number" value={threshold} style={{ width: '6em' }} onChange={e => setThreshold(e.target.value)} /></label>
            </>
          )}
          {(plot === 'timeseries' || plot === 'doy' || plot === 'spaghetti') && (
            <label><input type="checkbox" checked={logY} onChange={e => setLogY(e.target.checked)} /> Log(y)</label>
          )}
          {needsFocus && (
            <label>Series{' '}
              <select aria-label="Focus series" value={focusIdx} onChange={e => setFocusIdx(Number(e.target.value))}>
                {(plot === 'alignment' ? all.slice(1) : all).map((s, i) => (
                  <option key={s.name} value={plot === 'alignment' ? i + 1 : i}>{s.name}</option>
                ))}
              </select>
            </label>
          )}
        </div>
        {note && <p className="muted">{note}</p>}
        <PlotHost traces={traces} layout={layout} height={440} square={plot === 'scatter' || plot === 'fdc' || plot === 'qq'} name={`${ds.name.replace(/[^\w-]+/g, '_')}_${plot}`} />
      </section>
    </div>
  );
}
