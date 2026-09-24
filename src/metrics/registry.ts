// Single source of truth for metric metadata (§11.1) and the orchestrator that
// computes the full panel for one (obs, run) pair under the active view settings.

import * as C from './classical/catalogue'
import { applyNanPolicy, type NanPolicy, type Paired } from '../ingest/missing'
import { mean } from './support/stats'
import { peakTiming, eventErrors, lagSweep, type EventOptions } from './timing/events'
import { dtwOnTimeAxis, wasserstein1, wasserstein2sq, massIssue, DTW_CELL_BUDGET, type DtwRecordResult } from './timing/dtwWasserstein'
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
  M({ id: 'mse', label: 'MSE', group: 'Error norms', optimum: '0', direction: 'min', range: '[0,∞)', timing: false, unitful: true, digits: 3, blurb: 'Mean squared error; heavily weights peaks; and doubly punishes shifted peaks.', equation: '\\frac{1}{n}\\sum(S_i-O_i)^2' }),
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
  M({ id: 'mle', label: 'MLE (mean ln S/O)', group: 'Error norms', optimum: '0', direction: 'zero', range: '(−∞,∞)', timing: false, unitful: false, digits: 4, blurb: 'Mean log-ratio error (Törnquist et al., 1985): symmetric, unit-free bias; positive = over-estimation. Needs strictly positive flows. Note: the HydroErr code computes log1p here, diverging from the defining paper; HME follows the paper.', equation: '\\frac{1}{n}\\sum\\ln\\tfrac{S_i}{O_i}' }),
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
  M({ id: 'pbias', label: 'PBIAS % (+ = under)', group: 'Efficiencies', optimum: '0', direction: 'zero', range: '(−∞,100] %', timing: false, unitful: false, digits: 2, blurb: '100·Σ(O−S)/ΣO; positive means the model under-estimates volume (paper Table 2 convention).', equation: '100\\,\\frac{\\sum(O_i-S_i)}{\\sum O_i}' }),
  M({ id: 'beta_nse', label: 'β-NSE bias', group: 'Efficiencies', optimum: '0', direction: 'zero', range: '(−∞,∞)', timing: false, unitful: false, digits: 3, blurb: '(μs−μo)/σo; the standardised bias term.', equation: '\\frac{\\mu_S-\\mu_O}{\\sigma_O}' }),
  M({ id: 'alpha', label: 'α (σs/σo)', group: 'Efficiencies', optimum: '1', direction: 'one', range: '[0,∞)', timing: false, unitful: false, digits: 3, blurb: 'Variability ratio; <1 = flashiness under-estimated.', equation: '\\sigma_S/\\sigma_O' }),

  // ----- FDC signatures -----
  M({ id: 'fhv', label: '%BiasFHV (top 2 %)', group: 'FDC signatures', optimum: '0', direction: 'zero', range: '(−∞,∞)', timing: false, unitful: false, digits: 2, blurb: 'High-flow-volume bias of the FDC (Yilmaz et al., 2008).', equation: '100\\,\\frac{\\sum_{h\\in\\text{top }2\\%}(S_h-O_h)}{\\sum_h O_h}\\ \\text{(FDC-sorted)}' }),
  M({ id: 'flv', label: '%BiasFLV (low 30 %)', group: 'FDC signatures', optimum: '0', direction: 'zero', range: '(−∞,∞)', timing: false, unitful: false, digits: 2, blurb: 'Low-flow-volume bias in log space; positive = simulated low flows too low.', equation: '-100\\,\\frac{\\sum_l[(\\ln S_l-\\ln S_L)-(\\ln O_l-\\ln O_L)]}{\\sum_l(\\ln O_l-\\ln O_L)}' }),
  M({ id: 'fms', label: '%BiasFMS (slope 20–70 %)', group: 'FDC signatures', optimum: '0', direction: 'zero', range: '(−∞,∞)', timing: false, unitful: false, digits: 2, blurb: 'Mid-segment FDC slope bias; flashiness of the regime.', equation: '100\\,\\frac{(\\ln S_{0.2}-\\ln S_{0.7})-(\\ln O_{0.2}-\\ln O_{0.7})}{\\ln O_{0.2}-\\ln O_{0.7}}' }),
  M({ id: 'fmm', label: '%BiasFMM (median)', group: 'FDC signatures', optimum: '0', direction: 'zero', range: '(−∞,∞)', timing: false, unitful: false, digits: 2, blurb: 'Median-flow bias in log space.', equation: '100\\,\\frac{\\ln\\tilde{S}-\\ln\\tilde{O}}{\\ln\\tilde{O}}' }),

  // ----- timing & shape -----
  M({ id: 'peak_lag_abs', label: 'Peak timing |lag|', group: 'Timing & shape', optimum: '0', direction: 'min', range: '[0,∞) steps', timing: true, unitful: false, digits: 2, blurb: 'Mean |lag| of matched hydrograph peaks (Gauch et al., 2021). Directly answers "how late are my floods?"; invisible to NSE/KGE.', equation: '\\frac{1}{P}\\sum_{p=1}^{P}\\big|t^{S}_{p}-t^{O}_{p}\\big|' }),
  M({ id: 'peak_lag_signed', label: 'Peak timing bias', group: 'Timing & shape', optimum: '0', direction: 'zero', range: '(−∞,∞) steps', timing: true, unitful: false, digits: 2, blurb: 'Mean signed peak lag; + = simulated peaks late. Cancels mixed early/late errors; read with |lag|.', equation: '\\frac{1}{P}\\sum_{p}\\big(t^{S}_{p}-t^{O}_{p}\\big)' }),
  M({ id: 'event_threat', label: 'Event occurrence (threat)', group: 'Timing & shape', optimum: '1', direction: 'max', range: '[0,1]', timing: true, unitful: false, digits: 3, blurb: 'Hits/(hits+misses+false alarms) of threshold events; did the model produce the flood at all?', equation: '\\frac{\\text{hits}}{\\text{hits}+\\text{misses}+\\text{false}}' }),
  M({ id: 'event_peak', label: 'Event peak err %', group: 'Timing & shape', optimum: '0', direction: 'zero', range: '(−∞,∞)', timing: true, unitful: false, digits: 1, blurb: 'Mean signed peak-height error over matched events; the per-event peak component of Table 2.', equation: '\\overline{100\\,(S_{pk}-O_{pk})/O_{pk}}' }),
  M({ id: 'event_vol', label: 'Event volume err %', group: 'Timing & shape', optimum: '0', direction: 'zero', range: '(−∞,∞)', timing: true, unitful: false, digits: 2, blurb: 'Mean per-event volume error over observed event windows.', equation: '\\overline{100\\,(V_S-V_O)/V_O}\\ \\text{per event}' }),
  M({ id: 'event_lag', label: 'Event peak lag (median)', group: 'Timing & shape', optimum: '0', direction: 'zero', range: '(−∞,∞) steps', timing: true, unitful: false, digits: 2, blurb: 'Median per-event peak lag; + = late.', equation: '\\operatorname{med}_e\\big(t^{S}_{e}-t^{O}_{e}\\big)' }),
  M({ id: 'lag_best', label: 'Lag at best fit', group: 'Timing & shape', optimum: '0', direction: 'zero', range: 'steps', timing: true, unitful: false, digits: 0, blurb: 'Shift that maximises NSE in the lag sweep; the record-wide timing offset a synchronous metric never reports.', equation: '\\arg\\max_{L}\\ \\mathrm{NSE}\\big(O_t,\\,S_{t+L}\\big)' }),
  M({ id: 'de', label: 'DE (diagnostic eff.)', group: 'Timing & shape', optimum: '0', direction: 'min', range: '[0,∞)', timing: true, unitful: false, digits: 3, blurb: 'Schwemmle et al. (2021): √(constant² + dynamic² + (r−1)²); decomposes into the polar plot on the Timing tab. Needs perennial flow. Not shift-tolerant: its timing term is the linear correlation r, which responds to a lag without quantifying it.', equation: '\\sqrt{\\bar{B}_{rel}^{\\,2}+|B_{area}|^2+(r-1)^2}' }),
  M({ id: 'de_const', label: 'DE constant (B̄rel)', group: 'Timing & shape', optimum: '0', direction: 'zero', range: '(−∞,∞)', timing: true, unitful: false, digits: 3, blurb: 'Mean relative FDC bias; the constant error share. Built from the flow-duration curve, so blind to timing.', equation: '\\bar{B}_{rel}=\\overline{(S^{FDC}-O^{FDC})/O^{FDC}}' }),
  M({ id: 'de_dyn', label: 'DE dynamic (|B|area)', group: 'Timing & shape', optimum: '0', direction: 'min', range: '[0,∞)', timing: true, unitful: false, digits: 3, blurb: 'Area of residual FDC bias; high-vs-low-flow error trade. Built from the flow-duration curve, so blind to timing.', equation: '\\int_0^1\\big|B_{rel}(i)-\\bar{B}_{rel}\\big|\\,di' }),
  M({ id: 'sd_occ', label: 'SD occurrence', group: 'Timing & shape', optimum: '1', direction: 'max', range: '[0,1]', timing: true, unitful: false, digits: 3, blurb: 'Series Distance event threat score (Ehret & Zehe, 2011).', equation: '\\frac{\\text{hits}}{\\text{hits}+\\text{misses}+\\text{false}}\\ \\text{(matched events)}' }),
  M({ id: 'sd_amp', label: 'SD amplitude err', group: 'Timing & shape', optimum: '0', direction: 'zero', range: '(−∞,∞)', timing: true, unitful: true, digits: 3, blurb: 'Mean amplitude offset S − O on matched rise/recession segments, in flow units (Ehret & Zehe, 2011); + = simulation high. Events are windows above the observed-flow threshold on both series, so a constant bias widens the simulated windows and shows partly as timing error.', equation: '\\overline{S(u)-O(u)}\\ \\text{over segment positions }u' }),
  M({ id: 'sd_time', label: 'SD timing err', group: 'Timing & shape', optimum: '0', direction: 'zero', range: '(−∞,∞) steps', timing: true, unitful: false, digits: 2, blurb: 'Mean timing offset on matched segments; + = sim late. Time-synchronous scores fold this offset invisibly into amplitude error.', equation: '\\overline{t_S(u)-t_O(u)}\\ \\text{over segment positions }u' }),
  M({ id: 'dtw_warp', label: 'DTW mean |warp|', group: 'Timing & shape', optimum: '0', direction: 'min', range: '[0,∞) steps', timing: true, unitful: false, digits: 2, blurb: 'Mean time offset |tᵢ−tⱼ|, in steps of the record, along the optimal alignment inside a Sakoe–Chiba band of ±w steps (Timing tab; default = the peak window). It includes warping that only hides amplitude error, up to the band. Among equally cheap alignments it takes the one with the fewest warping moves, then the least total warp, so the value does not depend on the direction of time.', equation: '\\frac{1}{|\\pi^*|}\\sum_{(i,j)\\in\\pi^*}|t_i-t_j|,\\quad \\pi^*=\\arg\\min_{\\pi}\\textstyle\\sum|O_i-S_j|,\\ |t_i-t_j|\\le w' }),
  M({ id: 'dtw_dist', label: 'DTW distance (per step)', group: 'Timing & shape', optimum: '0', direction: 'min', range: '[0,∞)', timing: true, unitful: true, digits: 3, blurb: 'Amplitude mismatch left after optimal warping within the band (±w steps): mean |O−S| per matched pair.', equation: '\\frac{1}{|\\pi^*|}\\sum_{(i,j)\\in\\pi^*}|O_i-S_j|' }),
  M({ id: 'w1', label: 'Wasserstein W₁', group: 'Timing & shape', optimum: '0', direction: 'min', range: '[0,∞) steps', timing: true, unitful: false, digits: 2, blurb: 'Earth-mover distance, in steps, between the hydrographs treated as unit masses over time (Magyar & Sambridge, 2023). A pure shift reads the lag only for an event with zero flow at both ends of the record; with baseflow, or flow at the record ends, it reads less (about lag × the share of the mass that moves). Blind to proportional (multiplicative) volume error only: an additive bias moves mass toward low flows and registers as timing. Needs non-negative flow.', equation: '\\sum_t\\big|F_O(t)-F_S(t)\\big|\\,\\Delta t' }),
  M({ id: 'w2sq', label: 'Wasserstein W₂²', group: 'Timing & shape', optimum: '0', direction: 'min', range: '[0,∞) steps²', timing: true, unitful: false, digits: 2, blurb: 'Squared form featured in the paper (Magyar & Sambridge, 2023): equals the squared lag for a pure shift of an event with zero flow at both ends of the record, less with baseflow; smooth and convex in the shift where NSE collapses. Same conditions as W₁.', equation: '\\int_0^1\\big(F_O^{-1}(u)-F_S^{-1}(u)\\big)^2\\,du' }),
  M({ id: 'xwt_lag', label: 'XWT phase lag', group: 'Timing & shape', optimum: '0', direction: 'zero', range: '(−∞,∞) steps', timing: true, unitful: false, digits: 2, blurb: 'Power-weighted mean cross-wavelet lag over red-noise-significant, in-cone regions (Morlet; Torrence & Compo, 1998). Scale-resolved curve on the Timing tab.', equation: '\\frac{\\phi(s,t)}{2\\pi}\\,T(s)\\ \\text{power-weighted, significant \\& in-cone}' }),
];

