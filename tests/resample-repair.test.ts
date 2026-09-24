/**
 * Repairs after the adversarial review of the resample/subset fixes
 * (fixes/cr.review.json, entry "resample-subset"):
 *  1. subset-04: a committed seasonal subset holds no out-of-season rows, so
 *     no NaN policy can fill them; the dates still count them as time.
 *  2. compute-02 / subset-01: one shared pairing per bin (obs and every
 *     simulation valid) and a coverage rule (at least half of the bin's
 *     steps), so one missing step no longer empties a bin.
 *  3. units-02: calendar-monthly records stamped anywhere in the month (CF
 *     mid-month stamps) are '1mo' again.
 *  4. subset-07: a native subset re-detects its step.
 *  5. compute-03 / subset-02: partial edge bins follow the coverage rule and
 *     the caption says how many were scaled.
 *  6. units-02: monthly records with many single missing months are '1mo'.
 *  7. units-08: a few alternate missing readings do not make a record
 *     irregular; a sustained coarser stretch still does.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useApp, serialiseProject } from '../src/store/store'
import { parseProjectFile } from '../src/store/projectLoad'
import { applySubset, calendarDoy } from '../src/metrics/subset'
import { computeAll } from '../src/metrics/registry'
import { timePositions } from '../src/metrics/timing/timeAxis'
import { detectStep } from '../src/units/stepDetect'
import { computeForRun, subsetFrameFor, __resetComputeCachesForTests } from '../src/ui/compute'
import { defaultTimingConfig } from '../src/types'

const H = 3_600_000, DAY = 86_400_000;
const S = () => useApp.getState();
const active = () => S().project.datasets.find(d => d.id === S().project.activeDatasetId)!;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const uiMs = (s: string) => Date.parse(s + 'T00:00:00Z');
const daily = (y0: number, m0: number, d0: number, n: number) => Array.from({ length: n }, (_, i) => Date.UTC(y0, m0, d0) + i * DAY);
const vals = (a: ArrayLike<number>) => Array.from(a);
const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
/** Independent NSE on finite pairs. */
const nse = (o: number[], s: number[]) => {
  const mo = mean(o);
  let num = 0, den = 0;
  for (let i = 0; i < o.length; i++) { num += (o[i] - s[i]) ** 2; den += (o[i] - mo) ** 2; }
  return 1 - num / den;
};

beforeEach(() => {
  __resetComputeCachesForTests();
  S().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null });
});

