// Classical metric catalogue (spec §11 / App. A; paper Table 1–2).
// Implemented from the published equations. The metrics that have an executed
// reference are compared with HydroErr 2.0.0 / hydroeval 0.1.0 outputs in
// tests/classical.test.ts; the exceptions (log-error family, KGEnp with tied
// flows, MAAPE at O = S = 0) and the metrics with no executed reference are
// listed in README "Technical validation".
// All functions assume the (obs, sim) pair has already been NaN-paired.

import { arrMin, mean, stdPop, sum, median, quantile, pearson, ranksAverage, ranksOrdinal, sortedAsc, type Vec } from '../support/stats'

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
// HydroErr *code* deviates from the HydroErr *paper* here: it computes
// log1p(S)−log1p(O) = ln((1+S)/(1+O)), which is not scale-invariant. We follow
// the paper; tests pin these against independently computed NumPy references.
// Requires strictly positive flows (zeros/negatives → NaN/−∞, shown as n/a).
const logRatio = (o: Vec, s: Vec): number[] | null => {
  const r: number[] = [];
  for (let i = 0; i < o.length; i++) {
    if (o[i] <= 0 || s[i] <= 0) return null;       // log-ratio needs strictly positive flows
    r.push(Math.log(s[i] / o[i]));
  }
  return r;
};
export const mle   = (o: Vec, s: Vec) => { const r = logRatio(o, s); return r ? mean(r) : NaN; };
export const male  = (o: Vec, s: Vec) => { const r = logRatio(o, s); return r ? mean(r.map(Math.abs)) : NaN; };
export const msle  = (o: Vec, s: Vec) => { const r = logRatio(o, s); return r ? mean(r.map(x => x * x)) : NaN; };
export const rmsle = (o: Vec, s: Vec) => Math.sqrt(msle(o, s));

export const mape  = (o: Vec, s: Vec) => {
  let sum = 0;
  for (let i = 0; i < o.length; i++) {
    if (o[i] === 0) return NaN;                    // percentage error undefined at zero flow
    sum += Math.abs((s[i] - o[i]) / o[i]);
  }
  const v = 100 * sum / o.length;
  return isFinite(v) ? v : NaN;
};
/**
 * MAPD % (Jackson et al., 2019 Table 2): 100·Σ|S−O| / Σ|O|: bulk relative
 * error (= 100·(1−VE) for positive flows). hydroeval calls this quantity
 * "MARE" and HydroErr's mapd returns the fraction; we use the paper's name
 * and percent scale to avoid colliding with per-element MARE (= MAPE/100).
 */
export const mapd  = (o: Vec, s: Vec) => { let n = 0, d0 = 0; for (let i = 0; i < o.length; i++) { n += Math.abs(s[i] - o[i]); d0 += Math.abs(o[i]); } return over(100 * n, d0); };
/** sMAPE on the 0–200 % scale. Denominator (|O|+|S|)/2: HydroErr uses (S+O)/2,
 * identical for positive flows; the absolute form preserves the stated range. */
export const smape = (o: Vec, s: Vec) => {
  let sum = 0;
  for (let i = 0; i < o.length; i++) {
    const den = (Math.abs(o[i]) + Math.abs(s[i])) / 2;
    const diff = Math.abs(s[i] - o[i]);
    if (den === 0) { if (diff === 0) continue; return NaN; }  // 0/0 → 0 by limit; underflow → n/a
    sum += diff / den;
  }
  return 100 * sum / o.length;
};
/** MAAPE ∈ [0, π/2] (Kim & Kim, 2016), defined at zero flow: a step with
 *  O = 0 and S ≠ 0 scores atan(∞) = π/2, and a step with O = S = 0 (a correct
 *  zero-flow day) scores 0, the limit, as in sMAPE. The bare formula gives 0/0
 *  there, which once made MAAPE n/a for any intermittent record (audit
 *  norms-03). HydroErr returns NaN for such a record; elsewhere HME matches it. */
export const maape = (o: Vec, s: Vec) => mean(Array.from({ length: o.length }, (_, i) => {
  const diff = Math.abs(s[i] - o[i]);
  return diff === 0 ? 0 : Math.atan(diff / Math.abs(o[i]));
}));

