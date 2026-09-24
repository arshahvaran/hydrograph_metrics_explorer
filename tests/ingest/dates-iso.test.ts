/** Audit ingest-02 (ISO stamps were prefix-matched: one-digit hours, hour-only
 *  stamps and AM/PM lost their time without a parse failure), ingest-07 (UTC
 *  offsets were ignored, so the repeated fall-back hour was dropped) and
 *  ingest-11 (minutes and seconds out of range rolled over). */
import { describe, it, expect, beforeEach } from 'vitest'
import { parseDates } from '../../src/ingest/dateParse'
import { parseDelimited, stage } from '../../src/ingest/ingest'
import { useApp } from '../../src/store/store'
import { computeForRun, __resetComputeCachesForTests } from '../../src/ui/compute'

const U = Date.UTC;
const commitText = (txt: string) => {
  const s = stage(parseDelimited(txt), { name: 'x', unit: 'm3s', dateFormat: 'auto', missingValue: null, roles: ['date', 'observed', 'run'] });
  const id = useApp.getState().commitDataset(s.commit!);
  return { s, ds: useApp.getState().project.datasets.find(d => d.id === id)! };
};
beforeEach(() => { useApp.getState().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null } as any); });

describe('ingest-02: the whole stamp is read or the cell fails', () => {
  it('one-digit hours (Excel "yyyy-mm-dd h:mm") keep their hour in every date-format mode', () => {
    for (const f of ['auto', 'ymd', 'mdy', 'dmy'] as const) {
      const p = parseDates(['2020-01-01 1:00', '2020-01-01 9:30', '2020-01-01 13:00'], f);
      expect(p.ms, f).toEqual([U(2020, 0, 1, 1), U(2020, 0, 1, 9, 30), U(2020, 0, 1, 13)]);
      expect(p.failures).toBe(0);
    }
  });
  it('AM/PM is applied: 01:00 PM is 13:00, 12:00 AM is midnight, 12:30 PM is 12:30', () => {
    const p = parseDates(['2020-01-01 01:00 PM', '2020-01-01 12:00 AM', '2020-01-01 12:30 PM', '2020-01-01 1:15 p.m.']);
    expect(p.ms).toEqual([U(2020, 0, 1, 13), U(2020, 0, 1, 0), U(2020, 0, 1, 12, 30), U(2020, 0, 1, 13, 15)]);
    expect(parseDates(['1/2/2020 1:00 PM'], 'mdy').ms[0]).toBe(U(2020, 0, 2, 13));
    expect(parseDates(['2020-01-01 13:00 PM']).failures).toBe(1);        // no hour 13 on a 12-hour clock
  });
  it('an hour without minutes ("2020-01-01T01") is 01:00; fractions of a second are kept', () => {
    expect(parseDates(['2020-01-01T01']).ms[0]).toBe(U(2020, 0, 1, 1));
    expect(parseDates(['2020-01-01 12:00:30.250']).ms[0]).toBe(U(2020, 0, 1, 12, 0, 30, 250));
  });
  it('left-over text is a failure, not silently cut off', () => {
    const p = parseDates(['2020-01-01 01:00 foo', '2020-01-015', '2020-01-01 01:00']);
    expect(p.failures).toBe(2);
    expect(p.ambiguous).toBe(false);
    expect(p.ms[2]).toBe(U(2020, 0, 1, 1));
  });
  it('the audit file: 5 days of hourly stamps with one-digit hours commit all 120 rows; NSE matches the full record', () => {
    __resetComputeCachesForTests();
    const lines = ['date,obs,sim'];
    const o: number[] = [], s: number[] = [];
    for (let d = 0; d < 5; d++) for (let h = 0; h < 24; h++) {
      const k = d * 24 + h;
      const ov = +(10 + 8 * Math.exp(-(((k - 40) / 6) ** 2)) + 5 * Math.exp(-(((k - 90) / 5) ** 2))).toFixed(4);
      const sv = +(10 + 7 * Math.exp(-(((k - 43) / 6) ** 2)) + 5 * Math.exp(-(((k - 92) / 5) ** 2))).toFixed(4);
      o.push(ov); s.push(sv);
      lines.push(`2020-01-0${d + 1} ${h}:00,${ov},${sv}`);
    }
    const { s: staged, ds } = commitText(lines.join('\n'));
    expect(staged.validation.warnings.filter(w => /duplicate/.test(w))).toEqual([]);
    expect(ds.dates.length).toBe(120);
    expect(ds.dates[1] - ds.dates[0]).toBe(3_600_000);
    expect(ds.step.irregular).toBe(false);
    const mo = o.reduce((a, b) => a + b, 0) / o.length;
    const nseRef = 1 - o.reduce((a, x, i) => a + (x - s[i]) ** 2, 0) / o.reduce((a, x) => a + (x - mo) ** 2, 0);
    const nse = computeForRun(ds, ds.runs[0]).values.nse;
    expect(nse).toBeCloseTo(nseRef, 10);
    expect(nse).toBeCloseTo(0.738027, 6);                               // numpy, from the audit
  });
});

