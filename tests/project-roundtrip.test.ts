/** Project files (audit claims-01, project-01, -03, -04, -05, -06, -07, -09): every setting
 *  that changes a value survives Save and Load, and every loaded field is validated. */
import { it, expect, afterEach } from 'vitest'
import { useApp, serialiseProject } from '../src/store/store'
import { parseProjectFile } from '../src/store/projectLoad'
import { LIMITS } from '../src/ingest/limits'
import { frameFor, computeForRun, __resetComputeCachesForTests } from '../src/ui/compute'
import { rankRuns, DEFAULT_PRIORITIES } from '../src/metrics/rank'

const S = () => useApp.getState();

function file(extra: { view?: Record<string, unknown>; runs?: unknown[]; n?: number; dup?: number; id?: string } = {}) {
  const n = extra.n ?? 120, t0 = Date.UTC(2001, 0, 1);
  const dates = Array.from({ length: n }, (_, i) => t0 + i * 864e5);
  for (let k = 0; k < (extra.dup ?? 0); k++) dates[k + 1] = dates[k];
  const obs = dates.map((_, i) => 10 + 3 * Math.sin(i / 7));
  return {
    schemaVersion: 1,
    activeDatasetId: 'ds_second',
    datasets: [
      { id: extra.id ?? 'ds_first', name: 'first', dates, observed: { name: 'obs', values: obs, inputUnit: 'm3s' },
        runs: extra.runs ?? [{ id: 'run_a', name: 'a', values: obs.map(v => v * 1.1), inputUnit: 'm3s', visible: true },
                             { id: 'run_b', name: 'b', values: obs.map(v => v + 1), inputUnit: 'm3s', visible: true }],
        targetUnit: 'm3s', location: null, area: null, view: extra.view ?? {} },
      { id: 'ds_second', name: 'second', dates, observed: { name: 'obs', values: obs, inputUnit: 'm3s' },
        runs: [{ id: 'run_c', name: 'c', values: obs, inputUnit: 'm3s', visible: true }],
        targetUnit: 'm3s', location: null, area: null, view: {} },
    ],
  };
}

const saved = { rows: LIMITS.rows, cells: LIMITS.cells };
afterEach(() => { (LIMITS as any).rows = saved.rows; (LIMITS as any).cells = saved.cells; });

it('claims-01/project-01: the sandbox perturbation and its target simulation survive Save and Load', () => {
  const sandbox = { mode: 'perturb', targetRunId: 'run_b', shiftSteps: 6, offset: 1.5, scale: 1.4, dampen: 0.2, noiseAmp: 0.8, noiseKind: 'gaussian', noiseSeed: 7, enabled: true };
  const { project } = parseProjectFile(JSON.stringify(file({ view: { sandbox } })));
  S().loadProject(project);
  const again = parseProjectFile(serialiseProject(S().project)).project;
  const ds = again.datasets[0];
  expect(ds.view.sandbox).toEqual({ ...sandbox, targetRunId: ds.runs[1].id });
  expect(ds.runs[1].name).toBe('b');
});

it('project-07: the saved active dataset is the active one after loading', () => {
  const { project } = parseProjectFile(JSON.stringify(file()));
  expect(project.datasets.find(d => d.id === project.activeDatasetId)?.name).toBe('second');
});

it('project-03: the Metrics tab preset is saved and restored', () => {
  const { project } = parseProjectFile(JSON.stringify(file({ view: { metricPreset: 'extended (beta)' } })));
  expect(project.datasets[0].view.metricPreset).toBe('extended (beta)');
  const bad = parseProjectFile(JSON.stringify(file({ view: { metricPreset: 'toString' } }))).project;
  expect(bad.datasets[0].view.metricPreset).toBe('essentials');
});

it('project-04: an unknown benchmark or tab is rejected with a warning, not shown as another', () => {
  const { project, warnings } = parseProjectFile(JSON.stringify(file({ view: { benchmark: 'median', activeTab: 'nope', season: { startDoy: 400, endDoy: 2 } } })));
  expect(project.datasets[0].view.benchmark).toBe('mean');
  expect(project.datasets[0].view.activeTab).toBe('data');
  expect(project.datasets[0].view.season).toBeNull();
  expect(warnings.join(' ')).toMatch(/benchmark "median" is unknown/);
  expect(warnings.join(' ')).toMatch(/seasonal filter was invalid/);
});

it('project-05: prototype names are not accepted as units', () => {
  const f = file() as any;
  f.datasets[0].targetUnit = 'constructor';
  f.datasets[0].observed.inputUnit = '__proto__';
  const { project } = parseProjectFile(JSON.stringify(f));
  expect(project.datasets[0].targetUnit).toBe('m3s');
  expect(project.datasets[0].observed.inputUnit).toBe('m3s');
});

it('project-06: dropped duplicate-date rows and malformed simulation entries are reported', () => {
  const f = file({ dup: 3 }) as any;
  f.datasets[0].runs.push(42);
  const { warnings } = parseProjectFile(JSON.stringify(f));
  expect(warnings.join(' ')).toMatch(/3 rows repeating an earlier date were dropped/);
  expect(warnings.join(' ')).toMatch(/1 simulation entry was not an object/);
});

/** Two project files with the same saved ids: a script that writes .hme.json files
 *  with fixed ids, or a copy with one observed value corrected by hand. */
