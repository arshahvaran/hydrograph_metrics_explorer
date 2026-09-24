/** Project files (audit claims-01, project-01, -03, -04, -05, -06, -07, -09): every setting
 *  that changes a value survives Save and Load, and every loaded field is validated. */
import { it, expect, afterEach } from 'vitest'
import { useApp, serialiseProject } from '../src/store/store'
import { parseProjectFile } from '../src/store/projectLoad'
import { LIMITS } from '../src/ingest/limits'

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

it('project-09: project files obey the row and cell caps of a fresh import', () => {
  (LIMITS as any).rows = 100;
  expect(() => parseProjectFile(JSON.stringify(file()))).toThrow(/exceed the 100-row limit/);
  (LIMITS as any).rows = saved.rows; (LIMITS as any).cells = 300;
  expect(() => parseProjectFile(JSON.stringify(file()))).toThrow(/cell limit/);
});
