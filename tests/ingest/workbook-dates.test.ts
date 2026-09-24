/** Audit ingest-04 (XLSX date-times went through the viewer's local time zone
 *  and lost their seconds) and ingest-06 (1904 date-system workbooks were
 *  read 1,462 days early). Serial numbers carry no zone, so the result must
 *  be the same in every zone; the tests run in zones with DST changes. */
import { describe, it, expect, afterAll } from 'vitest'
import * as XLSX from 'xlsx'
import { parseWorkbook, stage, excelSerialToMs } from '../../src/ingest/ingest'

const TZ0 = process.env.TZ;
afterAll(() => { if (TZ0 === undefined) delete process.env.TZ; else process.env.TZ = TZ0; });
const ZONES = ['America/New_York', 'Europe/Berlin', 'America/Santiago', 'Australia/Lord_Howe', 'UTC'];

const serialOf = (utcMs: number) => utcMs / 86_400_000 + 25569;
const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ').replace(/:00$/, '');
function book(serials: number[], fmt: string, date1904 = false): ArrayBuffer {
  const ws: XLSX.WorkSheet = { A1: { t: 's', v: 'date' }, B1: { t: 's', v: 'obs' }, C1: { t: 's', v: 'sim' } };
  serials.forEach((s, i) => {
    ws[`A${i + 2}`] = { t: 'n', v: s, z: fmt };
    ws[`B${i + 2}`] = { t: 'n', v: 10 * i };
    ws[`C${i + 2}`] = { t: 'n', v: 10 * i + 1 };
  });
  ws['!ref'] = `A1:C${serials.length + 1}`;
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'D');
  if (date1904) (wb as any).Workbook = { ...(wb as any).Workbook, WBProps: { date1904: true } };
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}

describe('ingest-04: workbook date-times are zone-free and keep their seconds', () => {
  it.each(ZONES)('hourly stamps across the US and EU spring-forward days (TZ=%s)', async zone => {
    process.env.TZ = zone;
    for (const start of [Date.UTC(2020, 2, 8), Date.UTC(2020, 2, 29)]) {
      const hrs = [0, 1, 2, 3, 4].map(h => start + h * 3_600_000);
      const t = await parseWorkbook(book(hrs.map(serialOf), 'yyyy-mm-dd hh:mm'));
      expect(t.rows.map(r => r[0])).toEqual(hrs.map(stamp));
      const s = stage(t, { name: 'x', unit: 'm3s', dateFormat: 'auto', missingValue: null, roles: ['date', 'observed', 'run'] });
      expect(s.commit!.dates).toEqual(hrs);
      expect(Array.from(s.commit!.observed.values)).toEqual([0, 10, 20, 30, 40]);
      expect(s.validation.warnings.filter(w => /duplicate/.test(w))).toEqual([]);
    }
  });
  it.each(ZONES)('daily stamps across Chile\'s midnight DST change stay at 00:00 (TZ=%s)', async zone => {
    process.env.TZ = zone;
    const days = [4, 5, 6, 7, 8].map(d => Date.UTC(2020, 8, d));
    const t = await parseWorkbook(book(days.map(serialOf), 'yyyy-mm-dd'));
    expect(t.rows.map(r => r[0])).toEqual(days.map(stamp));
  });
  it('30-second logger data keeps every row and a 30 s step', async () => {
    process.env.TZ = 'America/New_York';
    const ts = [0, 1, 2, 3, 4, 5].map(k => Date.UTC(2020, 5, 1, 12) + k * 30_000);
    const t = await parseWorkbook(book(ts.map(serialOf), 'yyyy-mm-dd hh:mm:ss'));
    expect(t.rows.map(r => r[0])).toEqual(['2020-06-01 12:00', '2020-06-01 12:00:30', '2020-06-01 12:01', '2020-06-01 12:01:30', '2020-06-01 12:02', '2020-06-01 12:02:30']);
    const s = stage(t, { name: 'x', unit: 'm3s', dateFormat: 'auto', missingValue: null, roles: ['date', 'observed', 'run'] });
    expect(s.commit!.dates).toEqual(ts);
    expect(s.validation.step?.irregular).toBe(false);
    expect(s.validation.step?.ms).toBe(30_000);
  });
  it('numbers without a date format stay numbers; error and boolean cells are reported, not dropped', async () => {
    const ws: XLSX.WorkSheet = {
      A1: { t: 's', v: 'date' }, B1: { t: 's', v: 'obs' }, C1: { t: 's', v: 'sim' },
      A2: { t: 's', v: '2020-01-01' }, B2: { t: 'n', v: 12.345 }, C2: { t: 'n', v: 1 },
      A3: { t: 's', v: '2020-01-02' }, B3: { t: 'e', v: 0x2a, w: '#N/A' }, C3: { t: 'n', v: 2 },
      A4: { t: 's', v: '2020-01-03' }, B4: { t: 's', v: '0,5' }, C4: { t: 'n', v: 3 },
      A5: { t: 's', v: '2020-01-04' }, B5: { t: 'n', v: 4 }, C5: { t: 'n', v: 4 },
      '!ref': 'A1:C5',
    };
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'D');
    const t = await parseWorkbook(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
    expect(t.rows.map(r => r[1])).toEqual([12.345, '#N/A', '0,5', 4]);
    const s = stage(t, { name: 'x', unit: 'm3s', dateFormat: 'auto', missingValue: null, roles: ['date', 'observed', 'run'] });
    // the text cell "0,5" makes the column comma-decimal; the NUMBER 12.345 is not re-read as 12345
    expect(Array.from(s.commit!.observed.values).map(v => (Number.isNaN(v) ? null : v))).toEqual([12.345, null, 0.5, 4]);
    expect(s.validation.warnings).toContain('Column “obs”: 1 cell could not be read as a number (e.g. “#N/A”) and is treated as missing.');
  });
});

describe('ingest-06: the 1904 date system', () => {
  it('serial 42369 in a date1904 workbook is 2020-01-01; 42370.5 is 2020-01-02 12:00', async () => {
    const t = await parseWorkbook(book([42369, 42370.5], 'yyyy-mm-dd hh:mm', true));
    expect(t.rows.map(r => r[0])).toEqual(['2020-01-01 00:00', '2020-01-02 12:00']);
  });
  it('the 1900 system, including Excel\'s fictitious 1900-02-29 (serial 60)', () => {
    expect(excelSerialToMs(43831)).toBe(Date.UTC(2020, 0, 1));
    expect(excelSerialToMs(61)).toBe(Date.UTC(1900, 2, 1));
    expect(excelSerialToMs(59)).toBe(Date.UTC(1900, 1, 28));
    expect(excelSerialToMs(1)).toBe(Date.UTC(1900, 0, 1));
    expect(excelSerialToMs(60)).toBeNaN();
    expect(excelSerialToMs(0, true)).toBe(Date.UTC(1904, 0, 1));
  });
});
