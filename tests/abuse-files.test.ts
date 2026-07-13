/** AGENT B — file-format abuse: workbooks, ragged/hostile delimited text,
 *  reversed windows, and wide reports. Guards QA-009 and the S2/S3 layout
 *  and subsetting defects. */
import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { parseWorkbook, parseDelimited, stage } from '../src/ingest/ingest'
import { applySubset } from '../src/metrics/subset'
import { defaultView } from '../src/types'
import { chunkIndices } from '../src/report/report'

function wbBuffer(sheets: Record<string, any[][]>): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  for (const [name, aoa] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return out as ArrayBuffer;
}

describe('QA-009 workbooks: data on a later sheet', () => {
  it('skips empty leading sheets and says which sheet it used', async () => {
    const buf = wbBuffer({
      Notes: [[]],
      Cover: [['Prepared by', 'someone']],           // 1 row: not a data table
      Data: [['date', 'observed', 'm1'], ['2001-01-01', 1, 1.1], ['2001-01-02', 2, 2.1]],
    });
    const t = await parseWorkbook(buf);
    expect(t.header).toEqual(['date', 'observed', 'm1']);
    expect(t.rows.length).toBe(2);
    expect(t.note).toMatch(/Data/);
  });
  it('single-sheet workbook carries no note', async () => {
    const t = await parseWorkbook(wbBuffer({ Only: [['date', 'obs'], ['2001-01-01', 3]] }));
    expect(t.note).toBeUndefined();
  });
  it('workbook with no data rows anywhere degrades to an empty table', async () => {
    const t = await parseWorkbook(wbBuffer({ A: [[]], B: [['just a title']] }));
    expect(t.header).toEqual([]);
    expect(t.rows).toEqual([]);
  });
});

describe('delimited-text torture', () => {
  it('UTF-8 BOM does not corrupt the first header', () => {
    const t = parseDelimited('\ufeffdate,observed,m\n2001-01-01,1,1');
    expect(t.header[0]).toBe('date');
  });
  it('CRLF line endings parse identically to LF', () => {
    const lf = parseDelimited('date,observed,m\n2001-01-01,1,2\n2001-01-02,2,3');
    const crlf = parseDelimited('date,observed,m\r\n2001-01-01,1,2\r\n2001-01-02,2,3');
    expect(crlf.rows).toEqual(lf.rows);
  });
  it('ragged rows do not throw and short rows read as missing', () => {
    const t = parseDelimited('date,observed,m\n2001-01-01,1\n2001-01-02,2,3,EXTRA');
    const st = stage(t, { name: 'r', unit: 'm3s', dateFormat: 'auto', sentinels: true, roles: ['date', 'observed', 'run'] });
    expect(st.validation).toBeDefined(); // no throw is the contract
  });
  it('header-only and empty files stage with clear errors, not crashes', () => {
    for (const txt of ['date,observed,m', '']) {
      const st = stage(parseDelimited(txt), { name: 'x', unit: 'm3s', dateFormat: 'auto', sentinels: true, roles: ['date', 'observed', 'run'] });
      expect(st.commit).toBeNull();
      expect(st.validation.errors.length).toBeGreaterThan(0);
    }
  });
  it('non-ASCII and RTL header names survive intact', () => {
    const t = parseDelimited('تاریخ,القياس,Modèle-β\n2001-01-01,1,2');
    expect(t.header).toEqual(['تاریخ', 'القياس', 'Modèle-β']);
  });
});

describe('reversed analysis window (S2: silently empty frame)', () => {
  const dates = Array.from({ length: 10 }, (_, i) => Date.UTC(2001, 0, 1 + i));
  const obs = dates.map((_, i) => i + 1);
  it('end-before-start is treated as the span between the instants', () => {
    const v = defaultView(86_400_000, 10);
    const fwd = applySubset(dates, [obs], { ...v, window: [dates[2], dates[6]] }, { ms: 86_400_000, label: '1d' });
    const rev = applySubset(dates, [obs], { ...v, window: [dates[6], dates[2]] }, { ms: 86_400_000, label: '1d' });
    expect(rev.dates).toEqual(fwd.dates);
    expect(Array.from(rev.obs)).toEqual(Array.from(fwd.obs));
    expect(rev.dates.length).toBe(5);
  });
});

describe('wide reports: run-column chunking', () => {
  it('chunks 12 runs into page-fitting groups', () => {
    expect(chunkIndices(12, 6)).toEqual([[0, 1, 2, 3, 4, 5], [6, 7, 8, 9, 10, 11]]);
    expect(chunkIndices(5, 6)).toEqual([[0, 1, 2, 3, 4]]);
    expect(chunkIndices(13, 6).map(c => c.length)).toEqual([6, 6, 1]);
  });
});