function sameIds(offset: number) {
  const n = 120, t0 = Date.UTC(2001, 0, 1);
  const dates = Array.from({ length: n }, (_, i) => t0 + i * 864e5);
  const sim = dates.map((_, i) => 10 + 3 * Math.sin(i / 7));
  return JSON.stringify({
    schemaVersion: 1, activeDatasetId: 'ds1',
    datasets: [{ id: 'ds1', name: 'same', dates, observed: { name: 'obs', values: sim.map(v => v + offset), inputUnit: 'm3s' },
      runs: [{ id: 'run1', name: 'm', values: sim, inputUnit: 'm3s', visible: true }],
      targetUnit: 'm3s', location: null, area: null, view: {} }],
  });
}

it('project-07/claims-01 (review): a second file with the same saved ids never shows the first file\'s results', () => {
  __resetComputeCachesForTests();
  S().loadProject(parseProjectFile(sameIds(0)).project);
  const a = S().project.datasets[0];
  expect(computeForRun(a, a.runs[0]).values.nse).toBe(1);
  S().loadProject(parseProjectFile(sameIds(2)).project);
  const b = S().project.datasets[0];
  expect(frameFor(b).obs[0]).toBe(b.observed.values[0]);
  const nse = computeForRun(b, b.runs[0]).values.nse;
  __resetComputeCachesForTests();
  expect(nse).toBe(computeForRun(b, b.runs[0]).values.nse);   // what an empty cache gives
  expect(nse).toBeCloseTo(0.0875, 3);
  // every load gets fresh ids; references between saved fields still resolve
  expect(b.id).not.toBe('ds1');
  expect(b.runs[0].id).not.toBe('run1');
  expect(b.id).not.toBe(a.id);
  expect(S().project.activeDatasetId).toBe(b.id);
});

it('project-01 (review): a repeated saved run id resolves to its first occurrence, as runs.find does, with a warning', () => {
  const base = file();
  const obs = base.datasets[0].observed.values;
  const runs = [{ id: 'r', name: 'model0', values: obs, inputUnit: 'm3s', visible: true },
                { id: 'r', name: 'model1', values: obs.map(v => v + 1), inputUnit: 'm3s', visible: true }];
  const { project, warnings } = parseProjectFile(JSON.stringify(file({ runs, view: { sandbox: { targetRunId: 'r', shiftSteps: 3 } } })));
  const ds = project.datasets[0];
  expect(ds.runs.map(r => r.name)).toEqual(['model0', 'model1']);
  expect(new Set(ds.runs.map(r => r.id)).size).toBe(2);
  expect(ds.view.sandbox.targetRunId).toBe(ds.runs[0].id);
  expect(ds.view.sandbox.shiftSteps).toBe(3);
  expect(warnings.join(' ')).toMatch(/simulation id "r" is repeated/);
});

it('project-07 (review): a repeated saved dataset id resolves the active dataset to its first occurrence', () => {
  const f = file() as any;
  f.datasets[1].id = 'ds_first';
  f.activeDatasetId = 'ds_first';
  const { project, warnings } = parseProjectFile(JSON.stringify(f));
  expect(project.datasets.find(d => d.id === project.activeDatasetId)?.name).toBe('first');
  expect(warnings.join(' ')).toMatch(/dataset id "ds_first" is repeated/);
});

it('project loader (review): an impossible station location is dropped with a warning', () => {
  for (const loc of [{ lat: 43.3, lon: 1e308 }, { lat: 91, lon: 10 }, { lat: -90.5, lon: 10 }, { lat: 10, lon: -181 }, { lat: 'x', lon: 3 }]) {
    const f = file() as any;
    f.datasets[0].location = loc;
    const { project, warnings } = parseProjectFile(JSON.stringify(f));
    expect(project.datasets[0].location).toBeNull();
    expect(warnings.join(' ')).toMatch(/station location .* was dropped/);
  }
  const f = file() as any;
  f.datasets[0].location = { lat: -90, lon: 180 };
  const ok = parseProjectFile(JSON.stringify(f));
  expect(ok.project.datasets[0].location).toEqual({ lat: -90, lon: 180 });
  expect(ok.warnings).toEqual([]);
});

it('project-04 (review): unknown priority-metric ids are dropped with a warning', () => {
  const { project, warnings } = parseProjectFile(JSON.stringify(file({ view: { priorityMetrics: [{ id: 'bogus', weight: 1 }, { id: 'nse', weight: 2 }, { id: 'toString', weight: 1 }] } })));
  expect(project.datasets[0].view.priorityMetrics).toEqual([{ id: 'nse', weight: 2 }]);
  expect(warnings.join(' ')).toMatch(/priority metric "bogus" is unknown/);
  expect(warnings.join(' ')).toMatch(/priority metric "toString" is unknown/);
  const none = parseProjectFile(JSON.stringify(file({ view: { priorityMetrics: [{ id: 'bogus', weight: 1 }] } })));
  expect(none.project.datasets[0].view.priorityMetrics).toEqual(DEFAULT_PRIORITIES);
  const rows = rankRuns([{ runName: 'a', values: { nse: 0.5 } }, { runName: 'b', values: { nse: 0.7 } }], none.project.datasets[0].view.priorityMetrics);
  expect(rows.every(r => Number.isFinite(r.composite))).toBe(true);
});

it('project-09: project files obey the row and cell caps of a fresh import', () => {
  (LIMITS as any).rows = 100;
  expect(() => parseProjectFile(JSON.stringify(file()))).toThrow(/exceed the 100-row limit/);
  (LIMITS as any).rows = saved.rows; (LIMITS as any).cells = 300;
  expect(() => parseProjectFile(JSON.stringify(file()))).toThrow(/cell limit/);
});