/** QA-010: degenerate denominators answer NaN ("n/a"), never ±Infinity. */
const over = (num: number, den: number) => {
  if (den === 0) return NaN;
  const v = num / den;
  return isFinite(v) ? v : NaN;                     // overflow past double range ⇒ n/a
};

/** Log-family domain guard: the ε-shifted logs must all be finite, otherwise
 *  the metric is undefined (zero/negative flows with a vanishing ε). */
const logPair = (o: Vec, s: Vec): { lo: number[]; ls: number[] } | null => {
  const eps = EPS_FRAC * mean(o);
  const lo: number[] = [], ls: number[] = [];
  for (let i = 0; i < o.length; i++) {
    const a = o[i] + eps, b = s[i] + eps;
    if (a <= 0 || b <= 0) return null;
    lo.push(Math.log(a)); ls.push(Math.log(b));
  }
  return { lo, ls };
};

export const nrmseMean  = (o: Vec, s: Vec) => over(rmse(o, s), mean(o));
export const nrmseRange = (o: Vec, s: Vec) => { const so = sortedAsc(o); return over(rmse(o, s), so[so.length - 1] - so[0]); };
export const nrmseIqr   = (o: Vec, s: Vec) => over(rmse(o, s), quantile(o, 0.75) - quantile(o, 0.25));
/** RSR (Moriasi et al., 2007): RMSE / std(obs). */
export const rsr = (o: Vec, s: Vec) => over(rmse(o, s), sigmaObs(o));
/** MASE (Hyndman & Koehler, 2006), non-seasonal denominator. */
export const mase = (o: Vec, s: Vec) => {
  if (o.length < 2) return NaN;
  let denom = 0; for (let i = 1; i < o.length; i++) denom += Math.abs(o[i] - o[i - 1]);
  denom /= (o.length - 1);
  return over(mae(o, s), denom);                     // constant record ⇒ zero naive error ⇒ n/a; overflow ⇒ n/a
};

// ---------- correlation & agreement ----------
export const r = (o: Vec, s: Vec) => pearson(o, s);
export const r2 = (o: Vec, s: Vec) => pearson(o, s) ** 2;
export const spearman = (o: Vec, s: Vec) => pearson(ranksAverage(o), ranksAverage(s));
/** Weighted R² (Krause et al., 2005): |b|·R² for b ≤ 1, R²/|b| otherwise, b = regression slope of sim on obs. */
export const wr2 = (o: Vec, s: Vec) => {
  if (Number.isNaN(pearson(o, s))) return NaN;
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
  return isFinite(num / den) ? 1 - num / den : NaN;
};
/** Willmott's d1 (j = 1). */
export const d1 = (o: Vec, s: Vec) => {
  const mo = mean(o);
  let num = 0, den = 0;
  for (let i = 0; i < o.length; i++) {
    num += Math.abs(s[i] - o[i]);
    den += Math.abs(s[i] - mo) + Math.abs(o[i] - mo);
  }
  return isFinite(num / den) ? 1 - num / den : NaN;
};
/** Relative index of agreement (Krause et al., 2005). */
export const drel = (o: Vec, s: Vec) => {
  const mo = mean(o);
  if (mo === 0) return NaN;
  let num = 0, den = 0;
  for (let i = 0; i < o.length; i++) {
    if (o[i] === 0) return NaN;                    // relative form undefined at zero flow
    num += ((s[i] - o[i]) / o[i]) ** 2;
    den += ((Math.abs(s[i] - mo) + Math.abs(o[i] - mo)) / mo) ** 2;
  }
  return den === 0 ? NaN : 1 - num / den;
};
/** Refined index of agreement dr (Willmott et al., 2012). */
export const dr = (o: Vec, s: Vec) => {
  const mo = mean(o);
  let a = 0, b = 0;
  for (let i = 0; i < o.length; i++) { a += Math.abs(s[i] - o[i]); b += Math.abs(o[i] - mo); }
  return a <= 2 * b ? 1 - a / (2 * b) : 2 * b / a - 1;
};
/** Numerically-constant observed series (QA-012 mirror): when the spread of
 *  O around its mean is at the level of one-ulp summation noise, the variance
 *  denominator is not "small", it is zero, and an efficiency built on it is
 *  undefined (it once rendered as -7.7e27). `spread` is the RMS or mean
 *  absolute deviation from the mean, `scale` the mean itself. */
