/** Unit and area changes (audit units-03, units-04, units-07, timing-sandbox-03/-04, compute-08,
 *  plots-02): every stored flow-unit setting converts with the data, area changes re-derive
 *  the values, and cached frames follow the area. */
import { it, expect, beforeEach } from 'vitest'
import { useApp, convertSetting } from '../src/store/store'
import { frameFor, computeForRun, __resetComputeCachesForTests } from '../src/ui/compute'
import { convertSeries } from '../src/units/convert'

const S = () => useApp.getState();
const ds = () => S().project.datasets[0];

function load(stepMs = 864e5, n = 400) {
  __resetComputeCachesForTests();
  S().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null });
  const t0 = Date.UTC(2001, 0, 1);
  const dates = Array.from({ length: n }, (_, i) => t0 + i * stepMs);
  const obs = dates.map((_, i) => 12 + 9 * Math.exp(-0.5 * (((i % 60) - 20) / 3) ** 2));
  const sim = obs.map((_, i) => obs[Math.max(0, i - 2)] * 1.05);
  S().commitDataset({ name: 'u', dates, observed: { name: 'obs', values: obs, unit: 'm3s' }, runs: [{ name: 'sim', values: sim, unit: 'm3s' }] } as any);
}

beforeEach(() => load());

it('units-03/timing-sandbox-03/-04: prominence and sandbox offset/noise convert with the data', () => {
  S().updateView({ timingConfig: { ...ds().view.timingConfig, peakProminence: 4, eventThreshold: { kind: 'absolute', value: 15 } } });
  S().updateSandbox({ offset: 1.5, noiseAmp: 0.8 });
  const before = computeForRun(ds(), ds().runs[0]).values;
  expect(S().convertUnits('ls')).toBeNull();
  const v = ds().view;
  expect(v.timingConfig.peakProminence).toBeCloseTo(4000, 9);
  expect(v.timingConfig.eventThreshold.value).toBeCloseTo(15000, 9);
  expect(v.sandbox.offset).toBeCloseTo(1500, 9);
  expect(v.sandbox.noiseAmp).toBeCloseTo(800, 9);
  const after = computeForRun(ds(), ds().runs[0]).values;
  // dtw_warp is unit-invariant thanks to the DTW tie rule of audit dtw-wass-05
  for (const id of ['nse', 'kge2009', 'peak_lag_abs', 'peak_lag_signed', 'event_threat', 'w1', 'dtw_warp']) {
    if (Number.isFinite(before[id])) expect([id, after[id]]).toEqual([id, expect.closeTo(before[id], 9)]);
  }
});

it('units-04: on monthly depth the absolute threshold becomes the equivalent percentile, with a message', () => {
  const t0 = Date.UTC(2001, 0, 1);
  __resetComputeCachesForTests();
  S().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null });
  const dates = Array.from({ length: 48 }, (_, i) => Date.UTC(2001, i, 1));
  const obs = dates.map((_, i) => 20 + 10 * Math.sin(i / 2));
  S().commitDataset({ name: 'm', dates, observed: { name: 'obs', values: obs, unit: 'm3s' }, runs: [{ name: 'sim', values: obs, unit: 'm3s' }] } as any);
  S().setArea(100, 'km2');
  S().updateView({ timingConfig: { ...ds().view.timingConfig, eventThreshold: { kind: 'absolute', value: 25 } } });
  const msg = S().convertUnits('mm_step');
  expect(msg).toMatch(/equivalent percentile of observed flow, P\d/);
  const et = ds().view.timingConfig.eventThreshold;
  expect(et.kind).toBe('percentile');
  const share = obs.filter(v => v < 25).length / obs.length;
  expect(et.value).toBeCloseTo(100 * share, 0);
  expect(ds().targetUnit).toBe('mm_step');
  void t0;
});

it('units-07/compute-08/plots-02: an area change re-derives depth-converted values and the cache follows', () => {
  S().setArea(100, 'km2');
  expect(S().convertUnits('mm_step')).toBeNull();
  const mm100 = Array.from(frameFor(ds()).obs);
  S().setArea(200, 'km2');                         // corrected area: the same flow is half the depth
  const mm200 = Array.from(frameFor(ds()).obs);
  for (let i = 0; i < 10; i++) expect(mm200[i]).toBeCloseTo(mm100[i] / 2, 9);
  expect(S().convertUnits('m3s')).toBeNull();      // back to flow: the original values
  expect(frameFor(ds()).obs[5]).toBeCloseTo(12 + 9 * Math.exp(-0.5 * ((5 - 20) / 3) ** 2), 9);
});

/** A 365-day m3/s record, base 10, Gaussian floods 2 to 24 high (obs[110] = 18). */
function floods() {
  __resetComputeCachesForTests();
  S().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null });
  const t0 = Date.UTC(2001, 0, 1);
  const dates = Array.from({ length: 365 }, (_, i) => t0 + i * 864e5);
  const centres = [30, 70, 110, 150, 190, 230, 270, 310, 350], heights = [2, 14, 8, 24, 5, 20, 11, 17, 3];
  const obs = dates.map((_, i) => 10 + centres.reduce((a, c, k) => a + heights[k] * Math.exp(-0.5 * ((i - c) / 4) ** 2), 0));
  const sim = obs.map((_, i) => 0.9 * obs[Math.max(0, i - 2)] + 1);
  S().commitDataset({ name: 'f', dates, observed: { name: 'obs', values: obs, unit: 'm3s' }, runs: [{ name: 'sim', values: sim, unit: 'm3s' }] } as any);
  return obs;
}

