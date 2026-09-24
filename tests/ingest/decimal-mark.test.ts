/** Audit ingest-01 (decimal commas with exactly three decimals were read as
 *  thousands, x1000, decided per column without a word) and ingest-10
 *  (malformed numbers and missing-value tokens became missing silently;
 *  French space-grouped numbers lost exactly the peaks). */
import { describe, it, expect, beforeEach } from 'vitest'
import { parseDelimited, stage, type ColumnRole } from '../../src/ingest/ingest'
import { parseValue, detectCommaDecimal, parseNumericCell, readBoth } from '../../src/ingest/missing'
import type { DecimalMark } from '../../src/ingest/missing'
import { useApp } from '../../src/store/store'
import { computeForRun, __resetComputeCachesForTests } from '../../src/ui/compute'

const ROLES3: ColumnRole[] = ['date', 'observed', 'run'];
const st = (txt: string, opts: { roles?: ColumnRole[]; mv?: number | null; mark?: DecimalMark } = {}) =>
  stage(parseDelimited(txt), { name: 'x', unit: 'm3s', dateFormat: 'auto', missingValue: opts.mv ?? null, roles: opts.roles ?? ROLES3, decimalMark: opts.mark });
const NBSP = String.fromCharCode(0xA0), NNBSP = String.fromCharCode(0x202F);

describe('ingest-01: a decimal comma with three decimals is not a thousands group', () => {
  it('"0,125" and "-0,500" cannot be thousands groups (a group never starts with 0)', () => {
    expect(parseValue('0,125', {})).toBeCloseTo(0.125, 12);
    expect(parseValue('-0,500', {})).toBeCloseTo(-0.5, 12);
    expect(parseValue('1234,567', {})).toBeCloseTo(1234.567, 12);    // a first group has at most 3 digits
    expect(parseValue('0.500', { commaDecimal: true })).toBeCloseTo(0.5, 12);
  });

  it('the audit file: obs with 3 decimals, sim with 2, semicolon-delimited; NSE matches numpy', () => {
    __resetComputeCachesForTests();
    const obs = [12.345, 0.875, 3.25, 4.0, 5.125, 6.5, 7.75, 8.0, 9.625, 10.5];
    const sim = [11.98, 0.91, 3.4, 4.1, 5.0, 6.62, 7.7, 8.15, 9.5, 10.4];
    const lines = ['Datum;Q_obs;Q_sim'];
    obs.forEach((o, i) => lines.push(`${i + 10}.01.2020;${o.toFixed(3).replace('.', ',')};${sim[i].toFixed(2).replace('.', ',')}`));
    const s = st(lines.join('\n'));
    expect(s.validation.errors).toEqual([]);
    expect(Array.from(s.commit!.observed.values)).toEqual(obs);
    expect(Array.from(s.commit!.runs[0].values)).toEqual(sim);
    const id = useApp.getState().commitDataset(s.commit!);
    const ds = useApp.getState().project.datasets.find(d => d.id === id)!;
    expect(computeForRun(ds, ds.runs[0]).values.nse).toBeCloseTo(0.997813, 6);   // numpy (scratch/ingest/recompute.py)
  });

  it('a column with three decimals everywhere follows the file: the other value column has "11,98"', () => {
    const s = st('Datum;Q_obs;Q_sim\n10.01.2020;12,345;11,98\n11.01.2020;1,250;1,91\n13.01.2020;3,250;3,40');
    expect(Array.from(s.commit!.observed.values)).toEqual([12.345, 1.25, 3.25]);
  });

  it('a declared sentinel written "-999,000" is masked', () => {
    const s = st('Datum;Q_obs;Q_sim\n10.01.2020;12,345;11,98\n11.01.2020;-999,000;0,91\n13.01.2020;3,250;3,40', { mv: -999 });
    expect(Number.isNaN(s.commit!.observed.values[1])).toBe(true);
    expect(s.commit!.observed.values[0]).toBeCloseTo(12.345, 12);
  });

  it('in a comma-decimal column a lone dot is a thousands mark: "1.234" is 1234', () => {
    const rows = [['0,5'], ['1.234'], ['2,25']];
    expect(detectCommaDecimal(rows, 0)).toBe(true);
    expect(parseValue('1.234', { commaDecimal: detectCommaDecimal(rows, 0) })).toBe(1234);
    const s = st('d;o;s\n2020-01-01;0,5;1\n2020-01-02;1.234;2\n2020-01-03;2,25;3');
    expect(Array.from(s.commit!.observed.values)).toEqual([0.5, 1234, 2.25]);
  });

  it('when nothing in the file decides, the tool asks instead of guessing x1000', () => {
    const txt = 'Datum;Abfluss;Modell\n01.01.2020;12,345;1\n02.01.2020;3,250;2\n13.01.2020;4,000;3';
    const s = st(txt);
    expect(s.commit).toBeNull();
    expect(s.validation.errors).toContain('Column “Abfluss” has values such as “12,345” that read as 12345 with a decimal point or 12.345 with a decimal comma, and nothing in the file shows which is meant. Choose the decimal mark in the Decimal mark selector.');
    expect(Array.from(st(txt, { mark: 'comma' }).commit!.observed.values)).toEqual([12.345, 3.25, 4]);
    expect(Array.from(st(txt, { mark: 'point' }).commit!.observed.values)).toEqual([12345, 3250, 4000]);
  });

  it('anglophone files are unchanged: quoted thousands with decimals, and fixed three-decimal dot values', () => {
    const us = st('date,obs,sim\n2020-01-01,"1,234.5",2\n2020-01-02,"12,345",3\n2020-01-03,"1,000",4');
    expect(us.validation.errors).toEqual([]);
    expect(Array.from(us.commit!.observed.values)).toEqual([1234.5, 12345, 1000]);
    const dots = st('date,obs,sim\n2020-01-01,5.123,2.250\n2020-01-02,6.500,3.125\n2020-01-03,7.000,4.875');
    expect(dots.validation.errors).toEqual([]);
    expect(Array.from(dots.commit!.observed.values)).toEqual([5.123, 6.5, 7]);
    expect(parseValue('1,234', {})).toBe(1234);                 // single cell, no column: the old default
    expect(parseNumericCell('1,234', true)).toBeCloseTo(1.234, 12);
  });

  it('readBoth gives both readings, NaN where a mark cannot explain the cell', () => {
    expect(readBoth('1,234')).toEqual([1234, 1.234]);
    expect(readBoth('1.234,5')[0]).toBeNaN();
    expect(readBoth('1,234,567')[1]).toBeNaN();
    expect(readBoth('12')).toEqual([12, 12]);
  });
});

