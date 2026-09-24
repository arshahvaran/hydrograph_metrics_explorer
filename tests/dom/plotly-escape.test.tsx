// @vitest-environment jsdom
/** Audit SEC-MAP, Plotly sink (review): Plotly renders pseudo-HTML in trace names, point
 *  text, hover text, titles and annotations, so a run name holding '<a href>' from a
 *  shared project file became a live link in every legend. User text is escaped in one
 *  place before it reaches Plotly: PlotHost for the tabs, plotPng for the report. */
import { it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import Plotly from 'plotly.js-dist-min'
import { useApp } from '../../src/store/store'
import { parseProjectFile } from '../../src/store/projectLoad'
import { frameFor, computeForRun, __resetComputeCachesForTests } from '../../src/ui/compute'
import { plotSafeTraces, plotSafeLayout, tracesToCsv } from '../../src/ui/PlotHost'
import { buildReportImages } from '../../src/report/report'
import App from '../../src/App'

const EVIL = '<a href="https://evil.example/login" target="_blank">Model A (click here)</a>';
const EVIL_DS = 'Nith <b>River</b> & co';

function project(activeTab: string) {
  const n = 120, t0 = Date.UTC(2001, 0, 1);
  const dates = Array.from({ length: n }, (_, i) => t0 + i * 864e5);
  const obs = dates.map((_, i) => 10 + 3 * Math.sin(i / 7) + (i % 30 === 5 ? 8 : 0));
  return JSON.stringify({
    schemaVersion: 1,
    datasets: [{
      name: EVIL_DS, dates, observed: { name: '<img src=x>obs', values: obs, inputUnit: 'm3s' },
      runs: [{ name: EVIL, values: obs.map((_v, i) => obs[Math.max(0, i - 2)]), inputUnit: 'm3s', visible: true },
             { name: 'plain', values: obs.map(v => v * 1.1), inputUnit: 'm3s', visible: true }],
      targetUnit: 'm3s', location: null, area: null, view: { activeTab },
    }],
  });
}

/** Every string Plotly would draw as markup, from traces and layout. */
function drawnStrings(traces: any[], layout: any): string[] {
  const out: string[] = [];
  const add = (v: unknown) => { if (typeof v === 'string') out.push(v); else if (Array.isArray(v)) v.forEach(add); else if (v && typeof v === 'object' && typeof (v as any).text === 'string') out.push((v as any).text); };
  for (const tr of traces) { add(tr.name); add(tr.text); add(tr.hovertext); }
  add(layout?.title);
  for (const a of layout?.annotations ?? []) add(a.text);
  for (const k of Object.keys(layout ?? {})) if (/^[xy]axis\d*$/.test(k)) add(layout[k]?.title);
  return out;
}

beforeEach(() => {
  __resetComputeCachesForTests();
  vi.mocked(Plotly.react).mockClear();
  vi.mocked(Plotly.newPlot).mockClear();
  useApp.getState().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null });
});
afterEach(() => cleanup());

it('the helpers escape &, < and > in names, text arrays, hover text, titles and annotations, without touching the input', () => {
  const traces = [{ name: EVIL, text: [EVIL, 1, null], hovertext: 'a<b', x: [1], y: [2] }];
  const safe = plotSafeTraces(traces);
  expect(safe[0].name).toBe('&lt;a href="https://evil.example/login" target="_blank"&gt;Model A (click here)&lt;/a&gt;');
  expect(safe[0].text).toEqual([safe[0].name, 1, null]);
  expect(safe[0].hovertext).toBe('a&lt;b');
  expect(traces[0].name).toBe(EVIL);                       // input unchanged
  expect(tracesToCsv(traces)).toContain('Model A (click here)</a>');  // CSV keeps the raw name
  const lay = plotSafeLayout({ title: 'x & y', xaxis: { title: { text: '<i>t</i>', standoff: 3 } }, annotations: [{ text: '<br>' }] });
  expect(lay.title).toBe('x &amp; y');
  expect(lay.xaxis.title).toEqual({ text: '&lt;i&gt;t&lt;/i&gt;', standoff: 3 });
  expect(lay.annotations[0].text).toBe('&lt;br&gt;');
});

it('Plots and Timing tabs hand Plotly no markup from dataset or run names', async () => {
  useApp.getState().loadProject(parseProjectFile(project('plots')).project);
  render(<App />);
  await waitFor(() => expect(vi.mocked(Plotly.react).mock.calls.length).toBeGreaterThan(0), { timeout: 8000 });
  fireEvent.click(screen.getByRole('tab', { name: 'Timing' }));
  // the DE polar labels each point with its simulation name (text: runs.map(r => r.name))
  await waitFor(() => {
    const polar = vi.mocked(Plotly.react).mock.calls.some((c: any[]) => (c[1] as any[]).some((t: any) => t.type === 'scatterpolar' && Array.isArray(t.text) && t.text.length > 1));
    expect(polar).toBe(true);
  }, { timeout: 15000 });
  const strings: string[] = vi.mocked(Plotly.react).mock.calls.flatMap((c: any[]) => drawnStrings(c[1] as any[], c[2]));
  expect(strings.some(s => s.includes('Model A (click here)'))).toBe(true);
  for (const s of strings) expect(s).not.toMatch(/[<>]/);
}, 30000);

it('report figures hand Plotly no markup from dataset or run names', async () => {
  useApp.getState().loadProject(parseProjectFile(project('report')).project);
  const ds = useApp.getState().project.datasets[0];
  const runs = [ds.runs[0], ds.runs[1]];
  await buildReportImages(ds, frameFor(ds), runs, runs.map(r => computeForRun(ds, r)));
  const calls = vi.mocked(Plotly.newPlot).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const strings: string[] = calls.flatMap((c: any[]) => drawnStrings(c[1] as any[], c[2]));
  expect(strings.some(s => s.includes('Model A (click here)'))).toBe(true);
  for (const s of strings) expect(s).not.toMatch(/[<>]/);
});

it('with the real Plotly, an escaped hostile name shows as text and creates no link', async () => {
  const mod: any = await vi.importActual('plotly.js-dist-min');
  const P = mod.default ?? mod;
  const plot = async (traces: any[]) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    await P.newPlot(host, traces, { width: 600, height: 400 });
    return host;
  };
  const traces = [{ x: [1, 2, 3], y: [1, 2, 3], name: EVIL, type: 'scatter', mode: 'lines' }, { x: [1, 2, 3], y: [2, 2, 2], name: 'b', type: 'scatter' }];
  const raw = await plot(traces);
  expect(raw.querySelectorAll('.legend a').length).toBe(1);          // the defect: a live link
  const safe = await plot(plotSafeTraces(traces));
  expect(safe.querySelectorAll('.legend a').length).toBe(0);
  expect(safe.querySelector('.legend')!.textContent).toContain(EVIL); // shown literally
  P.purge(raw); P.purge(safe);
}, 30000);
