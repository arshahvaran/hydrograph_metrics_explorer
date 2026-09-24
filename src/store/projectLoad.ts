/**
 * QA-007: hardened project-file loading. Every dataset in a loaded file is
 * rebuilt through the SAME normalisation path as a fresh commit (alignByDate:
 * joint sort + dedup + finite-date filter), unknown keys are dropped (which
 * also neutralises hostile __proto__/constructor payloads: we never copy
 * arbitrary keys), and missing newer fields get defaults (forward compat for
 * projects saved by older versions).
 */
import type { Project, Dataset, ViewState, UnitId, AreaUnitId, SandboxState } from '../types'
import { PRESETS, byId } from '../metrics/registry'
import { defaultView, RUN_PALETTE, clampTimingConfig, migrateDtwBand } from '../types'
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
/** A user string quoted in a warning, cut short so a hostile file cannot flood the notice. */
const quote = (s: string) => JSON.stringify(s.length > 60 ? `${s.slice(0, 60)}…` : s);

/*
 * Ids. Every loaded dataset and run gets a FRESH id (nid), never the saved one.
 * The compute caches (frames, panels, CIs, Sandbox) are keyed by dataset and
 * run id, not by the values, so two files that share saved ids (a script that
 * writes .hme.json files with fixed ids, or a copy with one value corrected by
 * hand) once showed the first file's metrics under the second file's name.
 * References between saved fields (activeDatasetId, the sandbox's targetRunId)
 * are resolved through an old-to-new id map instead. When a saved id repeats,
 * the FIRST occurrence wins, as runs.find / datasets.find do in the app, and
 * the file is told about it.
 */

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

/**
 * The step of a loaded dataset: detected from its dates, as always, unless
 * detection can only call them irregular while the file saved a regular step
 * that the dates agree with (no interval shorter than 0.9 of it). A seasonal
 * subset of one month of monthly data keeps one date a year, which reads as
 * an irregular yearly step; its step was detected on the full span when the
 * subset was made ('1mo'), and a depth conversion needs that step.
 */
export function loadStep(saved: unknown, dates: number[]): { ms: number; label: string; irregular: boolean } {
  const det = detectStep(dates);
  const detected = { ms: det.ms, label: det.label, irregular: det.irregular };
  if (!det.irregular || !saved || typeof saved !== 'object') return detected;
  const s = saved as Record<string, unknown>;
  if (typeof s.ms !== 'number' || !Number.isFinite(s.ms) || s.ms <= 0 || typeof s.label !== 'string'
    || s.label.length > 40 || s.irregular !== false) return detected;
  const ms = s.ms;
  for (let i = 1; i < dates.length; i++) if (dates[i] - dates[i - 1] < 0.9 * ms) return detected;
  return { ms, label: s.label, irregular: false };
}

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
      .filter(x => (seen.has(x.id) ? false : (seen.add(x.id), true)))
      // An id the registry does not know scores NaN for every run, so no
      // composite and no recommendation could be computed (audit project-04).
      .filter(x => {
        if (byId.has(x.id)) return true;
        warn(`the priority metric ${quote(x.id)} is unknown and was dropped`);
        return false;
      });
    if (pm.length) out.priorityMetrics = pm.map(x => ({ id: x.id, weight: x.weight }));
    else if ((o.priorityMetrics as unknown[]).length) warn('no saved priority metric could be used; the default priorities are used');
  }
  if (typeof o.showBootstrapCIs === 'boolean') out.showBootstrapCIs = o.showBootstrapCIs;
  if (typeof o.activeTab === 'string' && (TABS as string[]).includes(o.activeTab)) out.activeTab = o.activeTab as ViewState['activeTab'];
  if (o.sandbox !== undefined) out.sandbox = loadSandbox(o.sandbox, base.sandbox, runIds, warn);
  if (o.timingConfig !== undefined) {
    // Every timing field is validated: a NaN band or a null threshold in a
    // hand-edited file once hung the worker or blanked the Timing tab.
    // Files before v1.14 hold the DTW band as a fraction of the record; it is
    // converted to steps (or reset to the default) with a note, never refused.
    const mig = migrateDtwBand(o.timingConfig, n, base.timingConfig);
    if (mig.note) warn(mig.note);
    // Files before v1.14 have no peak separation (it followed the event gap) and
    // saved the old hourly peak window of ±24 steps; the Gauch et al. (2021)
    // defaults (100-step separation, max(12 h, 3 steps) window) replace an
    // untouched old default, with a note.
    const tc0 = mig.raw as Record<string, unknown> | null;
    if (tc0 && typeof tc0 === 'object' && !('peakMinDistance' in tc0)) {
      const oldDefault = stepMs >= 22 * 3600_000 ? 3 : 24;
      if (tc0.peakMatchTolerance === oldDefault && base.timingConfig.peakMatchTolerance !== oldDefault) {
        (mig.raw as Record<string, unknown>).peakMatchTolerance = base.timingConfig.peakMatchTolerance;
        warn(`the project was saved before v1.14: the default peak window of ±${oldDefault} steps is now ±${base.timingConfig.peakMatchTolerance} steps (Gauch et al., 2021)`);
      }
      warn(`the project was saved before v1.14: peak timing now uses its own peak separation of ${base.timingConfig.peakMinDistance} steps (Gauch et al., 2021) instead of the event gap`);
    }
    const { config, changed } = clampTimingConfig(mig.raw, base.timingConfig, n);
    out.timingConfig = config;
    if (changed || typeof o.timingConfig !== 'object' || o.timingConfig === null) warn('timing settings were invalid and have been reset to defaults');
  }
  return out;
}

