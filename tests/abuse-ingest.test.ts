/** AGENT B — ingest abuse battery. QA-005 (decimal comma) and QA-006 (unsorted /
 *  duplicated dates) are S1 silent-wrongness defects; the rest probe graceful
 *  degradation. */
import { describe, it, expect } from 'vitest'
import { parseValue } from '../src/ingest/missing'
import { parseDelimited, stage } from '../src/ingest/ingest'
import { useApp } from '../src/store/store'
import { computeForRun, __resetComputeCachesForTests } from '../src/ui/compute'

describe('QA-005 numeric cell parsing (S1: silent wrong values)', () => {
  const cases: [string, number][] = [
    ['3,5', 3.5],          // European decimal comma — was parsed as 35
    ['12,34', 12.34],
    ['1,234', 1234],       // anglophone thousands
    ['1,234.5', 1234.5],   // thousands + dot decimal
    ['1.234,5', 1234.5],   // dot thousands + comma decimal
    ['1,234,567', 1234567],
    ['1e-3', 0.001],
    ['-2.5', -2.5],
    ['  7 ', 7],
  ];
  for (const [s, v] of cases) {
    it(`parses ${JSON.stringify(s)} as ${v}`, () => expect(parseValue(s, { sentinels: true })).toBeCloseTo(v, 10));
  }
  for (const bad of ['1,23,45', 'abc', '', '--5', '1.2.3']) {
    it(`rejects ${JSON.stringify(bad)} as NaN`, () => expect(Number.isNaN(parseValue(bad, { sentinels: true }))).toBe(true));
  }
  it('keeps sentinels', () => {
    expect(Number.isNaN(parseValue('-9999', { sentinels: true }))).toBe(true);
    expect(parseValue('-9999', { sentinels: false })).toBe(-9999);
  });
});

describe('QA-006 dates: unsorted / duplicated input (S1: silent wrong timing)', () => {
  const mk = (rows: string[]) => stage(parseDelimited(['date,observed,m'].concat(rows).join('\n')),
    { name: 'd', unit: 'm3s', dateFormat: 'auto', sentinels: true, roles: ['date', 'observed', 'run'] });

  it('commit sorts rows jointly by date', () => {
    __resetComputeCachesForTests();
    const shuffled = mk(['2001-01-03,3,3', '2001-01-01,1,1', '2001-01-04,4,4', '2001-01-02,2,2']);
    expect(shuffled.commit).toBeTruthy();
    const id = useApp.getState().commitDataset(shuffled.commit!);
    const ds = useApp.getState().project.datasets.find(d => d.id === id)!;
    expect(ds.dates).toEqual([...ds.dates].sort((a, b) => a - b));
    expect(Array.from(ds.observed.values as number[])).toEqual([1, 2, 3, 4]); // values moved WITH their dates
    expect(Array.from(ds.runs[0].values as number[])).toEqual([1, 2, 3, 4]);
  });

  it('duplicate timestamps keep the first occurrence, as the validator promises', () => {
    const dup = mk(['2001-01-01,1,1', '2001-01-02,2,2', '2001-01-02,99,99', '2001-01-03,3,3']);
    const id = useApp.getState().commitDataset(dup.commit!);
    const ds = useApp.getState().project.datasets.find(d => d.id === id)!;
    expect(ds.dates.length).toBe(3);
    expect(Array.from(ds.observed.values as number[])).toEqual([1, 2, 3]);
  });

  it('metrics identical for sorted vs shuffled input (order must not matter)', () => {
    __resetComputeCachesForTests();
    const n = 40;
    const rows = Array.from({ length: n }, (_, i) =>
      `${new Date(Date.UTC(2001, 0, 1) + i * 864e5).toISOString().slice(0, 10)},${5 + Math.sin(i / 4)},${5 + Math.sin((i - 2) / 4)}`);
    const shuffled = [...rows].sort(() => Math.random() - 0.5);
    const a = useApp.getState().commitDataset(mk(rows).commit!);
    const b = useApp.getState().commitDataset(mk(shuffled).commit!);
    const S = useApp.getState().project.datasets;
    const oa = computeForRun(S.find(d => d.id === a)!, S.find(d => d.id === a)!.runs[0]);
    const ob = computeForRun(S.find(d => d.id === b)!, S.find(d => d.id === b)!.runs[0]);
    expect(ob.values.nse).toBeCloseTo(oa.values.nse, 12);
    expect(ob.values.peak_lag_abs).toBeCloseTo(oa.values.peak_lag_abs, 12);
    expect(ob.values.dtw_dist).toBeCloseTo(oa.values.dtw_dist, 12);
  });
});
