/**
 * QA-007: hardened project-file loading. Every dataset in a loaded file is
 * rebuilt through the SAME normalisation path as a fresh commit (alignByDate:
 * joint sort + dedup + finite-date filter), unknown keys are dropped (which
 * also neutralises hostile __proto__/constructor payloads — we never copy
 * arbitrary keys), and missing newer fields get defaults (forward compat for
 * projects saved by older versions).
 */
import type { Project, Dataset, ViewState, UnitId, AreaUnitId } from '../types'
import { defaultView, RUN_PALETTE } from '../types'
import { UNITS } from '../units/registry'
import { alignByDate } from './store'
import { detectStep } from '../units/stepDetect'

const num = (v: unknown, d: number): number => (typeof v === 'number' && isFinite(v) ? v : d);
const str = (v: unknown, d: string): string => (typeof v === 'string' ? v : d);
const arrNum = (v: unknown): number[] | null =>
  Array.isArray(v) && v.every(x => typeof x === 'number' || x === null)
    ? v.map(x => (typeof x === 'number' ? x : NaN)) : null;

const unitId = (v: unknown): UnitId => (typeof v === 'string' && v in UNITS ? (v as UnitId) : 'm3s');

let seq = 0;
const nid = (p: string) => `${p}_load_${Date.now().toString(36)}_${(seq++).toString(36)}`;

function loadView(v: unknown, stepMs: number, n: number): ViewState {
  const base = defaultView(stepMs, n);
  if (typeof v !== 'object' || v === null) return base;
  const o = v as Record<string, unknown>;
  const out: ViewState = { ...base };
  // whitelist known keys only — anything else in the file is ignored
  if (o.transform === 'none' || o.transform === 'log' || o.transform === 'sqrt' || o.transform === 'inverse') out.transform = o.transform;
  if (o.nanPolicy === 'pairwise' || o.nanPolicy === 'zero' || o.nanPolicy === 'mean') out.nanPolicy = o.nanPolicy;
  if (Array.isArray(o.window) && o.window.length === 2 && o.window.every(x => typeof x === 'number')) out.window = [o.window[0] as number, o.window[1] as number];
  if (typeof o.season === 'object' && o.season !== null) {
    const s = o.season as Record<string, unknown>;
    if (typeof s.startDoy === 'number' && typeof s.endDoy === 'number') out.season = { startDoy: s.startDoy, endDoy: s.endDoy };
  }
  if (o.resample === 'native' || o.resample === 'daily' || o.resample === 'monthly') out.resample = o.resample;
  if (typeof o.benchmark === 'string') out.benchmark = str(o.benchmark, base.benchmark) as ViewState['benchmark'];
  if (Array.isArray(o.priorityMetrics)) {
    const pm = (o.priorityMetrics as unknown[]).filter((x): x is { id: string; weight: number } =>
      typeof x === 'object' && x !== null && typeof (x as any).id === 'string' && typeof (x as any).weight === 'number');
    if (pm.length) out.priorityMetrics = pm.map(x => ({ id: x.id, weight: x.weight }));
  }
  if (typeof o.showBootstrapCIs === 'boolean') out.showBootstrapCIs = o.showBootstrapCIs;
  if (typeof o.activeTab === 'string') out.activeTab = o.activeTab as ViewState['activeTab'];
  if (typeof o.timingConfig === 'object' && o.timingConfig !== null) out.timingConfig = { ...base.timingConfig, ...(o.timingConfig as object) } as ViewState['timingConfig'];
  return out;
}

