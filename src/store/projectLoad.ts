/**
 * QA-007: hardened project-file loading. Every dataset in a loaded file is
 * rebuilt through the SAME normalisation path as a fresh commit (alignByDate:
 * joint sort + dedup + finite-date filter), unknown keys are dropped (which
 * also neutralises hostile __proto__/constructor payloads: we never copy
 * arbitrary keys), and missing newer fields get defaults (forward compat for
 * projects saved by older versions).
 */
import type { Project, Dataset, ViewState, UnitId, AreaUnitId, SandboxState } from '../types'
import { PRESETS } from '../metrics/registry'
import { defaultView, RUN_PALETTE, clampTimingConfig } from '../types'
import { UNITS } from '../units/registry'
import { alignByDate } from './store'
import { detectStep } from '../units/stepDetect'
import { LIMITS } from '../ingest/limits'

const num = (v: unknown, d: number): number => (typeof v === 'number' && isFinite(v) ? v : d);
const str = (v: unknown, d: string): string => (typeof v === 'string' ? v : d);
const arrNum = (v: unknown): number[] | null =>
  Array.isArray(v) && v.every(x => typeof x === 'number' || x === null)
    ? v.map(x => (typeof x === 'number' ? x : NaN)) : null;

// own keys only: 'in' also accepts prototype names such as 'constructor' or 'toString'
const unitId = (v: unknown): UnitId => (typeof v === 'string' && Object.prototype.hasOwnProperty.call(UNITS, v) ? (v as UnitId) : 'm3s');

const TABS: ViewState['activeTab'][] = ['data', 'metrics', 'plots', 'timing', 'sandbox', 'compare', 'map', 'report'];
const BENCHMARKS: ViewState['benchmark'][] = ['mean', 'climatology', 'persistence'];
/** Saved ids are kept when they are plain, unique strings, so references between
 *  saved fields (activeDatasetId, the sandbox's targetRunId) still resolve. */
const idOk = (v: unknown, used: Set<string>): v is string =>
  typeof v === 'string' && /^[\w.-]{1,120}$/.test(v) && !used.has(v);
const usedIds = new Set<string>();

/** Sandbox settings change the Sandbox's metric values, so they are restored
 *  field by field (each validated) instead of being dropped. */
function loadSandbox(v: unknown, base: SandboxState, runIds: Map<string, string>, warn: (msg: string) => void): SandboxState {
  if (typeof v !== 'object' || v === null) return base;
  const o = v as Record<string, unknown>;
  const out: SandboxState = { ...base };
  let bad = false;
  const fin = (x: unknown, lo: number, hi: number): number | null =>
    typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi ? x : null;
  if (o.mode === 'perturb' || o.mode === 'synthetic') out.mode = o.mode; else if (o.mode !== undefined) bad = true;
  if (typeof o.targetRunId === 'string') {
    const id = runIds.get(o.targetRunId);
    if (id) out.targetRunId = id; else bad = true;
  }
  const shift = fin(o.shiftSteps, -100_000, 100_000);
  if (shift !== null && Number.isInteger(shift)) out.shiftSteps = shift; else if (o.shiftSteps !== undefined) bad = true;
  const off = fin(o.offset, -Number.MAX_VALUE, Number.MAX_VALUE); if (off !== null) out.offset = off; else if (o.offset !== undefined) bad = true;
  const sc = fin(o.scale, 0, 3); if (sc !== null) out.scale = sc; else if (o.scale !== undefined) bad = true;
  const dp = fin(o.dampen, 0, 1); if (dp !== null) out.dampen = dp; else if (o.dampen !== undefined) bad = true;
  const na = fin(o.noiseAmp, 0, Number.MAX_VALUE); if (na !== null) out.noiseAmp = na; else if (o.noiseAmp !== undefined) bad = true;
  if (o.noiseKind === 'uniform' || o.noiseKind === 'gaussian') out.noiseKind = o.noiseKind; else if (o.noiseKind !== undefined) bad = true;
  const seed = fin(o.noiseSeed, 0, 2_147_483_647);
  if (seed !== null && Number.isInteger(seed)) out.noiseSeed = seed; else if (o.noiseSeed !== undefined) bad = true;
  if (typeof o.enabled === 'boolean') out.enabled = o.enabled;
  if (bad) warn('some sandbox settings were invalid and were reset to their defaults');
  return out;
}

/** Largest |ms| a JavaScript Date represents; beyond it every date formatter
 *  throws "Invalid time value", which once took the Data, Plots and Timing
 *  tabs to the render boundary on a hand-edited project file. */
