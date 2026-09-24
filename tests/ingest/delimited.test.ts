/** Audit ingest-03 (an unterminated quote silently truncated the file),
 *  ingest-05 (trim() ate the leading TAB of a TSV header, shifting every
 *  column name) and ingest-09 (delimiter-only rows blocked the dataset with a
 *  misleading date-format error). */
import { describe, it, expect } from 'vitest'
import { parseDelimited, stage } from '../../src/ingest/ingest'

const iso = (i: number) => new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10);

describe('ingest-03: a broken quote refuses the file and names the line', () => {
  it('100 rows with one unterminated quote in an ignored remarks column', () => {
    const lines = ['date,obs,sim,remark'];
    for (let i = 0; i < 100; i++) lines.push(`${iso(i)},${i},${i + 1},${i === 10 ? '"estimated' : ''}`);
    expect(() => parseDelimited(lines.join('\n'))).toThrow(/^Line 12 of the file has a double quote \(“?"”?\) that opens a quoted cell which is not closed correctly/);
  });
  it('CRLF text, blank lines before the quote, and a quote followed by text', () => {
    expect(() => parseDelimited('date,obs,sim,remark\r\n\r\n2020-01-01,1,2,\r\n2020-01-02,2,3,"ice\r\n2020-01-03,3,4,\r\n'))
      .toThrow(/^Line 4 /);
    expect(() => parseDelimited('date,obs,sim\n2020-01-01,"1"x,2\n2020-01-02,2,3')).toThrow(/^Line 2 /);
  });
  it('properly quoted cells, quoted line breaks and inch marks inside a cell still load', () => {
    const t = parseDelimited('date,obs,rem\n2020-01-01,"1,5","a\nb"\n2020-01-02,2,5" rain\n2020-01-03,3,x');
    expect(t.rows).toEqual([['2020-01-01', '1,5', 'a\nb'], ['2020-01-02', '2', '5" rain'], ['2020-01-03', '3', 'x']]);
  });
});

describe('ingest-05: an empty first header cell is kept', () => {
  it('pandas to_csv(sep="\\t") with an unnamed index', () => {
    const t = parseDelimited('\tobs\tsim1\tsim2\r\n2020-01-01\t1.0\t1.1\t0.9\r\n2020-01-02\t2.0\t2.1\t1.9\r\n2020-01-03\t3.0\t3.1\t2.9\r\n');
    expect(t.header).toEqual(['', 'obs', 'sim1', 'sim2']);
    expect(t.rows[0]).toEqual(['2020-01-01', '1.0', '1.1', '0.9']);
    const s = stage(t, { name: 'x', unit: 'm3s', dateFormat: 'auto', missingValue: null, roles: ['date', 'observed', 'run', 'run'] });
    expect(s.commit!.observed.name).toBe('obs');
    expect(Array.from(s.commit!.observed.values)).toEqual([1, 2, 3]);
    expect(s.commit!.runs.map(r => [r.name, Array.from(r.values)])).toEqual([['sim1', [1.1, 2.1, 3.1]], ['sim2', [0.9, 1.9, 2.9]]]);
  });
  it('a byte-order mark and leading blank lines are still removed', () => {
    const t = parseDelimited(String.fromCharCode(0xFEFF) + '\n\n  \ndate,obs\n2020-01-01,1\n');
    expect(t.header).toEqual(['date', 'obs']);
    expect(t.rows).toEqual([['2020-01-01', '1']]);
  });
});

describe('ingest-09: rows holding only delimiters are dropped like blank lines', () => {
  it('trailing ",," rows from an Excel CSV export', () => {
    const t = parseDelimited('date,obs,sim\n2020-01-01,1,2\n2020-01-02,2,3\n2020-01-03,3,4\n,,\n,,\n');
    expect(t.rows.length).toBe(3);
    const s = stage(t, { name: 'x', unit: 'm3s', dateFormat: 'auto', missingValue: null, roles: ['date', 'observed', 'run'] });
    expect(s.validation.errors).toEqual([]);
    expect(s.commit).not.toBeNull();
  });
  it('";;" rows in a semicolon file and whitespace-only rows in between', () => {
    const t = parseDelimited('d;o;s\n2020-01-01;1;2\n;;\n \n2020-01-02;2;3\n; ;\n');
    expect(t.rows).toEqual([['2020-01-01', '1', '2'], ['2020-01-02', '2', '3']]);
  });
});