export const byId = new Map(REGISTRY.map(m => [m.id, m]));

/** Essentials = exactly the metrics of the paper's Table 2 (its two blocks);
 *  Extended adds every additional verified measure in the catalogue. */
export const PRESETS: Record<string, string[] | 'all'> = {
  essentials: [
    'rmse', 'mae', 'rsr', 'r', 'r2', 'd', 'nse', 'kge2009', 'pbias', 've',
    'fhv', 'flv', 'fms',
    'sd_occ', 'sd_amp', 'sd_time',
    'dtw_warp', 'dtw_dist',
    'xwt_lag',
    'w1',
    'peak_lag_abs', 'peak_lag_signed',
    'event_peak', 'event_vol', 'event_lag',
    'de',
  ],
  'extended (beta)': 'all',
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
  /** Original-row index of each compacted pair (Paired.index): lets consumers
   *  (the DTW alignment plot) map metric-space indices back to true rows. */
  pairedIndex?: number[];
  /** NSE and KGE skill against each benchmark forecast, computed with the
   *  panel (in the worker) so that the Metrics tab only reads it; switching
   *  the benchmark needs no recomputation. */
  benchmark?: Record<C.BenchmarkKind, BenchmarkSkill>;
  extras: {
    kge2009: C.KgeResult; kge2012: C.KgeResult; kge2021: C.KgeResult; kgenp: C.KgeResult;
    de?: ReturnType<typeof diagnosticEfficiency>;
    peaks?: ReturnType<typeof peakTiming>;
    events?: ReturnType<typeof eventErrors>;
    sd?: ReturnType<typeof seriesDistance>;
    /** decim: 1 at full resolution. Above the cell budget DTW runs on block
     *  means of `decim` consecutive pairs: `path` and `band` are then in
     *  blocks (multiply by decim for compacted-pair indices and steps).
     *  meanAbsWarp and bandSteps are always in steps of the record. */
    dtw?: DtwRecordResult;
    xwt?: ReturnType<typeof xwtLag>;
    sweep?: ReturnType<typeof lagSweep>;
  };
}