describe('1. subset-04: a committed season holds only in-season rows, so no NaN policy can fill the rest', () => {
  // The reviewer's repro: 3 years daily, season DOY 335-59 (1 Dec - 28 Feb).
  const dates = daily(2001, 0, 1, 1095);
  const obs = dates.map((_, i) => 10 + 8 * Math.sin(2 * Math.PI * i / 365) + 3 * Math.sin(i / 7));
  const sim = obs.map((o, i) => 0.9 * o + 1 + Math.cos(i / 5));
  const inSeason = (ms: number) => { const d = calendarDoy(ms); return d >= 335 || d <= 59; };
  const commitSeason = (nanPolicy: 'pairwise' | 'zero' | 'mean' = 'pairwise') => {
    S().commitDataset({ name: 'season', dates, observed: { name: 'obs', values: obs, unit: 'm3s' }, runs: [{ name: 'sim', values: sim, unit: 'm3s' }] });
    S().updateView({ nanPolicy, season: { startDoy: 335, endDoy: 59 } });
  };

  it('switching the NaN policy to zero or mean after commit changes neither n nor NSE', () => {
    commitSeason();
    S().commitSubsetDataset();
    const sub = active();
    expect(sub.dates.length).toBe(270);
    expect(sub.dates.every(inSeason)).toBe(true);
    const keep = dates.map((d, i) => (inSeason(d) ? i : -1)).filter(i => i >= 0);
    const expected = nse(keep.map(i => obs[i]), keep.map(i => sim[i]));
    const pw = computeForRun(sub, sub.runs[0]);
    expect(pw.n).toBe(270);
    expect(pw.values.nse).toBeCloseTo(expected, 12);
    expect(pw.values.nse).toBeCloseTo(0.955, 3);                // the reviewer's 0.9553
    for (const p of ['zero', 'mean'] as const) {
      S().updateView({ nanPolicy: p });
      const out = computeForRun(active(), active().runs[0]);
      expect(out.n).toBe(270);                                  // was 1095 under zero/mean
      expect(out.values.nse).toBeCloseTo(expected, 12);         // was 0.9943 (zero), 0.9489 (mean)
    }
  });

  it('the dates still count the out-of-season steps as time (D1)', () => {
    commitSeason();
    S().commitSubsetDataset();
    const sub = active();
    const pos = timePositions(sub.dates, sub.dates.length);
    const a = sub.dates.indexOf(Date.UTC(2001, 1, 28)), b = sub.dates.indexOf(Date.UTC(2001, 11, 1));
    expect(b).toBe(a + 1);                                     // adjacent rows ...
    expect(pos[b] - pos[a]).toBe(276);                         // ... 276 days apart on the time axis
  });

  it('DTW, W1 and W2^2 of the committed season equal those of the full record with the other steps blank (D1)', () => {
    commitSeason();
    S().commitSubsetDataset();
    const sub = active();
    const timing = { ...defaultTimingConfig(DAY, dates.length), dtwBand: 10 };
    const ctx = { nanPolicy: 'pairwise' as const, transform: 'none' as const, timing };
    const part = computeAll(sub.observed.values, sub.runs[0].values, { ...ctx, datesMs: sub.dates });
    const blank = obs.map((v, i) => (inSeason(dates[i]) ? v : NaN));
    const full = computeAll(blank, sim, { ...ctx, datesMs: dates });
    for (const id of ['w1', 'w2sq', 'dtw_dist', 'dtw_warp']) {
      expect(Number.isFinite(part.values[id])).toBe(true);
      expect(part.values[id]).toBeCloseTo(full.values[id], 9);
    }
    // counting rows instead would join Feb 28 to Dec 1 and shrink W1
    const rows = computeAll(sub.observed.values, sub.runs[0].values, ctx);
    expect(Math.abs(rows.values.w1 - part.values.w1)).toBeGreaterThan(0.1);
  });

  it('the Plots preview holds exactly the committed rows, so its DTW panel is not gap-filled either', () => {
    commitSeason('zero');
    const src = active();
    const pre = subsetFrameFor(src);
    expect(pre.dates.length).toBe(270);
    const out = computeAll(pre.obs, pre.apply(src.runs[0].values), { nanPolicy: 'zero', transform: 'none', timing: src.view.timingConfig, datesMs: pre.dates, heavy: false });
    expect(out.n).toBe(270);
    S().commitSubsetDataset();
    const sub = active();
    expect(sub.view.nanPolicy).toBe('zero');                    // the source policy is carried over
    expect(sub.dates).toEqual(pre.dates);
    expect(vals(sub.observed.values)).toEqual(vals(pre.obs));
    expect(computeForRun(sub, sub.runs[0]).values.nse).toBeCloseTo(out.values.nse, 12);
  });

  it('the persistence benchmark forecasts from the previous day, never across the out-of-season gap', () => {
    commitSeason();
    S().commitSubsetDataset();
    const sub = active();
    const o = sub.observed.values as number[];
    const ok: number[] = [], bench: number[] = [];
    for (let k = 1; k < o.length; k++) if (sub.dates[k] - sub.dates[k - 1] === DAY) { ok.push(o[k]); bench.push(o[k - 1]); }
    expect(ok.length).toBe(266);                               // Jan 1 2001 and three Dec 1 rows have no previous day
    const out = computeForRun(sub, sub.runs[0]);
    expect(out.benchmark!.persistence.n).toBe(266);
    expect(out.benchmark!.persistence.nseBench).toBeCloseTo(nse(ok, bench), 12);   // 0.9932; 0.8992 if Dec 1 took Feb 28
  });

  it('saved and loaded again, seasonal subsets keep their rows and step (the loader re-detects the step)', () => {
    commitSeason('zero');
    S().commitSubsetDataset();
    const months: number[] = [];
    for (let y = 2001; y <= 2004; y++) for (let m = 0; m < 12; m++) months.push(Date.UTC(y, m, 1));
    S().commitDataset({ name: 'mon', dates: months, observed: { name: 'o', values: months.map((_, i) => 30 + i), unit: 'mm_step' }, runs: [{ name: 's', values: months.map((_, i) => 31 + i), unit: 'mm_step' }] });
    S().updateView({ season: { startDoy: 305, endDoy: 59 } });
    S().commitSubsetDataset();
    const before = S().project.datasets;
    const { project } = parseProjectFile(serialiseProject(S().project));
    for (const name of [before[1].name, before[3].name]) {
      const a = before.find(d => d.name === name)!, b = project.datasets.find(d => d.name === name)!;
      expect(b.dates).toEqual(a.dates);
      expect(b.step).toEqual(a.step);
      expect(b.view.nanPolicy).toBe(a.view.nanPolicy);
    }
    expect(before[1].step).toEqual({ ms: DAY, label: '1d', irregular: false });
    expect(before[3].step).toEqual({ ms: 30 * DAY, label: '1mo', irregular: false });
    expect(before[3].dates.length).toBe(16);                   // Nov-Feb of four winters
  });

  it('a one-month season of monthly data reloads with its 1mo step (was 365d, irregular)', () => {
    const months: number[] = [];
    for (let y = 2001; y <= 2006; y++) for (let m = 0; m < 12; m++) months.push(Date.UTC(y, m, 1));
    S().commitDataset({ name: 'mon1', dates: months, observed: { name: 'o', values: months.map((_, i) => 30 + i), unit: 'mm_step' }, runs: [{ name: 's', values: months.map((_, i) => 31 + i), unit: 'mm_step' }] });
    S().updateView({ season: { startDoy: 60, endDoy: 90 } });   // March only
    S().commitSubsetDataset();
    const made = active();
    expect(made.dates.length).toBe(6);
    expect(made.step).toEqual({ ms: 30 * DAY, label: '1mo', irregular: false });
    expect(detectStep(made.dates).irregular).toBe(true);        // what the loader alone would conclude
    const { project } = parseProjectFile(serialiseProject(S().project));
    expect(project.datasets.find(d => d.name === made.name)!.step).toEqual(made.step);
  });

  it('the loader does not take a saved step that the dates contradict', () => {
    const days = daily(2001, 0, 1, 40);
    S().commitDataset({ name: 'd', dates: days, observed: { name: 'o', values: days.map((_, i) => i + 1), unit: 'm3s' }, runs: [{ name: 's', values: days.map((_, i) => i + 2), unit: 'm3s' }] });
    const file = JSON.parse(serialiseProject(S().project));
    file.datasets[0].step = { ms: 30 * DAY, label: '1mo', irregular: false };
    const { project } = parseProjectFile(JSON.stringify(file));
    expect(project.datasets[0].step).toEqual({ ms: DAY, label: '1d', irregular: false });
  });

  it('a missing in-season value is still a missing value that the source policy treats', () => {
    const o2 = obs.slice();
    o2[dates.indexOf(Date.UTC(2001, 0, 10))] = NaN;
    S().commitDataset({ name: 'gap', dates, observed: { name: 'obs', values: o2, unit: 'm3s' }, runs: [{ name: 'sim', values: sim, unit: 'm3s' }] });
    S().updateView({ season: { startDoy: 335, endDoy: 59 } });
    S().commitSubsetDataset();
    expect(active().dates.length).toBe(270);
    expect(computeForRun(active(), active().runs[0]).n).toBe(269);
    S().updateView({ nanPolicy: 'zero' });
    expect(computeForRun(active(), active().runs[0]).n).toBe(270);
  });
});

