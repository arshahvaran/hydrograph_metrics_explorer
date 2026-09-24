// Data model per webtool_v3.md §4.
// Dates are stored as UTC epoch milliseconds on a single shared, ascending index.

export type UnitId =
  | 'm3s' | 'cfs' | 'ls' | 'm3day' | 'MLday' | 'MGD' | 'acftday'   // volumetric flow
  | 'mm_step' | 'in_day'                                            // depth per interval
  | 'dimensionless';

export type UnitKind = 'volumetric' | 'depth' | 'dimensionless';

export type AreaUnitId = 'km2' | 'mi2' | 'ha' | 'acre';

export interface SeriesData {
  /** Values aligned to Dataset.dates; NaN encodes missing. */
  values: Float64Array | number[];
  /** Unit the values were provided in (before conversion to the dataset target unit). */
  inputUnit: UnitId;
  name: string;
}

export interface Run extends SeriesData {
  id: string;
  visible: boolean;
  color: string;
}

export interface TimingConfig {
  /** Sakoe–Chiba band half-width in time steps: the largest time offset DTW
   *  may use (default: the peak-match window; range 1 step to 10 % of n).
   *  Project files before v1.14 stored dtwBandFraction instead; see
   *  migrateDtwBand. */
  dtwBand: number;
  /** 'auto' or explicit list of wavelet scales (in steps). */
  waveletScales: 'auto' | number[];
  eventThreshold: { kind: 'percentile' | 'absolute'; value: number };
  /** Minimum separation between detected events, in steps. */
  eventMinDistance: number;
  /** Steps excluded at the start of the record before event detection. */
  eventWarmup: number;
  /** Peak matching search window, in steps (default is step-aware, see defaults()). */
  peakMatchTolerance: number;
  /** Peak prominence threshold; 'auto' = std of observed (Gauch et al., 2021). */
  peakProminence: 'auto' | number;
}

export interface SandboxState {
  mode: 'perturb' | 'synthetic';
  targetRunId: string | null;
  shiftSteps: number;      // Δt, integer steps, −30…+30 default range
  offset: number;          // β, in target units
  scale: number;           // γ, 0…3
  dampen: number;          // δ, 0…1
  noiseAmp: number;        // ε amplitude
  noiseKind: 'uniform' | 'gaussian';
  noiseSeed: number;
  enabled: boolean;
}

export interface ViewState {
  activeTab: 'data' | 'metrics' | 'plots' | 'timing' | 'sandbox' | 'compare' | 'map' | 'report';
  activePlot: string;
  /** Contiguous analysis window [startMs, endMs] or null = full record. */
  window: [number, number] | null;
  /** Recurring seasonal filter, day-of-year span (wraps across new year if start > end). */
  season: { startDoy: number; endDoy: number } | null;
  resample: 'native' | 'daily' | 'monthly';
  nanPolicy: 'pairwise' | 'zero' | 'mean';
  transform: 'none' | 'log' | 'sqrt' | 'inverse';
  benchmark: 'mean' | 'climatology' | 'persistence';
  selectedMetrics: string[];
  priorityMetrics: { id: string; weight: number }[];
  boundedDisplay: boolean;       // C2M display toggle
  showBootstrapCIs: boolean;     // v1.1
  timingConfig: TimingConfig;
  sandbox: SandboxState;
  plotToggles: {
    log: boolean;
    derivative: boolean;
    cumulative: boolean;
    movingAverage: number | null;
    fromMean: boolean;
    threshold: number | null;
  };
}

export interface Dataset {
  id: string;
  name: string;
  /** Shared ascending UTC date index (epoch ms). */
  dates: number[];
  observed: SeriesData;
  runs: Run[];
  /** Detected time step in ms and a human label like '1d', '1h', '1mo'. */
  step: { ms: number; label: string; irregular: boolean };
  targetUnit: UnitId;
  location: { lat: number; lon: number } | null;
  area: { value: number; unit: AreaUnitId } | null;
  view: ViewState;
  createdAt: number;
}

export interface Project {
  schemaVersion: 1;
  datasets: Dataset[];
  activeDatasetId: string | null;
}

