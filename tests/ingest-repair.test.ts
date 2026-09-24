/** Regression tests for the second ingest review (fixes/ingest.review.json):
 *  ingest-03-residual, ingest-01-dot-default, ingest-01-workbook-text,
 *  ingest-01-global-override, ingest-04-serial-rounding, SEC-XLSX-guard-scope,
 *  ingest-08-unrecognised-bracket and ingest-10-token-message. Each test
 *  below failed on the code before the repair. */
import { describe, it, expect, afterEach } from 'vitest'
import * as XLSX from 'xlsx'
import { parseDelimited, parseWorkbook, stage, excelSerialToMs, unitFromHeader, type ColumnRole, type RawTable } from '../src/ingest/ingest'
import type { DecimalMark } from '../src/ingest/missing'

const iso = (i: number) => new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10);
const nums = (v: ArrayLike<number>) => Array.from(v).map(x => (Number.isNaN(x) ? null : x));
const stageT = (t: RawTable, roles: ColumnRole[], mark?: DecimalMark) =>
  stage(t, { name: 'x', unit: 'm3s', dateFormat: 'auto', missingValue: null, roles, decimalMark: mark });
const st = (txt: string, roles: ColumnRole[] = ['date', 'observed', 'run'], mark?: DecimalMark) => stageT(parseDelimited(txt), roles, mark);
const bufOf = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