describe('ingest-07: UTC offsets are applied', () => {
  it('"-04:00" and "-05:00" on the same wall-clock hour are different instants', () => {
    const p = parseDates(['2020-11-01T01:00:00-04:00', '2020-11-01T01:00:00-05:00', '2020-11-01T06:00:00Z', '2020-11-01 08:00+0200', '2020-11-01 06:00 UTC']);
    expect(p.ms).toEqual([U(2020, 10, 1, 5), U(2020, 10, 1, 6), U(2020, 10, 1, 6), U(2020, 10, 1, 6), U(2020, 10, 1, 6)]);
    expect(p.shifted).toBe(3);
    expect(p.zoned).toBe(5);
  });
  it('the pandas fall-back file keeps all 4 hours, and says the times were converted to UTC', () => {
    const { s, ds } = commitText('date,obs,sim\n2020-11-01 00:00:00-04:00,1,1\n2020-11-01 01:00:00-04:00,2,2\n2020-11-01 01:00:00-05:00,3,3\n2020-11-01 02:00:00-05:00,4,4\n');
    expect(ds.dates).toEqual([4, 5, 6, 7].map(h => U(2020, 10, 1, h)));
    expect(Array.from(ds.observed.values as number[])).toEqual([1, 2, 3, 4]);
    expect(s.validation.warnings.filter(w => /duplicate/.test(w))).toEqual([]);
    expect(s.validation.warnings).toContain('4 date-times carry a UTC offset (e.g. “2020-11-01 00:00:00-04:00”) and are converted to UTC; all times are shown in UTC.');
  });
  it('the spring-forward file has no false one-hour gap', () => {
    const { ds } = commitText('date,obs,sim\n2020-03-08 00:00:00-05:00,1,1\n2020-03-08 01:00:00-05:00,2,2\n2020-03-08 03:00:00-04:00,3,3\n2020-03-08 04:00:00-04:00,4,4\n');
    expect(ds.dates).toEqual([5, 6, 7, 8].map(h => U(2020, 2, 8, h)));
    expect(ds.step.irregular).toBe(false);
  });
});

describe('ingest-11: time fields out of range fail instead of rolling over', () => {
  it('minute 99, minute 60 and second 60 are failures', () => {
    const p = parseDates(['2020-01-01 00:99', '2020-01-01 12:60', '2020-01-01 23:59:60', '2020-01-01 25:00']);
    expect(p.failures).toBe(4);
  });
  it('24:00 exactly is the end of the day (ISO 8601:2004), anything past it fails', () => {
    expect(parseDates(['2020-01-01 24:00']).ms[0]).toBe(U(2020, 0, 2));
    expect(parseDates(['2020-01-01 24:01']).failures).toBe(1);
  });
});
