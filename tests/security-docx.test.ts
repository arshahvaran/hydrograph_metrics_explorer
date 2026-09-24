/** Security regression (audit SEC-DOCX): user text with XML-invalid characters must not
 *  reach word/document.xml, or Word refuses to open the report. */
import { it, expect } from 'vitest'
import JSZip from 'jszip'
import { useApp } from '../src/store/store'
import { stage, parseDelimited } from '../src/ingest/ingest'
import { frameFor, computeForRun, __resetComputeCachesForTests } from '../src/ui/compute'
import { buildDocx, xmlSafe } from '../src/report/report'

it('xmlSafe drops C0 controls, U+FFFE/U+FFFF and lone surrogates, keeps tab/newline and pairs', () => {
  const s = 'a' + String.fromCharCode(1) + 'b' + String.fromCharCode(0xfffe) + '\t\n' + String.fromCharCode(0xd83d, 0xde00) + String.fromCharCode(0xd800) + 'c';
  expect(xmlSafe(s)).toBe('ab\t\n' + String.fromCharCode(0xd83d, 0xde00) + 'c');
});

it('SEC-DOCX: a run name holding U+0001 does not reach document.xml', async () => {
  __resetComputeCachesForTests();
  useApp.getState().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null });
  const rows = ['date,obs,sim' + String.fromCharCode(1) + 'A'];
  for (let i = 0; i < 60; i++) rows.push(`${new Date(Date.UTC(2001, 0, 1) + i * 864e5).toISOString().slice(0, 10)},${(6 + Math.sin(i / 5)).toFixed(3)},${(6 + Math.sin((i - 2) / 5)).toFixed(3)}`);
  const table = parseDelimited(rows.join('\n'));
  useApp.getState().commitDataset(stage(table, { name: 'ctrl', unit: 'm3s', dateFormat: 'auto', missingValue: null, roles: ['date', 'observed', 'run'] }).commit!);
  const ds = useApp.getState().project.datasets[0];
  const runs = ds.runs.filter(r => r.visible);
  const outputs = runs.map(r => computeForRun(ds, r));
  const blob = await buildDocx({ ds, frame: frameFor(ds), runs, outputs, images: [], notes: '', sections: { summary: true, metrics: true, plots: false, events: true, ranking: false } } as any);
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const xml = await zip.file('word/document.xml')!.async('string');
  expect(/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(xml)).toBe(false);
  expect(xml).toContain('simA');
});