describe('ingest-10: malformed numbers and missing tokens are reported', () => {
  it('French grouping with a space, U+00A0 or U+202F reads in full', () => {
    const col = ['12,5', `1${NBSP}234,5`, '1 234,5', '999,5', `1${NNBSP}234,5`];
    const rows = col.map(c => [c]);
    const cd = detectCommaDecimal(rows, 0);
    expect(col.map(c => parseValue(c, { commaDecimal: cd }))).toEqual([12.5, 1234.5, 1234.5, 999.5, 1234.5]);
    const s = st(['date;obs;sim', ...col.map((c, i) => `2020-01-0${i + 1};${c};1`)].join('\n'));
    expect(Array.from(s.commit!.observed.values)).toEqual([12.5, 1234.5, 1234.5, 999.5, 1234.5]);
    expect(s.validation.warnings.filter(w => /could not be read/.test(w))).toEqual([]);
  });

  it('cells that are not numbers are counted and named, with an example', () => {
    const s = st('date,obs,sim\n2020-01-01,1.5,2\n2020-01-02,1.2.3,3\n2020-01-03,abc,4\n2020-01-04,4,x');
    expect(s.validation.warnings).toContain('Column “obs”: 2 cells could not be read as a number (e.g. “1.2.3”) and are treated as missing.');
    expect(s.validation.warnings).toContain('Column “sim”: 1 cell could not be read as a number (e.g. “x”) and is treated as missing.');
  });

  it('missing-value tokens are read as missing and reported; empty cells are not reported', () => {
    const s = st('date,obs,sim\n2020-01-01,NA,2\n2020-01-02,-,3\n2020-01-03,,4\n2020-01-04,na,5\n2020-01-05,5,6\n2020-01-06,6,7');
    expect(Array.from(s.commit!.observed.values).map(v => (Number.isNaN(v) ? null : v))).toEqual([null, null, null, null, 5, 6]);
    expect(s.validation.warnings).toContain('Column “obs”: 3 cells hold “NA”, “-”, “na” and are treated as missing.');
  });
});

beforeEach(() => { useApp.getState().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null } as any); });