/** Compute every metric for one run against observed under the current view. */
export type ComputeCtx = ComputeContext;

/** The synchronous (classical) metric block on an already-paired, already-
 *  transformed pair; the unit resampled by the bootstrap. */

/** Contract barrier: metric values are finite or NaN, never ±Infinity,
 *  IEEE754 overflow on degenerate data must read "n/a", not a number.
 *  Per-metric guards handle the statistically meaningful zero-denominator
 *  cases; this enforces the contract against overflow in any remaining or
 *  future metric. */
function enforceFinite(values: Record<string, number>): void {
  for (const k of Object.keys(values)) {
    if (values[k] === Infinity || values[k] === -Infinity) values[k] = NaN;
  }
}

/** `o`/`s` are the paired series under the active transform; `raw` holds the
 *  same pairs untransformed (default: `o`/`s`, i.e. no transform). Design
 *  rule D2: the FDC signatures always use the untransformed flows (FLV, FMS
 *  and FMM contain their own logs; a transform once reversed the sign of
 *  FHV). Under the log transform the location-dependent metrics read n/a
 *  (C.LOCATION_DEPENDENT). */
export function classicalValues(o: Float64Array, s: Float64Array, raw: { o: Float64Array; s: Float64Array } = { o, s }, transform: C.Transform = 'none'): {
  values: Record<string, number>;
  kge: { kge2009: ReturnType<typeof C.kge2009>; kge2012: ReturnType<typeof C.kge2012>; kge2021: ReturnType<typeof C.kge2021>; kgenp: ReturnType<typeof C.kgenp> };
} {
  const k09 = C.kge2009(o, s), k12 = C.kge2012(o, s), k21 = C.kge2021(o, s), knp = C.kgenp(o, s);
  const ro = raw.o, rs = raw.s;
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
    fhv: C.fhv(ro, rs), flv: C.flv(ro, rs), fms: C.fms(ro, rs), fmm: C.fmm(ro, rs),
  };
  if (transform === 'log') {
    for (const id of C.LOCATION_DEPENDENT) values[id] = NaN;
    k09.value = NaN; k12.value = NaN; knp.value = NaN;
  }
  enforceFinite(values);
  return { values, kge: { kge2009: k09, kge2012: k12, kge2021: k21, kgenp: knp } };
}