const constantObs = (spread: number, scale: number) => spread <= Math.abs(scale) * 1e-12;
/** Population std of the observed series, read as exactly zero when the
 *  series is numerically constant, so every ratio over it answers n/a
 *  instead of a fifteen-digit number (RSR once read 8.5e14 on a constant
 *  0.1 record whose mean is not representable). */
const sigmaObs = (o: Vec, mo = mean(o)): number => {
  const so = stdPop(o, mo);
  return constantObs(so, mo) ? 0 : so;
};

/** Legates–McCabe index (= NSE with j = 1). */
export const lmIndex = (o: Vec, s: Vec) => {
  const mo = mean(o);
  let num = 0, den = 0;
  for (let i = 0; i < o.length; i++) { num += Math.abs(s[i] - o[i]); den += Math.abs(o[i] - mo); }
  if (constantObs(den / o.length, mo)) return NaN;
  const q = over(num, den);
  return Number.isNaN(q) ? NaN : 1 - q;
};

// ---------- efficiencies ----------
export const nse = (o: Vec, s: Vec) => {
  const mo = mean(o);
  let num = 0, den = 0;
  for (let i = 0; i < o.length; i++) { num += (s[i] - o[i]) ** 2; den += (o[i] - mo) ** 2; }
  if (den === 0 || constantObs(Math.sqrt(den / o.length), mo)) return NaN;
  return 1 - num / den;
};
export const nseMod = lmIndex; // j = 1 modified NSE
export const nseRel = (o: Vec, s: Vec) => {
  const mo = mean(o);
  if (mo === 0) return NaN;
  let num = 0, den = 0;
  for (let i = 0; i < o.length; i++) {
    if (o[i] === 0) return NaN;                      // relative form undefined at zero flow
    num += ((s[i] - o[i]) / o[i]) ** 2; den += ((o[i] - mo) / mo) ** 2;
  }
  if (constantObs(Math.sqrt(den / o.length), 1)) return NaN;
  const q = over(num, den);
  return Number.isNaN(q) ? NaN : 1 - q;
};
export const logNse = (o: Vec, s: Vec) => {
  const p = logPair(o, s);
  return p ? nse(p.lo, p.ls) : NaN;
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
  const alpha = stdPop(s, ms) / sigmaObs(o, mo);
  const beta = ms / mo;
  { const _v = 1 - Math.sqrt((rr - 1) ** 2 + (alpha - 1) ** 2 + (beta - 1) ** 2); return { value: isFinite(_v) ? _v : NaN, r: rr, variability: alpha, bias: beta }; }
};
/** KGE′ (2012): γ = CV_s / CV_o replaces α. */
export const kge2012 = (o: Vec, s: Vec): KgeResult => {
  const rr = pearson(o, s);
  const mo = mean(o), ms = mean(s);
  const gamma = (stdPop(s, ms) / ms) / (sigmaObs(o, mo) / mo);
  const beta = ms / mo;
  { const _v = 1 - Math.sqrt((rr - 1) ** 2 + (gamma - 1) ** 2 + (beta - 1) ** 2); return { value: isFinite(_v) ? _v : NaN, r: rr, variability: gamma, bias: beta }; }
};
/** KGE″ (Tang et al., 2021): bias term β″ = (μs − μo)/σo, optimum 0. */
export const kge2021 = (o: Vec, s: Vec): KgeResult => {
  const rr = pearson(o, s);
  const mo = mean(o), ms = mean(s);
  const so = sigmaObs(o, mo);
  const alpha = stdPop(s, ms) / so;
  const betaPP = (ms - mo) / so;
  { const _v = 1 - Math.sqrt((rr - 1) ** 2 + (alpha - 1) ** 2 + betaPP ** 2); return { value: isFinite(_v) ? _v : NaN, r: rr, variability: alpha, bias: betaPP }; }
};
/** Non-parametric KGE (Pool et al., 2018), matching hydroeval's construction. */
export const kgenp = (o: Vec, s: Vec): KgeResult => {
  const rs = pearson(ranksAverage(o), ranksAverage(s));   // average ranks: ties handled per scipy/R; constant series → NaN
  const mo = mean(o), ms = mean(s);
  const n = o.length;
  const fo = sortedAsc(Array.from({ length: n }, (_, i) => o[i] / (n * mo)));
  const fs = sortedAsc(Array.from({ length: n }, (_, i) => s[i] / (n * ms)));
  let l1 = 0; for (let i = 0; i < n; i++) l1 += Math.abs(fs[i] - fo[i]);
  const alpha = 1 - 0.5 * l1;
  const beta = ms / mo;
  { const _v = 1 - Math.sqrt((rs - 1) ** 2 + (alpha - 1) ** 2 + (beta - 1) ** 2); return { value: isFinite(_v) ? _v : NaN, r: rs, variability: alpha, bias: beta }; }
};

