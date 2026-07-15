/** The Plots-tab subset workflow: window/season/resample selections are
 *  materialised as NEW datasets; analysis tabs always see full records. */
import { describe, it, expect, beforeEach } from 'vitest'
import { useApp } from '../src/store/store'
import { stage, parseDelimited } from '../src/ingest/ingest'
import { frameFor, subsetFrameFor, computeForRun, __resetComputeCachesForTests } from '../src/ui/compute'
import { computeAll } from '../src/metrics/registry'
import { defaultView } from '../src/types'

const csv = (n = 120) => {
  const rows = ['date,observed,m'];
  for (let i = 0; i < n; i++) rows.push(`${new Date(Date.UTC(2001, 0, 1) + i * 864e5).toISOString().slice(0, 10)},${(5 + 3 * Math.sin(i / 5)).toFixed(4)},${(5 + 3 * Math.sin((i - 2) / 5)).toFixed(4)}`);
  return rows.join('\n');
};
const commit = () => useApp.getState().commitDataset(stage(parseDelimited(csv()), {
  name: 'base', unit: 'm3s', dateFormat: 'auto', missingValue: null, roles: ['date', 'observed', 'run'],
}).commit!);

beforeEach(() => {
  __resetComputeCachesForTests();
  useApp.getState().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null });
});

describe('subset materialisation', () => {
  it('no selection → no dataset is created', () => {
    commit();
    expect(useApp.getState().commitSubsetDataset()).toBeNull();
    expect(useApp.getState().project.datasets.length).toBe(1);
  });

  it('a window selection becomes a new, active dataset holding exactly the slice', () => {
    const srcId = commit();
    const src = useApp.getState().project.datasets[0];
    useApp.getState().updateView({ window: [src.dates[20], src.dates[59]] });
    const newId = useApp.getState().commitSubsetDataset();
    const st = useApp.getState().project;
    expect(newId).toBeTruthy();
    expect(st.datasets.length).toBe(2);
    expect(st.activeDatasetId).toBe(newId);
    const sub = st.datasets.find(d => d.id === newId)!;
    expect(sub.dates.length).toBe(40);
    expect(sub.dates[0]).toBe(src.dates[20]);
    expect(sub.name).toContain('window');
    expect(Array.from(sub.observed.values as number[])).toEqual((src.observed.values as number[]).slice(20, 60));
    // the source keeps its own identity and full record
    expect(st.datasets.find(d => d.id === srcId)!.dates.length).toBe(120);
  });

  it('metrics on the new dataset equal metrics on the old live-windowed frame', () => {
    commit();
    const src = useApp.getState().project.datasets[0];
    useApp.getState().updateView({ window: [src.dates[10], src.dates[89]] });
    // zustand updates immutably: re-read the dataset before building the preview
    const fresh = useApp.getState().project.datasets[0];
    const preview = subsetFrameFor(fresh);
    const v = defaultView(src.step.ms, preview.dates.length);
    const expected = computeAll(preview.obs, preview.apply(src.runs[0].values), {
      nanPolicy: v.nanPolicy, transform: v.transform, timing: v.timingConfig, heavy: false,
    });
    const newId = useApp.getState().commitSubsetDataset()!;
    const sub = useApp.getState().project.datasets.find(d => d.id === newId)!;
    const got = computeForRun(sub, sub.runs[0]);
    expect(got.values.nse).toBeCloseTo(expected.values.nse, 10);
    expect(got.values.rmse).toBeCloseTo(expected.values.rmse, 10);
  });

  it('analysis frames ignore window/season/resample; only the Plots preview honours them', () => {
    commit();
    const src = useApp.getState().project.datasets[0];
    useApp.getState().updateView({ window: [src.dates[30], src.dates[49]], resample: 'monthly' });
    const ds = useApp.getState().project.datasets[0];
    expect(frameFor(ds).dates.length).toBe(120);          // full record for Metrics/Timing/…
    expect(subsetFrameFor(ds).dates.length).toBeLessThan(120); // Plots preview subsets
  });
});
