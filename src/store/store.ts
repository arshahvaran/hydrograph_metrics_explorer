import { create } from 'zustand'
import type { Dataset, Project, Run, UnitId } from '../types'
import { defaultView, RUN_PALETTE } from '../types'
import { detectStep } from '../units/stepDetect'

export interface CommitInput {
  name: string;
  dates: number[];                       // UTC ms, already parsed & valid
  observed: { name: string; values: number[]; unit: UnitId };
  runs: { name: string; values: number[]; unit: UnitId }[];
}

interface AppState {
  project: Project;
  activeDataset: () => Dataset | null;
  commitDataset: (input: CommitInput) => string;
  setActiveTab: (tab: Dataset['view']['activeTab']) => void;
  setActiveDataset: (id: string) => void;
  removeDataset: (id: string) => void;
}

let idCounter = 0;
const newId = (p: string) => `${p}_${Date.now().toString(36)}_${(idCounter++).toString(36)}`;

/** Sort by date, drop unparseable rows, keep first of duplicate dates. */
function alignByDate(input: CommitInput): CommitInput {
  const order = input.dates
    .map((d, i) => [d, i] as const)
    .filter(([d]) => isFinite(d))
    .sort((a, b) => a[0] - b[0]);
  const dates: number[] = [];
  const pick: number[] = [];
  for (const [d, i] of order) {
    if (dates.length && d === dates[dates.length - 1]) continue; // duplicate date: first wins
    dates.push(d); pick.push(i);
  }
  return {
    ...input,
    dates,
    observed: { ...input.observed, values: pick.map(i => input.observed.values[i]) },
    runs: input.runs.map(r => ({ ...r, values: pick.map(i => r.values[i]) })),
  };
}

export const useApp = create<AppState>((set, get) => ({
  project: { schemaVersion: 1, datasets: [], activeDatasetId: null },

  activeDataset: () => {
    const { project } = get();
    return project.datasets.find(d => d.id === project.activeDatasetId) ?? null;
  },

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
      id,
      name: input.name,
      dates: input.dates,
      observed: { name: input.observed.name, values: input.observed.values, inputUnit: input.observed.unit },
      runs,
      step: { ms: step.ms, label: step.label, irregular: step.irregular },
      targetUnit: input.observed.unit,
      location: null,
      area: null,
      view: defaultView(step.ms, input.dates.length),
      createdAt: Date.now(),
    };
    set(s => ({ project: { ...s.project, datasets: [...s.project.datasets, ds], activeDatasetId: id } }));
    return id;
  },

  setActiveTab: (tab) => set(s => {
    const ds = s.project.datasets.find(d => d.id === s.project.activeDatasetId);
    if (!ds) return s;
    const datasets = s.project.datasets.map(d =>
      d.id === ds.id ? { ...d, view: { ...d.view, activeTab: tab } } : d);
    return { project: { ...s.project, datasets } };
  }),

  setActiveDataset: (id) => set(s => ({ project: { ...s.project, activeDatasetId: id } })),

  removeDataset: (id) => set(s => {
    const datasets = s.project.datasets.filter(d => d.id !== id);
    const activeDatasetId = s.project.activeDatasetId === id
      ? (datasets[0]?.id ?? null)
      : s.project.activeDatasetId;
    return { project: { ...s.project, datasets, activeDatasetId } };
  }),
}));