describe('2. compute-02 / subset-01: one shared pairing per bin and a coverage rule', () => {
  it('a simulation missing day 15 of every month keeps all 24 monthly bins (was 0 of 24)', () => {
    const dates = daily(2001, 0, 1, 730);
    const obs = dates.map((_, i) => 5 + Math.sin(i / 9));
    const sim = dates.map((d, i) => (new Date(d).getUTCDate() === 15 ? NaN : 4 + Math.sin(i / 9)));
    const r = applySubset(dates, [obs, sim], { window: null, season: null, resample: 'monthly' }, { ms: DAY, label: '1d' });
    expect(r.dates.length).toBe(24);
    expect(r.obs.every(Number.isFinite)).toBe(true);
    expect(r.sims[0].every(Number.isFinite)).toBe(true);
    // January: obs and sim are both the mean over the 30 days other than the 15th
    const jan = dates.map((_, i) => i).filter(i => i < 31 && i !== 14);
    expect(r.obs[0]).toBeCloseTo(mean(jan.map(i => obs[i])), 12);
    expect(r.sims[0][0]).toBeCloseTo(mean(jan.map(i => sim[i])), 12);
    expect(r.obs[0] - r.sims[0][0]).toBeCloseTo(1, 12);          // exactly paired
  });

  it('every simulation and the observations use the same steps, so each obs value matches each simulation', () => {
    const dates = daily(2001, 0, 1, 59);
    const obs = dates.map((_, i) => 10 + i);
    const a = obs.map((v, i) => (i === 4 ? NaN : v));             // A lacks 5 January
    const b = obs.slice();                                        // B is complete
    const r = applySubset(dates, [obs, a, b], { window: null, season: null, resample: 'monthly' }, { ms: DAY, label: '1d' });
    expect(r.sims[0][0]).toBeCloseTo(r.obs[0], 12);
    expect(r.sims[1][0]).toBeCloseTo(r.obs[0], 12);
    expect(r.obs[0]).toBeCloseTo((465 - 4) / 30 + 10, 12);        // 30 days without Jan 5
    expect(r.obs[1]).toBeCloseTo(10 + (31 + 58) / 2, 12);         // February complete
  });

  it('a bin needs at least half of its steps valid in every series', () => {
    const dates = daily(2001, 0, 1, 365);
    const obs = dates.map(() => 3);
    const mar = (lastMissingDay: number) => dates.map((d, i) => {
      const t = new Date(d);
      return t.getUTCMonth() === 2 && t.getUTCDate() <= lastMissingDay ? NaN : obs[i];
    });
    const keep = applySubset(dates, [obs, mar(15)], { window: null, season: null, resample: 'monthly' }, { ms: DAY, label: '1d' });
    expect(keep.dates.map(iso)).toContain('2001-03-01');         // 16 of 31 days
    expect(keep.caption).toContain('1 of 12 months partial');
    const drop = applySubset(dates, [obs, mar(16)], { window: null, season: null, resample: 'monthly' }, { ms: DAY, label: '1d' });
    expect(drop.dates.map(iso)).not.toContain('2001-03-01');     // 15 of 31 days
    expect(drop.dates.length).toBe(11);
    expect(drop.caption).toContain('1 left empty');
    expect(drop.caption).toContain('at least half');
  });

  it('hourly, sim missing hour 23 on 10 days, zero policy, daily resample: NSE of the 60 paired days', () => {
    const n = 60 * 24;
    const dates = Array.from({ length: n }, (_, i) => Date.UTC(2001, 0, 1) + i * H);
    const obs = dates.map((_, t) => 10 + 5 * Math.sin(2 * Math.PI * t / (24 * 9)) + 2 * Math.sin(2 * Math.PI * t / 24));
    const gapDays = new Set([3, 9, 15, 21, 27, 33, 39, 45, 51, 57]);
    const sim = obs.map((o, t) => (gapDays.has(Math.floor(t / 24)) && t % 24 === 23 ? NaN : 0.9 * o + 0.5 + 0.8 * Math.cos(t / 13)));
    // independent daily means over the hours valid in both
    const od: number[] = [], sd: number[] = [];
    for (let d = 0; d < 60; d++) {
      const hrs = Array.from({ length: 24 }, (_, h) => d * 24 + h).filter(t => Number.isFinite(sim[t]));
      od.push(mean(hrs.map(t => obs[t]))); sd.push(mean(hrs.map(t => sim[t])));
    }
    S().commitDataset({ name: 'hourly', dates, observed: { name: 'obs', values: obs, unit: 'm3s' }, runs: [{ name: 'sim', values: sim, unit: 'm3s' }] });
    S().updateView({ nanPolicy: 'zero', resample: 'daily' });
    S().commitSubsetDataset();
    const sub = active();
    expect(sub.dates.length).toBe(60);
    expect(sub.view.nanPolicy).toBe('zero');
    const out = computeForRun(sub, sub.runs[0]);
    expect(out.n).toBe(60);
    expect(out.values.nse).toBeCloseTo(nse(od, sd), 12);         // was -0.674 with the empty days set to zero
    expect(out.values.nse).toBeGreaterThan(0.9);
  });

  it('the preview and the committed dataset hold the same bins; empty bins are not rows', () => {
    const dates = daily(2001, 0, 1, 365);
    const obs = dates.map((_, i) => 5 + Math.sin(i / 11));
    const sim = obs.map((v, i) => (i >= 31 && i < 59 ? NaN : v * 1.1));   // February missing
    S().commitDataset({ name: 'feb', dates, observed: { name: 'obs', values: obs, unit: 'm3s' }, runs: [{ name: 'sim', values: sim, unit: 'm3s' }] });
    S().updateView({ resample: 'monthly', nanPolicy: 'mean' });
    const pre = subsetFrameFor(active());
    expect(pre.dates.length).toBe(11);
    expect(pre.dates.map(iso)).not.toContain('2001-02-01');
    S().commitSubsetDataset();
    const sub = active();
    expect(sub.dates).toEqual(pre.dates);
    expect(vals(sub.observed.values).every(Number.isFinite)).toBe(true);
    expect(computeForRun(sub, sub.runs[0]).n).toBe(11);          // the mean policy has nothing to fill
    expect(timePositions(sub.dates, sub.dates.length)[1]).toBe(2); // Jan -> Mar is two months
  });
});

