// Classical metric catalogue (spec §11 / App. A; paper Table 1–2).
// Implemented from the published equations; verified value-for-value against
// executed HydroErr 2.0.0 / hydroeval 0.1.0 outputs in tests/classical.test.ts.
// All functions assume the (obs, sim) pair has already been NaN-paired.

import { mean, stdPop, sum, median, quantile, pearson, ranksAverage, ranksOrdinal, sortedAsc, type Vec } from '../support/stats'

const EPS_FRAC = 0.01; // ε = 0.01 · mean(obs) for log/inverse transforms (§11.2)

// ---------- error norms ----------
export const me   = (o: Vec, s: Vec) => mean(Array.from({ length: o.length }, (_, i) => s[i] - o[i]));
export const mae  = (o: Vec, s: Vec) => { let a = 0; for (let i = 0; i < o.length; i++) a += Math.abs(s[i] - o[i]); return a / o.length; };
export const mse  = (o: Vec, s: Vec) => { let a = 0; for (let i = 0; i < o.length; i++) { const e = s[i] - o[i]; a += e * e; } return a / o.length; };
export const rmse = (o: Vec, s: Vec) => Math.sqrt(mse(o, s));
export const mdae = (o: Vec, s: Vec) => median(Array.from({ length: o.length }, (_, i) => Math.abs(s[i] - o[i])));
export const mde  = (o: Vec, s: Vec) => median(Array.from({ length: o.length }, (_, i) => s[i] - o[i]));
export const mdse = (o: Vec, s: Vec) => median(Array.from({ length: o.length }, (_, i) => (s[i] - o[i]) ** 2));

// Log-error family per the defining papers (Törnquist et al., 1985; Jackson et
// al., 2019 Table 1): error term ln(S/O), which is unit-invariant. NOTE: the
// HydroErr *code* deviates from the HydroErr *paper* here — it computes
// log1p(S)−log1p(O) = ln((1+S)/(1+O)), which is not scale-invariant. We follow
// the paper; tests pin these against independently computed NumPy references.
// Requires strictly positive flows (zeros/negatives → NaN/−∞, shown as n/a).
export const mle   = (o: Vec, s: Vec) => mean(Array.from({ length: o.length }, (_, i) => Math.log(s[i] / o[i])));
export const male  = (o: Vec, s: Vec) => mean(Array.from({ length: o.length }, (_, i) => Math.abs(Math.log(s[i] / o[i]))));
export const msle  = (o: Vec, s: Vec) => mean(Array.from({ length: o.length }, (_, i) => Math.log(s[i] / o[i]) ** 2));
export const rmsle = (o: Vec, s: Vec) => Math.sqrt(msle(o, s));

export const mape  = (o: Vec, s: Vec) => 100 * mean(Array.from({ length: o.length }, (_, i) => Math.abs((s[i] - o[i]) / o[i])));
/**
 * MAPD % (Jackson et al., 2019 Table 2): 100·Σ|S−O| / Σ|O| — bulk relative
 * error (= 100·(1−VE) for positive flows). hydroeval calls this quantity
 * "MARE" and HydroErr's mapd returns the fraction; we use the paper's name
 * and percent scale to avoid colliding with per-element MARE (= MAPE/100).
 */
export const mapd  = (o: Vec, s: Vec) => { let n = 0, d0 = 0; for (let i = 0; i < o.length; i++) { n += Math.abs(s[i] - o[i]); d0 += Math.abs(o[i]); } return d0 === 0 ? NaN : 100 * n / d0; };
/** sMAPE on the 0–200 % scale. Denominator (|O|+|S|)/2 — HydroErr uses (S+O)/2,
 * identical for positive flows; the absolute form preserves the stated range. */
export const smape = (o: Vec, s: Vec) => 100 * mean(Array.from({ length: o.length }, (_, i) => Math.abs(s[i] - o[i]) / ((Math.abs(o[i]) + Math.abs(s[i])) / 2)));
/** MAAPE ∈ [0, π/2] (Kim & Kim, 2016). */
export const maape = (o: Vec, s: Vec) => mean(Array.from({ length: o.length }, (_, i) => Math.atan(Math.abs((s[i] - o[i]) / o[i]))));

