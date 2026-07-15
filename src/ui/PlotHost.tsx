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

/** Fixed light palette for exports that must be readable on white (JPG). */
export function exportTemplate(): any {
  const ink = '#1a1a1a', soft = '#4a5563', grid = '#d7dbe0';
  const axis = {
    gridcolor: grid, zerolinecolor: soft,
    showline: true, linecolor: soft, linewidth: 1.2,
    ticks: 'outside', ticklen: 4, tickcolor: soft,
    automargin: true, title: { standoff: 10 },
  };
  return {
    layout: {
      font: { family: '"STIX Two Text", "Times New Roman", Georgia, serif', size: 13.5, color: ink },
      xaxis: axis, yaxis: axis,
      legend: { font: { color: ink } },
    },
  };
}

/** Theme-aware Plotly template: figure-style serif type on the current palette. */
function themeTemplate(): any {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fb: string) => (css.getPropertyValue(name).trim() || fb);
  const ink = v('--ink', '#101113');
  const soft = v('--ink-soft', '#697080');
  const grid = v('--plotgrid', '#e3e6ea');
  const axis = {
    gridcolor: grid, zerolinecolor: soft,
    // visible axis lines and consistent tick spacing on every figure
    showline: true, linecolor: soft, linewidth: 1.2,
    ticks: 'outside', ticklen: 4, tickcolor: soft,
    automargin: true, title: { standoff: 10 },
  };
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

export function PlotHost({ traces, layout, height = 380, name = 'hme_plot', square = false }: { traces: any[]; layout: any; height?: number; name?: string; square?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const theme = useApp(s => s.theme);
  useEffect(() => {
    let cancelled = false;
    loadPlotly().then(P => {
      if (cancelled || !ref.current) return;
      P.react(ref.current, traces, { ...BASE_LAYOUT, template: themeTemplate(), ...layout, ...(square ? { width: height, height, autosize: false } : {}) }, {
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
  const exportW = square ? height : 1100;
  const dl = (format: 'png' | 'svg') => {
    if (!ref.current) return;
    loadPlotly().then(P => P.downloadImage(ref.current!, { format, filename: name, width: exportW, height, scale: format === 'png' ? 300 / 96 : 1 }));
  };
  const dlJpg = async () => {
    // JPG has no alpha: render on a white background with dark type,
    // regardless of the on-screen theme.
    const P = await loadPlotly();
    const fig = {
      data: traces,
      layout: { ...BASE_LAYOUT, template: exportTemplate(), ...layout, paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff', width: exportW, height },
    };
    const url = await P.toImage(fig, { format: 'jpeg', width: exportW, height, scale: 300 / 96 });
    const a = document.createElement('a');
    a.href = url; a.download = `${name}.jpg`; a.click();
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
      <div ref={ref} style={{ width: square ? height : '100%', height }} className="plothost" />
      <div className="dlrow" aria-label="download this plot">
        <span className="ctrl-label">Download plot:</span>
        <button onClick={dlJpg} title="Download JPG (white background)">JPG</button>
        <button onClick={() => dl('png')} title="Download PNG">PNG</button>
        <button onClick={() => dl('svg')} title="Download SVG">SVG</button>
        <button onClick={dlCsv} title="Download plotted data as CSV">CSV</button>
      </div>
    </div>
  );
}