describe('3. units-02: CF mid-month stamps are calendar-monthly again', () => {
  const cf: number[] = [];
  for (let y = 2001; y <= 2003; y++) for (let m = 0; m < 12; m++) {
    const a = Date.UTC(y, m, 1), b = Date.UTC(y, m + 1, 1);
    cf.push(a + (b - a) / 2);                                     // 2001-01-16T12:00, 2001-02-15T00:00, ...
  }
  const dim = (ms: number) => { const d = new Date(ms); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); };

  it('detectStep: 1mo, regular', () => {
    expect(new Date(cf[0]).toISOString()).toBe('2001-01-16T12:00:00.000Z');
    expect(new Date(cf[1]).toISOString()).toBe('2001-02-15T00:00:00.000Z');
    expect(detectStep(cf)).toEqual({ ms: 30 * DAY, label: '1mo', irregular: false, monthly: true });
  });

  it('1 mm/day depths per month over 86.4 km2 convert to 1 m3/s in every month (February was 0.918)', () => {
    S().commitDataset({ name: 'cf', dates: cf, observed: { name: 'o', values: cf.map(dim), unit: 'mm_step' }, runs: [{ name: 's', values: cf.map(dim), unit: 'mm_step' }] });
    expect(active().step.label).toBe('1mo');
    S().setArea(86.4, 'km2');
    expect(S().convertUnits('m3s')).toBeNull();
    for (const q of vals(active().observed.values)) expect(q).toBeCloseTo(1, 9);
  });

  it('CF stamps with missing months, 15th-of-month, month-end and 23:00 local-midnight stamps are 1mo', () => {
    const gappy = cf.filter((_, i) => i % 5 !== 3);
    expect(detectStep(gappy)).toMatchObject({ label: '1mo', monthly: true, irregular: false });
    const mid = Array.from({ length: 36 }, (_, i) => Date.UTC(2001, i, 15));
    expect(detectStep(mid)).toMatchObject({ label: '1mo', monthly: true, irregular: false });
    const ends = Array.from({ length: 36 }, (_, i) => Date.UTC(2001, i + 1, 0));
    expect(detectStep(ends)).toMatchObject({ label: '1mo', monthly: true, irregular: false });
    const local = Array.from({ length: 36 }, (_, i) => Date.UTC(2001, i, 1) - H);   // 1st 00:00 at UTC+1
    expect(detectStep(local)).toMatchObject({ label: '1mo', monthly: true, irregular: false });
  });

  it('fixed 28- and 30-day steps are still not calendar months (units-05)', () => {
    const s30 = Array.from({ length: 24 }, (_, i) => Date.UTC(2021, 0, 1) + i * 30 * DAY);
    expect(detectStep(s30)).toEqual({ ms: 30 * DAY, label: '30d', irregular: false, monthly: false });
    const s28 = Array.from({ length: 26 }, (_, i) => Date.UTC(2021, 0, 1) + i * 28 * DAY);
    expect(detectStep(s28)).toEqual({ ms: 28 * DAY, label: '28d', irregular: false, monthly: false });
    const s30long = Array.from({ length: 120 }, (_, i) => Date.UTC(2001, 0, 15) + i * 30 * DAY);
    expect(detectStep(s30long).monthly).toBe(false);
  });
});