/** Pairs of one (obs, sim) record under the view: the NaN policy, then the
 *  transform (ε and the log reference from the observed mean of these pairs),
 *  then the pairs the transform makes invalid dropped from the raw and the
 *  transformed arrays alike. Shared by computeAll and benchmarkSkill so a
 *  model and its benchmark are scored on the same sample (D4). */
interface MetricPairs {
  /** transformed pairs */
  o: Float64Array; s: Float64Array;
  /** the same pairs untransformed, with their original row index */
  raw: Paired;
  /** observed mean of the NaN-policy pairs: sets ε and the log reference */
  obsMean: number;
  /** observations on the original row axis as the model score sees them:
   *  the raw record (pairwise) or the filled record (zero / mean) */
  obsRows: ArrayLike<number>;
  notes: string[];
}

function pairForMetrics(obsRaw: ArrayLike<number>, simRaw: ArrayLike<number>, ctx: Pick<ComputeContext, 'nanPolicy' | 'transform'>): MetricPairs {
  const paired0 = applyNanPolicy(obsRaw, simRaw, ctx.nanPolicy);
  const obsRows = ctx.nanPolicy === 'pairwise' ? obsRaw : paired0.obs;
  const obsMean = mean(paired0.obs);
  const tr = C.applyTransform(paired0.obs, paired0.sim, ctx.transform, obsMean);
  const notes: string[] = tr.note ? [tr.note] : [];

  // A transform can turn a finite pair into NaN (sqrt of a negative flow, log
  // of a value below -eps, inverse at exactly -eps). Pairing happened before
  // the transform, so those pairs are dropped again here, from the raw and
  // the transformed arrays alike, and the note says how many; one such pair
  // once turned 48 of 63 metrics n/a with n still reporting the full count.
  let o = tr.o, s = tr.s;
  let raw = paired0;
  if (ctx.transform !== 'none') {
    let bad = 0;
    for (let i = 0; i < o.length; i++) if (!isFinite(o[i]) || !isFinite(s[i])) bad++;
    if (bad > 0) {
      const keep = o.length - bad;
      const o2 = new Float64Array(keep), s2 = new Float64Array(keep);
      const ro = new Float64Array(keep), rs = new Float64Array(keep);
      const idx: number[] = new Array(keep);
      for (let i = 0, k = 0; i < o.length; i++) {
        if (!isFinite(o[i]) || !isFinite(s[i])) continue;
        o2[k] = o[i]; s2[k] = s[i]; ro[k] = paired0.obs[i]; rs[k] = paired0.sim[i]; idx[k] = paired0.index[i]; k++;
      }
      o = o2; s = s2;
      raw = { obs: ro, sim: rs, index: idx, n: keep };
      notes.push(keep === 0
        ? `The ${ctx.transform} transform needs positive flows; this record has non-positive values. Set the transform to none.`
        : `${bad} pair${bad === 1 ? ' was' : 's were'} excluded because ${bad === 1 ? 'it is' : 'they are'} not positive under the ${ctx.transform} transform.`);
    }
  }
  return { o, s, raw, obsMean, obsRows, notes };
}