describe('ingest-03-residual: two stray quotes cannot merge rows without a word', () => {
  const file = () => {
    const lines = ['date,obs,sim,remark'];
    for (let i = 0; i < 100; i++) lines.push(`${iso(i)},${i},${i + 1},${i === 10 ? '"estimated' : i === 49 ? 'staff gauge moved 6"' : ''}`);
    return lines.join('\n');
  };
  it('the review file (row 11 "estimated, row 50 moved 6") is refused and the lines are named', () => {
    expect(() => parseDelimited(file())).toThrow('Line 12 of the file has a double quote (") that opens a quoted cell, and the quote that closes it is on line 51. Lines 13 to 51 would be read into that one cell and lost as rows. Remove the stray quotes, then load the file again.');
  });
  it('CRLF text, blank lines, a tab delimiter and adjacent rows give the right line numbers', () => {
    expect(() => parseDelimited('date,obs,sim,rem\r\n\r\n2020-01-01,1,2,"a\r\n2020-01-02,2,3,b"\r\n2020-01-03,3,4,\r\n'))
      .toThrow(/^Line 3 of the file has a double quote \("\) that opens a quoted cell, and the quote that closes it is on line 4\. Line 4 would be read into that one cell and lost as a row\. /);
    expect(() => parseDelimited('date\tobs\tsim\n2020-01-01\t"1\t2\n2020-01-02\t2\t3"\n'))
      .toThrow(/^Line 2 of the file .* closes it is on line 3\./);
  });
  it('a real multi-line remark, quoted delimiters and inch marks still load', () => {
    const t = parseDelimited('date,obs,sim,rem\n2020-01-01,1,2,"gauge moved,\nsee log"\n2020-01-02,2,3,5" rain\n2020-01-03,3,4,"a, b"');
    expect(t.rows).toEqual([['2020-01-01', '1', '2', 'gauge moved,\nsee log'], ['2020-01-02', '2', '3', '5" rain'], ['2020-01-03', '3', '4', 'a, b']]);
  });
});

describe('ingest-01-dot-default: a dot before three digits is not silently a decimal point', () => {
  const EU = 'Datum;Q_obs;Q_sim\n13.01.2020;850;900\n14.01.2020;1.000;1.050\n15.01.2020;1.250;1.200\n16.01.2020;975;990\n17.01.2020;1.500;1.450\n';
  it('the review file (";" cells, dd.mm.yyyy dates, whole numbers next to 1.000) asks, and Comma reads 1000', () => {
    const s = st(EU);
    expect(s.commit).toBeNull();
    expect(s.validation.errors).toContain('Column “Q_obs” has values such as “1.000” that read as 1 with a decimal point or 1000 with a decimal comma. The column also has whole numbers such as “850”, which are near in size to the values with the dot as a thousands separator. Choose the decimal mark in the Decimal mark selector.');
    const c = st(EU, undefined, 'comma');
    expect(nums(c.commit!.observed.values)).toEqual([850, 1000, 1250, 975, 1500]);
    expect(nums(c.commit!.runs[0].values)).toEqual([900, 1050, 1200, 990, 1450]);
    expect(nums(st(EU, undefined, 'point').commit!.observed.values)).toEqual([850, 1, 1.25, 975, 1.5]);
  });
  it('whole numbers next to "1.234" ask in a comma-delimited ISO file too', () => {
    const s = st('date,obs,sim\n2020-01-01,850,2\n2020-01-02,1.234,3\n2020-01-03,975,4');
    expect(s.commit).toBeNull();
    expect(s.validation.errors[0]).toMatch(/^Column “obs” has values such as “1\.234” that read as 1\.234 with a decimal point or 1234 with a decimal comma\. The column also has whole numbers such as “850”/);
  });
  it('a small stray whole number among fixed three-decimal values keeps the decimal point', () => {
    const s = st('date,obs,sim\n2020-01-01,4.873,5.125\n2020-01-02,-2,6.250\n2020-01-03,6.000,7.375\n2020-01-04,7.125,8.500');
    expect(s.validation.errors).toEqual([]);
    expect(nums(s.commit!.observed.values)).toEqual([4.873, -2, 6, 7.125]);
  });
  it('a ";" file or dd.mm.yyyy dates with only dotted three-digit values ask', () => {
    const semi = st('date;obs;sim\n2020-01-01;1.250;2.500\n2020-01-02;3.125;4.750\n2020-01-03;5.375;6.625');
    expect(semi.commit).toBeNull();
    expect(semi.validation.errors[0]).toBe('Column “obs” has values such as “1.250” that read as 1.25 with a decimal point or 1250 with a decimal comma. The file uses “;” between cells, which usually goes with a decimal comma. Choose the decimal mark in the Decimal mark selector.');
    const dmy = st('date,obs,sim\n13.01.2020,1.250,2.500\n14.01.2020,3.125,4.750\n15.01.2020,5.375,6.625');
    expect(dmy.commit).toBeNull();
    expect(dmy.validation.errors[0]).toMatch(/The file has dates such as “13\.01\.2020”, which usually go with a decimal comma\./);
  });
  it('genuine decimal-point columns still read without a question', () => {
    const a = st('date,obs,sim\n2020-01-01,1.5,2.25\n2020-01-02,0.125,3\n2020-01-03,1.234,4.5\n2020-01-04,12,5');
    expect(a.validation.errors).toEqual([]);
    expect(nums(a.commit!.observed.values)).toEqual([1.5, 0.125, 1.234, 12]);
    const b = st('date;obs;sim\n2020-01-01;1.5;2\n2020-01-02;1.234;3\n2020-01-03;7;4');       // ";" file, but "1.5" decides
    expect(b.validation.errors).toEqual([]);
    expect(nums(b.commit!.observed.values)).toEqual([1.5, 1.234, 7]);
    const c = st('date,obs,sim\n2020-01-01,5.123,2.250\n2020-01-02,6.500,3.125\n2020-01-03,7.000,4.875');
    expect(c.validation.errors).toEqual([]);
    expect(nums(c.commit!.observed.values)).toEqual([5.123, 6.5, 7]);
  });
});

describe('ingest-01-workbook-text: text saved as .xls keeps its decimal commas', () => {
  const html = '<html><body><table><tr><td>date</td><td>obs</td><td>sim</td></tr>'
    + '<tr><td>2020-03-07</td><td>12,5</td><td>0,125</td></tr><tr><td>2020-03-08</td><td>12,345</td><td>1.234,5</td></tr>'
    + '<tr><td>2020-03-09</td><td>13,0</td><td>1,5</td></tr><tr><td>2020-03-10</td><td>14,25</td><td>2,5</td></tr></table></body></html>';
  it('an HTML table ("Export to Excel") reads 12,5 as 12.5 and 1.234,5 as 1234.5', async () => {
    const t = await parseWorkbook(bufOf(html));
    expect(t.rows.map(r => r[1])).toEqual(['12,5', '12,345', '13,0', '14,25']);
    const s = stageT(t, ['date', 'observed', 'run']);
    expect(s.validation.errors).toEqual([]);
    expect(nums(s.commit!.observed.values)).toEqual([12.5, 12.345, 13, 14.25]);
    expect(nums(s.commit!.runs[0].values)).toEqual([0.125, 1234.5, 1.5, 2.5]);
    expect(s.commit!.dates).toEqual([7, 8, 9, 10].map(d => Date.UTC(2020, 2, d)));
  });
  it('a ";" CSV saved with a .xls name reads 12,5 as 12.5 and 0,125 as 0.125', async () => {
    const t = await parseWorkbook(bufOf('date;obs;sim\n2020-01-01;12,5;0,125\n2020-01-02;13,5;1,5\n2020-01-03;14;2\n'));
    const s = stageT(t, ['date', 'observed', 'run']);
    expect(nums(s.commit!.observed.values)).toEqual([12.5, 13.5, 14]);
    expect(nums(s.commit!.runs[0].values)).toEqual([0.125, 1.5, 2]);
  });
  it('binary and XML workbooks still give typed numbers and dates (same as before)', async () => {
    const ws: XLSX.WorkSheet = { A1: { t: 's', v: 'date' }, B1: { t: 's', v: 'obs' }, C1: { t: 's', v: 'sim' } };
    [43831, 43831.5, 43832.25].forEach((v, i) => {
      ws[`A${i + 2}`] = { t: 'n', v, z: 'yyyy-mm-dd hh:mm' };
      ws[`B${i + 2}`] = { t: 'n', v: 1234.5 + i };
      ws[`C${i + 2}`] = { t: 's', v: ['0,5', '1,25', '2'][i] };
    });
    ws['!ref'] = 'A1:C4';
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'D');
    for (const bookType of ['xlsx', 'xlsb', 'biff8', 'biff5', 'biff2', 'xlml', 'ods', 'fods'] as const) {
      const buf = XLSX.write(wb, { type: 'array', bookType }) as ArrayBuffer;
      const t = await parseWorkbook(buf);
      expect(t.rows, bookType).toEqual([
        ['2020-01-01 00:00', 1234.5, '0,5'], ['2020-01-01 12:00', 1235.5, '1,25'], ['2020-01-02 06:00', 1236.5, '2']]);
    }
  });
});

describe('ingest-01-global-override: the Decimal mark choice does not override a column\'s own evidence', () => {
  const F = 'date;obs;simA;simB\n2020-01-01;12,345;1,5;1.5\n2020-01-02;13,345;2,5;1.234\n2020-01-03;14,345;3,5;2.5\n';
  const R: ColumnRole[] = ['date', 'observed', 'run', 'run'];
  it('Comma answers obs and leaves simB (1.5, 2.5 in the column) at 1.234', () => {
    expect(st(F, R).validation.errors.length).toBe(1);
    const s = st(F, R, 'comma');
    expect(nums(s.commit!.observed.values)).toEqual([12.345, 13.345, 14.345]);
    expect(nums(s.commit!.runs[0].values)).toEqual([1.5, 2.5, 3.5]);
    expect(nums(s.commit!.runs[1].values)).toEqual([1.5, 1.234, 2.5]);
  });
  it('Point answers obs and leaves simA a comma column', () => {
    const s = st(F, R, 'point');
    expect(nums(s.commit!.observed.values)).toEqual([12345, 13345, 14345]);
    expect(nums(s.commit!.runs[1].values)).toEqual([1.5, 1.234, 2.5]);
  });
  it('with nothing to ask, the choice changes nothing', () => {
    const txt = 'date,obs,sim\n2020-01-01,1.5,2\n2020-01-02,1.234,3\n2020-01-03,2.5,4';
    expect(nums(st(txt, undefined, 'comma').commit!.observed.values)).toEqual([1.5, 1.234, 2.5]);
  });
});

describe('ingest-04-serial-rounding: spreadsheet date-times are rounded to whole seconds', () => {
  it('an Excel fill-down (=A2+1/24) of 3,000 hours gives exact hours and no midnight on the wrong day', async () => {
    const ws: XLSX.WorkSheet = { A1: { t: 's', v: 'date' }, B1: { t: 's', v: 'obs' }, C1: { t: 's', v: 'sim' } };
    let s = 43831;                                    // 2020-01-01 00:00
    for (let i = 0; i < 3000; i++) {
      ws[`A${i + 2}`] = { t: 'n', v: s, z: 'yyyy-mm-dd hh:mm' };
      ws[`B${i + 2}`] = { t: 'n', v: i };
      ws[`C${i + 2}`] = { t: 'n', v: i + 1 };
      s = s + 1 / 24;                                 // what the fill-down stores, step by step
    }
    ws['!ref'] = 'A1:C3001';
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'D');
    const t = await parseWorkbook(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
    const want = Array.from({ length: 3000 }, (_, i) => Date.UTC(2020, 0, 1) + i * 3_600_000);
    expect(t.rows.filter(r => /\./.test(String(r[0]))).length).toBe(0);
    const st2 = stageT(t, ['date', 'observed', 'run']);
    expect(st2.commit!.dates).toEqual(want);
    expect(excelSerialToMs(43930.458333327544)).toBe(Date.UTC(2020, 3, 9, 11));
  });
  it('a number format with fractional seconds keeps the milliseconds', async () => {
    const half = 43831 + (12 * 3600 + 0.7) / 86400;
    const ws: XLSX.WorkSheet = { A1: { t: 's', v: 'date' }, B1: { t: 's', v: 'obs' },
      A2: { t: 'n', v: half, z: 'yyyy-mm-dd hh:mm:ss.000' }, B2: { t: 'n', v: 1 },
      A3: { t: 'n', v: half, z: 'yyyy-mm-dd hh:mm:ss' }, B3: { t: 'n', v: 2 }, '!ref': 'A1:B3' };
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'D');
    const t = await parseWorkbook(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
    expect(t.rows.map(r => r[0])).toEqual(['2020-01-01 12:00:00.700', '2020-01-01 12:00:01']);
  });
});

describe('SEC-XLSX-guard-scope: the reader cannot add properties to Object or its methods', () => {
  const fods = (target: string) => `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2" office:mimetype="application/vnd.oasis.opendocument.spreadsheet">
<office:body><office:spreadsheet>
<table:table table:name="Sheet1">
<table:table-row><table:table-cell office:value-type="string"><text:p>date</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p>obs</text:p></table:table-cell></table:table-row>
<table:table-row><table:table-cell office:value-type="string"><text:p>2001-01-01</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="1"><text:p>1</text:p></table:table-cell></table:table-row>
<table:table-row><table:table-cell office:value-type="string"><text:p>2001-01-02</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="3"><text:p>3</text:p></table:table-cell></table:table-row>
</table:table>
<table:database-ranges><table:database-range table:name="x" table:target-range-address="${target}.A1:${target}.B3"/></table:database-ranges>
</office:spreadsheet></office:body></office:document>`;
  const targets = (): Record<string, unknown>[] => [Object, Object.prototype.toString, Object.prototype.hasOwnProperty, Object.prototype.valueOf] as unknown as Record<string, unknown>[];
  afterEach(() => { for (const o of targets()) delete o['!autofilter']; });

  it.each(['constructor', 'toString', 'hasOwnProperty', 'valueOf'])('a database range on the sheet "%s" is undone and refused', async name => {
    await expect(parseWorkbook(bufOf(fods(name)))).rejects.toThrow(/would alter the page’s own program objects/);
    for (const o of targets()) expect(Object.prototype.hasOwnProperty.call(o, '!autofilter')).toBe(false);
  });
  it('an ordinary FODS file still loads', async () => {
    const t = await parseWorkbook(bufOf(fods('Sheet1')));
    expect(t.rows).toEqual([['2001-01-01', 1], ['2001-01-02', 3]]);
  });
});

describe('ingest-08-unrecognised-bracket: header units', () => {
  it('the unit comes from the flow columns only: "P [mm]" next to two "[cfs]" columns', () => {
    const h = ['date', 'P [mm]', 'Q_obs [cfs]', 'Q_sim [cfs]'];
    expect(unitFromHeader(h, [2, 3])).toEqual({ unit: 'cfs', note: 'Discharge unit set to ft³/s (cfs) from the column headers.' });
    expect(unitFromHeader(h).unit).toBeNull();                 // all columns: two units, so the user decides
  });
  it('a bracket the tool does not know gives a note and not a silent m³/s', () => {
    for (const u of ['kcfs', 'm3/h', 'in']) {
      expect(unitFromHeader(['date', `obs [${u}]`, `sim [${u}]`])).toEqual({ unit: null,
        note: `The unit “[${u}]” in the column headers is not a unit the tool knows, so the Discharge unit is set to m³/s. Check it.` });
    }
    const mixed = unitFromHeader(['date', 'obs [cfs]', 'sim [kcfs]']);
    expect(mixed.unit).toBe('cfs');
    expect(mixed.note).toBe('Discharge unit set to ft³/s (cfs) from the column headers. The unit “[kcfs]” in the column headers is not a unit the tool knows; make sure that column is also in ft³/s (cfs).');
  });
  it('mm/d, mm/day, mm h-1 and cusec are recognised', () => {
    for (const [u, per] of [['mm/d', '1 day'], ['mm/day', '1 day'], ['mm d-1', '1 day'], ['mm/h', '1 hour'], ['mm h-1', '1 hour']]) {
      expect(unitFromHeader(['date', `obs [${u}]`, `sim [${u}]`])).toEqual({ unit: 'mm_step',
        note: `Discharge unit set to mm / interval from the column headers. The tool reads “[${u}]” as mm per time step, which is correct only for a time step of ${per}.` });
    }
    expect(unitFromHeader(['date', 'obs [cusec]', 'sim [cusec]']).unit).toBe('cfs');
  });
});

describe('ingest-10-token-message: every missing-value text is named', () => {
  it('NA, n/a, -, NaN, --, NULL are all listed', () => {
    const cells = ['NA', 'n/a', '-', 'NaN', '--', 'NULL'];
    const s = st(['date,obs,sim', ...cells.map((c, i) => `${iso(i)},${c},${i}`), `${iso(6)},1,1`, `${iso(7)},2,2`].join('\n'));
    expect(s.validation.warnings).toContain('Column “obs”: 6 cells hold “NA”, “n/a”, “-”, “NaN”, “--”, “NULL” and are treated as missing.');
  });
  it('more than eight different texts: the rest are counted accurately', () => {
    const cells = ['NA', 'na', 'Na', 'nA', 'NaN', 'nan', 'NAN', 'null', 'NULL', 'Null', '-', '-'];
    const s = st(['date,obs,sim', ...cells.map((c, i) => `${iso(i)},${c},${i}`), `${iso(12)},1,1`, `${iso(13)},2,2`].join('\n'));
    expect(s.validation.warnings).toContain('Column “obs”: 12 cells hold “NA”, “na”, “Na”, “nA”, “NaN”, “nan”, “NAN”, “null” and 3 other missing-value texts, and are treated as missing.');
  });
});
