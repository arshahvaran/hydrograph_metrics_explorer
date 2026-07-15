// Report generation (spec §16): Word (.docx) and PDF, entirely client-side.
// DOCX via docx-js (dual DXA widths on tables, ShadingType.CLEAR, typed
// ImageRun, one Paragraph per line; per the documented gotchas). PDF via a
// print-styled window that mirrors the same content, so the two match.

import { arrMax } from '../metrics/support/stats'
import {
  AlignmentType, Document, HeadingLevel, ImageRun, Packer, Paragraph,
  ShadingType, Table, TableCell, TableRow, TextRun, WidthType, BorderStyle,
} from 'docx'
import { REGISTRY, GROUPS, type ComputeOutput } from '../metrics/registry'
import { rankRuns, DEFAULT_PRIORITIES, type RankRow } from '../metrics/rank'
import { fmtNum } from '../ui/format'
import { UNITS } from '../units/registry'
import { exportTemplate } from '../ui/PlotHost'
import { APP_VERSION } from '../version'
import type { Dataset, Run } from '../types'
import type { EventReport, EventError } from '../metrics/timing/events'
import type { Frame } from '../ui/compute'

export interface ReportSections {
  summary: boolean; metrics: boolean; plots: boolean; events: boolean; ranking: boolean;
}
export interface ReportImage { caption: string; dataUrl: string; w: number; h: number }

const TOOL_URL = 'https://arshahvaran.github.io/hydrograph_metrics_explorer/';
const CITATION = `Shahvaran, A.R. (2026). Hydrograph Metrics Explorer v${APP_VERSION} [software]. ${TOOL_URL} · Companion to: Shahvaran et al., "Beyond Conventional Metrics: Timing- and Shape-Aware Performance Assessment Frameworks for Hydrologic Model Evaluation."`;

export const reportFilename = (ds: Dataset, ext: string) =>
  `${ds.name.replace(/\W+/g, '_')}_evaluation_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.${ext}`;

/** ISO day for a millisecond stamp; 'n/a' when the stamp is missing or invalid
 *  (a Date built from undefined/NaN throws 'Invalid time value' on toISOString,
 *  which used to abort whole reports). */
export function isoDay(ms: number | undefined): string {
  return Number.isFinite(ms as number) ? new Date(ms as number).toISOString().slice(0, 10) : 'n/a';
}

/** One string row per event for the report tables (DOCX and PDF share this).
 *  Root cause of the historic 'Report generation failed: Invalid time value':
 *  both renderers read fields that do not exist on EventError (e.start,
 *  e.obsPeak, e.simPeak, e.volBiasPct) behind an 'any' cast, so the date lookup
 *  indexed with undefined and Date.toISOString threw as soon as a single event
 *  existed. This helper reads the real shape (e.obs.start, e.obs.peakQ,
 *  peakMagErrPct, volumeErrPct) and is pinned by tests/report-events.test.ts. */
export function eventTableRows(ev: EventReport, frame: Frame, ds: Dataset, limit = 12): string[][] {
  return ev.events.slice(0, limit).map((e: EventError, k: number) => {
    const simPeak = e.obs.peakQ * (1 + e.peakMagErrPct / 100);
    return [
      String(k + 1),
      isoDay(frame.dates[e.obs.start] ?? ds.dates[e.obs.start]),
      fmtNum(e.obs.peakQ, 2),
      fmtNum(simPeak, 2),
      fmtNum(e.peakLag, 1),
      fmtNum(e.volumeErrPct, 1),
    ];
  });
}

// ------------------------------------------------------------ figure capture
async function plotPng(traces: unknown[], layout: Record<string, unknown>): Promise<{ dataUrl: string; w: number; h: number }> {
  const P: any = (await import('plotly.js-dist-min')).default ?? (await import('plotly.js-dist-min'));
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-10000px;top:0;width:920px;height:430px;';
  document.body.appendChild(host);
  try {
    const base = {
      paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff',
      template: exportTemplate(),
      margin: { t: 40, r: 16, l: 60, b: 48 },
      legend: { orientation: 'h', y: 1.14 },
    };
    await P.newPlot(host, traces, { ...base, ...layout }, { staticPlot: true });
    const dataUrl: string = await P.toImage(host, { format: 'png', width: 920, height: 430, scale: 2 });
    return { dataUrl, w: 620, h: 290 };
  } finally {
    try { P.purge(host); } catch { /* noop */ }
    host.remove();
  }
}