/** Note naming what the active transform applies to (design rule D2). */
export const transformScopeNote = (t: C.Transform): string =>
  `FDC signatures, Diagnostic Efficiency, W₁, W₂², event, peak-timing, Series Distance and lag-sweep metrics are computed on untransformed flows; the ${t} transform applies to the error, correlation and efficiency metrics, the benchmark skill, DTW and XWT.`;

/** Every note that a transform setting adds to the panel, in panel order: what
 *  the transform is, what it applies to, and (log) which metrics read n/a.
 *  Shown wherever transformed values appear (Metrics, Timing, Compare and
 *  Sandbox tabs, reports). */
export function transformNotes(t: C.Transform): string[] {
  if (t === 'none') return [];
  return [C.TRANSFORM_NOTES[t], transformScopeNote(t), ...(t === 'log' ? [C.LOG_NA_NOTE] : [])];
}

const listing = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** Note for a composite ranking (Compare tab, report): the weighted priority
 *  metrics that no simulation has a value for, which the ranking leaves out
 *  of the composite, and why when the log transform makes them n/a. Under
 *  log the default priorities once lost KGE (2009) without a word. */
export function rankingOmissionNote(priorities: { id: string; weight: number }[], values: Record<string, number>[], t: C.Transform): string | null {
  if (!values.length) return null;
  const gone = priorities.filter(p => p.weight > 0 && values.every(v => !Number.isFinite(v[p.id]))).map(p => p.id);
  if (!gone.length) return null;
  const label = (id: string) => byId.get(id)?.label ?? id;
  const onLog = t === 'log' ? gone.filter(id => C.LOCATION_DEPENDENT.has(id)) : [];
  let text = `Left out of the composite because no simulation has a value: ${listing(gone.map(label))}.`;
  if (onLog.length) {
    text += ` ${listing(onLog.map(label))} ${onLog.length === 1 ? 'reads' : 'read'} n/a on log flows (Santos et al., 2018); set the transform to none, sqrt or inverse to rank on ${onLog.length === 1 ? 'it' : 'them'}.`;
  }
  return text;
}

