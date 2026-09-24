import { useEffect, useMemo, useRef } from 'react'
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
      font: { family: '"STIX Two Text Variable", "STIX Two Text", "Times New Roman", Georgia, serif', size: 13.5, color: ink },
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
      font: { family: '"STIX Two Text Variable", "STIX Two Text", "Times New Roman", Georgia, serif', size: 13.5, color: ink },
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

/**
 * Plotly draws trace names, point text, hover text, titles and annotations as
 * pseudo-HTML: it renders <a href>, <b>, <br> and the like. Dataset and run
 * names come from user files and shared project files, so a run named
 * '<a href="https://evil.example/">Model A</a>' became a live link in every
 * legend (audit SEC-MAP, Plotly sink). Every such string is escaped here, in
 * one place, before it reaches Plotly (the tabs through PlotHost, the report
 * figures through plotPng); Plotly decodes &amp; &lt; &gt; back, so the
 * characters show literally. The app puts no markup in these fields, and the
 * CSV export keeps the raw names.
 */
export const plotText = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escText = (v: unknown): unknown =>
  typeof v === 'string' ? plotText(v)
    : Array.isArray(v) ? v.map(x => (typeof x === 'string' ? plotText(x) : x))
      : v;
const escTitle = (t: unknown): unknown =>
  typeof t === 'string' ? plotText(t)
    : t && typeof t === 'object' && typeof (t as any).text === 'string' ? { ...(t as object), text: plotText((t as any).text) }
      : t;

/** Traces with every user-visible string escaped (a new array; the input is not changed). */
export function plotSafeTraces(traces: any[]): any[] {
  return traces.map(tr => {
    if (!tr || typeof tr !== 'object') return tr;
    const out = { ...tr };
    for (const k of ['name', 'text', 'hovertext']) if (k in out) out[k] = escText(out[k]);
    if (out.legendgrouptitle) out.legendgrouptitle = escTitle(out.legendgrouptitle);
    if (out.colorbar?.title) out.colorbar = { ...out.colorbar, title: escTitle(out.colorbar.title) };
    if (out.marker?.colorbar?.title) out.marker = { ...out.marker, colorbar: { ...out.marker.colorbar, title: escTitle(out.marker.colorbar.title) } };
    return out;
  });
}

/** Layout with its title, axis titles, legend title and annotation text escaped. */
export function plotSafeLayout<T extends Record<string, any>>(layout: T): T {
  const out: Record<string, any> = { ...layout };
  if ('title' in out) out.title = escTitle(out.title);
  for (const k of Object.keys(out)) {
    if (/^[xy]axis\d*$/.test(k) && out[k] && typeof out[k] === 'object' && 'title' in out[k]) out[k] = { ...out[k], title: escTitle(out[k].title) };
  }
  if (out.legend?.title) out.legend = { ...out.legend, title: escTitle(out.legend.title) };
  if (Array.isArray(out.annotations)) out.annotations = out.annotations.map((a: any) => (a && typeof a === 'object' && 'text' in a ? { ...a, text: escText(a.text) } : a));
  return out as T;
}

type TraceKind = 'xy' | 'heatmap' | 'polar';
const traceKind = (tr: any): TraceKind =>
  Array.isArray(tr.z) ? 'heatmap'
    : (tr.r !== undefined || tr.theta !== undefined || /polar/.test(String(tr.type ?? ''))) ? 'polar'
      : 'xy';
const arr = (v: unknown): any[] | null => (Array.isArray(v) || ArrayBuffer.isView(v) ? Array.from(v as ArrayLike<unknown>) : null);
const titleText = (t: any): string | null => (typeof t === 'string' ? t : typeof t?.text === 'string' ? t.text : null);

/**
 * The plotted data as CSV, one row per plotted point:
 *  - x/y traces: trace, x, y (a null y is a gap in the line, kept as an empty cell);
 *  - heatmaps: trace, x, y, z, one row per non-empty cell (z is the plotted value);
 *  - polar traces: trace, r, theta_deg;
 *  - a per-point marker colour array (a colour scale) adds a column named
 *    after its colour-bar title.
 * The trace column is meta.csvName, else the trace name, else the point's
 * text label (the DE polar labels each point with its simulation).
 * `columns` names the x, y and z columns where a plot's axes need saying
 * (the day-of-year plots name their 365-day calendar); the default headers
 * are x, y and z. Exported for tests.
 */
export interface CsvColumns { x?: string; y?: string; z?: string }