export async function buildReportImages(ds: Dataset, frame: Frame, runs: Run[], outputs: ComputeOutput[]): Promise<ReportImage[]> {
  const dates = frame.dates.map(m => new Date(m).toISOString().slice(0, 10));
  const clean = (v: ArrayLike<number>) => Array.from(v, x => (isFinite(x as number) ? (x as number) : null));
  const images: ReportImage[] = [];
  // One misbehaving canvas must not abort the whole report: each figure is
  // isolated; a failed figure is skipped (logged) and the rest still render.
  const tryFigure = async (caption: string, build: () => Promise<{ dataUrl: string; w: number; h: number }>) => {
    try { images.push({ caption, ...(await build()) }); }
    catch (e) { console.error(`Report figure skipped (${caption}):`, e); }
  };

  await tryFigure(`Fig. R1. Observed vs simulated hydrographs${frame.caption ? ` (${frame.caption})` : ''}.`, () => plotPng(
    [
      { x: dates, y: clean(frame.obs), name: ds.observed.name || 'Observed', type: 'scatter', mode: 'lines', line: { color: '#1f77b4', width: 2.2 } },
      ...runs.map(r => ({ x: dates, y: clean(frame.apply(r.values)), name: r.name, type: 'scatter', mode: 'lines', line: { color: r.color, width: 1.6 } })),
    ],
    { yaxis: { title: `Q [${UNITS[ds.targetUnit].label}]` }, xaxis: { title: '' } },
  ));

  const r0 = runs[0];
  const o = clean(frame.obs), s = clean(frame.apply(r0.values));
  const finite = o.map((v, i) => (v != null && s[i] != null ? [v, s[i]!] as [number, number] : null)).filter((x): x is [number, number] => !!x);
  const lim = [0, arrMax(finite.map(p => Math.max(p[0], p[1]))) * 1.05];
  await tryFigure(`Fig. R2. Predicted–observed scatter, ${r0.name}.`, () => plotPng(
    [
      { x: finite.map(p => p[0]), y: finite.map(p => p[1]), name: r0.name, type: 'scattergl', mode: 'markers', marker: { color: r0.color, size: 4, opacity: 0.55 } },
      { x: lim, y: lim, name: '1:1', type: 'scatter', mode: 'lines', line: { color: '#555', dash: 'dot', width: 1.2 } },
    ],
    { xaxis: { title: `Observed [${UNITS[ds.targetUnit].label}]`, range: lim }, yaxis: { title: `Simulated [${UNITS[ds.targetUnit].label}]`, range: lim, scaleanchor: 'x' } },
  ));

  const rows = outputs[0]?.extras.sweep?.rows ?? [];
  if (rows.length) {
    await tryFigure(`Fig. R3. Lag sweep for ${r0.name}: time-synchronous NSE vs the transport-based W₁.`, () => plotPng(
      [
        { x: rows.map((r: any) => r.lag), y: rows.map((r: any) => r.nse), name: 'NSE', type: 'scatter', mode: 'lines', line: { color: '#1f77b4', width: 2.2 } },
        { x: rows.map((r: any) => r.lag), y: rows.map((r: any) => r.w1), name: 'W₁', yaxis: 'y2', type: 'scatter', mode: 'lines', line: { color: '#d95f02', width: 2, dash: 'dot' } },
      ],
      {
        xaxis: { title: `lag [steps of ${frame.step.label}] (positive = simulation late)`, zeroline: true },
        yaxis: { title: 'NSE' }, yaxis2: { title: 'W₁', overlaying: 'y', side: 'right' },
        shapes: [{ type: 'line', x0: 0, x1: 0, yref: 'paper', y0: 0, y1: 1, line: { color: '#888', width: 1, dash: 'dot' } }],
      },
    ));
  }
  return images;
}

