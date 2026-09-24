/** Audit report-05/claims-05, report-11, report-14: the report lists every setting that
 *  changes a value, prints an absolute threshold in data units, never prints NaN
 *  composites, and keeps the line breaks of the notes. */
import { it, expect, beforeEach } from 'vitest'
import JSZip from 'jszip'
import { useApp } from '../../src/store/store'
import { stage, parseDelimited } from '../../src/ingest/ingest'
import { frameFor, computeForRun, __resetComputeCachesForTests } from '../../src/ui/compute'
import { summaryPairs, openPrintReport, buildDocx } from '../../src/report/report'
import { UNITS } from '../../src/units/registry'

beforeEach(() => {
  __resetComputeCachesForTests();
  const rows = ['date,observed,simA,simB'];
  for (let i = 0; i < 80; i++) rows.push(`${new Date(Date.UTC(2006, 0, 1) + i * 864e5).toISOString().slice(0, 10)},${(6 + Math.sin(i / 5)).toFixed(3)},${(6 + Math.sin((i - 2) / 5)).toFixed(3)},${(6.5 + Math.sin(i / 5)).toFixed(3)}`);
  useApp.getState().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null });
  useApp.getState().commitDataset(stage(parseDelimited(rows.join('\n')), {
    name: 'rep', unit: 'm3s', dateFormat: 'auto', missingValue: null, roles: ['date', 'observed', 'run', 'run'],
  }).commit!);
});

function payload(notes: string) {
  const ds = useApp.getState().project.datasets[0];
  const runs = ds.runs.filter(r => r.visible);
  return { ds, frame: frameFor(ds), runs, outputs: runs.map(r => computeForRun(ds, r)), images: [], notes,
    sections: { summary: true, metrics: true, plots: false, events: true, ranking: true } } as any;
}

it('report-05/report-11: every value-changing timing setting is listed; an absolute threshold is in data units', () => {
  const ds = useApp.getState().project.datasets[0];
  useApp.getState().updateView({ timingConfig: { ...ds.view.timingConfig, eventThreshold: { kind: 'absolute', value: 12.5 }, eventWarmup: 7, peakProminence: 0.4 } });
  const text = summaryPairs(useApp.getState().project.datasets[0], frameFor(useApp.getState().project.datasets[0])).map(p => p.join(': ')).join('\n');
  const unit = UNITS[useApp.getState().project.datasets[0].targetUnit].label;
  // the detector counts flows strictly above the threshold (events.ts: x[i] > thr)
  expect(text).toContain(`events > 12.5 ${unit}`);
  expect(text).not.toContain('events ≥');
  expect(text).not.toMatch(/P12\.5/);
  expect(text).toContain('7 steps');
  expect(text).toContain(`0.4 ${unit}`);
  expect(text).toMatch(/Input units/);
});

it('report-14: the print report shows n/a for a missing composite and keeps note line breaks', () => {
  useApp.getState().updateView({ priorityMetrics: [{ id: 'nse', weight: 0 }] });
  let captured = '';
  const fakeWin: any = { document: { write: (h: string) => { captured += h; }, close() {} }, focus() {}, print() {} };
  const origOpen = window.open;
  (window as any).open = () => fakeWin;
  try { openPrintReport(payload('line one\nline two')); } finally { (window as any).open = origOpen; }
  expect(captured).not.toMatch(/>NaN</);
  expect(captured).toContain('line one<br>line two');
});

it('report-14: the Word report keeps one paragraph per notes line', async () => {
  const blob = await buildDocx(payload('first line\nsecond line'));
  const xml = await (await JSZip.loadAsync(await blob.arrayBuffer())).file('word/document.xml')!.async('string');
  expect(xml).not.toContain('first line second line');
  expect(xml).toMatch(/first line<\/w:t>[\s\S]*<w:p[ >][\s\S]*second line<\/w:t>/);
});
it('report-05 (review): the settings row says the bootstrap CIs are in the Metrics tab, not in this report', () => {
  const pairs = () => Object.fromEntries(summaryPairs(useApp.getState().project.datasets[0], frameFor(useApp.getState().project.datasets[0])));
  expect(pairs()['Bootstrap CIs']).toBe('off in the Metrics tab; not included in this report');
  useApp.getState().updateView({ showBootstrapCIs: true });
  expect(pairs()['Bootstrap CIs']).toBe('shown in the Metrics tab (block bootstrap, seeded); not included in this report');
  expect(Object.values(pairs()).join(' ')).not.toMatch(/shown \(block bootstrap/);
});

it('report-14 (review): with no composite, neither report shades a winner, and zero-weight metrics are not listed', async () => {
  useApp.getState().updateView({ priorityMetrics: [{ id: 'nse', weight: 0 }] });
  const p = { ...payload(''), sections: { summary: false, metrics: false, plots: false, events: false, ranking: true } };
  const blob = await buildDocx(p);
  const xml = await (await JSZip.loadAsync(await blob.arrayBuffer())).file('word/document.xml')!.async('string');
  expect(xml).toContain('No composite could be computed');
  expect(xml).not.toMatch(/ECF5EA/i);                  // the winner shading
  expect(xml).not.toContain('nse (w=0)');
  let html = '';
  const fakeWin: any = { document: { write: (h: string) => { html += h; }, close() {} }, focus() {}, print() {} };
  const origOpen = window.open;
  (window as any).open = () => fakeWin;
  try { openPrintReport(p); } finally { (window as any).open = origOpen; }
  expect(html).not.toContain('<tr class="timing">');
  expect(html).not.toContain('nse (w=0)');
  // with a composite, rank 1 is still shaded in both and the weighted metric is a column
  useApp.getState().updateView({ priorityMetrics: [{ id: 'nse', weight: 1 }, { id: 'kge2009', weight: 0 }] });
  const q = { ...payload(''), sections: p.sections };
  const xml2 = await (await JSZip.loadAsync(await (await buildDocx(q)).arrayBuffer())).file('word/document.xml')!.async('string');
  expect(xml2).toMatch(/ECF5EA/i);
  expect(xml2).toContain('nse (w=1)');
  expect(xml2).not.toContain('kge2009 (w=0)');
});