function loadDataset(raw: unknown, errors: string[], dsIds: Map<string, string>): Dataset | null {
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
  const dsId = nid('ds');
  if (typeof d.id === 'string') {
    if (!dsIds.has(d.id)) dsIds.set(d.id, dsId);
    else errors.push(`dataset "${name}": the dataset id ${quote(d.id)} is repeated in the file; the saved active dataset refers to the first dataset with that id.`);
  }
  // saved run id -> fresh id, first occurrence wins (the Sandbox target is
  // resolved with runs.find, which takes the first run with a matching id)
  const runIds = new Map<string, string>();
  const firstName = new Map<string, string>();
  const repeated = new Set<string>();
  const newRunIds = aligned.runs.map((r, i) => {
    const saved = runsIn[i]?.id;
    const id = nid('run');
    if (typeof saved === 'string') {
      if (!runIds.has(saved)) { runIds.set(saved, id); firstName.set(saved, r.name); }
      else if (!repeated.has(saved)) {
        repeated.add(saved);
        errors.push(`dataset "${name}": the simulation id ${quote(saved)} is repeated; references to it use the first simulation with that id (${quote(firstName.get(saved)!)}).`);
      }
    }
    return id;
  });
  const step = loadStep(d.step, aligned.dates);
  // Same bounds as the Map tab's Set button: an infinite or out-of-range
  // coordinate once made Leaflet try to load an infinite number of tiles.
  let loc: { lat: number; lon: number } | null = null;
  if (d.location != null) {
    const L = d.location as Record<string, unknown>;
    const lat = typeof L === 'object' ? L.lat : undefined, lon = typeof L === 'object' ? L.lon : undefined;
    if (typeof lat === 'number' && typeof lon === 'number' && Number.isFinite(lat) && Number.isFinite(lon)
      && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) loc = { lat, lon };
    else errors.push(`dataset "${name}": the station location is not a valid latitude and longitude (|lat| ≤ 90°, |lon| ≤ 180°) and was dropped.`);
  }

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
  const dsIds = new Map<string, string>();   // saved dataset id -> fresh id
  const datasets = p.datasets.map(d => loadDataset(d, errors, dsIds)).filter((d): d is Dataset => d !== null);
  if (p.datasets.length > 0 && datasets.length === 0) {
    throw new Error(`No dataset in the file could be loaded:\n- ${errors.join('\n- ')}`);
  }
  const activeDatasetId = (typeof p.activeDatasetId === 'string' ? dsIds.get(p.activeDatasetId) : undefined)
    ?? (datasets[0]?.id ?? null);
  return { project: { schemaVersion: 1, datasets, activeDatasetId }, warnings: errors };
}
