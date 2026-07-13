// Single source of truth for metric metadata (§11.1) and the orchestrator that
// computes the full panel for one (obs, run) pair under the active view settings.

import * as C from './classical/catalogue'
import { applyNanPolicy, type NanPolicy } from '../ingest/missing'
import { peakTiming, eventErrors, lagSweep, type EventOptions } from './timing/events'
import { dtw, wasserstein1, wasserstein2sq } from './timing/dtwWasserstein'
import { diagnosticEfficiency, seriesDistance } from './timing/deSd'
import { xwtLag } from './timing/xwt'
import type { TimingConfig } from '../types'

export type Direction = 'max' | 'min' | 'zero' | 'one';

export interface MetricMeta {
  id: string;
  label: string;
  group: 'Error norms' | 'Correlation & agreement' | 'Efficiencies' | 'FDC signatures' | 'Timing & shape';
  optimum: string;
  direction: Direction;
  range: string;
  timing: boolean;
  unitful: boolean;          // carries data units (else dimensionless / % / steps)
  digits: number;
  blurb: string;             // what it measures + blind spot ("what existing tools miss" for timing)
}

const M = (m: MetricMeta) => m;

export const REGISTRY: MetricMeta[] = [
  // ----- error norms -----
  M({ id: 'me', label: 'ME (mean error)', group: 'Error norms', optimum: '0', direction: 'zero', range: '(−∞,∞)', timing: false, unitful: true, digits: 3, blurb: 'Mean of sim−obs; positive = over-estimation on average. Cancels compensating errors.' }),
  M({ id: 'mae', label: 'MAE', group: 'Error norms', optimum: '0', direction: 'min', range: '[0,∞)', timing: false, unitful: true, digits: 3, blurb: 'Mean absolute error. Blind to timing: a shifted flood costs the same as a wrong-sized one.' }),
  M({ id: 'mdae', label: 'MdAE (median |e|)', group: 'Error norms', optimum: '0', direction: 'min', range: '[0,∞)', timing: false, unitful: true, digits: 3, blurb: 'Median absolute error; robust to outliers, dominated by low flows.' }),
  M({ id: 'mse', label: 'MSE', group: 'Error norms', optimum: '0', direction: 'min', range: '[0,∞)', timing: false, unitful: true, digits: 3, blurb: 'Mean squared error; heavily weights peaks — and doubly punishes shifted peaks.' }),
  M({ id: 'rmse', label: 'RMSE', group: 'Error norms', optimum: '0', direction: 'min', range: '[0,∞)', timing: false, unitful: true, digits: 3, blurb: 'Root mean squared error, in data units. The double-penalty problem lives here.' }),
  M({ id: 'rsr', label: 'RSR (RMSE/σobs)', group: 'Error norms', optimum: '0', direction: 'min', range: '[0,∞)', timing: false, unitful: false, digits: 3, blurb: 'RMSE standardised by observed spread (Moriasi et al., 2007).' }),
  M({ id: 'nrmse_mean', label: 'NRMSE (mean)', group: 'Error norms', optimum: '0', direction: 'min', range: '[0,∞)', timing: false, unitful: false, digits: 3, blurb: 'RMSE / mean(obs).' }),
  M({ id: 'nrmse_range', label: 'NRMSE (range)', group: 'Error norms', optimum: '0', direction: 'min', range: '[0,∞)', timing: false, unitful: false, digits: 3, blurb: 'RMSE / (max−min of obs).' }),
  M({ id: 'nrmse_iqr', label: 'NRMSE (IQR)', group: 'Error norms', optimum: '0', direction: 'min', range: '[0,∞)', timing: false, unitful: false, digits: 3, blurb: 'RMSE / interquartile range of obs.' }),
  M({ id: 'mape', label: 'MAPE %', group: 'Error norms', optimum: '0', direction: 'min', range: '[0,∞)', timing: false, unitful: false, digits: 2, blurb: 'Mean absolute percent error; explodes near zero flows.' }),
  M({ id: 'smape', label: 'sMAPE %', group: 'Error norms', optimum: '0', direction: 'min', range: '[0,200]', timing: false, unitful: false, digits: 2, blurb: 'Symmetric MAPE on the 0–200 % scale.' }),
  M({ id: 'maape', label: 'MAAPE', group: 'Error norms', optimum: '0', direction: 'min', range: '[0,π/2]', timing: false, unitful: false, digits: 3, blurb: 'Arctangent-bounded percent error (Kim & Kim, 2016); safe at zero flows.' }),
  M({ id: 'mare', label: 'MARE', group: 'Error norms', optimum: '0', direction: 'min', range: '[0,∞)', timing: false, unitful: false, digits: 3, blurb: 'Mean absolute relative error.' }),
  M({ id: 'msle', label: 'MSLE', group: 'Error norms', optimum: '0', direction: 'min', range: '[0,∞)', timing: false, unitful: false, digits: 4, blurb: 'Mean squared log error; emphasises low flows.' }),
  M({ id: 'mase', label: 'MASE', group: 'Error norms', optimum: '0', direction: 'min', range: '[0,∞)', timing: false, unitful: false, digits: 3, blurb: 'Error scaled by naive persistence (Hyndman & Koehler, 2006); <1 beats persistence.' }),

  // ----- correlation & agreement -----
  M({ id: 'r', label: 'r (Pearson)', group: 'Correlation & agreement', optimum: '1', direction: 'max', range: '[−1,1]', timing: false, unitful: false, digits: 3, blurb: 'Linear association. Completely blind to bias and to amplitude scaling.' }),
  M({ id: 'r2', label: 'R²', group: 'Correlation & agreement', optimum: '1', direction: 'max', range: '[0,1]', timing: false, unitful: false, digits: 3, blurb: 'Squared Pearson r; same blind spots as r.' }),
  M({ id: 'wr2', label: 'wR² (slope-weighted)', group: 'Correlation & agreement', optimum: '1', direction: 'max', range: '[0,1]', timing: false, unitful: false, digits: 3, blurb: 'R² penalised by regression slope ≠ 1 (Krause et al., 2005).' }),
  M({ id: 'spearman', label: 'ρ (Spearman)', group: 'Correlation & agreement', optimum: '1', direction: 'max', range: '[−1,1]', timing: false, unitful: false, digits: 3, blurb: 'Rank correlation; robust to monotone distortion.' }),
  M({ id: 'd', label: 'd (Willmott)', group: 'Correlation & agreement', optimum: '1', direction: 'max', range: '[0,1]', timing: false, unitful: false, digits: 3, blurb: 'Index of agreement.' }),
  M({ id: 'd1', label: 'd₁', group: 'Correlation & agreement', optimum: '1', direction: 'max', range: '[0,1]', timing: false, unitful: false, digits: 3, blurb: 'Absolute-error index of agreement.' }),
  M({ id: 'dr', label: 'dᵣ (refined)', group: 'Correlation & agreement', optimum: '1', direction: 'max', range: '[−1,1]', timing: false, unitful: false, digits: 3, blurb: 'Refined index of agreement (Willmott et al., 2012).' }),
  M({ id: 'drel', label: 'd_rel', group: 'Correlation & agreement', optimum: '1', direction: 'max', range: '(−∞,1]', timing: false, unitful: false, digits: 3, blurb: 'Relative-error index of agreement.' }),
  M({ id: 'lm_index', label: 'E₁ (Legates–McCabe)', group: 'Correlation & agreement', optimum: '1', direction: 'max', range: '(−∞,1]', timing: false, unitful: false, digits: 3, blurb: 'Absolute-error efficiency; less peak-dominated than NSE.' }),

  // ----- efficiencies -----
  M({ id: 'nse', label: 'NSE', group: 'Efficiencies', optimum: '1', direction: 'max', range: '(−∞,1]', timing: false, unitful: false, digits: 3, blurb: 'Nash–Sutcliffe. Squared errors ⇒ double penalty for timing offsets; benchmark is the mean flow.' }),
  M({ id: 'nse_mod', label: 'NSE₁ (modified)', group: 'Efficiencies', optimum: '1', direction: 'max', range: '(−∞,1]', timing: false, unitful: false, digits: 3, blurb: 'NSE with absolute errors (j = 1).' }),
  M({ id: 'nse_rel', label: 'NSE_rel', group: 'Efficiencies', optimum: '1', direction: 'max', range: '(−∞,1]', timing: false, unitful: false, digits: 3, blurb: 'NSE on relative deviations; emphasises low flows.' }),
  M({ id: 'lognse', label: 'logNSE', group: 'Efficiencies', optimum: '1', direction: 'max', range: '(−∞,1]', timing: false, unitful: false, digits: 3, blurb: 'NSE of log flows (ε = 0.01·mean obs); low-flow oriented.' }),
  M({ id: 'kge2009', label: 'KGE (2009)', group: 'Efficiencies', optimum: '1', direction: 'max', range: '(−∞,1]', timing: false, unitful: false, digits: 3, blurb: 'Kling–Gupta: r, α = σs/σo, β = μs/μo. Timing hides inside r only. Mean-flow benchmark scores −0.41.' }),
  M({ id: 'kge2012', label: 'KGE′ (2012)', group: 'Efficiencies', optimum: '1', direction: 'max', range: '(−∞,1]', timing: false, unitful: false, digits: 3, blurb: 'KGE with γ = CV ratio replacing α, decoupling bias and variability.' }),
  M({ id: 'kge2021', label: 'KGE″ (2021)', group: 'Efficiencies', optimum: '1', direction: 'max', range: '(−∞,1]', timing: false, unitful: false, digits: 3, blurb: 'KGE with non-dimensional bias β″ = (μs−μo)/σo (Tang et al., 2021); robust when μo → 0.' }),
  M({ id: 'kgenp', label: 'KGEnp', group: 'Efficiencies', optimum: '1', direction: 'max', range: '(−∞,1]', timing: false, unitful: false, digits: 3, blurb: 'Non-parametric KGE (Pool et al., 2018): Spearman r + normalised-FDC α.' }),
  M({ id: 've', label: 'VE (volumetric)', group: 'Efficiencies', optimum: '1', direction: 'max', range: '(−∞,1]', timing: false, unitful: false, digits: 3, blurb: 'Volumetric efficiency (Criss & Winston, 2008).' }),
  M({ id: 'pbias', label: 'PBIAS % (+ = under)', group: 'Efficiencies', optimum: '0', direction: 'zero', range: '(−∞,∞)', timing: false, unitful: false, digits: 2, blurb: '100·Σ(O−S)/ΣO — positive means the model under-estimates volume (paper Table 2 convention).' }),
  M({ id: 'beta_nse', label: 'β-NSE bias', group: 'Efficiencies', optimum: '0', direction: 'zero', range: '(−∞,∞)', timing: false, unitful: false, digits: 3, blurb: '(μs−μo)/σo — the standardised bias term.' }),
  M({ id: 'alpha', label: 'α (σs/σo)', group: 'Efficiencies', optimum: '1', direction: 'one', range: '[0,∞)', timing: false, unitful: false, digits: 3, blurb: 'Variability ratio; <1 = flashiness under-estimated.' }),

  // ----- FDC signatures -----
  M({ id: 'fhv', label: '%BiasFHV (top 2 %)', group: 'FDC signatures', optimum: '0', direction: 'zero', range: '(−∞,∞)', timing: false, unitful: false, digits: 2, blurb: 'High-flow-volume bias of the FDC (Yilmaz et al., 2008).' }),
  M({ id: 'flv', label: '%BiasFLV (low 30 %)', group: 'FDC signatures', optimum: '0', direction: 'zero', range: '(−∞,∞)', timing: false, unitful: false, digits: 2, blurb: 'Low-flow-volume bias in log space; positive = simulated low flows too low.' }),
  M({ id: 'fms', label: '%BiasFMS (slope 20–70 %)', group: 'FDC signatures', optimum: '0', direction: 'zero', range: '(−∞,∞)', timing: false, unitful: false, digits: 2, blurb: 'Mid-segment FDC slope bias — flashiness of the regime.' }),
  M({ id: 'fmm', label: '%BiasFMM (median)', group: 'FDC signatures', optimum: '0', direction: 'zero', range: '(−∞,∞)', timing: false, unitful: false, digits: 2, blurb: 'Median-flow bias in log space.' }),

  // ----- timing & shape -----
  M({ id: 'peak_lag_abs', label: 'Peak timing |lag|', group: 'Timing & shape', optimum: '0', direction: 'min', range: '[0,∞) steps', timing: true, unitful: false, digits: 2, blurb: 'Mean |lag| of matched hydrograph peaks (Gauch et al., 2021). Directly answers "how late are my floods?" — invisible to NSE/KGE.' }),
  M({ id: 'peak_lag_signed', label: 'Peak timing bias', group: 'Timing & shape', optimum: '0', direction: 'zero', range: '(−∞,∞) steps', timing: true, unitful: false, digits: 2, blurb: 'Mean signed peak lag; + = simulated peaks late. Cancels mixed early/late errors — read with |lag|.' }),
  M({ id: 'event_threat', label: 'Event occurrence (threat)', group: 'Timing & shape', optimum: '1', direction: 'max', range: '[0,1]', timing: true, unitful: false, digits: 3, blurb: 'Hits/(hits+misses+false alarms) of threshold events — did the model produce the flood at all?' }),
  M({ id: 'event_vol', label: 'Event volume err %', group: 'Timing & shape', optimum: '0', direction: 'zero', range: '(−∞,∞)', timing: true, unitful: false, digits: 2, blurb: 'Mean per-event volume error over observed event windows.' }),
  M({ id: 'event_lag', label: 'Event peak lag (median)', group: 'Timing & shape', optimum: '0', direction: 'zero', range: '(−∞,∞) steps', timing: true, unitful: false, digits: 2, blurb: 'Median per-event peak lag; + = late.' }),
  M({ id: 'lag_best', label: 'Lag at best fit', group: 'Timing & shape', optimum: '0', direction: 'zero', range: 'steps', timing: true, unitful: false, digits: 0, blurb: 'Shift that maximises NSE in the lag sweep — the record-wide timing offset a synchronous metric never reports.' }),
  M({ id: 'de', label: 'DE (diagnostic eff.)', group: 'Timing & shape', optimum: '0', direction: 'min', range: '[0,∞)', timing: true, unitful: false, digits: 3, blurb: 'Schwemmle et al. (2021): √(constant² + dynamic² + (r−1)²); decomposes into the polar plot on the Timing tab. Needs perennial flow.' }),
  M({ id: 'de_const', label: 'DE constant (B̄rel)', group: 'Timing & shape', optimum: '0', direction: 'zero', range: '(−∞,∞)', timing: true, unitful: false, digits: 3, blurb: 'Mean relative FDC bias — the constant error share.' }),
  M({ id: 'de_dyn', label: 'DE dynamic (|B|area)', group: 'Timing & shape', optimum: '0', direction: 'min', range: '[0,∞)', timing: true, unitful: false, digits: 3, blurb: 'Area of residual FDC bias — high-vs-low-flow error trade.' }),
  M({ id: 'sd_occ', label: 'SD occurrence', group: 'Timing & shape', optimum: '1', direction: 'max', range: '[0,1]', timing: true, unitful: false, digits: 3, blurb: 'Series Distance event threat score (Ehret & Zehe, 2011).' }),
  M({ id: 'sd_amp', label: 'SD amplitude err %', group: 'Timing & shape', optimum: '0', direction: 'zero', range: '(−∞,∞)', timing: true, unitful: false, digits: 2, blurb: 'Mean relative amplitude offset on matched rise/recession segments.' }),
  M({ id: 'sd_time', label: 'SD timing err', group: 'Timing & shape', optimum: '0', direction: 'zero', range: '(−∞,∞) steps', timing: true, unitful: false, digits: 2, blurb: 'Mean timing offset on matched segments; + = sim late. The component classical scores fold invisibly into amplitude error.' }),
  M({ id: 'dtw_warp', label: 'DTW mean |warp|', group: 'Timing & shape', optimum: '0', direction: 'min', range: '[0,∞) steps', timing: true, unitful: false, digits: 2, blurb: 'Mean |i−j| along the optimal Sakoe–Chiba-banded alignment — average timing distortion in steps.' }),
  M({ id: 'dtw_dist', label: 'DTW distance (per step)', group: 'Timing & shape', optimum: '0', direction: 'min', range: '[0,∞)', timing: true, unitful: true, digits: 3, blurb: 'Alignment-invariant amplitude mismatch after optimal warping.' }),
  M({ id: 'w1', label: 'Wasserstein W₁', group: 'Timing & shape', optimum: '0', direction: 'min', range: '[0,∞) steps', timing: true, unitful: false, digits: 2, blurb: 'Earth-mover distance between mass-normalised hydrographs over time: equals the lag exactly under a pure shift; volume-blind by construction.' }),
  M({ id: 'w2sq', label: 'Wasserstein W₂²', group: 'Timing & shape', optimum: '0', direction: 'min', range: '[0,∞) steps²', timing: true, unitful: false, digits: 2, blurb: 'Squared-lag form featured in the paper (Magyar & Sambridge, 2023): smooth and convex in the shift where NSE collapses.' }),
  M({ id: 'xwt_lag', label: 'XWT phase lag', group: 'Timing & shape', optimum: '0', direction: 'zero', range: '(−∞,∞) steps', timing: true, unitful: false, digits: 2, blurb: 'Power-weighted mean cross-wavelet lag over red-noise-significant, in-cone regions (Morlet; Torrence & Compo, 1998). Scale-resolved curve on the Timing tab.' }),
];