/** Volumetric efficiency (Criss & Winston, 2008). */
export const ve = (o: Vec, s: Vec) => {
  let num = 0, den = 0;
  for (let i = 0; i < o.length; i++) { num += Math.abs(s[i] - o[i]); den += o[i]; }
  const q = over(num, den);
  return Number.isNaN(q) ? NaN : 1 - q;
};
/** PBIAS, paper sign convention: 100·Σ(O−S)/ΣO: positive = underestimation. */
export const pbias = (o: Vec, s: Vec) => {
  let num = 0, den = 0;
  for (let i = 0; i < o.length; i++) { num += o[i] - s[i]; den += o[i]; }
  return over(100 * num, den);
};
/** β-NSE bias term (μs − μo)/σo, optimum 0. */
export const betaNse = (o: Vec, s: Vec) => over(mean(s) - mean(o), sigmaObs(o));
/** Variability ratio α = σs/σo, optimum 1. */
export const alphaRatio = (o: Vec, s: Vec) => over(stdPop(s), sigmaObs(o));
/** Bounded C2M form of an efficiency (Mathevet et al., 2006). */
export const c2m = (e: number) => e / (2 - e);

// ---------- FDC signatures (Yilmaz et al., 2008) ----------
// FLV, FMS and FMM take the plain natural log of each flow, as published: no
// ε shift. So a uniform scaling S = c·O scores exactly 0 for FLV and FMS, and
// no value depends on the flow unit. The log of a flow ≤ 0 is undefined, so a
// signature whose logged flows include one is NaN (n/a); fdcLogNote says which
// signature and why (zero flows of an intermittent river, or a simulation that
// dries out). An ε = 0.01·mean(O) shift once kept these finite, but it changed
// FLV by up to a factor of 5 against the published equation and gave a
// non-zero FLV/FMS for S = c·O (audit fdc-01).
const descending = (a: Vec) => Float64Array.from(a as ArrayLike<number>).sort().reverse();
/** Start index of the low-flow segment (lowest `frac` of the flows) in an FDC sorted high to low. */
const lowStart = (n: number, frac: number) => Math.floor((1 - frac) * n);

/** %BiasFHV: bias over the top `frac` of flows (default top 2 %). */
export const fhv = (o: Vec, s: Vec, frac = 0.02) => {
  const os = descending(o), ss = descending(s);
  const k = Math.max(1, Math.round(frac * os.length));
  let num = 0, den = 0;
  for (let i = 0; i < k; i++) { num += ss[i] - os[i]; den += os[i]; }
  return over(100 * num, den);
};
/** %BiasFLV (Yilmaz et al., 2008): log-space shape of the lowest `frac`
 *  (default 30 %) of the FDC, each segment measured above its own minimum
 *  (index L). Yilmaz sign: positive = the simulated low segment is flatter,
 *  its lowest flows too high (e.g. over-estimated baseflow); negative = it is
 *  steeper, its lowest flows too low. n/a when the segment holds a flow ≤ 0. */
export const flv = (o: Vec, s: Vec, frac = 0.3) => {
  const os = descending(o), ss = descending(s);
  const lo: number[] = [], ls: number[] = [];
  for (let i = lowStart(os.length, frac); i < os.length; i++) {
    if (!(os[i] > 0) || !(ss[i] > 0)) return NaN;   // ln of a flow ≤ 0 is undefined
    lo.push(Math.log(os[i])); ls.push(Math.log(ss[i]));
  }
  if (lo.length === 0) return NaN;
  const minLo = arrMin(lo), minLs = arrMin(ls);
  let num = 0, den = 0;
  for (let i = 0; i < lo.length; i++) {
    num += (ls[i] - minLs) - (lo[i] - minLo);
    den += lo[i] - minLo;
  }
  return over(-100 * num, den);
};
/** Flow at exceedance probability p (quantile 1 − p, NumPy 'linear'). */
const exceed = (a: Vec, p: number) => quantile(a, 1 - p);
/** %BiasFMS: mid-segment FDC slope bias between exceedance 20 % and 70 %, in
 *  log space; positive = simulated mid-segment steeper (flashier). n/a when a
 *  flow at either exceedance is ≤ 0. */