export const nrmseMean  = (o: Vec, s: Vec) => rmse(o, s) / mean(o);
export const nrmseRange = (o: Vec, s: Vec) => { const so = sortedAsc(o); return rmse(o, s) / (so[so.length - 1] - so[0]); };
export const nrmseIqr   = (o: Vec, s: Vec) => rmse(o, s) / (quantile(o, 0.75) - quantile(o, 0.25));
/** RSR (Moriasi et al., 2007): RMSE / std(obs). */
export const rsr = (o: Vec, s: Vec) => rmse(o, s) / stdPop(o);
/** MASE (Hyndman & Koehler, 2006), non-seasonal denominator. */
export const mase = (o: Vec, s: Vec) => {
  let denom = 0; for (let i = 1; i < o.length; i++) denom += Math.abs(o[i] - o[i - 1]);
  denom /= (o.length - 1);
  return mae(o, s) / denom;
};

// ---------- correlation & agreement ----------
export const r = (o: Vec, s: Vec) => pearson(o, s);
export const r2 = (o: Vec, s: Vec) => pearson(o, s) ** 2;
export const spearman = (o: Vec, s: Vec) => pearson(ranksAverage(o), ranksAverage(s));
/** Weighted R² (Krause et al., 2005): |b|·R² for b ≤ 1, R²/|b| otherwise, b = regression slope of sim on obs. */
export const wr2 = (o: Vec, s: Vec) => {
  const mo = mean(o), ms = mean(s);
  let num = 0, den = 0;
  for (let i = 0; i < o.length; i++) { num += (o[i] - mo) * (s[i] - ms); den += (o[i] - mo) ** 2; }
  const b = num / den;
  const rr = r2(o, s);
  return Math.abs(b) <= 1 ? Math.abs(b) * rr : rr / Math.abs(b);
};

/** Willmott's index of agreement d. */
export const d = (o: Vec, s: Vec) => {
  const mo = mean(o);
  let num = 0, den = 0;
  for (let i = 0; i < o.length; i++) {
    num += (s[i] - o[i]) ** 2;
    den += (Math.abs(s[i] - mo) + Math.abs(o[i] - mo)) ** 2;
  }
  return 1 - num / den;
};
/** Willmott's d1 (j = 1). */
export const d1 = (o: Vec, s: Vec) => {
  const mo = mean(o);
  let num = 0, den = 0;
  for (let i = 0; i < o.length; i++) {
    num += Math.abs(s[i] - o[i]);
    den += Math.abs(s[i] - mo) + Math.abs(o[i] - mo);
  }
  return 1 - num / den;
};
/** Relative index of agreement (Krause et al., 2005). */
export const drel = (o: Vec, s: Vec) => {
  const mo = mean(o);
  let num = 0, den = 0;
  for (let i = 0; i < o.length; i++) {
    num += ((s[i] - o[i]) / o[i]) ** 2;
    den += ((Math.abs(s[i] - mo) + Math.abs(o[i] - mo)) / mo) ** 2;
  }
  return 1 - num / den;
};
/** Refined index of agreement dr (Willmott et al., 2012). */
export const dr = (o: Vec, s: Vec) => {
  const mo = mean(o);
  let a = 0, b = 0;
  for (let i = 0; i < o.length; i++) { a += Math.abs(s[i] - o[i]); b += Math.abs(o[i] - mo); }
  return a <= 2 * b ? 1 - a / (2 * b) : 2 * b / a - 1;
};
/** Legates–McCabe index (= NSE with j = 1). */
export const lmIndex = (o: Vec, s: Vec) => {
  const mo = mean(o);
  let num = 0, den = 0;
  for (let i = 0; i < o.length; i++) { num += Math.abs(s[i] - o[i]); den += Math.abs(o[i] - mo); }
  return 1 - num / den;
};

// ---------- efficiencies ----------
export const nse = (o: Vec, s: Vec) => {
  const mo = mean(o);
  let num = 0, den = 0;
  for (let i = 0; i < o.length; i++) { num += (s[i] - o[i]) ** 2; den += (o[i] - mo) ** 2; }
  return den === 0 ? NaN : 1 - num / den;
};
export const nseMod = lmIndex; // j = 1 modified NSE
export const nseRel = (o: Vec, s: Vec) => {
  const mo = mean(o);
  let num = 0, den = 0;
  for (let i = 0; i < o.length; i++) { num += ((s[i] - o[i]) / o[i]) ** 2; den += ((o[i] - mo) / mo) ** 2; }
  return 1 - num / den;
};
export const logNse = (o: Vec, s: Vec) => {
  const eps = EPS_FRAC * mean(o);
  const lo = Array.from({ length: o.length }, (_, i) => Math.log(o[i] + eps));
  const ls = Array.from({ length: s.length }, (_, i) => Math.log(s[i] + eps));
  return nse(lo, ls);
};

