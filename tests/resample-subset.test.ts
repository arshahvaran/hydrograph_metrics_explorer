/**
 * Audit fixes for the Plots-tab subset (window / season / resample) and the
 * "Use this data" commit path. DESIGN.md D5 (resampling pairs obs and each
 * simulation over the same steps; depth-per-step data are summed) and D1
 * (a seasonal subset keeps its time axis: out-of-season steps stay as gaps).
 * Finding ids: compute-02, compute-03, subset-01..05, subset-07, subset-08,
 * units-01, project-02.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useApp } from '../src/store/store'
import { applySubset, calendarDoy } from '../src/metrics/subset'
import { computeAll } from '../src/metrics/registry'
import { benchmarkSeries } from '../src/metrics/classical/catalogue'
import { computeForRun, subsetFrameFor, __resetComputeCachesForTests } from '../src/ui/compute'
import { defaultTimingConfig } from '../src/types'

const H = 3_600_000, DAY = 86_400_000;
const S = () => useApp.getState();
const active = () => S().project.datasets.find(d => d.id === S().project.activeDatasetId)!;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const uiMs = (s: string) => Date.parse(s + 'T00:00:00Z'); // what the date inputs produce
const daily = (y0: number, m0: number, d0: number, n: number) => Array.from({ length: n }, (_, i) => Date.UTC(y0, m0, d0) + i * DAY);
const vals = (a: ArrayLike<number>) => Array.from(a);

beforeEach(() => {
  __resetComputeCachesForTests();
  S().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null });
});

describe('compute-02 / subset-01: resampling pairs obs and sim over the same steps (D5)', () => {
  // 2001 daily; obs = 10 + day of month with days 1-15 missing; sim = the complete truth.
  const dates = daily(2001, 0, 1, 365);
  const truth = dates.map(d => 10 + new Date(d).getUTCDate());
  const obsGap = truth.map((v, i) => (new Date(dates[i]).getUTCDate() <= 15 ? NaN : v));

  it('applySubset: each monthly sim mean covers exactly the days the obs mean covers', () => {
    const r = applySubset(dates, [obsGap, truth], { window: null, season: null, resample: 'monthly' }, { ms: DAY, label: '1d' });
    expect(r.dates.length).toBe(12);
    for (let b = 0; b < 12; b++) expect(r.sims[0][b]).toBeCloseTo(r.obs[b], 12);
    expect(r.obs[0]).toBeCloseTo((26 + 41) / 2, 12);  // Jan 16..31 of 10 + day
  });

  it('flood days missing from obs no longer bias the monthly pairs (compute-02 repro)', () => {
    const d2 = daily(2001, 0, 1, 730);
    const t2 = d2.map(d => { const dd = new Date(d).getUTCDate(); return 10 + (dd >= 10 && dd <= 14 ? 90 : 0); });
    const o2 = t2.map((v, i) => { const dd = new Date(d2[i]).getUTCDate(); return dd >= 11 && dd <= 14 ? NaN : v; });
    const r = applySubset(d2, [o2, t2], { window: null, season: null, resample: 'monthly' }, { ms: DAY, label: '1d' });
    const out = computeAll(r.obs, r.sims[0], { nanPolicy: 'pairwise', transform: 'none', timing: defaultTimingConfig(30 * DAY, r.dates.length), heavy: false });
    expect(out.values.nse).toBeCloseTo(1, 12);
    expect(out.values.pbias).toBeCloseTo(0, 12);
    expect(out.values.rmse).toBeCloseTo(0, 12);
  });

  it('committed dataset and Plots preview both give NSE 1, PBIAS 0, KGE 1 for a perfect simulation', () => {
    S().commitDataset({ name: 'gap', dates, observed: { name: 'obs', values: obsGap, unit: 'm3s' }, runs: [{ name: 'perfect', values: truth, unit: 'm3s' }] });
    S().updateView({ resample: 'monthly' });
    const pre = subsetFrameFor(active());
    const preOut = computeAll(pre.obs, pre.apply(active().runs[0].values), { nanPolicy: 'pairwise', transform: 'none', timing: active().view.timingConfig, heavy: false });
    expect(preOut.values.nse).toBeCloseTo(1, 12);
    expect(preOut.values.pbias).toBeCloseTo(0, 12);
    S().commitSubsetDataset();
    const sub = active();
    const got = computeForRun(sub, sub.runs[0]);
    expect(got.n).toBe(12);
    expect(got.values.nse).toBeCloseTo(1, 12);
    expect(got.values.pbias).toBeCloseTo(0, 12);
    expect(got.values.kge2009).toBeCloseTo(1, 12);
  });

  it('a simulation missing a step the obs has leaves that bin empty instead of mixing different days', () => {
    const obs = dates.map(() => 5);
    const sim = dates.map((_, i) => (i === 4 ? NaN : 5 + (i < 31 ? i : 0)));
    const r = applySubset(dates, [obs, sim], { window: null, season: null, resample: 'monthly' }, { ms: DAY, label: '1d' });
    expect(r.obs[0]).toBe(5);
    expect(Number.isNaN(r.sims[0][0])).toBe(true);   // January: sim lacks Jan 5
    expect(r.sims[0][1]).toBe(5);                   // February complete
  });
});

describe('compute-03 / subset-02 / units-01: depth per interval is summed on resampling (D5)', () => {
  it('hourly mm/interval -> daily totals; converting the subset gives the native flow', () => {
    const dates = Array.from({ length: 72 }, (_, i) => Date.UTC(2001, 0, 1) + i * H);
    S().commitDataset({ name: 'depth', dates, observed: { name: 'obs', values: dates.map(() => 1), unit: 'mm_step' }, runs: [{ name: 'sim', values: dates.map(() => 0.5), unit: 'mm_step' }] });
    S().setArea(100, 'km2');
    S().updateView({ resample: 'daily' });
    expect(subsetFrameFor(active()).caption).toContain('daily totals');
    S().commitSubsetDataset();
    const sub = active();
    expect(sub.name).toContain('daily totals');
    expect(sub.step).toEqual({ ms: DAY, label: '1d', irregular: false });
    expect(vals(sub.observed.values)).toEqual([24, 24, 24]);
    expect(vals(sub.runs[0].values)).toEqual([12, 12, 12]);
    expect(S().convertUnits('m3s')).toBeNull();
    for (const q of vals(active().observed.values)) expect(q).toBeCloseTo(24 * 100 * 1000 / 86400, 9); // 27.7778
  });

  it('daily mm/interval -> monthly totals (62 and 56 mm), converted to 2.3148 m3/s', () => {
    const dates = daily(2001, 0, 1, 59);
    S().commitDataset({ name: 'depthd', dates, observed: { name: 'obs', values: dates.map(() => 2), unit: 'mm_step' }, runs: [{ name: 'sim', values: dates.map(() => 2), unit: 'mm_step' }] });
    S().setArea(100, 'km2');
    S().updateView({ resample: 'monthly' });
    S().commitSubsetDataset();
    expect(vals(active().observed.values)).toEqual([62, 56]);
    S().convertUnits('m3s');
    for (const q of vals(active().observed.values)) expect(q).toBeCloseTo(2 * 100 * 1000 / 86400, 9);
  });

  it('a bin with missing steps is scaled from the mean rate of its valid steps', () => {
    const dates = Array.from({ length: 48 }, (_, i) => Date.UTC(2001, 0, 1) + i * H);
    const obs = dates.map((_, i) => (i === 3 ? NaN : 1));
    const r = applySubset(dates, [obs], { window: null, season: null, resample: 'daily' }, { ms: H, label: '1h' }, { perStepDepth: true });
    expect(vals(r.obs)).toEqual([24, 24]);
  });

  it('flow rates are still averaged', () => {
    const dates = Array.from({ length: 48 }, (_, i) => Date.UTC(2001, 0, 1) + i * H);
    const r = applySubset(dates, [dates.map(() => 3)], { window: null, season: null, resample: 'daily' }, { ms: H, label: '1h' });
    expect(vals(r.obs)).toEqual([3, 3]);
    expect(r.caption).toBe('daily means');
  });
});

describe('subset-03: the window end date is included through the end of that day', () => {
  it('hourly record: 3 whole days (72 steps) and correct daily means', () => {
    const dates = Array.from({ length: 240 }, (_, i) => Date.UTC(2001, 0, 1) + i * H);
    const v = dates.map((_, i) => i);
    const view = { window: [uiMs('2001-01-03'), uiMs('2001-01-05')] as [number, number], season: null, resample: 'native' as const };
    const r = applySubset(dates, [v], view, { ms: H, label: '1h' });
    expect(r.dates.length).toBe(72);
    expect(new Date(r.dates[71]).toISOString()).toBe('2001-01-05T23:00:00.000Z');
    expect(r.caption).toContain('window 2001-01-03–2001-01-05');
    const rd = applySubset(dates, [v], { ...view, resample: 'daily' }, { ms: H, label: '1h' });
    expect(vals(rd.obs)).toEqual([59.5, 83.5, 107.5]);
  });

  it('daily record stamped 09:00 keeps the end day', () => {
    const dates = Array.from({ length: 10 }, (_, i) => Date.UTC(2001, 0, 1, 9) + i * DAY);
    const r = applySubset(dates, [dates.map((_, i) => i)], { window: [uiMs('2001-01-03'), uiMs('2001-01-05')], season: null, resample: 'native' }, { ms: DAY, label: '1d' });
    expect(r.dates.map(iso)).toEqual(['2001-01-03', '2001-01-04', '2001-01-05']);
  });
});

describe('subset-04: a seasonal subset keeps the time axis; seasons are not joined (D1)', () => {
  const dates = daily(2001, 0, 1, 730);

  it('out-of-season steps stay in the frame as gaps, so step indices are true time', () => {
    const v = dates.map((_, i) => i);
    const r = applySubset(dates, [v], { window: null, season: { startDoy: 305, endDoy: 59 }, resample: 'native' }, { ms: DAY, label: '1d' });
    for (let i = 1; i < r.dates.length; i++) expect(r.dates[i] - r.dates[i - 1]).toBe(DAY);
    const k = r.dates.indexOf(Date.UTC(2001, 10, 1));
    expect(r.obs[k]).toBe(304);
    expect(Number.isNaN(r.obs[k - 1])).toBe(true);        // 2001-10-31 is out of season
    expect(r.shown).toBe(2 * (59 + 61));
    expect(r.caption).toMatch(/gaps/);
  });

  it('committed subset: persistence does not forecast Nov 1 from Feb 28; pairs keep their true step distance', () => {
    const obs = dates.map(d => (iso(d) === '2001-02-26' ? 10 : 1));
    const sim = dates.map(d => (iso(d) === '2001-11-01' ? 10 : 1));
    S().commitDataset({ name: 'seam', dates, observed: { name: 'obs', values: obs, unit: 'm3s' }, runs: [{ name: 'sim', values: sim, unit: 'm3s' }] });
    S().updateView({ season: { startDoy: 305, endDoy: 59 } });
    S().commitSubsetDataset();
    const sub = active();
    const k = sub.dates.indexOf(Date.UTC(2001, 10, 1));
    const pers = benchmarkSeries(sub.observed.values as number[], 'persistence', sub.dates);
    expect(Number.isNaN(pers[k])).toBe(true);
    const out = computeForRun(sub, sub.runs[0]);
    const idx = out.pairedIndex!;
    const p = idx.findIndex(i => iso(sub.dates[i]) === '2001-02-28');
    expect(iso(sub.dates[idx[p + 1]])).toBe('2001-11-01');
    expect(idx[p + 1] - idx[p]).toBe(246);                  // 246 days, not one step
  });
});

describe('subset-05: seasons select the same calendar days in leap years', () => {
  const dates = daily(2003, 0, 1, 3 * 365 + 1); // 2003-01-01 .. 2005-12-31
  const keptDays = (season: { startDoy: number; endDoy: number }) => {
    const r = applySubset(dates, [dates.map(() => 1)], { window: null, season, resample: 'native' }, { ms: DAY, label: '1d' });
    return { r, kept: new Set(r.dates.filter((_, i) => isFinite(r.obs[i])).map(iso)) };
  };

  it('DOY 335-59 is 1 Dec to end of February in every year', () => {
    const { r, kept } = keptDays({ startDoy: 335, endDoy: 59 });
    expect(kept.has('2003-11-30')).toBe(false);
    expect(kept.has('2004-11-30')).toBe(false);
    expect(kept.has('2004-12-01')).toBe(true);
    expect(kept.has('2004-02-29')).toBe(true);
    expect(r.caption).toContain('1 Dec–28 Feb');
  });

  it('DOY 60-90 is 1 Mar to 31 Mar in every year', () => {
    const { kept } = keptDays({ startDoy: 60, endDoy: 90 });
    const list = [...kept].sort();
    for (const y of ['2003', '2004', '2005']) {
      const ys = list.filter(s => s.startsWith(y));
      expect(ys[0]).toBe(`${y}-03-01`);
      expect(ys[ys.length - 1]).toBe(`${y}-03-31`);
    }
  });

  it('calendarDoy maps Feb 29 onto Feb 28 and Mar 1 to 60 in every year', () => {
    expect(calendarDoy(Date.UTC(2004, 1, 29))).toBe(59);
    expect(calendarDoy(Date.UTC(2004, 2, 1))).toBe(60);
    expect(calendarDoy(Date.UTC(2003, 2, 1))).toBe(60);
    expect(calendarDoy(Date.UTC(2004, 11, 31))).toBe(365);
  });
});

describe('subset-07: committed subsets keep a calendar-monthly step', () => {
  it('season-filtered monthly depth record stays 1mo; February converts with 28 days', () => {
    const dates: number[] = [];
    for (let y = 2001; y <= 2003; y++) for (let m = 0; m < 12; m++) dates.push(Date.UTC(y, m, 1));
    S().commitDataset({ name: 'mon', dates, observed: { name: 'o', values: dates.map(() => 28), unit: 'mm_step' }, runs: [{ name: 's', values: dates.map(() => 28), unit: 'mm_step' }] });
    S().setArea(100, 'km2');
    S().updateView({ season: { startDoy: 305, endDoy: 59 } });
    S().commitSubsetDataset();
    expect(active().step).toEqual({ ms: 30 * DAY, label: '1mo', irregular: false });
    S().convertUnits('m3s');
    const feb = active().dates.indexOf(Date.UTC(2001, 1, 1));
    expect((active().observed.values as number[])[feb]).toBeCloseTo(28 * 100 * 1000 / (28 * 86400), 9);
  });

  it('daily record, season + monthly resample: step 1mo, regular', () => {
    const dates = daily(2001, 0, 1, 1095);
    S().commitDataset({ name: 'd', dates, observed: { name: 'o', values: dates.map(() => 1), unit: 'm3s' }, runs: [{ name: 's', values: dates.map(() => 1), unit: 'm3s' }] });
    S().updateView({ season: { startDoy: 305, endDoy: 59 }, resample: 'monthly' });
    S().commitSubsetDataset();
    expect(active().step).toEqual({ ms: 30 * DAY, label: '1mo', irregular: false });
  });
});

describe('subset-08: a resample that cannot aggregate is a no-op, not a mislabelled "daily means"', () => {
  it('monthly record + daily resample keeps the monthly step and claims nothing', () => {
    const dates = Array.from({ length: 24 }, (_, i) => Date.UTC(2001, i, 1));
    const r = applySubset(dates, [dates.map((_, i) => i + 1)], { window: null, season: null, resample: 'daily' }, { ms: 30 * DAY, label: '1mo' });
    expect(r.step).toEqual({ ms: 30 * DAY, label: '1mo' });
    expect(r.caption).not.toMatch(/daily/);
    expect(r.resampled).toBe(false);
    expect(vals(r.obs)).toEqual(dates.map((_, i) => i + 1));
  });

  it('monthly record + monthly resample and daily record + daily resample are no-ops too', () => {
    const m = Array.from({ length: 24 }, (_, i) => Date.UTC(2001, i, 1));
    expect(applySubset(m, [m.map(() => 1)], { window: null, season: null, resample: 'monthly' }, { ms: 30 * DAY, label: '1mo' }).caption).toBe('');
    const d = daily(2001, 0, 1, 40);
    const r = applySubset(d, [d.map(() => 1)], { window: null, season: null, resample: 'daily' }, { ms: DAY, label: '1d' });
    expect(r.caption).toBe('');
    expect(r.step.label).toBe('1d');
  });
});

describe('project-02: "Use this data" carries the analysis settings', () => {
  const setup = () => {
    const dates = daily(2001, 0, 1, 900);
    const obs = dates.map((_, i) => 5 + 4 * Math.sin(i / 20));
    S().commitDataset({ name: 'full', dates, observed: { name: 'o', values: obs, unit: 'm3s' }, runs: [{ name: 'A', values: obs.map(v => v * 1.1), unit: 'm3s' }] });
    S().updateView({ benchmark: 'climatology', transform: 'sqrt', showBootstrapCIs: true });
    S().updateTiming({ eventThreshold: { kind: 'absolute', value: 12 }, peakMatchTolerance: 6, peakProminence: 2, eventMinDistance: 9, eventWarmup: 4 });
    return dates;
  };

  it('window-only subset (same step): benchmark, CI toggle and the whole timing config are kept', () => {
    const dates = setup();
    const src = active();
    S().updateView({ window: [dates[100], dates[799]] });
    S().commitSubsetDataset();
    const sub = active();
    expect(sub.view.benchmark).toBe('climatology');
    expect(sub.view.transform).toBe('sqrt');
    expect(sub.view.showBootstrapCIs).toBe(true);
    expect(sub.view.timingConfig).toEqual(src.view.timingConfig);
  });

  it('a seasonal subset uses pairwise deletion, so a zero/mean NaN policy cannot fill the out-of-season gaps', () => {
    setup();
    S().updateView({ nanPolicy: 'zero', season: { startDoy: 305, endDoy: 59 } });
    S().commitSubsetDataset();
    expect(active().view.nanPolicy).toBe('pairwise');
  });

  it('summed depths: an absolute threshold and prominence in per-step units go back to the defaults', () => {
    const dates = Array.from({ length: 96 }, (_, i) => Date.UTC(2001, 0, 1) + i * H);
    S().commitDataset({ name: 'mm', dates, observed: { name: 'o', values: dates.map(() => 1), unit: 'mm_step' }, runs: [{ name: 's', values: dates.map(() => 1), unit: 'mm_step' }] });
    S().updateTiming({ eventThreshold: { kind: 'absolute', value: 2 }, peakProminence: 0.5 });
    S().updateView({ resample: 'daily' });
    S().commitSubsetDataset();
    const d = defaultTimingConfig(DAY, 4);
    expect(active().view.timingConfig.eventThreshold).toEqual(d.eventThreshold);
    expect(active().view.timingConfig.peakProminence).toBe(d.peakProminence);
  });

  it('resampled subset: step-free settings kept, step-counted settings reset for the new step', () => {
    setup();
    const src = active();
    S().updateView({ resample: 'monthly' });
    S().commitSubsetDataset();
    const sub = active();
    const d = defaultTimingConfig(30 * DAY, sub.dates.length);
    expect(sub.view.benchmark).toBe('climatology');
    expect(sub.view.timingConfig.eventThreshold).toEqual(src.view.timingConfig.eventThreshold);
    expect(sub.view.timingConfig.peakProminence).toBe(2);
    expect(sub.view.timingConfig.peakMatchTolerance).toBe(d.peakMatchTolerance);
    expect(sub.view.timingConfig.eventMinDistance).toBe(d.eventMinDistance);
    expect(sub.view.timingConfig.eventWarmup).toBe(d.eventWarmup);
  });
});