it('units-07 (review): an area change re-derives the flow-unit settings with the data, so a depth round trip is the identity', () => {
  const obs = floods();
  expect(obs[110]).toBe(18);
  S().setArea(100, 'km2');
  S().updateView({ timingConfig: { ...ds().view.timingConfig, eventThreshold: { kind: 'absolute', value: 18 }, peakProminence: 9 } });
  S().updateSandbox({ offset: 5, noiseAmp: 2 });
  const before = computeForRun(ds(), ds().runs[0]).values;
  expect(before.event_threat).toBe(1);
  expect(S().convertUnits('mm_step')).toBeNull();
  S().setArea(200, 'km2');
  expect(S().convertUnits('m3s')).toBeNull();
  const v = ds().view;
  expect(ds().observed.values[110]).toBeCloseTo(18, 12);
  expect(v.timingConfig.eventThreshold.value).toBeCloseTo(18, 12);
  expect(v.timingConfig.peakProminence).toBeCloseTo(9, 12);
  expect(v.sandbox.offset).toBeCloseTo(5, 12);
  expect(v.sandbox.noiseAmp).toBeCloseTo(2, 12);
  const after = computeForRun(ds(), ds().runs[0]).values;
  for (const id of ['event_threat', 'event_vol', 'event_peak', 'peak_lag_abs', 'nse']) {
    expect([id, after[id]]).toEqual([id, expect.closeTo(before[id], 9)]);
  }
});

it('units-07 (review): the area change scales the settings exactly as it scales the observed series', () => {
  floods();
  S().setArea(100, 'km2');
  expect(S().convertUnits('mm_step')).toBeNull();
  const thr = ds().observed.values[110];            // a threshold sitting exactly on an observed value
  S().updateView({ timingConfig: { ...ds().view.timingConfig, eventThreshold: { kind: 'absolute', value: thr }, peakProminence: thr } });
  S().updateSandbox({ offset: -thr, noiseAmp: thr });
  S().setArea(137, 'km2');
  const v = ds().view, o110 = ds().observed.values[110];
  expect(o110).toBeCloseTo(thr * 100 / 137, 12);
  expect(v.timingConfig.eventThreshold.value).toBe(o110);   // a tie stays a tie
  expect(v.timingConfig.peakProminence).toBe(o110);
  expect(v.sandbox.offset).toBe(-o110);
  expect(v.sandbox.noiseAmp).toBe(o110);
});

it('units-07 (review): settings stay when the observed series is not re-derived', () => {
  floods();
  S().setArea(100, 'km2');
  S().updateView({ timingConfig: { ...ds().view.timingConfig, eventThreshold: { kind: 'absolute', value: 18 }, peakProminence: 9 } });
  S().updateSandbox({ offset: 5, noiseAmp: 2 });
  S().setArea(250, 'km2');                         // flow data, flow target: nothing depends on the area
  const v = ds().view;
  expect(v.timingConfig.eventThreshold.value).toBe(18);
  expect(v.timingConfig.peakProminence).toBe(9);
  expect(v.sandbox.offset).toBe(5);
  expect(v.sandbox.noiseAmp).toBe(2);
});

it('units-03/timing-sandbox-04 (review): a flow equal to the threshold stays equal after a unit conversion', () => {
  __resetComputeCachesForTests();
  S().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null });
  const t0 = Date.UTC(2001, 0, 1);
  const dates = Array.from({ length: 200 }, (_, i) => t0 + i * 864e5);
  const shape: Record<number, number[]> = { 20: [12, 18, 25, 18, 12], 60: [12, 18, 25, 18, 12], 100: [15, 25, 40, 25, 15], 140: [12, 18, 25, 18, 12] };
  const obs = dates.map(() => 8);
  for (const [c, vals] of Object.entries(shape)) vals.forEach((x, k) => { obs[+c - 2 + k] = x; });
  const sim = obs.map((x, i) => (Object.keys(shape).some(c => +c === i) ? x + 3 : x));
  S().commitDataset({ name: 'tie', dates, observed: { name: 'obs', values: obs, unit: 'm3s' }, runs: [{ name: 'sim', values: sim, unit: 'm3s' }] } as any);
  S().updateView({ timingConfig: { ...ds().view.timingConfig, eventThreshold: { kind: 'absolute', value: 25 } } });
  const before = computeForRun(ds(), ds().runs[0]).values.event_threat;
  expect(before).toBe(0.25);
  expect(S().convertUnits('MGD')).toBeNull();
  expect(ds().view.timingConfig.eventThreshold.value).toBe(ds().observed.values[20]);
  expect(computeForRun(ds(), ds().runs[0]).values.event_threat).toBe(0.25);
  // the same holds for every volumetric pair and every whole flow from 1 to 1000
  const units = ['m3s', 'cfs', 'ls', 'm3day', 'MLday', 'MGD', 'acftday'] as const;
  for (const from of units) for (const to of units) {
    if (from === to) continue;
    const xs = Array.from({ length: 1000 }, (_, i) => i + 1);
    const data = convertSeries(xs, { from, to });
    for (const x of [1, 7, 25, 333, 1000]) expect(convertSetting(x, { from, to })).toBe(data[x - 1]);
  }
});