describe('4. subset-07: a native subset re-detects its step', () => {
  // 200 daily rows (mm / interval), then 2400 hourly rows: the source is {1h, irregular}.
  const dly = daily(2001, 0, 1, 200);
  const t0 = dly[dly.length - 1] + DAY;
  const dates = [...dly, ...Array.from({ length: 2400 }, (_, i) => t0 + i * H)];

  it('a window over the daily part is a regular 1d dataset; depths convert over one day', () => {
    S().commitDataset({ name: 'mixed', dates, observed: { name: 'o', values: dates.map(() => 2), unit: 'mm_step' }, runs: [{ name: 's', values: dates.map(() => 2), unit: 'mm_step' }] });
    expect(active().step).toEqual({ ms: H, label: '1h', irregular: true });
    S().setArea(100, 'km2');
    S().updateView({ window: [uiMs('2001-01-01'), uiMs('2001-05-31')] });
    expect(subsetFrameFor(active()).step.label).toBe('1d');
    S().commitSubsetDataset();
    const sub = active();
    expect(sub.step).toEqual({ ms: DAY, label: '1d', irregular: false });
    // the step-counted timing settings take the daily defaults
    const d = defaultTimingConfig(DAY, sub.dates.length);
    expect(sub.view.timingConfig.peakMatchTolerance).toBe(d.peakMatchTolerance);
    expect(sub.view.timingConfig.eventMinDistance).toBe(d.eventMinDistance);
    S().convertUnits('m3s');
    for (const q of vals(active().observed.values)) expect(q).toBeCloseTo(2 * 100 * 1000 / 86400, 9);  // was 24x too high
  });

  it('a subset with the source step keeps the source timing settings', () => {
    const d2 = daily(2001, 0, 1, 400);
    S().commitDataset({ name: 'd', dates: d2, observed: { name: 'o', values: d2.map(() => 1), unit: 'm3s' }, runs: [{ name: 's', values: d2.map(() => 1), unit: 'm3s' }] });
    S().updateTiming({ peakMatchTolerance: 6, eventMinDistance: 9 });
    const src = active();
    S().updateView({ window: [d2[10], d2[300]] });
    S().commitSubsetDataset();
    expect(active().step).toEqual(src.step);
    expect(active().view.timingConfig).toEqual(src.view.timingConfig);
  });
});