// ------------------------------------------------------------- data summary
export function summaryPairs(ds: Dataset, frame: Frame): [string, string][] {
  const v = ds.view;
  return [
    ['Record', `${new Date(ds.dates[0]).toISOString().slice(0, 10)} – ${new Date(ds.dates[ds.dates.length - 1]).toISOString().slice(0, 10)} (${ds.dates.length} steps of ${ds.step.label}${ds.step.irregular ? ', irregular' : ''})`],
    ['Analysis subset', frame.caption || 'full record'],
    ['Steps in analysis', String(frame.dates.length)],
    ['Unit', UNITS[ds.targetUnit].label + (ds.area ? ` · area ${ds.area.value} ${ds.area.unit}` : '')],
    ['Location', ds.location ? `${ds.location.lat.toFixed(4)}, ${ds.location.lon.toFixed(4)} (WGS84)` : 'n/a'],
    ['NaN policy / transform / benchmark', `${v.nanPolicy} / ${v.transform} / ${v.benchmark}`],
    ['Timing config', `events ≥ P${v.timingConfig.eventThreshold.value}${v.timingConfig.eventThreshold.kind === 'absolute' ? ' (abs)' : ''}, min-distance ${v.timingConfig.eventMinDistance}, peak window ±${v.timingConfig.peakMatchTolerance}, DTW band ${Math.round(v.timingConfig.dtwBandFraction * 100)}%`],
  ];
}

// ------------------------------------------------------------------- docx --
const DXA_PAGE = 12240, MARGIN = 1080, CONTENT = DXA_PAGE - 2 * MARGIN;

/** Split 0..n-1 into consecutive chunks of at most `per` (exported for tests). */
export function chunkIndices(n: number, per: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < n; i += per) out.push(Array.from({ length: Math.min(per, n - i) }, (_, k) => i + k));
  return out;
}
const cellP = (text: string, opts: { bold?: boolean; mono?: boolean; color?: string } = {}) =>
  new Paragraph({ children: [new TextRun({ text, bold: opts.bold, color: opts.color, font: opts.mono ? 'Consolas' : undefined, size: opts.mono ? 16 : 18 })] });

function tableOf(headers: string[], rows: { cells: string[]; shaded?: boolean; boldFirst?: boolean }[], widths: number[]): Table {
  const mk = (texts: string[], head: boolean, shaded?: boolean, boldFirst?: boolean) =>
    new TableRow({
      children: texts.map((t, i) => new TableCell({
        width: { size: widths[i], type: WidthType.DXA },
        shading: head ? { type: ShadingType.CLEAR, fill: 'EFF1F4' } : shaded ? { type: ShadingType.CLEAR, fill: 'ECF5EA' } : undefined,
        children: [cellP(t, { bold: head || (boldFirst && i === 0) })],
      })),
    });
  return new Table({
    width: { size: CONTENT, type: WidthType.DXA },
    columnWidths: widths,
    rows: [mk(headers, true), ...rows.map(r => mk(r.cells, false, r.shaded, r.boldFirst))],
  });
}

async function dataUrlBytes(u: string): Promise<Uint8Array> {
  const res = await fetch(u);
  return new Uint8Array(await res.arrayBuffer());
}

export interface ReportPayload {
  ds: Dataset; frame: Frame; runs: Run[]; outputs: ComputeOutput[];
  images: ReportImage[]; sections: ReportSections; notes: string;
}