export const byId = new Map(REGISTRY.map(m => [m.id, m]));

export const PRESETS: Record<string, string[] | 'all'> = {
  Essentials: ['nse', 'kge2009', 'rmse', 'pbias', 'r'],
  'Timing-aware': ['nse', 'kge2009', 'rmse', 'pbias', 'r', 'peak_lag_abs', 'event_threat', 'event_lag', 'lag_best', 'de', 'sd_time', 'dtw_warp', 'w1', 'w2sq', 'xwt_lag'],
  Everything: 'all',
};

export interface ComputeContext {
  nanPolicy: NanPolicy;
  transform: C.Transform;
  timing: TimingConfig;
  datesMs?: number[];
  heavy?: boolean;           // include DTW / XWT / SD / DE / events (default true)
}

export interface ComputeOutput {
  values: Record<string, number>;
  n: number;
  notes: string[];
  extras: {
    kge2009: C.KgeResult; kge2012: C.KgeResult; kge2021: C.KgeResult; kgenp: C.KgeResult;
    de?: ReturnType<typeof diagnosticEfficiency>;
    peaks?: ReturnType<typeof peakTiming>;
    events?: ReturnType<typeof eventErrors>;
    sd?: ReturnType<typeof seriesDistance>;
    dtw?: ReturnType<typeof dtw>;
    xwt?: ReturnType<typeof xwtLag>;
    sweep?: ReturnType<typeof lagSweep>;
  };
}

