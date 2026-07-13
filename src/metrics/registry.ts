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
  /** KaTeX source for the reference table. O = observed, S = simulated, n = valid pairs. */
  equation: string;
}

const M = (m: MetricMeta) => m;

export const GROUPS = ['Error norms', 'Correlation & agreement', 'Efficiencies', 'FDC signatures', 'Timing & shape'] as const;

export const REGISTRY: MetricMeta[] = [
  // ----- error norms -----
  M({ id: 'me', label: 'ME (mean error)', group: 'Error norms', optimum: '0', direction: 'zero', range: '(−∞,∞)', timing: false, unitful: true, digits: 3, blurb: 'Mean of sim−obs; positive = over-estimation on average. Cancels compensating errors.', equation: '\\frac{1}{n}\\sum_{i=1}^{n}(S_i-O_i)' }),
  M({ id: 'mae', label: 'MAE', group: 'Error norms', optimum: '0', direction: 'min', range: '[0,∞)', timing: false, unitful: true, digits: 3, blurb: 'Mean absolute error. Blind to timing: a shifted flood costs the same as a wrong-sized one.', equation: '\\frac{1}{n}\\sum|S_i-O_i|' }),
  M({ id: 'mdae', label: 'MdAE (median |e|)', group: 'Error norms', optimum: '0', direction: 'min', range: '[0,∞)', timing: false, unitful: true, digits: 3, blurb: 'Median absolute error; robust to outliers, dominated by low flows.', equation: '\\operatorname{med}\\,|S_i-O_i|' }),
  M({ id: 'mse', label: 'MSE', group: 'Error norms', optimum: '0', direction: 'min', range: '[0,∞)', timing: false, unitful: true, digits: 3, blurb: 'Mean squared error; heavily weights peaks — and doubly punishes shifted peaks.', equation: '\\frac{1}{n}\\sum(S_i-O_i)^2' }),
  M({ id: 'rmse', label: 'RMSE', group: 'Error norms', optimum: '0', direction: 'min', range: '[0,∞)', timing: false, unitful: true, digits: 3, blurb: 'Root mean squared error, in data units. The double-penalty problem lives here.', equation: '\\sqrt{\\tfrac{1}{n}\\sum(S_i-O_i)^2}' }),
  M({ id: 'rsr', label: 'RSR (RMSE/σobs)', group: 'Error norms', optimum: '0', direction: 'min', range: '[0,∞)', timing: false, unitful: false, digits: 3, blurb: 'RMSE standardised by observed spread (Moriasi et al., 2007).', equation: '\\mathrm{RMSE}/\\sigma_O' }),
  M({ id: 'nrmse_mean', label: 'NRMSE (mean)', group: 'Error norms', optimum: '0', direction: 'min', range: '[0,∞)', timing: false, unitful: false, digits: 3, blurb: 'RMSE / mean(obs).', equation: '\\mathrm{RMSE}/\\bar{O}' }),
  M({ id: 'nrmse_range', label: 'NRMSE (range)', group: 'Error norms', optimum: '0', direction: 'min', range: '[0,∞)', timing: false, unitful: false, digits: 3, blurb: 'RMSE / (max−min of obs).', equation: '\\mathrm{RMSE}/(O_{\\max}-O_{\\min})' }),
  M({ id: 'nrmse_iqr', label: 'NRMSE (IQR)', group: 'Error norms', optimum: '0', direction: 'min', range: '[0,∞)', timing: false, unitful: false, digits: 3, blurb: 'RMSE / interquartile range of obs.', equation: '\\mathrm{RMSE}/\\mathrm{IQR}(O)' }),
  M({ id: 'mape', label: 'MAPE %', group: 'Error norms', optimum: '0', direction: 'min', range: '[0,∞)', timing: false, unitful: false, digits: 2, blurb: 'Mean absolute percent error; explodes near zero flows.', equation: '\\frac{100}{n}\\sum\\left|\\frac{S_i-O_i}{O_i}\\right|' }),
  M({ id: 'smape', label: 'sMAPE %', group: 'Error norms', optimum: '0', direction: 'min', range: '[0,200]', timing: false, unitful: false, digits: 2, blurb: 'Symmetric MAPE on the 0–200 % scale.', equation: '\\frac{100}{n}\\sum\\frac{|S_i-O_i|}{(|O_i|+|S_i|)/2}' }),
  M({ id: 'maape', label: 'MAAPE', group: 'Error norms', optimum: '0', direction: 'min', range: '[0,π/2]', timing: false, unitful: false, digits: 3, blurb: 'Arctangent-bounded percent error (Kim & Kim, 2016); safe at zero flows.', equation: '\\frac{1}{n}\\sum\\arctan\\left|\\frac{S_i-O_i}{O_i}\\right|' }),
  M({ id: 'mapd', label: 'MAPD %', group: 'Error norms', optimum: '0', direction: 'min', range: '[0,∞)', timing: false, unitful: false, digits: 2, blurb: 'Bulk relative error: total |error| as a share of total observed flow (= 100·(1−VE) for positive flows). hydroeval names this quantity MARE.', equation: '100\\,\\frac{\\sum|S_i-O_i|}{\\sum|O_i|}' }),
  M({ id: 'msle', label: 'MSLE', group: 'Error norms', optimum: '0', direction: 'min', range: '[0,∞)', timing: false, unitful: false, digits: 4, blurb: 'Mean squared log error; emphasises low flows.', equation: '\\frac{1}{n}\\sum\\big(\\ln\\tfrac{S_i}{O_i}\\big)^2' }),
  M({ id: 'mle', label: 'MLE (mean ln S/O)', group: 'Error norms', optimum: '0', direction: 'zero', range: '(−∞,∞)', timing: false, unitful: false, digits: 4, blurb: 'Mean log-ratio error (Törnquist et al., 1985): symmetric, unit-free bias; positive = over-estimation. Needs strictly positive flows. Note: the HydroErr code computes log1p here, diverging from the defining paper — HME follows the paper.', equation: '\\frac{1}{n}\\sum\\ln\\tfrac{S_i}{O_i}' }),
  M({ id: 'male', label: 'MALE', group: 'Error norms', optimum: '0', direction: 'min', range: '[0,∞)', timing: false, unitful: false, digits: 4, blurb: 'Mean |log-ratio| error; weights low and high flows evenly. Positive flows only.', equation: '\\frac{1}{n}\\sum\\big|\\ln\\tfrac{S_i}{O_i}\\big|' }),
  M({ id: 'rmsle', label: 'RMSLE', group: 'Error norms', optimum: '0', direction: 'min', range: '[0,∞)', timing: false, unitful: false, digits: 4, blurb: 'Root mean squared log-ratio error.', equation: '\\sqrt{\\mathrm{MSLE}}' }),
  M({ id: 'mde', label: 'MdE (median error)', group: 'Error norms', optimum: '0', direction: 'zero', range: '(−∞,∞)', timing: false, unitful: true, digits: 3, blurb: 'Median signed error; outlier-robust bias indicator.', equation: '\\operatorname{med}(S_i-O_i)' }),
  M({ id: 'mdse', label: 'MdSE', group: 'Error norms', optimum: '0', direction: 'min', range: '[0,∞)', timing: false, unitful: true, digits: 3, blurb: 'Median squared error; outlier-robust companion to MSE.', equation: '\\operatorname{med}\\big((S_i-O_i)^2\\big)' }),
  M({ id: 'mase', label: 'MASE', group: 'Error norms', optimum: '0', direction: 'min', range: '[0,∞)', timing: false, unitful: false, digits: 3, blurb: 'Error scaled by naive persistence (Hyndman & Koehler, 2006); <1 beats persistence.', equation: '\\frac{\\frac{1}{n}\\sum|S_i-O_i|}{\\frac{1}{n-1}\\sum_{i=2}^{n}|O_i-O_{i-1}|}' }),

  // ----- correlation & agreement -----
  M({ id: 'r', label: 'r (Pearson)', group: 'Correlation & agreement', optimum: '1', direction: 'max', range: '[−1,1]', timing: false, unitful: false, digits: 3, blurb: 'Linear association. Completely blind to bias and to amplitude scaling.', equation: '\\frac{\\sum(O_i-\\bar{O})(S_i-\\bar{S})}{\\sqrt{\\sum(O_i-\\bar{O})^2\\sum(S_i-\\bar{S})^2}}' }),
  M({ id: 'r2', label: 'R²', group: 'Correlation & agreement', optimum: '1', direction: 'max', range: '[0,1]', timing: false, unitful: false, digits: 3, blurb: 'Squared Pearson r; same blind spots as r.', equation: 'r^2' }),
  M({ id: 'wr2', label: 'wR² (slope-weighted)', group: 'Correlation & agreement', optimum: '1', direction: 'max', range: '[0,1]', timing: false, unitful: false, digits: 3, blurb: 'R² penalised by regression slope ≠ 1 (Krause et al., 2005).', equation: '|b|\\,R^2\\ (|b|\\le 1);\\quad R^2/|b|\\ (|b|>1)' }),
  M({ id: 'spearman', label: 'ρ (Spearman)', group: 'Correlation & agreement', optimum: '1', direction: 'max', range: '[−1,1]', timing: false, unitful: false, digits: 3, blurb: 'Rank correlation; robust to monotone distortion.', equation: 'r\\ \\text{of average ranks of }O,S' }),
  M({ id: 'd', label: 'd (Willmott)', group: 'Correlation & agreement', optimum: '1', direction: 'max', range: '[0,1]', timing: false, unitful: false, digits: 3, blurb: 'Index of agreement.', equation: '1-\\frac{\\sum(S_i-O_i)^2}{\\sum(|S_i-\\bar{O}|+|O_i-\\bar{O}|)^2}' }),
  M({ id: 'd1', label: 'd₁', group: 'Correlation & agreement', optimum: '1', direction: 'max', range: '[0,1]', timing: false, unitful: false, digits: 3, blurb: 'Absolute-error index of agreement.', equation: '1-\\frac{\\sum|S_i-O_i|}{\\sum(|S_i-\\bar{O}|+|O_i-\\bar{O}|)}' }),
  M({ id: 'dr', label: 'dᵣ (refined)', group: 'Correlation & agreement', optimum: '1', direction: 'max', range: '[−1,1]', timing: false, unitful: false, digits: 3, blurb: 'Refined index of agreement (Willmott et al., 2012).', equation: '1-\\frac{\\sum|S_i-O_i|}{2\\sum|O_i-\\bar{O}|}\\ \\text{or}\\ \\frac{2\\sum|O_i-\\bar{O}|}{\\sum|S_i-O_i|}-1' }),
  M({ id: 'drel', label: 'd_rel', group: 'Correlation & agreement', optimum: '1', direction: 'max', range: '(−∞,1]', timing: false, unitful: false, digits: 3, blurb: 'Relative-error index of agreement.', equation: '1-\\frac{\\sum\\big(\\frac{S_i-O_i}{O_i}\\big)^2}{\\sum\\big(\\frac{|S_i-\\bar{O}|+|O_i-\\bar{O}|}{\\bar{O}}\\big)^2}' }),
  M({ id: 'lm_index', label: 'E₁ (Legates–McCabe)', group: 'Correlation & agreement', optimum: '1', direction: 'max', range: '(−∞,1]', timing: false, unitful: false, digits: 3, blurb: 'Absolute-error efficiency; less peak-dominated than NSE.', equation: '1-\\frac{\\sum|S_i-O_i|}{\\sum|O_i-\\bar{O}|}' }),

  // ----- efficiencies -----
  M({ id: 'nse', label: 'NSE', group: 'Efficiencies', optimum: '1', direction: 'max', range: '(−∞,1]', timing: false, unitful: false, digits: 3, blurb: 'Nash–Sutcliffe. Squared errors ⇒ double penalty for timing offsets; benchmark is the mean flow.', equation: '1-\\frac{\\sum(S_i-O_i)^2}{\\sum(O_i-\\bar{O})^2}' }),
  M({ id: 'nse_mod', label: 'NSE₁ (modified)', group: 'Efficiencies', optimum: '1', direction: 'max', range: '(−∞,1]', timing: false, unitful: false, digits: 3, blurb: 'NSE with absolute errors (j = 1).', equation: '1-\\frac{\\sum|S_i-O_i|}{\\sum|O_i-\\bar{O}|}' }),
  M({ id: 'nse_rel', label: 'NSE_rel', group: 'Efficiencies', optimum: '1', direction: 'max', range: '(−∞,1]', timing: false, unitful: false, digits: 3, blurb: 'NSE on relative deviations; emphasises low flows.', equation: '1-\\frac{\\sum\\big(\\frac{S_i-O_i}{O_i}\\big)^2}{\\sum\\big(\\frac{O_i-\\bar{O}}{\\bar{O}}\\big)^2}' }),
  M({ id: 'lognse', label: 'logNSE', group: 'Efficiencies', optimum: '1', direction: 'max', range: '(−∞,1]', timing: false, unitful: false, digits: 3, blurb: 'NSE of log flows (ε = 0.01·mean obs); low-flow oriented.', equation: '\\mathrm{NSE}\\big(\\ln(O+\\varepsilon),\\ln(S+\\varepsilon)\\big),\\ \\varepsilon=0.01\\,\\bar{O}' }),
  M({ id: 'kge2009', label: 'KGE (2009)', group: 'Efficiencies', optimum: '1', direction: 'max', range: '(−∞,1]', timing: false, unitful: false, digits: 3, blurb: 'Kling–Gupta: r, α = σs/σo, β = μs/μo. Timing hides inside r only. Mean-flow benchmark scores −0.41.', equation: '1-\\sqrt{(r-1)^2+(\\alpha-1)^2+(\\beta-1)^2},\\ \\alpha=\\tfrac{\\sigma_S}{\\sigma_O},\\ \\beta=\\tfrac{\\mu_S}{\\mu_O}' }),
  M({ id: 'kge2012', label: 'KGE′ (2012)', group: 'Efficiencies', optimum: '1', direction: 'max', range: '(−∞,1]', timing: false, unitful: false, digits: 3, blurb: 'KGE with γ = CV ratio replacing α, decoupling bias and variability.', equation: '1-\\sqrt{(r-1)^2+(\\gamma-1)^2+(\\beta-1)^2},\\ \\gamma=\\tfrac{CV_S}{CV_O}' }),
  M({ id: 'kge2021', label: 'KGE″ (2021)', group: 'Efficiencies', optimum: '1', direction: 'max', range: '(−∞,1]', timing: false, unitful: false, digits: 3, blurb: 'KGE with non-dimensional bias β″ = (μs−μo)/σo (Tang et al., 2021); robust when μo → 0.', equation: '1-\\sqrt{(r-1)^2+(\\alpha-1)^2+\\beta\'\'^2},\\ \\beta\'\'=\\tfrac{\\mu_S-\\mu_O}{\\sigma_O}' }),
  M({ id: 'kgenp', label: 'KGEnp', group: 'Efficiencies', optimum: '1', direction: 'max', range: '(−∞,1]', timing: false, unitful: false, digits: 3, blurb: 'Non-parametric KGE (Pool et al., 2018): Spearman r + normalised-FDC α.', equation: '1-\\sqrt{(r_S-1)^2+(\\alpha_{NP}-1)^2+(\\beta-1)^2},\\ \\alpha_{NP}=1-\\tfrac{1}{2}\\sum|\\hat{F}_S-\\hat{F}_O|' }),
  M({ id: 've', label: 'VE (volumetric)', group: 'Efficiencies', optimum: '1', direction: 'max', range: '(−∞,1]', timing: false, unitful: false, digits: 3, blurb: 'Volumetric efficiency (Criss & Winston, 2008).', equation: '1-\\frac{\\sum|S_i-O_i|}{\\sum O_i}' }),
  M({ id: 'pbias', label: 'PBIAS % (+ = under)', group: 'Efficiencies', optimum: '0', direction: 'zero', range: '(−∞,∞)', timing: false, unitful: false, digits: 2, blurb: '100·Σ(O−S)/ΣO — positive means the model under-estimates volume (paper Table 2 convention).', equation: '100\\,\\frac{\\sum(O_i-S_i)}{\\sum O_i}' }),
  M({ id: 'beta_nse', label: 'β-NSE bias', group: 'Efficiencies', optimum: '0', direction: 'zero', range: '(−∞,∞)', timing: false, unitful: false, digits: 3, blurb: '(μs−μo)/σo — the standardised bias term.', equation: '\\frac{\\mu_S-\\mu_O}{\\sigma_O}' }),
  M({ id: 'alpha', label: 'α (σs/σo)', group: 'Efficiencies', optimum: '1', direction: 'one', range: '[0,∞)', timing: false, unitful: false, digits: 3, blurb: 'Variability ratio; <1 = flashiness under-estimated.', equation: '\\sigma_S/\\sigma_O' }),

  // ----- FDC signatures -----
  M({ id: 'fhv', label: '%BiasFHV (top 2 %)', group: 'FDC signatures', optimum: '0', direction: 'zero', range: '(−∞,∞)', timing: false, unitful: false, digits: 2, blurb: 'High-flow-volume bias of the FDC (Yilmaz et al., 2008).', equation: '100\\,\\frac{\\sum_{h\\in\\text{top }2\\%}(S_h-O_h)}{\\sum_h O_h}\\ \\text{(FDC-sorted)}' }),
  M({ id: 'flv', label: '%BiasFLV (low 30 %)', group: 'FDC signatures', optimum: '0', direction: 'zero', range: '(−∞,∞)', timing: false, unitful: false, digits: 2, blurb: 'Low-flow-volume bias in log space; positive = simulated low flows too low.', equation: '-100\\,\\frac{\\sum_l[(\\ln S_l-\\ln S_L)-(\\ln O_l-\\ln O_L)]}{\\sum_l(\\ln O_l-\\ln O_L)}' }),
  M({ id: 'fms', label: '%BiasFMS (slope 20–70 %)', group: 'FDC signatures', optimum: '0', direction: 'zero', range: '(−∞,∞)', timing: false, unitful: false, digits: 2, blurb: 'Mid-segment FDC slope bias — flashiness of the regime.', equation: '100\\,\\frac{(\\ln S_{0.2}-\\ln S_{0.7})-(\\ln O_{0.2}-\\ln O_{0.7})}{\\ln O_{0.2}-\\ln O_{0.7}}' }),
  M({ id: 'fmm', label: '%BiasFMM (median)', group: 'FDC signatures', optimum: '0', direction: 'zero', range: '(−∞,∞)', timing: false, unitful: false, digits: 2, blurb: 'Median-flow bias in log space.', equation: '100\\,\\frac{\\ln\\tilde{S}-\\ln\\tilde{O}}{\\ln\\tilde{O}}' }),

  // ----- timing & shape -----
  M({ id: 'peak_lag_abs', label: 'Peak timing |lag|', group: 'Timing & shape', optimum: '0', direction: 'min', range: '[0,∞) steps', timing: true, unitful: false, digits: 2, blurb: 'Mean |lag| of matched hydrograph peaks (Gauch et al., 2021). Directly answers "how late are my floods?" — invisible to NSE/KGE.', equation: '\\frac{1}{P}\\sum_{p=1}^{P}\\big|t^{S}_{p}-t^{O}_{p}\\big|' }),
  M({ id: 'peak_lag_signed', label: 'Peak timing bias', group: 'Timing & shape', optimum: '0', direction: 'zero', range: '(−∞,∞) steps', timing: true, unitful: false, digits: 2, blurb: 'Mean signed peak lag; + = simulated peaks late. Cancels mixed early/late errors — read with |lag|.', equation: '\\frac{1}{P}\\sum_{p}\\big(t^{S}_{p}-t^{O}_{p}\\big)' }),
  M({ id: 'event_threat', label: 'Event occurrence (threat)', group: 'Timing & shape', optimum: '1', direction: 'max', range: '[0,1]', timing: true, unitful: false, digits: 3, blurb: 'Hits/(hits+misses+false alarms) of threshold events — did the model produce the flood at all?', equation: '\\frac{\\text{hits}}{\\text{hits}+\\text{misses}+\\text{false}}' }),
  M({ id: 'event_vol', label: 'Event volume err %', group: 'Timing & shape', optimum: '0', direction: 'zero', range: '(−∞,∞)', timing: true, unitful: false, digits: 2, blurb: 'Mean per-event volume error over observed event windows.', equation: '\\overline{100\\,(V_S-V_O)/V_O}\\ \\text{per event}' }),
  M({ id: 'event_lag', label: 'Event peak lag (median)', group: 'Timing & shape', optimum: '0', direction: 'zero', range: '(−∞,∞) steps', timing: true, unitful: false, digits: 2, blurb: 'Median per-event peak lag; + = late.', equation: '\\operatorname{med}_e\\big(t^{S}_{e}-t^{O}_{e}\\big)' }),
  M({ id: 'lag_best', label: 'Lag at best fit', group: 'Timing & shape', optimum: '0', direction: 'zero', range: 'steps', timing: true, unitful: false, digits: 0, blurb: 'Shift that maximises NSE in the lag sweep — the record-wide timing offset a synchronous metric never reports.', equation: '\\arg\\max_{L}\\ \\mathrm{NSE}\\big(O_t,\\,S_{t+L}\\big)' }),
  M({ id: 'de', label: 'DE (diagnostic eff.)', group: 'Timing & shape', optimum: '0', direction: 'min', range: '[0,∞)', timing: true, unitful: false, digits: 3, blurb: 'Schwemmle et al. (2021): √(constant² + dynamic² + (r−1)²); decomposes into the polar plot on the Timing tab. Needs perennial flow.', equation: '\\sqrt{\\bar{B}_{rel}^{\\,2}+|B_{area}|^2+(r-1)^2}' }),
  M({ id: 'de_const', label: 'DE constant (B̄rel)', group: 'Timing & shape', optimum: '0', direction: 'zero', range: '(−∞,∞)', timing: true, unitful: false, digits: 3, blurb: 'Mean relative FDC bias — the constant error share.', equation: '\\bar{B}_{rel}=\\overline{(S^{FDC}-O^{FDC})/O^{FDC}}' }),
  M({ id: 'de_dyn', label: 'DE dynamic (|B|area)', group: 'Timing & shape', optimum: '0', direction: 'min', range: '[0,∞)', timing: true, unitful: false, digits: 3, blurb: 'Area of residual FDC bias — high-vs-low-flow error trade.', equation: '\\int_0^1\\big|B_{rel}(i)-\\bar{B}_{rel}\\big|\\,di' }),
  M({ id: 'sd_occ', label: 'SD occurrence', group: 'Timing & shape', optimum: '1', direction: 'max', range: '[0,1]', timing: true, unitful: false, digits: 3, blurb: 'Series Distance event threat score (Ehret & Zehe, 2011).', equation: '\\frac{\\text{hits}}{\\text{hits}+\\text{misses}+\\text{false}}\\ \\text{(matched events)}' }),
  M({ id: 'sd_amp', label: 'SD amplitude err %', group: 'Timing & shape', optimum: '0', direction: 'zero', range: '(−∞,∞)', timing: true, unitful: false, digits: 2, blurb: 'Mean relative amplitude offset on matched rise/recession segments.', equation: '\\overline{100\\,(S(u)-O(u))/O(u)}\\ \\text{over segment positions }u' }),
  M({ id: 'sd_time', label: 'SD timing err', group: 'Timing & shape', optimum: '0', direction: 'zero', range: '(−∞,∞) steps', timing: true, unitful: false, digits: 2, blurb: 'Mean timing offset on matched segments; + = sim late. The component classical scores fold invisibly into amplitude error.', equation: '\\overline{t_S(u)-t_O(u)}\\ \\text{over segment positions }u' }),
  M({ id: 'dtw_warp', label: 'DTW mean |warp|', group: 'Timing & shape', optimum: '0', direction: 'min', range: '[0,∞) steps', timing: true, unitful: false, digits: 2, blurb: 'Mean |i−j| along the optimal Sakoe–Chiba-banded alignment — average timing distortion in steps.', equation: '\\frac{1}{|\\pi^*|}\\sum_{(i,j)\\in\\pi^*}|i-j|,\\quad \\pi^*=\\arg\\min_{\\pi}\\textstyle\\sum|O_i-S_j|,\\ |i-j|\\le w' }),
  M({ id: 'dtw_dist', label: 'DTW distance (per step)', group: 'Timing & shape', optimum: '0', direction: 'min', range: '[0,∞)', timing: true, unitful: true, digits: 3, blurb: 'Alignment-invariant amplitude mismatch after optimal warping.', equation: '\\frac{1}{|\\pi^*|}\\sum_{(i,j)\\in\\pi^*}|O_i-S_j|' }),
  M({ id: 'w1', label: 'Wasserstein W₁', group: 'Timing & shape', optimum: '0', direction: 'min', range: '[0,∞) steps', timing: true, unitful: false, digits: 2, blurb: 'Earth-mover distance between mass-normalised hydrographs over time: equals the lag exactly under a pure shift; volume-blind by construction.', equation: '\\sum_t\\big|F_O(t)-F_S(t)\\big|\\,\\Delta t' }),
  M({ id: 'w2sq', label: 'Wasserstein W₂²', group: 'Timing & shape', optimum: '0', direction: 'min', range: '[0,∞) steps²', timing: true, unitful: false, digits: 2, blurb: 'Squared-lag form featured in the paper (Magyar & Sambridge, 2023): smooth and convex in the shift where NSE collapses.', equation: '\\int_0^1\\big(F_O^{-1}(u)-F_S^{-1}(u)\\big)^2\\,du' }),
  M({ id: 'xwt_lag', label: 'XWT phase lag', group: 'Timing & shape', optimum: '0', direction: 'zero', range: '(−∞,∞) steps', timing: true, unitful: false, digits: 2, blurb: 'Power-weighted mean cross-wavelet lag over red-noise-significant, in-cone regions (Morlet; Torrence & Compo, 1998). Scale-resolved curve on the Timing tab.', equation: '\\frac{\\phi(s,t)}{2\\pi}\\,T(s)\\ \\text{power-weighted, significant \\& in-cone}' }),
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
export type ComputeCtx = ComputeContext;

/** The synchronous (classical) metric block on an already-paired, already-
 *  transformed pair — the unit resampled by the bootstrap. */
export function classicalValues(o: Float64Array, s: Float64Array): {
  values: Record<string, number>;
  kge: { kge2009: ReturnType<typeof C.kge2009>; kge2012: ReturnType<typeof C.kge2012>; kge2021: ReturnType<typeof C.kge2021>; kgenp: ReturnType<typeof C.kgenp> };
} {
  const k09 = C.kge2009(o, s), k12 = C.kge2012(o, s), k21 = C.kge2021(o, s), knp = C.kgenp(o, s);
  const values: Record<string, number> = {
    me: C.me(o, s), mae: C.mae(o, s), mdae: C.mdae(o, s), mse: C.mse(o, s), rmse: C.rmse(o, s),
    rsr: C.rsr(o, s), nrmse_mean: C.nrmseMean(o, s), nrmse_range: C.nrmseRange(o, s), nrmse_iqr: C.nrmseIqr(o, s),
    mape: C.mape(o, s), smape: C.smape(o, s), maape: C.maape(o, s), mapd: C.mapd(o, s),
    msle: C.msle(o, s), mle: C.mle(o, s), male: C.male(o, s), rmsle: C.rmsle(o, s),
    mde: C.mde(o, s), mdse: C.mdse(o, s), mase: C.mase(o, s),
    r: C.r(o, s), r2: C.r2(o, s), wr2: C.wr2(o, s), spearman: C.spearman(o, s),
    d: C.d(o, s), d1: C.d1(o, s), dr: C.dr(o, s), drel: C.drel(o, s), lm_index: C.lmIndex(o, s),
    nse: C.nse(o, s), nse_mod: C.nseMod(o, s), nse_rel: C.nseRel(o, s), lognse: C.logNse(o, s),
    kge2009: k09.value, kge2012: k12.value, kge2021: k21.value, kgenp: knp.value,
    ve: C.ve(o, s), pbias: C.pbias(o, s), beta_nse: C.betaNse(o, s), alpha: C.alphaRatio(o, s),
    fhv: C.fhv(o, s), flv: C.flv(o, s), fms: C.fms(o, s), fmm: C.fmm(o, s),
  };
  return { values, kge: { kge2009: k09, kge2012: k12, kge2021: k21, kgenp: knp } };
}

export function computeAll(obsRaw: ArrayLike<number>, simRaw: ArrayLike<number>, ctx: ComputeContext): ComputeOutput {
  const paired = applyNanPolicy(obsRaw, simRaw, ctx.nanPolicy);
  const { o, s, note } = C.applyTransform(paired.obs, paired.sim, ctx.transform);
  const notes: string[] = note ? [note] : [];
  const heavy = ctx.heavy !== false;

  const { values, kge } = classicalValues(o, s);
  const extras: ComputeOutput['extras'] = { ...kge };

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