export const fms = (o: Vec, s: Vec, p1 = 0.2, p2 = 0.7) => {
  const qo1 = exceed(o, p1), qo2 = exceed(o, p2), qs1 = exceed(s, p1), qs2 = exceed(s, p2);
  if (!(qo1 > 0 && qo2 > 0 && qs1 > 0 && qs2 > 0)) return NaN;
  const so = Math.log(qo1) - Math.log(qo2), ss = Math.log(qs1) - Math.log(qs2);
  return over(100 * (ss - so), so);
};
/** %BiasFMM: median-flow bias as the unit-free log ratio 100·ln(S̃/Õ);
 *  positive = simulated median too high. Yilmaz et al. (2008) divide
 *  ln S̃ − ln Õ by ln Õ; that value changes with the flow unit and changes
 *  sign when Õ < 1 in the loaded unit (audit fdc-02), so HME reports the log
 *  ratio. n/a when either median is ≤ 0. */
export const fmm = (o: Vec, s: Vec) => {
  const mo = median(o), ms = median(s);
  if (!(mo > 0) || !(ms > 0)) return NaN;
  return 100 * Math.log(ms / mo);
};

/** Panel note for FLV, FMS and FMM when they are n/a because a flow they take
 *  the log of is ≤ 0. Call it with the same arrays as flv/fms/fmm. Returns
 *  null when all three are inside their domain. */
export function fdcLogNote(o: Vec, s: Vec, frac = 0.3, p2 = 0.7): string | null {
  const who = (bo: boolean, bs: boolean) => (bo && bs ? 'observed and simulated' : bo ? 'observed' : 'simulated');
  const parts: string[] = [];
  const os = descending(o), ss = descending(s);
  let zo = 0, zs = 0;
  for (let i = lowStart(os.length, frac); i < os.length; i++) { if (!(os[i] > 0)) zo++; if (!(ss[i] > 0)) zs++; }
  if (zo + zs > 0) {
    const counts = [zo ? `${zo} observed` : '', zs ? `${zs} simulated` : ''].filter(Boolean).join(' and ');
    parts.push(`%BiasFLV (the lowest ${Math.round(frac * 100)} % of flows include ${counts} value${zo + zs === 1 ? '' : 's'} ≤ 0)`);
  }
  const fo = !(exceed(o, p2) > 0), fs = !(exceed(s, p2) > 0);
  if (fo || fs) parts.push(`%BiasFMS (the ${who(fo, fs)} flow exceeded ${Math.round(p2 * 100)} % of the time is ≤ 0)`);
  const mo = !(median(o) > 0), ms = !(median(s) > 0);
  if (mo || ms) parts.push(`%BiasFMM (the ${who(mo, ms)} median flow is ≤ 0)`);
  if (parts.length === 0) return null;
  return `n/a: ${parts.join('; ')}. These FDC signatures take the natural log of each flow (Yilmaz et al., 2008), and the log of a flow ≤ 0 is undefined.`;
}

// ---------- transforms (§11.2) ----------
export type Transform = 'none' | 'log' | 'sqrt' | 'inverse';

/** The pointwise transform of one record, fixed by the mean of its observed
 *  flows (design rule D3). ε = 0.01·mean(obs). The log form is
 *  ln((Q + ε)/mean(obs)): dividing by the observed mean makes every
 *  transformed value, and so every dimensionless metric computed on it,
 *  independent of the flow unit (ln(Q + ε) once added ln(c) to every value
 *  when the unit was scaled by c; Santos et al., 2018). sqrt and inverse are
 *  scale-equivariant already. A value outside the domain answers NaN. */