export function computeAll(obsRaw: ArrayLike<number>, simRaw: ArrayLike<number>, ctx: ComputeContext): ComputeOutput {
  const pairs = pairForMetrics(obsRaw, simRaw, ctx);
  const { o, s, raw, notes } = pairs;
  const heavy = ctx.heavy !== false;
  if (ctx.transform !== 'none') notes.push(transformScopeNote(ctx.transform));
  if (ctx.transform === 'log') notes.push(C.LOG_NA_NOTE);

  // D2: the FDC signatures take the untransformed surviving pairs.
  const { values, kge } = classicalValues(o, s, { o: raw.obs, s: raw.sim }, ctx.transform);
  const extras: ComputeOutput['extras'] = { ...kge };
  // D4: the skill against every benchmark, on this panel's pairs. It is part
  // of the panel so that it runs in the worker, not during rendering
  // (tb-rev-05: 1.6 to 3.5 s of blocked UI at 1M rows with 5 simulations).
  const benchmark = {
    mean: scoreBenchmark(pairs, 'mean', ctx),
    climatology: scoreBenchmark(pairs, 'climatology', ctx),
    persistence: scoreBenchmark(pairs, 'persistence', ctx),
  };

  if (heavy && o.length >= 4) {
    const t = ctx.timing;
    const evOpt: EventOptions = {
      thresholdKind: t.eventThreshold.kind, thresholdValue: t.eventThreshold.value,
      minDistance: t.eventMinDistance, warmup: t.eventWarmup,
    };
    const daily = true;
    // D2: events, peak timing, Series Distance, Diagnostic Efficiency, W₁/W₂²
    // and the lag sweep run on the untransformed flows of the same surviving
    // pairs. Events and peaks are threshold-based, physical measures (an
    // absolute threshold of 30 m3/s once met log flows near 3 and every event
    // vanished); DE is built on relative FDC errors (S − O)/O and needs
    // perennial flow (Schwemmle et al., 2021); W₁/W₂² need a non-negative
    // mass. Under the old log transform each of them changed with the flow
    // unit. DTW and XWT keep the transform: a weighting choice that, after
    // D3, no longer depends on the unit.
    const ro = raw.obs, rs = raw.sim;
    const de = diagnosticEfficiency(ro, rs);
    // QA-011: peak separation must follow the configured event spacing, not a
    // hardcoded 100 steps (which silently suppressed real peaks in daily data).
    const peaks = peakTiming(ro, rs, { prominence: t.peakProminence, minDistance: t.eventMinDistance, window: t.peakMatchTolerance });
    const events = eventErrors(ro, rs, evOpt, t.peakMatchTolerance);
    const sd = seriesDistance(ro, rs, evOpt, t.peakMatchTolerance, 20, raw.index);
    // D1: the time axis of DTW, W1 and W2^2 is the original step index of each
    // surviving pair, so a gap never shortens a warp or a transport distance.
    const tAxis = raw.index;
    // D6: band in steps, full resolution with banded storage; block means
    // (never point samples) only above the cell budget.
    const dtwRes = dtwOnTimeAxis(o, s, tAxis, t.dtwBand);
    if (dtwRes.decim > 1) {
      notes.push(`DTW was computed on means of ${dtwRes.decim} consecutive pairs because the full-resolution alignment would need more than ${Math.round(DTW_CELL_BUDGET / 1e6)} million cells; DTW distance and mean |warp| are approximate, with a resolution of about ${dtwRes.decim} steps, and the band was rounded up to ${dtwRes.bandSteps} steps.`);
    }
    let longGaps = 0;
    for (let k = 1; k < tAxis.length; k++) if (tAxis[k] - tAxis[k - 1] - 1 > dtwRes.bandSteps) longGaps++;
    if (longGaps > 0) {
      notes.push(`${longGaps} gap${longGaps === 1 ? ' is' : 's are'} longer than the DTW band (±${dtwRes.bandSteps} steps); the DTW alignment cannot warp across ${longGaps === 1 ? 'it' : 'them'}, so the pairs at ${longGaps === 1 ? 'its edges' : 'their edges'} are aligned with zero warp.`);
    }
    const xw = xwtLag(o, s, t.waveletScales);
    if (xw.decimation > 1) notes.push(`Cross-wavelet analysis computed on a 1/${xw.decimation} block-mean of the record for tractability; its lags keep a resolution of about ${xw.decimation} steps.`);
    const sweep = lagSweep(ro, rs, -30, 30);

    if (peaks.unresolved > 0) {
      notes.push(`${peaks.unresolved} observed peak(s) had no resolvable simulated peak within ±${t.peakMatchTolerance} steps; those pairs are excluded from the peak-timing means. Widen the peak-match tolerance if lags may exceed it.`);
    }
    const flat = Math.max(peaks.flat ?? 0, events.flat ?? 0);
    if (flat > 0) {
      notes.push(`${flat} observed peak(s) faced a flat simulation inside the search window and were not matched; a flat line has no peak timing.`);
    }
    values.peak_lag_abs = peaks.meanAbsLag;
    values.peak_lag_signed = peaks.meanSignedLag;
    values.event_threat = events.threat;
    values.event_vol = events.meanVolumeErrPct;
    values.event_peak = events.meanPeakErrPct;
    values.event_lag = events.medianPeakLag;
    values.lag_best = sweep.bestLag;
    values.de = de.de; values.de_const = de.brelMean; values.de_dyn = de.bArea;
    values.sd_occ = sd.occurrence; values.sd_amp = sd.meanAmplitudeErr; values.sd_time = sd.meanTimingErr;
    values.dtw_warp = dtwRes.meanAbsWarp;
    values.dtw_dist = dtwRes.normalized;
    values.w1 = wasserstein1(ro, rs, tAxis);
    values.w2sq = wasserstein2sq(ro, rs, tAxis);
    values.xwt_lag = xw.headlineLag;

    if (!Number.isFinite(values.w1)) {
      // W1/W2^2 read flow as mass: one negative value or a zero total makes
      // them undefined for the whole record, which must not happen silently
      const why: string[] = [];
      // W1/W2 take the untransformed flows (D2), so the note inspects those
      for (const [x, who] of [[ro, 'observed series'], [rs, 'simulation']] as const) {
        const iss = massIssue(x);
        if (iss?.negative) why.push(`the ${who} has ${iss.negative} negative value${iss.negative === 1 ? '' : 's'}`);
        else if (iss?.zeroTotal) why.push(`the ${who} sums to zero`);
      }
      if (why.length) notes.push(`W₁ and W₂² are n/a: they treat flow as mass over time and need non-negative values with a positive total; ${why.join(' and ')}.`);
    }
    if (de.nonPerennial) notes.push('DE: observed record is not strictly positive; diagnostic efficiency assumptions violated');
    if (de.rUndefined) notes.push('DE: the correlation r is undefined for a constant series and is set to 0, as in diag-eff (Schwemmle et al., 2021).');
    if (events.events.length === 0) notes.push('No events at the current threshold; raise/lower it on the Timing tab');

    Object.assign(extras, { de, peaks, events, sd, dtw: dtwRes, xwt: xw, sweep });
  }

  enforceFinite(values);
  return { values, n: raw.n, notes, extras, pairedIndex: raw.index, benchmark };
}

