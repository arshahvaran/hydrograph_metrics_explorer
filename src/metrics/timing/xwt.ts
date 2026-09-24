// Cross-wavelet timing analysis (paper §4.3): Morlet continuous wavelet
// transform per Torrence & Compo (1998), cross-spectrum phase converted to a
// time lag per scale, gated by red-noise (AR1) significance at 95 % and the
// cone of influence, in the manner of Grinsted et al. (2004) / Liu et al. (2011)
// as applied to streamflow by Towler & McCreight (2021).

import { mean, stdPop, pearson, type Vec } from '../support/stats'

const OMEGA0 = 6;
const FOURIER_FACTOR = (4 * Math.PI) / (OMEGA0 + Math.sqrt(2 + OMEGA0 * OMEGA0)); // ≈ 1.0330

// ---- iterative radix-2 FFT (in place) ----
function fft(re: Float64Array, im: Float64Array, invert = false): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (2 * Math.PI / len) * (invert ? 1 : -1);
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi;
        const vi = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr; cwr = nwr;
      }
    }
  }
  if (invert) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

/** Morlet CWT of a (standardised) series at the given scales. Returns complex W[scale][time]. */
function cwt(x: Float64Array, scales: number[]): { re: Float64Array; im: Float64Array }[] {
  const n = x.length;
  let n2 = 1; while (n2 < n) n2 <<= 1;
  const xr = new Float64Array(n2), xi = new Float64Array(n2);
  xr.set(x);
  fft(xr, xi);

  const omega = new Float64Array(n2);
  for (let k = 0; k <= n2 / 2; k++) omega[k] = (2 * Math.PI * k) / n2;
  for (let k = n2 / 2 + 1; k < n2; k++) omega[k] = -(2 * Math.PI * (n2 - k)) / n2;

  const norm0 = Math.pow(Math.PI, -0.25);
  return scales.map(s => {
    const wr = new Float64Array(n2), wi = new Float64Array(n2);
    const norm = norm0 * Math.sqrt(2 * Math.PI * s); // δt = 1 step
    for (let k = 0; k < n2; k++) {
      if (omega[k] <= 0) continue;                    // analytic wavelet: positive freqs only
      const arg = s * omega[k] - OMEGA0;
      const psi = norm * Math.exp(-0.5 * arg * arg);
      // multiply x̂ by conj(ψ̂) (ψ̂ real here)
      wr[k] = xr[k] * psi; wi[k] = xi[k] * psi;
    }
    fft(wr, wi, true);
    return { re: wr.subarray(0, n) as Float64Array, im: wi.subarray(0, n) as Float64Array };
  });
}

/** Lag-1 autocorrelation for the red-noise background. */
function ar1(x: Float64Array): number {
  const m = mean(x);
  let num = 0, den = 0;
  for (let i = 1; i < x.length; i++) num += (x[i] - m) * (x[i - 1] - m);
  for (let i = 0; i < x.length; i++) den += (x[i] - m) ** 2;
  return Math.max(0, Math.min(0.999, num / den));
}

export interface XwtScaleRow {
  scale: number;               // native steps
  period: number;              // native steps
  meanLag: number;             // lag (native steps) from the circular power-weighted mean phase, unwrapped across scales
  fracSignificant: number;     // share of in-COI points above the 95 % red-noise level
  /** |meanLag| > period/2: the phase alone cannot identify this lag; it was
   *  placed on the branch nearest the next coarser scale's lag. */
  beyondHalfPeriod: boolean;
}

export interface XwtResult {
  headlineLag: number;         // significant-power-weighted mean of the per-scale lags (native steps)
  headlineAbsLag: number;
  byScale: XwtScaleRow[];
  fracSignificant: number;
  decimation: number;          // >1 if the series was block-averaged for tractability
}

/**
 * Cross-wavelet phase lag. Positive lag = simulation late.
 * The cross spectrum W_os = W_o · conj(W_s) has phase φ = arg(W_os); a pure
 * simulation delay of k steps gives φ = +2πk/T at period T (pinned by tests).
 *
 * Phase is circular, so per scale the phases are averaged as unit vectors
 * weighted by cross power (not as numbers, which collapses lags near ±T/2), and
 * a phase only identifies a lag modulo the period T. Lags are therefore unwrapped
 * from the coarsest significant scale to the finest: at each finer scale the
 * 2π branch nearest the previous (coarser) lag is taken, so a shift longer than
 * half of a fast period is not folded back toward zero or flipped in sign.
 * `scalesIn` ('auto' or explicit scales in native steps) is the Timing-tab setting.
 */