export const DATE_MS_MAX = 8.64e15;
const validMs = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= DATE_MS_MAX;

let seq = 0;
const nid = (p: string) => `${p}_load_${Date.now().toString(36)}_${(seq++).toString(36)}`;

function loadView(v: unknown, stepMs: number, n: number, warn: (msg: string) => void, runIds: Map<string, string> = new Map()): ViewState {
  const base = defaultView(stepMs, n);
  if (typeof v !== 'object' || v === null) return base;
  const o = v as Record<string, unknown>;
  const out: ViewState = { ...base };
  // whitelist known keys only: anything else in the file is ignored
  if (o.transform === 'none' || o.transform === 'log' || o.transform === 'sqrt' || o.transform === 'inverse') out.transform = o.transform;
  if (o.nanPolicy === 'pairwise' || o.nanPolicy === 'zero' || o.nanPolicy === 'mean') out.nanPolicy = o.nanPolicy;
  if (o.window != null) {
    const w = o.window;
    if (Array.isArray(w) && w.length === 2 && w.every(validMs)) out.window = [w[0] as number, w[1] as number];
    else warn('the analysis window was invalid and has been cleared');
  }
  if (typeof o.season === 'object' && o.season !== null) {
    const s = o.season as Record<string, unknown>;
    const doy = (x: unknown) => typeof x === 'number' && Number.isInteger(x) && x >= 1 && x <= 366;
    if (doy(s.startDoy) && doy(s.endDoy)) out.season = { startDoy: s.startDoy as number, endDoy: s.endDoy as number };
    else warn('the seasonal filter was invalid (days of year must be whole numbers from 1 to 366) and has been cleared');
  }
  if (o.resample === 'native' || o.resample === 'daily' || o.resample === 'monthly') out.resample = o.resample;
  if (typeof o.benchmark === 'string') {
    if ((BENCHMARKS as string[]).includes(o.benchmark)) out.benchmark = o.benchmark as ViewState['benchmark'];
    else warn(`the benchmark "${o.benchmark}" is unknown; the ${base.benchmark} benchmark is used`);
  }
  if (typeof o.metricPreset === 'string' && Object.prototype.hasOwnProperty.call(PRESETS, o.metricPreset)) out.metricPreset = o.metricPreset;
  if (Array.isArray(o.priorityMetrics)) {
    const seen = new Set<string>();
    const pm = (o.priorityMetrics as unknown[])
      .filter((x): x is { id: string; weight: number } =>
        typeof x === 'object' && x !== null && typeof (x as any).id === 'string'
        && Number.isFinite((x as any).weight) && (x as any).weight >= 0)
      .filter(x => (seen.has(x.id) ? false : (seen.add(x.id), true)));
    if (pm.length) out.priorityMetrics = pm.map(x => ({ id: x.id, weight: x.weight }));
  }
  if (typeof o.showBootstrapCIs === 'boolean') out.showBootstrapCIs = o.showBootstrapCIs;
  if (typeof o.activeTab === 'string' && (TABS as string[]).includes(o.activeTab)) out.activeTab = o.activeTab as ViewState['activeTab'];
  if (o.sandbox !== undefined) out.sandbox = loadSandbox(o.sandbox, base.sandbox, runIds, warn);
  if (o.timingConfig !== undefined) {
    // Every timing field is validated: a NaN band or a null threshold in a
    // hand-edited file once hung the worker or blanked the Timing tab.
    const { config, changed } = clampTimingConfig(o.timingConfig, base.timingConfig);
    out.timingConfig = config;
    if (changed || typeof o.timingConfig !== 'object' || o.timingConfig === null) warn('timing settings were invalid and have been reset to defaults');
  }
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

  // A null or out-of-range date cannot be drawn or formatted: the row is
  // dropped here (alignByDate skips NaN dates) and the file is told about it.
  let badDates = 0;
  for (let i = 0; i < dates.length; i++) if (!validMs(dates[i])) { dates[i] = NaN; badDates++; }
  if (badDates) errors.push(`dataset "${name}": ${badDates} row${badDates === 1 ? '' : 's'} with a missing or out-of-range date ${badDates === 1 ? 'was' : 'were'} skipped.`);

  // The same caps as a fresh import: a project file must not load what the
  // Data tab would refuse (1,000,000 rows, 30 million cells).
  if (dates.length > LIMITS.rows) { errors.push(`dataset "${name}": ${dates.length.toLocaleString('en-US')} rows exceed the ${LIMITS.rows.toLocaleString('en-US')}-row limit; the dataset was not loaded.`); return null; }
  const cells = dates.length * (2 + runsRaw.length);
  if (cells > LIMITS.cells) { errors.push(`dataset "${name}": ${cells.toLocaleString('en-US')} cells exceed the ${LIMITS.cells.toLocaleString('en-US')}-cell limit; the dataset was not loaded.`); return null; }

  const runsIn: { id: unknown; name: string; values: number[]; unit: UnitId; visible: boolean; color?: string }[] = [];
  let malformed = 0;
  for (const rr of runsRaw) {
    if (typeof rr !== 'object' || rr === null) { malformed++; continue; }
    const r = rr as Record<string, unknown>;
    const vals = arrNum(r.values);
    if (!vals || vals.length !== dates.length) { errors.push(`dataset "${name}": simulation "${str(r.name, '?')}" has mismatched length`); return null; }
    runsIn.push({ id: r.id, name: str(r.name, `simulation ${runsIn.length + 1}`), values: vals, unit: unitId(r.inputUnit), visible: r.visible !== false, color: typeof r.color === 'string' ? r.color : undefined });
  }
  if (malformed) errors.push(`dataset "${name}": ${malformed} simulation entr${malformed === 1 ? 'y was' : 'ies were'} not an object and ${malformed === 1 ? 'was' : 'were'} skipped.`);
  if (!runsIn.length) { errors.push(`dataset "${name}": no valid simulations`); return null; }
  if (runsIn.length > LIMITS.runs) {
    errors.push(`dataset "${name}": ${runsIn.length} simulations found; only the first ${LIMITS.runs} were loaded.`);
    runsIn.length = LIMITS.runs;
  }
  if (runsIn.every(r => !r.visible)) {
    // Every tab indexes the visible simulations; an all-hidden dataset has
    // nothing to draw, so the first one is shown and the file is told about it.
    runsIn[0].visible = true;
    errors.push(`dataset "${name}": every simulation was hidden; the first one was made visible.`);
  }

  // Reuse the exact commit-path invariants: joint sort, dedup-first, finite dates.
  const aligned = alignByDate({
    name, dates,
    observed: { name: str(obs!.name, 'observed'), values: obsVals, unit: unitId((obs as Record<string, unknown>).inputUnit ?? d.targetUnit) },
    runs: runsIn.map(r => ({ name: r.name, values: r.values, unit: r.unit })),
  });
  if (aligned.dates.length < 2) { errors.push(`dataset "${name}": fewer than 2 rows with valid dates`); return null; }
  const dup = dates.length - badDates - aligned.dates.length;
  if (dup > 0) errors.push(`dataset "${name}": ${dup} row${dup === 1 ? '' : 's'} repeating an earlier date ${dup === 1 ? 'was' : 'were'} dropped (the first row of each date is kept).`);
  const dsId = idOk(d.id, usedIds) ? d.id : nid('ds');
  usedIds.add(dsId);
  const runIds = new Map<string, string>();
  const newRunIds = aligned.runs.map((_r, i) => {
    const saved = runsIn[i]?.id;
    const id = idOk(saved, usedIds) ? saved : nid('run');
    usedIds.add(id);
    if (typeof saved === 'string') runIds.set(saved, id);
    return id;
  });
  const step = detectStep(aligned.dates);
  const loc = (typeof d.location === 'object' && d.location !== null &&
    typeof (d.location as any).lat === 'number' && typeof (d.location as any).lon === 'number')
    ? { lat: (d.location as any).lat, lon: (d.location as any).lon } : null;

  return {
    id: dsId,
    name,
    dates: aligned.dates,
    observed: { name: aligned.observed.name, values: aligned.observed.values, inputUnit: aligned.observed.unit },
    runs: aligned.runs.map((r, i) => ({
      id: newRunIds[i], name: r.name, values: r.values, inputUnit: r.unit,
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
    view: loadView(d.view, step.ms, aligned.dates.length, msg => errors.push(`dataset "${name}": ${msg}`), runIds),
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
  usedIds.clear();
  const datasets = p.datasets.map(d => loadDataset(d, errors)).filter((d): d is Dataset => d !== null);
  if (p.datasets.length > 0 && datasets.length === 0) {
    throw new Error(`No dataset in the file could be loaded:\n- ${errors.join('\n- ')}`);
  }
  const activeDatasetId = datasets.some(d => d.id === p.activeDatasetId)
    ? p.activeDatasetId as string
    : (datasets[0]?.id ?? null);
  return { project: { schemaVersion: 1, datasets, activeDatasetId }, warnings: errors };
}
