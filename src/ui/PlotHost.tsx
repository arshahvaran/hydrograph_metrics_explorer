import { useEffect, useRef } from 'react'
import { useApp } from '../store/store'
import { csvLine } from './format'

let plotlyPromise: Promise<any> | null = null;
const loadPlotly = () => (plotlyPromise ??= import('plotly.js-dist-min').then(m => m.default ?? m));

export const BASE_LAYOUT = {
  margin: { t: 36, r: 14, l: 58, b: 46 },
  paper_bgcolor: 'rgba(0,0,0,0)',
  plot_bgcolor: 'rgba(0,0,0,0)',
  legend: { orientation: 'h', y: 1.12 },
  hovermode: 'x unified',
} as const;

/** Theme-aware Plotly template: figure-style serif type on the current palette. */
function themeTemplate(): any {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fb: string) => (css.getPropertyValue(name).trim() || fb);
  const ink = v('--ink', '#101113');
  const soft = v('--ink-soft', '#697080');
  const grid = v('--plotgrid', '#e3e6ea');
  const axis = { gridcolor: grid, zerolinecolor: soft, linecolor: grid, tickcolor: grid };
  return {
    layout: {
      font: { family: '"STIX Two Text", "Times New Roman", Georgia, serif', size: 13.5, color: ink },
      xaxis: { ...axis, rangeslider: { bgcolor: 'rgba(0,0,0,0)', bordercolor: grid } },
      yaxis: axis,
      modebar: { color: soft, activecolor: ink, bgcolor: 'rgba(0,0,0,0)' },
      polar: {
        bgcolor: 'rgba(0,0,0,0)',
        angularaxis: { gridcolor: grid, linecolor: soft },
        radialaxis: { gridcolor: grid, linecolor: grid },
      },
      legend: { font: { color: ink } },
      hoverlabel: { font: { family: '"Hanken Grotesk", sans-serif' } },
    },
  };
}

function tracesToCsv(traces: any[]): string {
  const lines = ['trace,x,y'];
  for (const tr of traces) {
    const xs = tr.x ?? [], ys = tr.y ?? tr.r ?? [];
    const name = String(tr.name ?? 'series');
    for (let i = 0; i < Math.min(xs.length ?? 0, ys.length ?? 0); i++) {
      lines.push(csvLine([name, xs[i], ys[i]]));
    }
  }
  return lines.join('\n');
}

export function PlotHost({ traces, layout, height = 380, name = 'hme_plot' }: { traces: any[]; layout: any; height?: number; name?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const theme = useApp(s => s.theme);
  useEffect(() => {
    let cancelled = false;
    loadPlotly().then(P => {
      if (cancelled || !ref.current) return;
      P.react(ref.current, traces, { ...BASE_LAYOUT, template: themeTemplate(), ...layout }, {
        responsive: true, displaylogo: false,
        modeBarButtonsToRemove: ['lasso2d', 'select2d'],
        toImageButtonOptions: { format: 'png', filename: 'hme_plot', scale: 2 },
      });
    });
    return () => { cancelled = true; };
  }, [traces, layout, theme]);
  useEffect(() => () => {
    if (ref.current) loadPlotly().then(P => P.purge(ref.current!));
  }, []);
  const dl = (format: 'png' | 'svg') => {
    if (!ref.current) return;
    loadPlotly().then(P => P.downloadImage(ref.current!, { format, filename: name, width: 1100, height, scale: format === 'png' ? 2 : 1 }));
  };
  const dlCsv = () => {
    const blob = new Blob([tracesToCsv(traces)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  return (
    <div>
      <div ref={ref} style={{ width: '100%', height }} className="plothost" />
      <div className="dlrow" aria-label="download this plot">
        <button onClick={() => dl('png')} title="Download PNG">PNG</button>
        <button onClick={() => dl('svg')} title="Download SVG">SVG</button>
        <button onClick={dlCsv} title="Download plotted data as CSV">CSV</button>
      </div>
    </div>
  );
}