describe('5. compute-03 / subset-02: partial edge bins follow the coverage rule and are labelled', () => {
  const dates = daily(2004, 0, 1, 366);
  const load = () => {
    S().commitDataset({ name: 'mm', dates, observed: { name: 'o', values: dates.map(() => 2), unit: 'mm_step' }, runs: [{ name: 's', values: dates.map(() => 2), unit: 'mm_step' }] });
  };

  it('window 2004-01-10..2004-03-20: edge months kept (22/31, 20/31 days), scaled, and said so', () => {
    load();
    S().updateView({ window: [uiMs('2004-01-10'), uiMs('2004-03-20')], resample: 'monthly' });
    const pre = subsetFrameFor(active());
    expect(vals(pre.obs)).toEqual([62, 58, 62]);
    expect(pre.caption).toContain('monthly totals');
    expect(pre.caption).toContain('scaled to the whole month');
    expect(pre.caption).toContain('2 of 3 months partial');
    S().commitSubsetDataset();
    expect(active().name).toContain('2 of 3 months partial');
  });

  it('window 2004-01-20..2004-03-10: edge months under half covered are left empty', () => {
    load();
    S().updateView({ window: [uiMs('2004-01-20'), uiMs('2004-03-10')], resample: 'monthly' });
    const pre = subsetFrameFor(active());
    expect(pre.dates.map(iso)).toEqual(['2004-02-01']);
    expect(vals(pre.obs)).toEqual([58]);
    expect(pre.caption).toContain('2 left empty');
    expect(pre.shown).toBe(1);
  });

  it('complete bins carry no partial count', () => {
    load();
    S().updateView({ window: [uiMs('2004-01-01'), uiMs('2004-02-29')], resample: 'monthly' });
    const pre = subsetFrameFor(active());
    expect(vals(pre.obs)).toEqual([62, 58]);
    expect(pre.caption).not.toMatch(/months? partial/);
    expect(pre.caption).not.toContain('left empty');
  });
});