export function tracesToCsv(traces: any[], columns: CsvColumns = {}): string {
  const kinds = traces.map(traceKind);
  const hasXY = kinds.some(k => k !== 'polar'), hasZ = kinds.includes('heatmap'), hasPolar = kinds.includes('polar');
  const colourTr = traces.find(tr => arr(tr.marker?.color) && traceKind(tr) !== 'heatmap');
  const colourCol = colourTr ? (titleText(colourTr.marker.colorbar?.title) ?? 'marker_color') : null;
  const header = ['trace', ...(hasXY ? [columns.x ?? 'x', columns.y ?? 'y'] : []), ...(hasZ ? [columns.z ?? 'z'] : []), ...(hasPolar ? ['r', 'theta_deg'] : []), ...(colourCol ? [colourCol] : [])];
  const lines = [csvLine(header)];
  traces.forEach((tr, t) => {
    const kind = kinds[t];
    const text = arr(tr.text);
    const label = (i: number) => String(tr.meta?.csvName ?? tr.name ?? (text && text[i] != null ? text[i] : 'series'));
    const colours = arr(tr.marker?.color);
    const row = (i: number, cells: { x?: unknown; y?: unknown; z?: unknown; r?: unknown; theta?: unknown }) => {
      lines.push(csvLine([
        label(i),
        ...(hasXY ? [cells.x, cells.y] : []), ...(hasZ ? [cells.z] : []), ...(hasPolar ? [cells.r, cells.theta] : []),
        ...(colourCol ? [colours && kind !== 'heatmap' ? colours[i] : ''] : []),
      ]));
    };
    if (kind === 'heatmap') {
      const xs = arr(tr.x), ys = arr(tr.y);
      (tr.z as any[]).forEach((zrow, i) => {
        (arr(zrow) ?? []).forEach((v, j) => {
          if (v === null || v === undefined || !Number.isFinite(v)) return;
          row(i, { x: xs ? xs[j] : j, y: ys ? ys[i] : i, z: v });
        });
      });
    } else if (kind === 'polar') {
      const rs = arr(tr.r) ?? [], th = arr(tr.theta) ?? [];
      const toDeg = tr.thetaunit === 'radians' ? 180 / Math.PI : 1;
      for (let i = 0; i < Math.min(rs.length, th.length); i++) {
        row(i, { r: rs[i], theta: typeof th[i] === 'number' ? th[i] * toDeg : th[i] });
      }
    } else {
      const xs = arr(tr.x), ys = arr(tr.y) ?? [];
      // a trace without x is drawn against 0, 1, 2, ... by Plotly
      for (let i = 0; i < (xs ? Math.min(xs.length, ys.length) : ys.length); i++) row(i, { x: xs ? xs[i] : i, y: ys[i] });
    }
  });
  return lines.join('\n');
}

export function PlotHost({ traces, layout, height = 380, name = 'hme_plot', square = false, csvColumns }: { traces: any[]; layout: any; height?: number; name?: string; square?: boolean; csvColumns?: CsvColumns }) {
  const ref = useRef<HTMLDivElement>(null);
  const theme = useApp(s => s.theme);
  // what Plotly draws: user text escaped (plotSafeTraces); the CSV uses the raw traces
  const shownTraces = useMemo(() => plotSafeTraces(traces), [traces]);
  const shownLayout = useMemo(() => plotSafeLayout(layout ?? {}), [layout]);
  useEffect(() => {
    let cancelled = false;
    loadPlotly().then(P => {
      if (cancelled || !ref.current) return;
      P.react(ref.current, shownTraces, { ...BASE_LAYOUT, template: themeTemplate(), ...shownLayout, ...(square ? { width: height, height, autosize: false } : { width: null, height, autosize: true }) }, {
        responsive: true, displaylogo: false,
        modeBarButtonsToRemove: ['lasso2d', 'select2d'],
        toImageButtonOptions: { format: 'png', filename: 'hme_plot', scale: 2 },
      });
    });
    return () => { cancelled = true; };
  }, [shownTraces, shownLayout, theme]);
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
      data: shownTraces,
      layout: { ...BASE_LAYOUT, template: exportTemplate(), ...shownLayout, paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff', width: exportW, height },
    };
    const url = await P.toImage(fig, { format: 'jpeg', width: exportW, height, scale: 300 / 96 });
    const a = document.createElement('a');
    a.href = url; a.download = `${name}.jpg`; a.click();
  };
  const dlCsv = () => {
    const blob = new Blob([tracesToCsv(traces, csvColumns)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  return (
    <div className="plotwrap">
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
