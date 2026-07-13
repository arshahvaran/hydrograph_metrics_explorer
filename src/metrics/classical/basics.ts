// Seed of the classical engine (full catalogue lands at CP2).
// All implementations are written from the published equations (App. A / paper
// Table 1) — no code is taken from HydroErr/Hydrostats/hydroGOF — and are
// verified value-for-value against executed reference outputs in tests/.

function mean(a: ArrayLike<number>): number {
  let s = 0; for (let i = 0; i < a.length; i++) s += a[i];
  return s / a.length;
}

/** Population standard deviation (ddof = 0), matching the reference libraries. */
function stdPop(a: ArrayLike<number>, m = mean(a)): number {
  let s = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - m; s += d * d; }
  return Math.sqrt(s / a.length);
}

export function pearsonR(obs: ArrayLike<number>, sim: ArrayLike<number>): number {
  const mo = mean(obs), ms = mean(sim);
  let num = 0, dso = 0, dss = 0;
  for (let i = 0; i < obs.length; i++) {
    const o = obs[i] - mo, s = sim[i] - ms;
    num += o * s; dso += o * o; dss += s * s;
  }
  const den = Math.sqrt(dso * dss);
  return den === 0 ? NaN : num / den;
}

/** Nash–Sutcliffe efficiency: 1 − Σ(S−O)² / Σ(O−Ō)².  (−∞, 1], optimum 1. */
export function nse(obs: ArrayLike<number>, sim: ArrayLike<number>): number {
  const mo = mean(obs);
  let num = 0, den = 0;
  for (let i = 0; i < obs.length; i++) {
    const e = sim[i] - obs[i]; num += e * e;
    const d = obs[i] - mo; den += d * d;
  }
  return den === 0 ? NaN : 1 - num / den;
}

export interface KgeParts { kge: number; r: number; alpha: number; beta: number }

/** Kling–Gupta efficiency (Gupta et al., 2009): α = σs/σo, β = μs/μo. */
export function kge2009(obs: ArrayLike<number>, sim: ArrayLike<number>): KgeParts {
  const r = pearsonR(obs, sim);
  const mo = mean(obs), ms = mean(sim);
  const alpha = stdPop(sim, ms) / stdPop(obs, mo);
  const beta = ms / mo;
  const kge = 1 - Math.sqrt((r - 1) ** 2 + (alpha - 1) ** 2 + (beta - 1) ** 2);
  return { kge, r, alpha, beta };
}

export function rmse(obs: ArrayLike<number>, sim: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < obs.length; i++) { const e = sim[i] - obs[i]; s += e * e; }
  return Math.sqrt(s / obs.length);
}

/**
 * Percent bias with the paper's sign convention (Table 2 footnote):
 * PBIAS = 100 · Σ(O − S) / ΣO, so **positive = underestimation**.
 */
export function pbias(obs: ArrayLike<number>, sim: ArrayLike<number>): number {
  let num = 0, den = 0;
  for (let i = 0; i < obs.length; i++) { num += obs[i] - sim[i]; den += obs[i]; }
  return den === 0 ? NaN : (100 * num) / den;
}

/** Bounded C2M form of an efficiency E (Mathevet et al., 2006): E/(2−E) ∈ (−1, 1]. */
export function c2m(e: number): number {
  return e / (2 - e);
}