describe('6. units-02: monthly records with many single missing months', () => {
  // The reviewer's repro: 2001-2003 on the 15th, every third month missing.
  const dates = Array.from({ length: 36 }, (_, i) => Date.UTC(2001, i, 15)).filter((_, i) => i % 3 !== 1);

  it('15th-of-month stamps, every third month missing (11 one-month and 12 two-month gaps) are 1mo', () => {
    expect(dates.length).toBe(24);
    const k = dates.slice(1).map((t, i) => new Date(t).getUTCMonth() - new Date(dates[i]).getUTCMonth() + 12 * (new Date(t).getUTCFullYear() - new Date(dates[i]).getUTCFullYear()));
    expect(k.filter(x => x === 1).length).toBe(11);
    expect(k.filter(x => x === 2).length).toBe(12);
    expect(detectStep(dates)).toEqual({ ms: 30 * DAY, label: '1mo', irregular: false, monthly: true });
  });

  it('each month converts with its own length in such a record (all months were 30 days)', () => {
    S().commitDataset({ name: 'm', dates, observed: { name: 'o', values: dates.map(() => 28), unit: 'mm_step' }, runs: [{ name: 's', values: dates.map(() => 28), unit: 'mm_step' }] });
    S().setArea(100, 'km2');
    S().convertUnits('m3s');
    const q = (y: number, m: number) => (active().observed.values as number[])[active().dates.indexOf(Date.UTC(y, m, 15))];
    expect(q(2001, 2)).toBeCloseTo(28 * 100 * 1000 / (31 * 86400), 9);   // March
    expect(q(2001, 5)).toBeCloseTo(28 * 100 * 1000 / (30 * 86400), 9);   // June
    expect(q(2001, 11)).toBeCloseTo(28 * 100 * 1000 / (31 * 86400), 9);  // December
  });

  it('quarterly and annual records stay coarser than monthly, even with one odd gap', () => {
    const q = Array.from({ length: 20 }, (_, i) => Date.UTC(2001, 3 * i, 1));
    expect(detectStep(q).monthly).toBe(false);
    const qOdd = q.map((t, i) => (i >= 10 ? Date.UTC(2001, 3 * i + 1, 1) : t));   // one 4-month gap
    expect(detectStep(qOdd).monthly).toBe(false);
    const annual = Array.from({ length: 10 }, (_, i) => Date.UTC(2000 + i, 0, 1));
    expect(detectStep(annual).monthly).toBe(false);
  });
});

describe('7. units-08: irregular means off-grid intervals or a sustained coarser stretch, not a few missing steps', () => {
  it('an hourly record with 3 alternate missing hours is regular', () => {
    const all = Array.from({ length: 1000 }, (_, i) => Date.UTC(2020, 0, 1) + i * H);
    const drop = new Set([10, 12, 14]);                         // 09, 11, 13, 15 kept
    const d = all.filter((_, i) => !drop.has(i));
    expect(detectStep(d)).toEqual({ ms: H, label: '1h', irregular: false, monthly: false });
  });

  it('many missing hours on the hourly grid are missing steps, even when most intervals are longer than 1 h', () => {
    const all = Array.from({ length: 2000 }, (_, i) => Date.UTC(2020, 0, 1) + i * H);
    const d = all.filter((_, i) => [0, 1, 3].includes(i % 6));   // intervals 1 h, 2 h, 3 h, 1 h, 2 h, 3 h, ...
    expect(detectStep(d)).toEqual({ ms: H, label: '1h', irregular: false, monthly: false });
  });

  it('a sustained stretch at a coarser step (daily rows, then hourly rows) is still irregular', () => {
    const dly = Array.from({ length: 200 }, (_, i) => Date.UTC(2019, 0, 1) + i * DAY);
    const t0 = dly[dly.length - 1] + DAY;
    const info = detectStep([...dly, ...Array.from({ length: 2400 }, (_, i) => t0 + i * H)]);
    expect(info).toMatchObject({ label: '1h', irregular: true });
    const two = Array.from({ length: 1000 }, (_, i) => Date.UTC(2020, 0, 1) + i * H).filter((_, i) => i > 400 || i % 2 === 0);
    expect(detectStep(two).irregular).toBe(true);                // 200 two-hourly rows in a row
  });

  it('off-grid intervals still flag a record irregular', () => {
    const d = Array.from({ length: 100 }, (_, i) => Date.UTC(2020, 0, 1) + i * H + (i % 7 === 3 ? 20 * 60_000 : 0));
    expect(detectStep(d).irregular).toBe(true);
  });
});