export function defaultTimingConfig(stepMs: number, n: number): TimingConfig {
  const daily = stepMs >= 22 * 3600_000; // daily or coarser
  return {
    // the largest physically credible lag, taken as the default peak-match
    // window below (Sakoe & Chiba, 1978, set the window from the plausible
    // timing deviation, not from the record length); never above the
    // accepted range of 10 % of a very short record
    dtwBand: Math.min(daily ? 3 : 24, dtwBandMax(n)),
    waveletScales: 'auto',
    eventThreshold: { kind: 'percentile', value: 90 },
    eventMinDistance: daily ? 5 : 24,
    eventWarmup: 0,
    // Gauch et al. (2021): search window 1 day for hourly data, 3 days for daily data.
    peakMatchTolerance: daily ? 3 : 24,
    peakProminence: 'auto',
  };
}

/** Accepted ranges for the timing settings; the Timing tab clamps at the
 *  control and the project loader and store clamp again. The DTW band is a
 *  whole number of steps (its upper bound for a record of n steps is
 *  dtwBandMax(n), 10 % of n), the percentile a value in [0, 100]. */
export const TIMING_RANGES = {
  eventPercentile: [0, 100],
  eventMinDistance: [1, 100_000],
  eventWarmup: [0, 10_000_000],
  peakMatchTolerance: [1, 10_000],
  dtwBand: [1, 100_000],
  peakProminence: [0, Number.MAX_VALUE],
} as const;

/** Largest DTW band offered for a record of n steps: 10 % of n, at least 1. */
export const dtwBandMax = (n: number): number =>
  Math.max(1, Math.min(TIMING_RANGES.dtwBand[1], Math.floor(n / 10)));

const finiteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Project files before v1.14 stored the DTW band as a fraction of the record
 * (dtwBandFraction, default 0.1). The band is now a number of steps. A file
 * that still has the fraction (and no dtwBand) is migrated here, with a note:
 * the old default of 10 % becomes the new default band (10 % of the record
 * was the setting that let DTW hide amplitude error as timing); any other
 * fraction becomes round(fraction × n) steps, limited to 1 … dtwBandMax(n);
 * an unreadable fraction falls back to the default. Loading never fails here.
 */
export function migrateDtwBand(raw: unknown, n: number, base: TimingConfig): { raw: unknown; note: string | null } {
  if (typeof raw !== 'object' || raw === null) return { raw, note: null };
  const o = raw as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(o, 'dtwBandFraction')) return { raw, note: null };
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o)) if (k !== 'dtwBandFraction') out[k] = o[k];
  if (o.dtwBand !== undefined) return { raw: out, note: null };
  const f = o.dtwBandFraction;
  const def = base.dtwBand;
  if (f === 0.1) {
    return { raw: out, note: `the DTW band was the old default of 10% of the record; the band is now set in time steps, and the default of ${def} step${def === 1 ? '' : 's'} (the peak window) is used` };
  }
  if (finiteNum(f) && f > 0) {
    const hi = dtwBandMax(n);
    const want = Math.max(1, Math.round(f * n));
    const steps = Math.min(hi, want);
    out.dtwBand = steps;
    const pct = Number((f * 100).toPrecision(4));
    return { raw: out, note: `the DTW band of ${pct}% of the record was converted to ${steps} time step${steps === 1 ? '' : 's'}${steps < want ? ' (the band is limited to 10% of the record)' : ''}` };
  }
  return { raw: out, note: `the DTW band in the file was not a valid fraction of the record; the default of ${def} step${def === 1 ? '' : 's'} is used` };
}

/**
 * Coerce an untrusted timing configuration (a hand-edited project file, a
 * cleared number box) into a valid one. Unknown or non-finite fields fall
 * back to `base`; out-of-range numbers are clamped. `changed` reports
 * whether anything that WAS supplied had to be corrected (missing fields are
 * forward-compatibility, not corruption). A NaN band fraction once sent the
 * DTW backtrack into an unbounded loop and a null threshold crashed the
 * Timing tab, so every field is checked here. With `n` (the record length)
 * the DTW band is also limited to dtwBandMax(n).
 */