export async function buildDocx(p: ReportPayload): Promise<Blob> {
  const { ds, frame, runs, outputs, images, sections, notes } = p;
  const kids: (Paragraph | Table)[] = [];
  const H = (text: string, level: (typeof HeadingLevel)[keyof typeof HeadingLevel] = HeadingLevel.HEADING_1) =>
    kids.push(new Paragraph({ heading: level, spacing: { before: 240, after: 100 }, children: [new TextRun(text)] }));
  const Ptext = (text: string, opts: { italic?: boolean; mono?: boolean; size?: number } = {}) =>
    kids.push(new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text, italics: opts.italic, font: opts.mono ? 'Consolas' : undefined, size: opts.size ?? (opts.mono ? 14 : 20) })] }));

  kids.push(new Paragraph({
    heading: HeadingLevel.TITLE, alignment: AlignmentType.LEFT,
    children: [new TextRun(`Model evaluation report: ${ds.name}`)],
  }));
  Ptext(`Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC by Hydrograph Metrics Explorer v${APP_VERSION} (${TOOL_URL}). All computation ran in the browser; no data left the device.`, { italic: true });

  if (sections.summary) {
    H('1. Data and settings');
    kids.push(tableOf(['Item', 'Value'], summaryPairs(ds, frame).map(([k, v]) => ({ cells: [k, v], boldFirst: true })), [2600, CONTENT - 2600]));
  }

  if (sections.metrics) {
    H('2. Metrics');
    Ptext('Rows shaded green and marked ⏱ are the timing- and shape-aware measures this tool adds over conventional suites.', { italic: true });
    const nameW = 2900, optW = 1100;
    // QA: with many runs a single table overflows US-Letter. Chunk the run
    // columns so each table fits; chunk size derives from the minimum legible
    // column width.
    for (const idx of chunkIndices(runs.length, Math.max(1, Math.floor((CONTENT - nameW - optW) / 900)))) {
      const chunkRuns = idx.map(i => runs[i]);
      const chunkOuts = idx.map(i => outputs[i]);
      if (runs.length > idx.length) Ptext(`Runs ${idx[0] + 1}–${idx[idx.length - 1] + 1} of ${runs.length}`, { italic: true });
      const runW = Math.floor((CONTENT - nameW - optW) / chunkRuns.length);
      const widths = [nameW, optW, ...chunkRuns.map(() => runW)];
      const rows: { cells: string[]; shaded?: boolean; boldFirst?: boolean }[] = [];
      for (const g of GROUPS) {
        const ms = REGISTRY.filter(m => m.group === g);
        if (!ms.length) continue;
        rows.push({ cells: [g, '', ...chunkRuns.map(() => '')], boldFirst: true });
        for (const m of ms) {
          rows.push({
            cells: [`${m.timing ? '⏱ ' : ''}${m.label}`, m.optimum, ...chunkOuts.map(o => fmtNum(o.values[m.id], m.digits))],
            shaded: m.timing,
          });
        }
      }
      kids.push(tableOf(['Metric', 'Optimum', ...chunkRuns.map(r => r.name)], rows, widths));
    }
  }

  if (sections.plots) {
    H('3. Figures');
    for (const img of images) {
      kids.push(new Paragraph({
        alignment: AlignmentType.CENTER, spacing: { before: 160, after: 40 },
        children: [new ImageRun({ type: 'png', data: await dataUrlBytes(img.dataUrl), transformation: { width: img.w, height: img.h } })],
      }));
      kids.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 140 }, children: [new TextRun({ text: img.caption, italics: true, size: 18 })] }));
    }
  }

  if (sections.events) {
    H('4. Event summary');
    for (let i = 0; i < runs.length; i++) {
      const ev = outputs[i].extras.events;
      H(`${runs[i].name}`, HeadingLevel.HEADING_2);
      if (!ev || !ev.events.length) { Ptext('n/a; no events at this threshold.', { italic: true }); continue; }
      Ptext(`Hits ${ev.hits} · misses ${ev.misses} · false alarms ${ev.falseAlarms} · threat score ${fmtNum(ev.threat, 2)}.`);
      const w = Math.floor(CONTENT / 6);
      kids.push(tableOf(
        ['#', 'Start', 'Obs peak', 'Sim peak', 'Peak lag [steps]', 'Volume bias %'],
        eventTableRows(ev, frame, ds).map(cells => ({ cells })),
        [w, w, w, w, w, CONTENT - 5 * w],
      ));
      if (ev.events.length > 12) Ptext(`… ${ev.events.length - 12} more events omitted; export the full table from the Timing tab.`, { italic: true });
    }
  }

  if (sections.ranking && runs.length >= 2) {
    H('5. Simulation ranking and recommendation');
    const priorities = ds.view.priorityMetrics.length ? ds.view.priorityMetrics : DEFAULT_PRIORITIES;
    const rows: RankRow[] = rankRuns(runs.map((r, i) => ({ runName: r.name, values: outputs[i].values })), priorities);
    const order = rows.map((_, i) => i).sort((a, b) => rows[a].rank - rows[b].rank);
    const w0 = 900, wn = 2600;
    const wm = Math.max(900, Math.floor((CONTENT - w0 - wn - 1400) / priorities.length));
    kids.push(tableOf(
      ['Rank', 'Simulation', ...priorities.map(pr => `${pr.id} (w=${pr.weight})`), 'Composite'],
      order.map(i => ({
        cells: [String(rows[i].rank), rows[i].runName,
          ...priorities.map(pr => (isFinite(rows[i].perMetric[pr.id]) ? rows[i].perMetric[pr.id].toFixed(2) : 'n/a')),
          isFinite(rows[i].composite) ? rows[i].composite.toFixed(3) : 'n/a'],
        shaded: rows[i].rank === 1, boldFirst: true,
      })),
      [w0, wn, ...priorities.map(() => wm), 1400],
    ));
    if (isFinite(rows[order[0]].composite)) {
      Ptext(`Recommended simulation: ${rows[order[0]].runName} (composite ${rows[order[0]].composite.toFixed(3)}). Scores are relative to the compared simulations; unbounded efficiencies are normalised through C2M = E/(2−E) before weighting.`);
    } else {
      Ptext('No composite could be computed for the selected priority metrics.', { italic: true });
    }
  }

  if (notes.trim()) { H('Notes'); Ptext(notes.trim()); }

  H('Provenance', HeadingLevel.HEADING_2);
  Ptext('Every setting needed to regenerate this report:', { italic: true });
  const provenance = JSON.stringify({ tool: `HME v${APP_VERSION}`, dataset: ds.name, unit: ds.targetUnit, view: ds.view }, null, 1);
  for (const line of provenance.split('\n')) Ptext(line, { mono: true });
  Ptext(CITATION, { italic: true, size: 16 });

  const doc = new Document({
    styles: { default: { document: { run: { font: 'Calibri', size: 20 } } } },
    sections: [{
      properties: { page: { size: { width: DXA_PAGE, height: 15840 }, margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN } } },
      children: kids,
    }],
  });
  return Packer.toBlob(doc);
}