export interface KgeResult {
  value: number;
  r: number;
  /** σS/σO (2009, 2021), CV ratio γ (2012), or αNP (np). */
  variability: number;
  /** μS/μO (2009, 2012, np) or β″ = (μS−μO)/σO (2021, optimum 0). */
  bias: number;
}
export const kge2009 = (o: Vec, s: Vec): KgeResult => {
  const rr = pearson(o, s);
  const mo = mean(o), ms = mean(s);
  const alpha = stdPop(s, ms) / stdPop(o, mo);
  const beta = ms / mo;
  return { value: 1 - Math.sqrt((rr - 1) ** 2 + (alpha - 1) ** 2 + (beta - 1) ** 2), r: rr, variability: alpha, bias: beta };
};
/** KGE′ (2012): γ = CV_s / CV_o replaces α. */
export const kge2012 = (o: Vec, s: Vec): KgeResult => {
  const rr = pearson(o, s);
  const mo = mean(o), ms = mean(s);
  const gamma = (stdPop(s, ms) / ms) / (stdPop(o, mo) / mo);
  const beta = ms / mo;
  return { value: 1 - Math.sqrt((rr - 1) ** 2 + (gamma - 1) ** 2 + (beta - 1) ** 2), r: rr, variability: gamma, bias: beta };
};
/** KGE″ (Tang et al., 2021): bias term β″ = (μs − μo)/σo, optimum 0. */
export const kge2021 = (o: Vec, s: Vec): KgeResult => {
  const rr = pearson(o, s);
  const mo = mean(o), ms = mean(s);
  const so = stdPop(o, mo);
  const alpha = stdPop(s, ms) / so;
  const betaPP = (ms - mo) / so;
  return { value: 1 - Math.sqrt((rr - 1) ** 2 + (alpha - 1) ** 2 + betaPP ** 2), r: rr, variability: alpha, bias: betaPP };
};
/** Non-parametric KGE (Pool et al., 2018), matching hydroeval's construction. */
export const kgenp = (o: Vec, s: Vec): KgeResult => {
  const rs = pearson(ranksOrdinal(o), ranksOrdinal(s));
  const mo = mean(o), ms = mean(s);
  const n = o.length;
  const fo = sortedAsc(Array.from({ length: n }, (_, i) => o[i] / (n * mo)));
  const fs = sortedAsc(Array.from({ length: n }, (_, i) => s[i] / (n * ms)));
  let l1 = 0; for (let i = 0; i < n; i++) l1 += Math.abs(fs[i] - fo[i]);
  const alpha = 1 - 0.5 * l1;
  const beta = ms / mo;
  return { value: 1 - Math.sqrt((rs - 1) ** 2 + (alpha - 1) ** 2 + (beta - 1) ** 2), r: rs, variability: alpha, bias: beta };
};

/** Volumetric efficiency (Criss & Winston, 2008). */
export const ve = (o: Vec, s: Vec) => {
  let num = 0, den = 0;
  for (let i = 0; i < o.length; i++) { num += Math.abs(s[i] - o[i]); den += o[i]; }
  return 1 - num / den;
};
/** PBIAS, paper sign convention: 100·Σ(O−S)/ΣO — positive = underestimation. */
export const pbias = (o: Vec, s: Vec) => {
  let num = 0, den = 0;
  for (let i = 0; i < o.length; i++) { num += o[i] - s[i]; den += o[i]; }
  return den === 0 ? NaN : 100 * num / den;
};
/** β-NSE bias term (μs − μo)/σo, optimum 0. */
export const betaNse = (o: Vec, s: Vec) => (mean(s) - mean(o)) / stdPop(o);
/** Variability ratio α = σs/σo, optimum 1. */
export const alphaRatio = (o: Vec, s: Vec) => stdPop(s) / stdPop(o);
/** Bounded C2M form of an efficiency (Mathevet et al., 2006). */
export const c2m = (e: number) => e / (2 - e);

// ---------- FDC signatures (Yilmaz et al., 2008) ----------
const descending = (a: Vec) => Float64Array.from(a as ArrayLike<number>).sort().reverse();

