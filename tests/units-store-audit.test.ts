/** Unit and area changes (audit units-03, units-04, units-07, timing-sandbox-03/-04, compute-08,
 *  plots-02): every stored flow-unit setting converts with the data, area changes re-derive
 *  the values, and cached frames follow the area. */
import { it, expect, beforeEach } from 'vitest'
import { useApp } from '../src/store/store'
import { frameFor, computeForRun, __resetComputeCachesForTests } from '../src/ui/compute'

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