export interface BenchmarkSkill {
  /** Pairs on which both the model and the benchmark are scored. */
  n: number;
  nse: number; kge: number;
  nseBench: number; kgeBench: number;
  nseSkill: number; kgeSkill: number;
}

/**
 * NSE and KGE skill of a simulation against a benchmark forecast, on ONE
 * sample and in ONE space (design rule D4; Knoben et al., 2019; Schaefli &
 * Gupta, 2007). Every benchmark is a flow series built from the observations
 * of the model's evaluated pairs (after the NaN policy and after the pairs
 * the transform drops), in flow units:
 *  - mean: the mean flow of those observations;
 *  - climatology: the mean flow of those observations in the same calendar
 *    month (UTC);
 *  - persistence: the observation at the previous step of the record (of the
 *    filled record under the zero / mean policies). There is none at the
 *    first step or after a missing observation, and the pair is then dropped
 *    from both scores, under every NaN policy.
 * The benchmark is then transformed like the simulation (same ε and log
 * reference), and both scores are taken on the pairs where it exists. With
 * no transform the mean-flow benchmark scores NSE = 0 and, with r taken as 0
 * for a constant series, KGE = 1 − √2; the climatology, the least-squares
 * monthly fit that contains it, never scores lower. Under a transform the
 * transformed mean flow is not the mean of the transformed flows, so the
 * mean-flow benchmark scores below those values. Under the log transform KGE
 * is n/a (C.LOG_NA_NOTE), and so is its skill.
 * tb-rev-01: the mean benchmark was once the mean of the transformed
 * observations and the climatology the transformed monthly mean of every raw
 * observation of the record, so under a transform a climatology could score
 * far below the mean flow it contains and the skill order inverted.
 */
