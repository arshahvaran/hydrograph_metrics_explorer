import { create } from 'zustand'
import type { Dataset, Project, Run, UnitId, ViewState, TimingConfig, SandboxState, AreaUnitId } from '../types'
import { defaultView, RUN_PALETTE } from '../types'
import { detectStep } from '../units/stepDetect'
import { convertSeries } from '../units/convert'

export interface CommitInput {
  name: string;
  dates: number[];                       // UTC ms, already parsed & valid
  observed: { name: string; values: number[]; unit: UnitId };
  runs: { name: string; values: number[]; unit: UnitId }[];
}

interface AppState {
  project: Project;
  commitDataset: (input: CommitInput) => string;
  setActiveDataset: (id: string) => void;
  removeDataset: (id: string) => void;
  setActiveTab: (tab: ViewState['activeTab']) => void;
  updateView: (patch: Partial<ViewState>) => void;
  updateTiming: (patch: Partial<TimingConfig>) => void;
  updateSandbox: (patch: Partial<SandboxState>) => void;
  setLocation: (lat: number, lon: number) => void;
  setArea: (value: number, unit: AreaUnitId) => void;
  convertUnits: (to: UnitId) => string | null;   // returns error message or null
  loadProject: (p: Project) => void;
  toggleRunVisible: (runId: string) => void;
}

let idCounter = 0;
const newId = (p: string) => `${p}_${Date.now().toString(36)}_${(idCounter++).toString(36)}`;

function alignByDate(input: CommitInput): CommitInput {
  const order = input.dates
    .map((d, i) => [d, i] as const)
    .filter(([d]) => isFinite(d))
    .sort((a, b) => a[0] - b[0]);
  const dates: number[] = [];
  const pick: number[] = [];
  for (const [d, i] of order) {
    if (dates.length && d === dates[dates.length - 1]) continue;
    dates.push(d); pick.push(i);
  }
  return {
    ...input,
    dates,
    observed: { ...input.observed, values: pick.map(i => input.observed.values[i]) },
    runs: input.runs.map(r => ({ ...r, values: pick.map(i => r.values[i]) })),
  };
}

const mutateActive = (s: AppState, fn: (d: Dataset) => Dataset) => {
  const ds = s.project.datasets.find(d => d.id === s.project.activeDatasetId);
  if (!ds) return {};
  return {
    project: {
      ...s.project,
      datasets: s.project.datasets.map(d => (d.id === ds.id ? fn(d) : d)),
    },
  };
};

export const useApp = create<AppState>((set, get) => ({
  project: { schemaVersion: 1, datasets: [], activeDatasetId: null },

  commitDataset: (raw) => {
    const input = alignByDate(raw);
    const step = detectStep(input.dates);
    const id = newId('ds');
    const runs: Run[] = input.runs.map((r, i) => ({
      id: newId('run'),
      name: r.name,
      values: r.values,
      inputUnit: r.unit,
      visible: true,
      color: RUN_PALETTE[i % RUN_PALETTE.length],
    }));
    const ds: Dataset = {
      id, name: input.name, dates: input.dates,
      observed: { name: input.observed.name, values: input.observed.values, inputUnit: input.observed.unit },
      runs,
      step: { ms: step.ms, label: step.label, irregular: step.irregular },
      targetUnit: input.observed.unit,
      location: null, area: null,
      view: defaultView(step.ms, input.dates.length),
      createdAt: Date.now(),
    };
    set(s => ({ project: { ...s.project, datasets: [...s.project.datasets, ds], activeDatasetId: id } }));
    return id;
  },

  setActiveDataset: (id) => set(s => ({ project: { ...s.project, activeDatasetId: id } })),

  removeDataset: (id) => set(s => {
    const datasets = s.project.datasets.filter(d => d.id !== id);
    return {
      project: {
        ...s.project, datasets,
        activeDatasetId: s.project.activeDatasetId === id ? (datasets[0]?.id ?? null) : s.project.activeDatasetId,
      },
    };
  }),

  setActiveTab: (tab) => set(s => mutateActive(s, d => ({ ...d, view: { ...d.view, activeTab: tab } }))),
  updateView: (patch) => set(s => mutateActive(s, d => ({ ...d, view: { ...d.view, ...patch } }))),
  updateTiming: (patch) => set(s => mutateActive(s, d => ({ ...d, view: { ...d.view, timingConfig: { ...d.view.timingConfig, ...patch } } }))),
  updateSandbox: (patch) => set(s => mutateActive(s, d => ({ ...d, view: { ...d.view, sandbox: { ...d.view.sandbox, ...patch } } }))),
  setLocation: (lat, lon) => set(s => mutateActive(s, d => ({ ...d, location: { lat, lon } }))),
  setArea: (value, unit) => set(s => mutateActive(s, d => ({ ...d, area: { value, unit } }))),

  convertUnits: (to) => {
    const s = get();
    const ds = s.project.datasets.find(d => d.id === s.project.activeDatasetId);
    if (!ds) return 'No active dataset';
    try {
      const ctx = {
        area: ds.area, stepMs: ds.step.ms,
        monthly: ds.step.label === '1mo', dates: ds.dates,
      };
      const observed = { ...ds.observed, values: Array.from(convertSeries(ds.observed.values, { ...ctx, from: ds.targetUnit, to })) };
      const runs = ds.runs.map(r => ({ ...r, values: Array.from(convertSeries(r.values, { ...ctx, from: ds.targetUnit, to })) }));
      set(st => mutateActive(st, d => ({ ...d, observed, runs, targetUnit: to })));
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  },

  toggleRunVisible: (runId) => set(s => mutateActive(s, d => ({
    ...d, runs: d.runs.map(r => (r.id === runId ? { ...r, visible: !r.visible } : r)),
  }))),

  loadProject: (p) => set(() => ({ project: p })),
}));

export function serialiseProject(p: Project): string {
  return JSON.stringify({
    ...p,
    datasets: p.datasets.map(d => ({
      ...d,
      observed: { ...d.observed, values: Array.from(d.observed.values as number[]) },
      runs: d.runs.map(r => ({ ...r, values: Array.from(r.values as number[]) })),
    })),
  });
}
