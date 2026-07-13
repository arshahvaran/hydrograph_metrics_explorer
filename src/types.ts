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
  /** Sakoe–Chiba band as a fraction of series length n (default 0.1). */
  dtwBandFraction: number;
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
  activeTab: 'data' | 'metrics' | 'plots' | 'timing' | 'sandbox' | 'map';
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
    dtwBandFraction: 0.1,
    waveletScales: 'auto',
    eventThreshold: { kind: 'percentile', value: 90 },
    eventMinDistance: daily ? 5 : 24,
    eventWarmup: 0,
    // Gauch et al. (2021): search window 1 day for hourly data, 3 days for daily data.
    peakMatchTolerance: daily ? 3 : 24,
    peakProminence: 'auto',
  };
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
      { id: 'kge2009', weight: 1 },
      { id: 'nse', weight: 1 },
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
