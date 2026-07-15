/** Final-QA regression: unit conversion vs the frame cache.
 *  convertUnits rewrites value arrays in place under the same dataset id; the
 *  frame cache was keyed only on id + length, so after a conversion it kept
 *  serving observed values in the OLD unit against simulations in the NEW one.
 *  Metrics went catastrophically wrong (NSE about -6.5 million on a healthy
 *  fit) yet displayed as real results until a page reload. The cache key now
 *  includes targetUnit; this test crosses the two features. */
import { describe, it, expect, beforeEach } from 'vitest'
import { useApp } from '../src/store/store'
import { stage, parseDelimited } from '../src/ingest/ingest'
import { frameFor, subsetFrameFor, computeForRun, __resetComputeCachesForTests } from '../src/ui/compute'

const csv = (() => {
  const r = ['date,observed,m'];
  for (let i = 0; i < 60; i++) r.push(`${new Date(Date.UTC(2001, 0, 1) + i * 864e5).toISOString().slice(0, 10)},${(5 + 3 * Math.sin(i / 5)).toFixed(4)},${(5 + 3 * Math.sin((i - 2) / 5)).toFixed(4)}`);
  return r.join('\n');
})();

beforeEach(() => {
  __resetComputeCachesForTests();
  useApp.getState().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null });
  useApp.getState().commitDataset(stage(parseDelimited(csv), {
    name: 'unitcase', unit: 'm3s', dateFormat: 'auto', missingValue: null, roles: ['date', 'observed', 'run'],
  }).commit!);
});

describe('unit conversion invalidates cached frames', () => {
  it('m3s to ls: frame obs is converted, scale-free metrics invariant, unitful metrics scale by 1000', () => {
    let ds = useApp.getState().project.datasets[0];
    const before = computeForRun(ds, ds.runs[0]);
    frameFor(ds); // populate the cache in the old unit, as a browsing session would
    expect(useApp.getState().convertUnits('ls' as any)).toBeNull();
    ds = useApp.getState().project.datasets[0];
    expect(ds.observed.values[0]).toBeCloseTo(5000, 6);
    expect(frameFor(ds).obs[0]).toBeCloseTo(5000, 6); // the old bug returned 5 here
    const after = computeForRun(ds, ds.runs[0]);
    expect(after.values.nse).toBeCloseTo(before.values.nse, 9);
    expect(after.values.pbias).toBeCloseTo(before.values.pbias, 7);
    expect(after.values.rmse).toBeCloseTo(before.values.rmse * 1000, 5);
  });

  it('the subset preview frame is unit-keyed too', () => {
    let ds = useApp.getState().project.datasets[0];
    const beforeObs0 = subsetFrameFor(ds).obs[0];
    expect(useApp.getState().convertUnits('ls' as any)).toBeNull();
    ds = useApp.getState().project.datasets[0];
    expect(subsetFrameFor(ds).obs[0]).toBeCloseTo(beforeObs0 * 1000, 6);
  });

  it('an unknown unit id is rejected with a readable message and changes nothing', () => {
    let ds = useApp.getState().project.datasets[0];
    const v0 = ds.observed.values[0];
    const err = useApp.getState().convertUnits('lps' as any);
    expect(err).toMatch(/Unknown unit/);
    ds = useApp.getState().project.datasets[0];
    expect(ds.observed.values[0]).toBe(v0);
    expect(ds.targetUnit).toBe('m3s');
  });
});

describe('absolute event threshold follows unit conversion', () => {
  it('8 m3/s becomes 8000 L/s; percentile thresholds are untouched', () => {
    let ds = useApp.getState().project.datasets[0];
    useApp.getState().updateView({ timingConfig: { ...ds.view.timingConfig, eventThreshold: { kind: 'absolute', value: 8 } } } as any);
    expect(useApp.getState().convertUnits('ls' as any)).toBeNull();
    ds = useApp.getState().project.datasets[0];
    expect(ds.view.timingConfig.eventThreshold).toEqual({ kind: 'absolute', value: 8000 });
    // round-trip back
    expect(useApp.getState().convertUnits('m3s' as any)).toBeNull();
    ds = useApp.getState().project.datasets[0];
    expect(ds.view.timingConfig.eventThreshold.value).toBeCloseTo(8, 9);
  });
  it('percentile thresholds pass through unchanged', () => {
    let ds = useApp.getState().project.datasets[0];
    const before = { ...ds.view.timingConfig.eventThreshold };
    expect(before.kind).toBe('percentile');
    expect(useApp.getState().convertUnits('cfs' as any)).toBeNull();
    ds = useApp.getState().project.datasets[0];
    expect(ds.view.timingConfig.eventThreshold).toEqual(before);
  });
});