export function transformFn(t: Transform, obsMean: number): (v: number) => number {
  const eps = EPS_FRAC * obsMean;
  if (t === 'none') return v => v;
  if (t === 'sqrt') return v => (v < 0 ? NaN : Math.sqrt(v));
  if (t === 'inverse') return v => 1 / (v + eps);
  return v => {
    const q = (v + eps) / obsMean;
    return obsMean > 0 && q > 0 ? Math.log(q) : NaN;
  };
}

export const TRANSFORM_NOTES: Record<Exclude<Transform, 'none'>, string> = {
  log: 'log transform: ln((Q + ε)/mean(obs)), ε = 0.01·mean(obs); dividing by the observed mean makes the values independent of the flow unit',
  sqrt: 'sqrt transform: √Q',
  inverse: 'inverse transform: 1/(Q + ε), ε = 0.01·mean(obs)',
};

/** Apply transform `t` to a paired record. `obsMean` sets ε and the log
 *  reference; it defaults to the mean of `o`, and a benchmark scored against
 *  a model passes the model's value so both are transformed identically. */
export function applyTransform(o: Vec, s: Vec, t: Transform, obsMean: number = mean(o)): { o: Float64Array; s: Float64Array; note: string | null } {
  if (t === 'none') return { o: Float64Array.from(o as ArrayLike<number>), s: Float64Array.from(s as ArrayLike<number>), note: null };
  const f = transformFn(t, obsMean);
  const to = new Float64Array(o.length), ts = new Float64Array(s.length);
  for (let i = 0; i < o.length; i++) { to[i] = f(o[i]); ts[i] = f(s[i]); }
  return { o: to, s: ts, note: TRANSFORM_NOTES[t] };
}

/** Metrics whose value changes when the same constant is added to O and S:
 *  ratios to the level of the flows (NRMSE(mean), the percentage errors,
 *  VE, PBIAS, NSE_rel, d_rel, the β and γ terms of KGE, KGE′ and KGEnp) and
 *  the log-ratio family. On log flows, whose zero is an arbitrary reference
 *  (Hyndman & Koehler, 2006; Santos et al., 2018), they have no meaning:
 *  their denominators sit near zero or below it, VE exceeds its bound of 1
 *  and PBIAS reverses its sign. They read n/a under the log transform. */
export const LOCATION_DEPENDENT = new Set([
  'nrmse_mean', 'mape', 'smape', 'maape', 'mapd', 'msle', 'mle', 'male', 'rmsle',
  'drel', 'nse_rel', 'lognse', 'kge2009', 'kge2012', 'kgenp', 've', 'pbias',
]);
export const LOG_NA_NOTE = 'On log flows, NRMSE (mean), MAPE, sMAPE, MAAPE, MAPD, MSLE, MLE, MALE, RMSLE, d_rel, NSE_rel, logNSE, KGE (2009), KGE′, KGEnp, VE and PBIAS read n/a: log flows have no natural zero, so a ratio to their level is arbitrary (Santos et al., 2018). NSE, KGE″ and the difference-based metrics are computed on the log flows; use the sqrt or inverse transform for a transformed KGE.';

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
/** KGE (2009) of a benchmark forecast `b`. A constant benchmark (the mean
 *  flow) has σ_b = 0, so r is undefined; Knoben et al. (2019) take r = 0,
 *  with α = 0, which gives KGE = 1 − √2 ≈ −0.41 for the mean of the
 *  observations. Any other benchmark scores the ordinary KGE (2009). */
export function benchmarkKge(o: Vec, b: Vec): number {
  const mb = mean(b);
  if (!constantObs(stdPop(b, mb), mb)) return kge2009(o, b).value;
  const mo = mean(o);
  if (sigmaObs(o, mo) === 0) return NaN;             // constant observations: KGE undefined
  const beta = mb / mo;
  const v = 1 - Math.sqrt(1 + 1 + (beta - 1) ** 2);
  return isFinite(v) ? v : NaN;
}

/** Skill score of a bounded-above metric vs a benchmark: (M − M_b)/(opt − M_b), clamped at 1. */
export function skill(metricModel: number, metricBench: number, optimum = 1): number {
  if (!isFinite(metricModel) || !isFinite(metricBench) || optimum === metricBench) return NaN;
  return Math.min(1, (metricModel - metricBench) / (optimum - metricBench));
}