/** %BiasFHV: bias over the top `frac` of flows (default top 2 %). */
export const fhv = (o: Vec, s: Vec, frac = 0.02) => {
  const os = descending(o), ss = descending(s);
  const k = Math.max(1, Math.round(frac * os.length));
  let num = 0, den = 0;
  for (let i = 0; i < k; i++) { num += ss[i] - os[i]; den += os[i]; }
  return 100 * num / den;
};
/** %BiasFLV: low-flow bias in log space over the bottom `frac` (default 30 %). */
export const flv = (o: Vec, s: Vec, frac = 0.3) => {
  const os = descending(o), ss = descending(s);
  const n = os.length;
  const start = Math.floor((1 - frac) * n);
  const eps = EPS_FRAC * mean(o);
  const lo = Array.from(os.slice(start), v => Math.log(v + eps));
  const ls = Array.from(ss.slice(start), v => Math.log(v + eps));
  const minLo = Math.min(...lo), minLs = Math.min(...ls);
  let num = 0, den = 0;
  for (let i = 0; i < lo.length; i++) {
    num += (ls[i] - minLs) - (lo[i] - minLo);
    den += lo[i] - minLo;
  }
  return -100 * num / den; // Yilmaz sign: positive = simulated low flows too low
};
/** %BiasFMS: mid-segment FDC slope bias between exceedance 20 % and 70 %. */
export const fms = (o: Vec, s: Vec, p1 = 0.2, p2 = 0.7) => {
  const eps = EPS_FRAC * mean(o);
  const at = (a: Vec, p: number) => quantile(a, 1 - p); // exceedance p ↔ quantile 1−p
  const so1 = Math.log(at(o, p1) + eps), so2 = Math.log(at(o, p2) + eps);
  const ss1 = Math.log(at(s, p1) + eps), ss2 = Math.log(at(s, p2) + eps);
  return 100 * ((ss1 - ss2) - (so1 - so2)) / (so1 - so2);
};
/** Median (FMM) bias in log space. */
export const fmm = (o: Vec, s: Vec) => {
  const eps = EPS_FRAC * mean(o);
  return 100 * (Math.log(median(s) + eps) - Math.log(median(o) + eps)) / Math.log(median(o) + eps);
};

// ---------- transforms (§11.2) ----------
export type Transform = 'none' | 'log' | 'sqrt' | 'inverse';
export function applyTransform(o: Vec, s: Vec, t: Transform): { o: Float64Array; s: Float64Array; note: string | null } {
  if (t === 'none') return { o: Float64Array.from(o as ArrayLike<number>), s: Float64Array.from(s as ArrayLike<number>), note: null };
  const eps = EPS_FRAC * mean(o);
  const f = t === 'log' ? (v: number) => Math.log(v + eps)
    : t === 'sqrt' ? (v: number) => (v < 0 ? NaN : Math.sqrt(v))
      : (v: number) => 1 / (v + eps);
  const to = new Float64Array(o.length), ts = new Float64Array(s.length);
  for (let i = 0; i < o.length; i++) { to[i] = f(o[i]); ts[i] = f(s[i]); }
  const note = t === 'sqrt' ? 'sqrt transform' : `${t} transform, ε = 0.01·mean(obs)`;
  return { o: to, s: ts, note };
}

// ---------- benchmarks & skill (§11.8) ----------
export type BenchmarkKind = 'mean' | 'climatology' | 'persistence';
/** Build the benchmark series aligned with obs; datesMs needed for climatology. */
export function benchmarkSeries(obs: Vec, kind: BenchmarkKind, datesMs?: number[]): Float64Array {
  const n = obs.length;
  const out = new Float64Array(n);
  let fSum = 0, fCount = 0;
  for (let i = 0; i < n; i++) if (isFinite(obs[i])) { fSum += obs[i]; fCount++; }
  const finiteMean = fCount ? fSum / fCount : NaN;
  if (kind === 'mean') { out.fill(finiteMean); return out; }
  if (kind === 'persistence') {
    out[0] = obs[0];
    for (let i = 1; i < n; i++) out[i] = obs[i - 1];
    return out;
  }
  // monthly climatology over finite observations only
  const sums = new Float64Array(12), counts = new Float64Array(12);
  for (let i = 0; i < n; i++) {
    if (!isFinite(obs[i])) continue;
    const m = new Date(datesMs![i]).getUTCMonth();
    sums[m] += obs[i]; counts[m]++;
  }
  for (let i = 0; i < n; i++) {
    const m = new Date(datesMs![i]).getUTCMonth();
    out[i] = counts[m] ? sums[m] / counts[m] : finiteMean;
  }
  return out;
}
/** Skill score of a bounded-above metric vs a benchmark: (M − M_b)/(opt − M_b), clamped at 1. */
export function skill(metricModel: number, metricBench: number, optimum = 1): number {
  if (!isFinite(metricModel) || !isFinite(metricBench) || optimum === metricBench) return NaN;
  return Math.min(1, (metricModel - metricBench) / (optimum - metricBench));
}