function loadDataset(raw: unknown, errors: string[]): Dataset | null {
  if (typeof raw !== 'object' || raw === null) { errors.push('a dataset entry is not an object'); return null; }
  const d = raw as Record<string, unknown>;
  const name = str(d.name, 'unnamed');
  const dates = arrNum(d.dates);
  const obs = (typeof d.observed === 'object' && d.observed) ? d.observed as Record<string, unknown> : null;
  const obsVals = obs ? arrNum(obs.values) : null;
  const runsRaw = Array.isArray(d.runs) ? d.runs : null;
  if (!dates || !obsVals || !runsRaw) { errors.push(`dataset "${name}": missing or malformed dates/observed/runs`); return null; }
  if (obsVals.length !== dates.length) { errors.push(`dataset "${name}": observed length ${obsVals.length} ≠ dates length ${dates.length}`); return null; }

  const runsIn: { name: string; values: number[]; unit: UnitId; visible: boolean; color?: string }[] = [];
  for (const rr of runsRaw) {
    if (typeof rr !== 'object' || rr === null) continue;
    const r = rr as Record<string, unknown>;
    const vals = arrNum(r.values);
    if (!vals || vals.length !== dates.length) { errors.push(`dataset "${name}": run "${str(r.name, '?')}" has mismatched length`); return null; }
    runsIn.push({ name: str(r.name, `run ${runsIn.length + 1}`), values: vals, unit: unitId(r.inputUnit), visible: r.visible !== false, color: typeof r.color === 'string' ? r.color : undefined });
  }
  if (!runsIn.length) { errors.push(`dataset "${name}": no valid runs`); return null; }

  // Reuse the exact commit-path invariants: joint sort, dedup-first, finite dates.
  const aligned = alignByDate({
    name, dates,
    observed: { name: str(obs!.name, 'observed'), values: obsVals, unit: unitId((obs as Record<string, unknown>).inputUnit ?? d.targetUnit) },
    runs: runsIn.map(r => ({ name: r.name, values: r.values, unit: r.unit })),
  });
  if (aligned.dates.length < 2) { errors.push(`dataset "${name}": fewer than 2 rows with valid dates`); return null; }
  const step = detectStep(aligned.dates);
  const loc = (typeof d.location === 'object' && d.location !== null &&
    typeof (d.location as any).lat === 'number' && typeof (d.location as any).lon === 'number')
    ? { lat: (d.location as any).lat, lon: (d.location as any).lon } : null;

  return {
    id: nid('ds'),
    name,
    dates: aligned.dates,
    observed: { name: aligned.observed.name, values: aligned.observed.values, inputUnit: aligned.observed.unit },
    runs: aligned.runs.map((r, i) => ({
      id: nid('run'), name: r.name, values: r.values, inputUnit: r.unit,
      visible: runsIn[i]?.visible ?? true,
      color: runsIn[i]?.color ?? RUN_PALETTE[i % RUN_PALETTE.length],
    })),
    step: { ms: step.ms, label: step.label, irregular: step.irregular },
    targetUnit: unitId(d.targetUnit),
    location: loc,
    area: (typeof d.area === 'object' && d.area !== null &&
      typeof (d.area as any).value === 'number' && isFinite((d.area as any).value) && (d.area as any).value > 0 &&
      ['km2', 'mi2', 'ha', 'acre'].includes((d.area as any).unit))
      ? { value: (d.area as any).value, unit: (d.area as any).unit as AreaUnitId } : null,
    view: loadView(d.view, step.ms, aligned.dates.length),
    createdAt: num(d.createdAt, Date.now()),
  };
}

export function parseProjectFile(text: string): { project: Project; warnings: string[] } {
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch { throw new Error('The file is not valid JSON; it may be truncated or not an HME project.'); }
  if (typeof raw !== 'object' || raw === null) throw new Error('Not an HME project file.');
  const p = raw as Record<string, unknown>;
  if (p.schemaVersion !== 1) throw new Error(`Unsupported schema version ${String(p.schemaVersion)}; this build reads schemaVersion 1.`);
  if (!Array.isArray(p.datasets)) throw new Error('Not an HME project file (no datasets array).');

  const errors: string[] = [];
  const datasets = p.datasets.map(d => loadDataset(d, errors)).filter((d): d is Dataset => d !== null);
  if (p.datasets.length > 0 && datasets.length === 0) {
    throw new Error(`No dataset in the file could be loaded:\n- ${errors.join('\n- ')}`);
  }
  const activeDatasetId = datasets.some(d => d.id === p.activeDatasetId)
    ? p.activeDatasetId as string
    : (datasets[0]?.id ?? null);
  return { project: { schemaVersion: 1, datasets, activeDatasetId }, warnings: errors };
}