export function clampTimingConfig(raw: unknown, base: TimingConfig, n?: number): { config: TimingConfig; changed: boolean } {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  let changed = false;
  const take = (v: unknown, range: readonly [number, number], d: number, integer = false): number => {
    if (!finiteNum(v)) { if (v !== undefined) changed = true; return d; }
    const x = integer ? Math.round(v) : v;
    const c = Math.min(range[1], Math.max(range[0], x));
    if (c !== v) changed = true;
    return c;
  };
  let eventThreshold = { ...base.eventThreshold };
  if (o.eventThreshold !== undefined) {
    const et = o.eventThreshold as Record<string, unknown> | null;
    const kind = et && (et.kind === 'percentile' || et.kind === 'absolute') ? et.kind : null;
    if (!et || typeof et !== 'object' || !kind || !finiteNum(et.value)) changed = true;
    const k = kind ?? base.eventThreshold.kind;
    const v = et && finiteNum(et.value) ? et.value : base.eventThreshold.value;
    const value = k === 'percentile' ? take(v, TIMING_RANGES.eventPercentile, base.eventThreshold.value) : v;
    eventThreshold = { kind: k, value };
  }
  let waveletScales: TimingConfig['waveletScales'] = base.waveletScales;
  if (o.waveletScales !== undefined) {
    if (o.waveletScales === 'auto') waveletScales = 'auto';
    else if (Array.isArray(o.waveletScales) && o.waveletScales.length > 0 && o.waveletScales.every(x => finiteNum(x) && x > 0)) waveletScales = o.waveletScales.slice() as number[];
    else changed = true;
  }
  let peakProminence: TimingConfig['peakProminence'] = base.peakProminence;
  if (o.peakProminence !== undefined) {
    if (o.peakProminence === 'auto') peakProminence = 'auto';
    else peakProminence = take(o.peakProminence, TIMING_RANGES.peakProminence, typeof base.peakProminence === 'number' ? base.peakProminence : 0);
  }
  const config: TimingConfig = {
    dtwBand: take(o.dtwBand,
      n === undefined ? TIMING_RANGES.dtwBand : [TIMING_RANGES.dtwBand[0], dtwBandMax(n)],
      base.dtwBand, true),
    waveletScales,
    eventThreshold,
    eventMinDistance: take(o.eventMinDistance, TIMING_RANGES.eventMinDistance, base.eventMinDistance, true),
    eventWarmup: take(o.eventWarmup, TIMING_RANGES.eventWarmup, base.eventWarmup, true),
    peakMatchTolerance: take(o.peakMatchTolerance, TIMING_RANGES.peakMatchTolerance, base.peakMatchTolerance, true),
    peakProminence,
  };
  return { config, changed };
}

export function defaultView(stepMs: number, n: number): ViewState {
  return {
    activeTab: 'data',
    activePlot: 'timeseries',
    window: null,
    season: null,
    resample: 'native',
    nanPolicy: 'pairwise',
    transform: 'none',
    benchmark: 'mean',
    selectedMetrics: ['nse', 'kge2009', 'rmse', 'pbias', 'r'],
    priorityMetrics: [
      { id: 'nse', weight: 1 },
      { id: 'kge2009', weight: 1 },
      { id: 'w1', weight: 1 },
      { id: 'peak_lag_abs', weight: 1 },
    ],
    boundedDisplay: false,
    showBootstrapCIs: false,
    timingConfig: defaultTimingConfig(stepMs, n),
    sandbox: {
      mode: 'perturb',
      targetRunId: null,
      shiftSteps: 0,
      offset: 0,
      scale: 1,
      dampen: 0,
      noiseAmp: 0,
      noiseKind: 'uniform',
      noiseSeed: 42,
      enabled: false,
    },
    plotToggles: {
      log: false,
      derivative: false,
      cumulative: false,
      movingAverage: null,
      fromMean: false,
      threshold: null,
    },
  };
}

/**
 * Run palette matching the paper's figure style: first run takes the
 * "simulated" orange used throughout the figures, then the ColorBrewer Dark2
 * family (colour-vision friendly). Observed is reserved the figures' blue.
 */
export const RUN_PALETTE = [
  '#d95f02', '#7570b3', '#e7298a', '#1b9e77',
  '#e6ab02', '#66a61e', '#a6761d', '#666666',
  '#0072B2', '#CC79A7', '#56B4E9', '#8C510A',
];

export const OBSERVED_COLOR = '#1f77b4';