export function xwtLag(obsIn: Vec, simIn: Vec, scalesIn: 'auto' | number[] = 'auto'): XwtResult {
  // tractability cap
  let obs = Float64Array.from(obsIn as ArrayLike<number>);
  let sim = Float64Array.from(simIn as ArrayLike<number>);
  let decimation = 1;
  if (obs.length > 16384) {
    decimation = Math.ceil(obs.length / 8192);
    const m = Math.floor(obs.length / decimation);
    const o2 = new Float64Array(m), s2 = new Float64Array(m);
    for (let i = 0; i < m; i++) {
      let ao = 0, as = 0;
      for (let k = 0; k < decimation; k++) { ao += obs[i * decimation + k]; as += sim[i * decimation + k]; }
      o2[i] = ao / decimation; s2[i] = as / decimation;
    }
    obs = o2; sim = s2;
  }
  const n = obs.length;

  // standardise (means computed once: inside the map they cost O(n²))
  const so = stdPop(obs), ss = stdPop(sim);
  const mo = mean(obs), ms = mean(sim);
  const o = Float64Array.from(obs, v => (v - mo) / (so || 1));
  const s = Float64Array.from(sim, v => (v - ms) / (ss || 1));

  // scales, in steps of the (possibly block-averaged) series: auto = s0 = 2,
  // dj = 0.25, up to n/4; explicit scales arrive in native steps
  let scales: number[];
  if (Array.isArray(scalesIn) && scalesIn.length > 0) {
    scales = [...new Set(scalesIn.map(v => v / decimation))]
      .filter(v => Number.isFinite(v) && v >= 1 && v <= n / 2)
      .sort((a, b) => a - b);
  } else {
    const s0 = 2, dj = 0.25;
    const J = Math.floor(Math.log2(n / (4 * s0)) / dj);
    scales = Array.from({ length: J + 1 }, (_, j) => s0 * Math.pow(2, j * dj));
  }

  const Wo = cwt(o, scales);
  const Ws = cwt(s, scales);

  const aO = ar1(o), aS = ar1(s);
  const Z95 = 3.999; // ν = 2 (complex wavelet), 95 %; Torrence & Compo / Grinsted
  const redNoise = (a: number, period: number) => {
    const f = 1 / period; // cycles per step
    return (1 - a * a) / (1 + a * a - 2 * a * Math.cos(2 * Math.PI * f));
  };

  // per scale: significant cross power and its power-weighted circular mean phase
  const perScale: { sc: number; period: number; power: number; phase: number; frac: number }[] = [];
  let sigCount = 0, coiCount = 0;

  scales.forEach((sc, si) => {
    const period = sc * FOURIER_FACTOR;
    const sigLevel = (Z95 / 2) * Math.sqrt(redNoise(aO, period) * redNoise(aS, period));
    const coi = Math.SQRT2 * sc;
    let wSum = 0, wCos = 0, wSin = 0, sig = 0, inCoi = 0;
    const wo = Wo[si], ws = Ws[si];
    for (let t = 0; t < n; t++) {
      if (Math.min(t, n - 1 - t) < coi) continue;   // outside the cone of influence
      inCoi++;
      // cross spectrum W_o · conj(W_s)
      const xr = wo.re[t] * ws.re[t] + wo.im[t] * ws.im[t];
      const xi = wo.im[t] * ws.re[t] - wo.re[t] * ws.im[t];
      const power = Math.hypot(xr, xi);
      if (power <= sigLevel) continue;
      sig++;
      // power-weighted unit phasor: Σ power·(cos φ, sin φ) = Σ (xr, xi)
      wSum += power; wCos += xr; wSin += xi;
    }
    coiCount += inCoi; sigCount += sig;
    perScale.push({ sc, period, power: wSum, phase: wSum > 0 ? Math.atan2(wSin, wCos) : NaN, frac: inCoi > 0 ? sig / inCoi : 0 });
  });

  // unwrap from coarse to fine: the principal lag at period T is only known
  // modulo T; take the branch nearest the last coarser significant lag
  const lagOf = new Array<number>(perScale.length).fill(NaN);
  let ref = NaN;
  for (let k = perScale.length - 1; k >= 0; k--) {
    const p = perScale[k];
    if (!Number.isFinite(p.phase)) continue;
    const principal = (p.phase / (2 * Math.PI)) * p.period;   // sim late ⇒ positive (test-pinned)
    lagOf[k] = Number.isFinite(ref) ? principal + p.period * Math.round((ref - principal) / p.period) : principal;
    ref = lagOf[k];
  }

  const byScale: XwtScaleRow[] = [];
  let sumW = 0, sumWLag = 0, sumWAbs = 0;
  perScale.forEach((p, k) => {
    const lag = lagOf[k];
    if (Number.isFinite(lag)) { sumW += p.power; sumWLag += p.power * lag; sumWAbs += p.power * Math.abs(lag); }
    // reported in NATIVE steps: scale, period and lag are all multiplied back
    // by the block size when the series was block-averaged
    byScale.push({
      scale: p.sc * decimation, period: p.period * decimation,
      meanLag: lag * decimation,
      fracSignificant: p.frac,
      beyondHalfPeriod: Number.isFinite(lag) && Math.abs(lag) > p.period / 2,
    });
  });

  return {
    headlineLag: sumW > 0 ? (sumWLag / sumW) * decimation : NaN,
    headlineAbsLag: sumW > 0 ? (sumWAbs / sumW) * decimation : NaN,
    byScale,
    fracSignificant: coiCount > 0 ? sigCount / coiCount : 0,
    decimation,
  };
}

export { pearson as _xwtPearson };
