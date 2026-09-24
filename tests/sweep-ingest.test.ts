/**
 * Final sweep, ingest: a file with a workbook name is read by what it holds,
 * not by its name (the two gaps the ingest repair left).
 *  1. An RTF document named .xls went through the spreadsheet reader's RTF
 *     reader, which rewrites numbers ("12,5" -> 125); it is now refused.
 *  2. A CSV or TSV named .xls went through the spreadsheet reader, which
 *     loses the ";" cue for a decimal comma; it now goes through the tool's
 *     own text parser, as a .csv upload does.
 */
import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { parseWorkbook, sniffWorkbook, stage, type ColumnRole, type RawTable } from '../src/ingest/ingest'

const nums = (v: ArrayLike<number>) => Array.from(v).map(x => (Number.isNaN(x) ? null : x))
const stageT = (t: RawTable, roles: ColumnRole[] = ['date', 'observed', 'run']) =>
  stage(t, { name: 'x', unit: 'm3s', dateFormat: 'auto', missingValue: null, roles })
const bufOf = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer
const utf16le = (s: string) => {
  const b = new Uint8Array(2 + 2 * s.length)
  b[0] = 0xFF; b[1] = 0xFE
  for (let i = 0; i < s.length; i++) { b[2 + 2 * i] = s.charCodeAt(i) & 0xFF; b[3 + 2 * i] = s.charCodeAt(i) >> 8 }
  return b.buffer as ArrayBuffer
}
const sheet = () => {
  const ws: XLSX.WorkSheet = { A1: { t: 's', v: 'date' }, B1: { t: 's', v: 'obs' }, C1: { t: 's', v: 'sim' } }
  ;[['2020-01-01', 12.5, 0.125], ['2020-01-02', 13.5, 1.5], ['2020-01-03', 14, 2]].forEach((r, i) => {
    ws[`A${i + 2}`] = { t: 's', v: r[0] }; ws[`B${i + 2}`] = { t: 'n', v: r[1] }; ws[`C${i + 2}`] = { t: 'n', v: r[2] }
  })
  ws['!ref'] = 'A1:C4'
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'D')
  return wb
}

describe('1. an RTF document with a workbook name is refused, not misread', () => {
  it('the RTF that the spreadsheet library itself writes', async () => {
    const buf = XLSX.write(sheet(), { type: 'array', bookType: 'rtf' }) as ArrayBuffer
    expect(sniffWorkbook(buf).kind).toBe('rtf')
    await expect(parseWorkbook(buf)).rejects.toThrow(/RTF document \(word-processor text\), not a spreadsheet/)
  })
  it('a hand-written RTF table with decimal commas (was read as 125 and 5)', async () => {
    const rtf = '{\\rtf1\\ansi\\deff0 {\\trowd\\cellx1000\\cellx2000\\cellx3000 date\\cell obs\\cell sim\\cell\\row}'
      + '{\\trowd\\cellx1000\\cellx2000\\cellx3000 2020-01-01\\cell 12,5\\cell 0,5\\cell\\row}}'
    await expect(parseWorkbook(bufOf(rtf))).rejects.toThrow(/save it as CSV or XLSX/)
  })
})

describe('2. plain text with a workbook name goes through the tool\'s own text parser', () => {
  it('a ";" CSV named .xls keeps the ";" cue: 1.250 is asked about, as in a .csv upload', async () => {
    const t = await parseWorkbook(bufOf('date;obs;sim\n2020-01-01;1.250;2.500\n2020-01-02;3.125;4.750\n2020-01-03;5.375;6.625\n'))
    expect(t.delimiter).toBe(';')
    expect(t.note).toMatch(/holds plain text, so it was read as delimited text/)
    const s = stageT(t)
    expect(s.commit).toBeNull()
    expect(s.validation.errors[0]).toMatch(/The file uses “;” between cells, which usually goes with a decimal comma/)
  })
  it('a TSV named .xlsx reads its tab-separated columns', async () => {
    const t = await parseWorkbook(bufOf('date\tobs\tsim\n2020-01-01\t12.5\t0.125\n2020-01-02\t13.5\t1.5\n'))
    expect(t.header).toEqual(['date', 'obs', 'sim'])
    expect(t.delimiter).toBe('\t')
    expect(nums(stageT(t).commit!.observed.values)).toEqual([12.5, 13.5])
  })
  it('a UTF-16 CSV with a byte-order mark (Excel "Unicode text") is read as text', async () => {
    const buf = utf16le('date,obs,sim\r\n2020-01-01,12.5,0.125\r\n2020-01-02,13.5,1.5\r\n')
    expect(sniffWorkbook(buf).kind).toBe('text')
    const t = await parseWorkbook(buf)
    expect(t.header).toEqual(['date', 'obs', 'sim'])
    expect(nums(stageT(t).commit!.runs[0].values)).toEqual([0.125, 1.5])
  })
  it('an over-size text table is refused with the delimited-text limit message', async () => {
    const rows = ['a,b'].concat(Array.from({ length: 1_000_001 }, () => '1,2')).join('\n')
    await expect(parseWorkbook(bufOf(rows))).rejects.toThrow(/data rows; the tool accepts up to 1,000,000/)
  })
})

describe('3. real workbooks and markup keep the spreadsheet reader', () => {
  it('binary, zipped and XML workbooks, SYLK and DIF are sniffed as workbook or markup and give typed numbers', async () => {
    for (const bookType of ['xlsx', 'xlsb', 'biff8', 'biff5', 'biff2', 'ods', 'xlml', 'fods', 'sylk', 'dif', 'html'] as const) {
      const buf = XLSX.write(sheet(), { type: 'array', bookType }) as ArrayBuffer
      const kind = sniffWorkbook(buf).kind
      expect(['workbook', 'markup'], bookType).toContain(kind)
      const t = await parseWorkbook(buf)
      expect(t.note ?? '', bookType).not.toMatch(/holds plain text/)
      expect(t.rows.length, bookType).toBe(3)
    }
  })
  it('text that does not split into columns still goes to the spreadsheet reader', async () => {
    const t = await parseWorkbook(bufOf('just one line of text\n'))
    expect(t.note ?? '').not.toMatch(/holds plain text/)
  })
})