/** Compute every metric for one run against observed under the current view. */
export function computeAll(obsRaw: ArrayLike<number>, simRaw: ArrayLike<number>, ctx: ComputeContext): ComputeOutput {
  const paired = applyNanPolicy(obsRaw, simRaw, ctx.nanPolicy);
  const { o, s, note } = C.applyTransform(paired.obs, paired.sim, ctx.transform);
  const notes: string[] = note ? [note] : [];
  const heavy = ctx.heavy !== false;

  const k09 = C.kge2009(o, s), k12 = C.kge2012(o, s), k21 = C.kge2021(o, s), knp = C.kgenp(o, s);
  const values: Record<string, number> = {
    me: C.me(o, s), mae: C.mae(o, s), mdae: C.mdae(o, s), mse: C.mse(o, s), rmse: C.rmse(o, s),
    rsr: C.rsr(o, s), nrmse_mean: C.nrmseMean(o, s), nrmse_range: C.nrmseRange(o, s), nrmse_iqr: C.nrmseIqr(o, s),
    mape: C.mape(o, s), smape: C.smape(o, s), maape: C.maape(o, s), mare: C.mare(o, s),
    msle: C.msle(o, s), mase: C.mase(o, s),
    r: C.r(o, s), r2: C.r2(o, s), wr2: C.wr2(o, s), spearman: C.spearman(o, s),
    d: C.d(o, s), d1: C.d1(o, s), dr: C.dr(o, s), drel: C.drel(o, s), lm_index: C.lmIndex(o, s),
    nse: C.nse(o, s), nse_mod: C.nseMod(o, s), nse_rel: C.nseRel(o, s), lognse: C.logNse(o, s),
    kge2009: k09.value, kge2012: k12.value, kge2021: k21.value, kgenp: knp.value,
    ve: C.ve(o, s), pbias: C.pbias(o, s), beta_nse: C.betaNse(o, s), alpha: C.alphaRatio(o, s),
    fhv: C.fhv(o, s), flv: C.flv(o, s), fms: C.fms(o, s), fmm: C.fmm(o, s),
  };

  const extras: ComputeOutput['extras'] = { kge2009: k09, kge2012: k12, kge2021: k21, kgenp: knp };

  if (heavy && o.length >= 4) {
    const t = ctx.timing;
    const evOpt: EventOptions = {
      thresholdKind: t.eventThreshold.kind, thresholdValue: t.eventThreshold.value,
      minDistance: t.eventMinDistance, warmup: t.eventWarmup,
    };
    const daily = true;
    const de = diagnosticEfficiency(o, s);
    const peaks = peakTiming(o, s, { prominence: t.peakProminence, minDistance: 100, window: t.peakMatchTolerance });
    const events = eventErrors(o, s, evOpt, t.peakMatchTolerance);
    const sd = seriesDistance(o, s, evOpt, t.peakMatchTolerance);
    // DTW guard for very long series: decimate to keep the DP tractable
    let dtwRes; let dtwDecim = 1;
    if (o.length > 6000) {
      dtwDecim = Math.ceil(o.length / 4000);
      const m = Math.floor(o.length / dtwDecim);
      const o2 = new Float64Array(m), s2 = new Float64Array(m);
      for (let i = 0; i < m; i++) { o2[i] = o[i * dtwDecim]; s2[i] = s[i * dtwDecim]; }
      dtwRes = dtw(o2, s2, t.dtwBandFraction);
      notes.push(`DTW computed on 1/${dtwDecim} decimation for tractability`);
    } else {
      dtwRes = dtw(o, s, t.dtwBandFraction);
    }
    const xw = xwtLag(o, s);
    const sweep = lagSweep(o, s, -30, 30);

    values.peak_lag_abs = peaks.meanAbsLag;
    values.peak_lag_signed = peaks.meanSignedLag;
    values.event_threat = events.threat;
    values.event_vol = events.meanVolumeErrPct;
    values.event_lag = events.medianPeakLag;
    values.lag_best = sweep.bestLag;
    values.de = de.de; values.de_const = de.brelMean; values.de_dyn = de.bArea;
    values.sd_occ = sd.occurrence; values.sd_amp = sd.meanAmplitudeErrPct; values.sd_time = sd.meanTimingErr;
    values.dtw_warp = dtwRes.meanAbsWarp * dtwDecim;
    values.dtw_dist = dtwRes.normalized;
    values.w1 = wasserstein1(o, s);
    values.w2sq = wasserstein2sq(o, s);
    values.xwt_lag = xw.headlineLag;

    if (de.nonPerennial) notes.push('DE: observed record is not strictly positive — diagnostic efficiency assumptions violated');
    if (events.events.length === 0) notes.push('No events at the current threshold — raise/lower it on the Timing tab');

    Object.assign(extras, { de, peaks, events, sd, dtw: dtwRes, xwt: xw, sweep });
  }

  return { values, n: paired.n, notes, extras };
}

/** Bounded C2M display transform for unbounded-below efficiencies (§11.4). */
export const C2M_APPLICABLE = new Set(['nse', 'nse_mod', 'nse_rel', 'lognse', 'kge2009', 'kge2012', 'kge2021', 'kgenp', 've', 'lm_index', 'drel']);
export const toC2M = C.c2m;
