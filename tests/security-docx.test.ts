/** Security regression (audit SEC-DOCX): user text with XML-invalid characters must not
 *  reach word/document.xml, or Word refuses to open the report. */
import { it, expect } from 'vitest'
import JSZip from 'jszip'
import { useApp } from '../src/store/store'
import { stage, parseDelimited } from '../src/ingest/ingest'
import { frameFor, computeForRun, __resetComputeCachesForTests } from '../src/ui/compute'
import { buildDocx, xmlSafe } from '../src/report/report'
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import fc from 'fast-check'

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

it('xmlSafe drops C0 controls, U+FFFE/U+FFFF and lone surrogates, keeps tab/newline and pairs', () => {
  const s = 'a' + String.fromCharCode(1) + 'b' + String.fromCharCode(0xfffe) + '\t\n' + String.fromCharCode(0xd83d, 0xde00) + String.fromCharCode(0xd800) + 'c';
  expect(xmlSafe(s)).toBe('ab\t\n' + String.fromCharCode(0xd83d, 0xde00) + 'c');
});

it('SEC-DOCX (review): xmlSafe uses no regex lookbehind, which Safari 14.0 to 16.3 cannot parse', () => {
  // esbuild rewrites a lookbehind literal to new RegExp(...), which throws on those
  // browsers at the first call, so every Word report failed there.
  expect(xmlSafe.toString()).not.toMatch(/\(\?<[!=]/);
  for (const f of walk('src')) {
    if (!/\.(ts|tsx)$/.test(f)) continue;
    expect([f, /\(\?<[!=]/.test(readFileSync(f, 'utf8'))]).toEqual([f, false]);
  }
  if (existsSync('dist/assets')) {
    for (const f of walk('dist/assets').filter(x => /index-.*\.js$/.test(x))) {
      expect([f, readFileSync(f, 'utf8').includes('(?<![')]).toEqual([f, false]);
    }
  }
});

it('SEC-DOCX (review): xmlSafe keeps every valid character and pair, and drops exactly the XML-invalid code units', () => {
  const units = fc.array(fc.oneof(
    fc.constantFrom(0, 1, 8, 9, 10, 11, 12, 13, 14, 31, 32, 0x41, 0xd7ff, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xe000, 0xfffd, 0xfffe, 0xffff),
    fc.integer({ min: 0, max: 0xffff })), { maxLength: 40 });
  fc.assert(fc.property(units, cs => {
    const s = String.fromCharCode(...cs);
    // reference: walk code units; a high surrogate followed by a low one is a pair
    let ref = '';
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i], d = cs[i + 1];
      if (c >= 0xd800 && c <= 0xdbff && d !== undefined && d >= 0xdc00 && d <= 0xdfff) { ref += String.fromCharCode(c, d); i++; continue; }
      if ((c >= 0xd800 && c <= 0xdfff) || c === 0xfffe || c === 0xffff || (c < 0x20 && c !== 9 && c !== 10 && c !== 13)) continue;
      ref += String.fromCharCode(c);
    }
    expect(xmlSafe(s)).toBe(ref);
  }), { numRuns: 2000 });
  expect(xmlSafe(String.fromCharCode(0xdc00, 0xd800, 0xdc00))).toBe(String.fromCharCode(0xd800, 0xdc00));
  expect(xmlSafe(String.fromCharCode(0xd800, 0xd800, 0xdc00))).toBe(String.fromCharCode(0xd800, 0xdc00));
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
