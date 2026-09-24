/** SEC-XLSX regression: SheetJS 0.18.5 (the last npm-registry build) let a
 *  crafted spreadsheet write to Object.prototype (CVE-2023-30533) and has a
 *  ReDoS (CVE-2024-22363). The tool now uses the fixed 0.20.3 build from
 *  cdn.sheetjs.com. The workbook below names a database range on the sheet
 *  "__proto__", which 0.18.5 turned into Object.prototype["!autofilter"]. */
import { it, expect, afterEach } from 'vitest'
import { parseWorkbook } from '../../src/ingest/ingest'

const FODS = `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2" office:mimetype="application/vnd.oasis.opendocument.spreadsheet">
<office:body><office:spreadsheet>
<table:table table:name="Sheet1">
<table:table-row><table:table-cell office:value-type="string"><text:p>date</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p>obs</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p>sim</text:p></table:table-cell></table:table-row>
<table:table-row><table:table-cell office:value-type="string"><text:p>2001-01-01</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="1"><text:p>1</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="2"><text:p>2</text:p></table:table-cell></table:table-row>
<table:table-row><table:table-cell office:value-type="string"><text:p>2001-01-02</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="3"><text:p>3</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="4"><text:p>4</text:p></table:table-cell></table:table-row>
</table:table>
<table:database-ranges><table:database-range table:name="x" table:target-range-address="__proto__.A1:__proto__.C3"/></table:database-ranges>
</office:spreadsheet></office:body></office:document>`;

afterEach(() => { delete (Object.prototype as Record<string, unknown>)['!autofilter']; });

it('a crafted spreadsheet does not write to Object.prototype', async () => {
  expect(({} as Record<string, unknown>)['!autofilter']).toBeUndefined();
  const buf = new TextEncoder().encode(FODS).buffer as ArrayBuffer;
  try { await parseWorkbook(buf); } catch { /* refusing the file is also safe */ }
  const probe: Record<string, unknown> = {};
  const keys: string[] = [];
  for (const k in probe) keys.push(k);
  expect(probe['!autofilter']).toBeUndefined();
  expect(keys).toEqual([]);
});

it('the bundled SheetJS is a fixed build (0.19.3 or later)', async () => {
  const { version } = await import('xlsx');
  const [maj, min, pat] = version.split('.').map(Number);
  expect(maj * 1e6 + min * 1e3 + pat).toBeGreaterThanOrEqual(19 * 1e3 + 3);
});