// -------------------------------------------------------------------- pdf --
export function openPrintReport(p: ReportPayload): void {
  const { ds, frame, runs, outputs, images, sections, notes } = p;
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const rowsHtml = (cells: string[], tag = 'td', cls = '') => `<tr class="${cls}">${cells.map(c => `<${tag}>${esc(c)}</${tag}>`).join('')}</tr>`;
  let body = `<h1>Model evaluation report: ${esc(ds.name)}</h1>
  <p class="meta">Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC by Hydrograph Metrics Explorer v${APP_VERSION}; ${TOOL_URL}. All computation ran in the browser.</p>`;
  if (sections.summary) {
    body += `<h2>1. Data and settings</h2><table>${summaryPairs(ds, frame).map(([k, v]) => rowsHtml([k, v])).join('')}</table>`;
  }
  if (sections.metrics) {
    body += `<h2>2. Metrics</h2><table><thead>${rowsHtml(['Metric', 'Optimum', ...runs.map(r => r.name)], 'th')}</thead><tbody>`;
    for (const g of GROUPS) {
      const ms = REGISTRY.filter(m => m.group === g);
      if (!ms.length) continue;
      body += rowsHtml([g, '', ...runs.map(() => '')], 'td', 'group');
      for (const m of ms) body += rowsHtml([`${m.timing ? '⏱ ' : ''}${m.label}`, m.optimum, ...outputs.map(o => fmtNum(o.values[m.id], m.digits))], 'td', m.timing ? 'timing' : '');
    }
    body += '</tbody></table>';
  }
  if (sections.plots) {
    body += '<h2>3. Figures</h2>' + images.map(i => `<figure><img src="${i.dataUrl}" style="width:100%"/><figcaption>${esc(i.caption)}</figcaption></figure>`).join('');
  }
  if (sections.events) {
    body += '<h2>4. Event summary</h2>';
    runs.forEach((r, i) => {
      const ev = outputs[i].extras.events;
      body += `<h3>${esc(r.name)}</h3>`;
      if (!ev || !ev.events.length) { body += '<p><em>n/a; no events at this threshold.</em></p>'; return; }
      body += `<p>Hits ${ev.hits} · misses ${ev.misses} · false alarms ${ev.falseAlarms} · threat ${fmtNum(ev.threat, 2)}.</p>`;
      body += `<table><thead>${rowsHtml(['#', 'Start', 'Obs peak', 'Sim peak', 'Peak lag', 'Vol bias %'], 'th')}</thead><tbody>` +
        eventTableRows(ev, frame, ds).map(cells => rowsHtml(cells)).join('') + '</tbody></table>';
    });
  }
  if (sections.ranking && runs.length >= 2) {
    const priorities = ds.view.priorityMetrics.length ? ds.view.priorityMetrics : DEFAULT_PRIORITIES;
    const rows = rankRuns(runs.map((r, i) => ({ runName: r.name, values: outputs[i].values })), priorities);
    const order = rows.map((_, i) => i).sort((a, b) => rows[a].rank - rows[b].rank);
    body += `<h2>5. Simulation ranking</h2><table><thead>${rowsHtml(['Rank', 'Simulation', ...priorities.map(p2 => `${p2.id} (w=${p2.weight})`), 'Composite'], 'th')}</thead><tbody>` +
      order.map(i => rowsHtml([String(rows[i].rank), rows[i].runName, ...priorities.map(p2 => (isFinite(rows[i].perMetric[p2.id]) ? rows[i].perMetric[p2.id].toFixed(2) : 'n/a')), rows[i].composite.toFixed(3)], 'td', rows[i].rank === 1 ? 'timing' : '')).join('') + '</tbody></table>' +
      (isFinite(rows[order[0]].composite)
        ? `<p><strong>Recommended simulation: ${esc(rows[order[0]].runName)}</strong> (composite ${rows[order[0]].composite.toFixed(3)}).</p>`
        : '<p><em>No composite could be computed for the selected priority metrics.</em></p>');
  }
  if (notes.trim()) body += `<h2>Notes</h2><p>${esc(notes.trim())}</p>`;
  body += `<h2>Provenance</h2><pre>${esc(JSON.stringify({ tool: `HME v${APP_VERSION}`, dataset: ds.name, unit: ds.targetUnit, view: ds.view }, null, 1))}</pre><p class="meta">${esc(CITATION)}</p>`;

  const w = window.open('', '_blank');
  if (!w) { alert('Pop-up blocked; allow pop-ups to print the PDF report.'); return; }
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${reportFilename(ds, 'pdf').replace(/\.pdf$/, '')}</title><style>
    body{font-family:"Times New Roman",Georgia,serif;color:#101113;margin:26mm 20mm;line-height:1.45;font-size:11pt}
    h1{font-size:17pt;margin:0 0 4pt} h2{font-size:13pt;margin:14pt 0 4pt} h3{font-size:11.5pt;margin:10pt 0 2pt}
    .meta{color:#555;font-style:italic;font-size:9.5pt}
    table{border-collapse:collapse;width:100%;margin:6pt 0;font-size:9.5pt}
    th,td{border:1px solid #c8ccd2;padding:2.5pt 5pt;text-align:left}
    thead th{background:#eff1f4} tr.group td{background:#eff1f4;font-weight:700}
    tr.timing td{background:#ecf5ea} figure{margin:10pt 0;page-break-inside:avoid} figcaption{font-style:italic;font-size:9.5pt;text-align:center}
    pre{font-size:8pt;background:#f4f5f7;padding:6pt;white-space:pre-wrap}
    @media print{ a{color:inherit;text-decoration:none} }
  </style></head><body>${body}</body></html>`);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 350);
}