function scoreBenchmark(p: MetricPairs, kind: C.BenchmarkKind, ctx: Pick<ComputeContext, 'transform' | 'datesMs'>): BenchmarkSkill {
  const rows = p.raw.index, ro = p.raw.obs, n0 = rows.length;
  const flow = new Float64Array(n0);            // benchmark flow at each evaluated pair
  if (kind === 'mean') {
    flow.fill(n0 ? mean(ro) : NaN);
  } else if (kind === 'climatology') {
    const dates = ctx.datesMs;
    const month = new Int8Array(n0).fill(-1);
    const sums = new Float64Array(12), counts = new Float64Array(12);
    for (let k = 0; dates && k < n0; k++) {
      const m = new Date(dates[rows[k]]).getUTCMonth();
      if (!Number.isInteger(m)) continue;         // no date for this row
      month[k] = m; sums[m] += ro[k]; counts[m]++;
    }
    for (let k = 0; k < n0; k++) flow[k] = month[k] < 0 ? NaN : sums[month[k]] / counts[month[k]];
  } else {
    for (let k = 0; k < n0; k++) flow[k] = rows[k] > 0 ? p.obsRows[rows[k] - 1] : NaN;
  }

  const f = C.transformFn(ctx.transform, p.obsMean);
  const bT = new Float64Array(n0);
  let keep = 0;
  for (let k = 0; k < n0; k++) { bT[k] = f(flow[k]); if (Number.isFinite(bT[k])) keep++; }
  let o = p.o, s = p.s, b = bT;
  if (keep < n0) {
    o = new Float64Array(keep); s = new Float64Array(keep); b = new Float64Array(keep);
    for (let k = 0, j = 0; k < n0; k++) {
      if (!Number.isFinite(bT[k])) continue;
      o[j] = p.o[k]; s[j] = p.s[k]; b[j] = bT[k]; j++;
    }
  }
  const logNa = ctx.transform === 'log' && C.LOCATION_DEPENDENT.has('kge2009');
  const fin = (v: number) => (Number.isFinite(v) ? v : NaN);
  const nseM = fin(C.nse(o, s)), nseB = fin(C.nse(o, b));
  const kgeM = logNa ? NaN : fin(C.kge2009(o, s).value);
  const kgeB = logNa ? NaN : fin(C.benchmarkKge(o, b));
  return {
    n: keep,
    nse: nseM, kge: kgeM, nseBench: nseB, kgeBench: kgeB,
    nseSkill: fin(C.skill(nseM, nseB)), kgeSkill: fin(C.skill(kgeM, kgeB)),
  };
}

/** Benchmark skill of one (obs, sim) record under the view (see
 *  scoreBenchmark); the panel (computeAll) carries the same values for all
 *  three benchmarks. */
export function benchmarkSkill(
  obsRaw: ArrayLike<number>, simRaw: ArrayLike<number>, kind: C.BenchmarkKind,
  ctx: Pick<ComputeContext, 'nanPolicy' | 'transform' | 'datesMs'>,
): BenchmarkSkill {
  return scoreBenchmark(pairForMetrics(obsRaw, simRaw, ctx), kind, ctx);
}

/** Bounded C2M display transform for unbounded-below efficiencies (§11.4). */
export const C2M_APPLICABLE = new Set(['nse', 'nse_mod', 'nse_rel', 'lognse', 'kge2009', 'kge2012', 'kge2021', 'kgenp', 've', 'lm_index', 'drel']);
export const toC2M = C.c2m;
