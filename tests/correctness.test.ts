/**
 * QA numerical correctness audit.
 * Synthetic cases with KNOWN answers, asserted exactly. This is the suite the
 * paper depends on: if the shift battery fails, the paper's Section 6 claim
 * is false.
 */
import { describe, it, expect } from 'vitest'
import { computeAll, REGISTRY, classicalValues } from '../src/metrics/registry'
import { defaultView } from '../src/types'
import { dtw, wasserstein1 } from '../src/metrics/timing/dtwWasserstein'
import { rankRuns } from '../src/metrics/rank'
import { mulberry32 } from '../src/metrics/support/stats'

const ctx = (n = 240) => {
  const v = defaultView(86_400_000, n);
  return { nanPolicy: v.nanPolicy, transform: v.transform, timing: v.timingConfig, heavy: true } as any;
};
// A hydrograph with clear, well-separated peaks so event/peak metrics engage.
const hydro = (n = 240, lag = 0) =>
  Float64Array.from({ length: n }, (_, i) => 2 + 8 * Math.exp(-(((i - lag + 600) % 40 - 20) ** 2) / 18));

describe('C1: identical series → every metric at its documented optimum', () => {
  const o = hydro(), s = hydro();
  const out = computeAll(o, s, ctx());
  // metrics whose optimum is not a plain number (documented, not dodged):
  const NON_NUMERIC = new Set(['lag_best']); // optimum '0 steps' parses fine; keep set for future
  for (const m of REGISTRY) {
    const opt = parseFloat(m.optimum);
    if (!isFinite(opt)) { NON_NUMERIC.add(m.id); continue; }
    it(`${m.id} = ${opt}`, () => {
      const v = out.values[m.id];
      expect(isFinite(v), `${m.id} returned ${v}`).toBe(true);
      expect(Math.abs(v - opt)).toBeLessThan(1e-6);
    });
  }
  it('nothing important was skipped', () => {
    expect([...NON_NUMERIC].filter(id => id !== 'lag_best')).toEqual([]);
  });
});

describe('C2: simulated = observed mean (the NSE=0 benchmark, exactly)', () => {
  const o = hydro();
  const m = o.reduce((a, b) => a + b, 0) / o.length;
  const s = Float64Array.from(o, () => m);
  const { values } = classicalValues(o, s);
  it('NSE is exactly 0', () => expect(values.nse).toBeCloseTo(0, 12));
  it('RSR is exactly 1', () => expect(values.rsr).toBeCloseTo(1, 12));
  it('r and KGE are n/a (zero-variance simulation), never numbers', () => {
    expect(Number.isNaN(values.r)).toBe(true);
    expect(Number.isNaN(values.kge2009)).toBe(true);
  });
});

const ctxTol = (n: number, tol: number) => {
  const c = ctx(n);
  return { ...c, timing: { ...c.timing, peakMatchTolerance: tol } };
};

describe('C3: pure time shift; the paper\'s central demonstration', () => {
  const K = 4;
  const o = hydro(240, 0), s = hydro(240, K); // simulation is K steps LATE
  // Peak-match tolerance is set >= the expected lag, as an analyst would.
  const out = computeAll(o, s, ctxTol(240, 8));
  it('synchronous scores degrade', () => {
    expect(out.values.nse).toBeLessThan(0.9);
    expect(out.values.r).toBeLessThan(0.95);
    expect(out.values.rmse).toBeGreaterThan(0.5);
  });
  it('peak timing reads the shift exactly, with "late = positive"', () => {
    expect(out.values.peak_lag_abs).toBeCloseTo(K, 6);
    expect(out.values.peak_lag_signed).toBeCloseTo(K, 6);
  });
  it('lag sweep finds the same shift with the same sign', () => {
    expect(out.values.lag_best).toBeCloseTo(K, 6);
  });
  it('cross-wavelet lag agrees in sign and roughly in size', () => {
    expect(Math.sign(out.values.xwt_lag)).toBe(1);
    expect(Math.abs(out.values.xwt_lag - K)).toBeLessThan(2);
  });
  it('DTW absorbs the shift: tiny distance while RMSE is large, bounded warp', () => {
    // DTW warp is local and transient (the path warps only through the events
    // and rides the diagonal in between), so mean warp is a *fraction* of the
    // shift. The sharp, honest claims: distance ≈ 0 while RMSE is large.
    expect(out.values.dtw_dist).toBeLessThan(0.05);
    expect(out.values.rmse).toBeGreaterThan(10 * out.values.dtw_dist);
    expect(out.values.dtw_warp).toBeGreaterThan(0);
    expect(out.values.dtw_warp).toBeLessThanOrEqual(K + 1e-9);
  });

  it('W1 = the shift exactly for a whole-mass interior translation (zero base)', () => {
    // W1 is mass-weighted displacement: exact-K only when ALL mass moves.
    const bump = (lag: number) => Float64Array.from({ length: 200 }, (_, i) =>
      9 * Math.exp(-(((i - lag - 100) ** 2)) / 20));
    expect(wasserstein1(bump(0), bump(K))).toBeCloseTo(K, 6);
  });

  it('a true lag beyond the search window answers n/a; never a clamped number', () => {
    // With tolerance 3 and true lag 4, the old code confidently reported 3.
    const clamped = computeAll(o, s, ctxTol(240, 3));
    expect(Number.isNaN(clamped.values.peak_lag_abs)).toBe(true);
    expect(Number.isNaN(clamped.values.peak_lag_signed)).toBe(true);
    expect(clamped.notes.join(' ')).toMatch(/no resolvable/i);
  });
  it('event & series-distance timing agree', () => {
    expect(Math.abs(out.values.event_lag - K)).toBeLessThan(1.01);
    expect(Math.abs(out.values.sd_time - K)).toBeLessThan(1.01);
  });
  it('W1 grows monotonically with the shift', () => {
    const w = (k: number) => computeAll(hydro(240, 0), hydro(240, k), ctx()).values.w1;
    expect(w(2)).toBeLessThan(w(5));
    expect(w(5)).toBeLessThan(w(9));
  });
});

describe('C4: pure constant offset', () => {
  const C = 2;
  const o = hydro();
  const s = Float64Array.from(o, v => v + C);
  const { values } = classicalValues(o, s);
  const mo = o.reduce((a, b) => a + b, 0) / o.length;
  const sso = o.reduce((a, b) => a + (b - mo) ** 2, 0);
  it('correlation is untouched', () => expect(values.r).toBeCloseTo(1, 12));
  it('ME = +C exactly', () => expect(values.me).toBeCloseTo(C, 12));
  it('PBIAS is negative (over-estimation) with the exact magnitude', () => {
    expect(values.pbias).toBeCloseTo(-100 * C * o.length / o.reduce((a, b) => a + b, 0), 9);
  });
  it('β-NSE = C/σo exactly', () => {
    expect(values.beta_nse).toBeCloseTo(C / Math.sqrt(sso / o.length), 9);
  });
  it('NSE matches its closed form 1 − nC²/SSO', () => {
    expect(values.nse).toBeCloseTo(1 - (o.length * C * C) / sso, 9);
  });
});

describe('C5: pure scaling about zero', () => {
  const G = 1.3;
  const o = hydro();
  const s = Float64Array.from(o, v => v * G);
  const out = computeAll(o, s, { ...ctx(), heavy: false });
  it('variability ratio α = γ exactly', () => expect(out.values.alpha).toBeCloseTo(G, 12));
  it('KGE-2009 variability term = γ; correlation stays 1', () => {
    expect(out.extras.kge2009!.variability).toBeCloseTo(G, 12);
    expect(out.extras.kge2009!.r).toBeCloseTo(1, 12);
    expect(out.extras.kge2009!.bias).toBeCloseTo(G, 12);
  });
});

describe('C6: DTW path properties (seeded property loop)', () => {
  it('monotonic, corner-to-corner, inside the band; 40 random pairs', () => {
    const rng = mulberry32(2024);
    for (let iter = 0; iter < 40; iter++) {
      const n = 8 + Math.floor(rng() * 110);
      const f = [0.05, 0.1, 0.3, 1][Math.floor(rng() * 4)];
      const o = Float64Array.from({ length: n }, () => rng() * 10);
      const s = Float64Array.from({ length: n }, () => rng() * 10);
      const r = dtw(o, s, f);
      const band = Math.max(1, Math.ceil(f * n));
      expect(r.path[0]).toEqual([0, 0]);
      expect(r.path[r.path.length - 1]).toEqual([n - 1, n - 1]);
      let [pi, pj] = [0, 0];
      for (const [i, j] of r.path.slice(1)) {
        expect(i - pi).toBeGreaterThanOrEqual(0);
        expect(j - pj).toBeGreaterThanOrEqual(0);
        expect((i - pi) + (j - pj)).toBeGreaterThan(0);
        expect(Math.abs(i - j)).toBeLessThanOrEqual(band);
        [pi, pj] = [i, j];
      }
      expect(r.normalized).toBeGreaterThanOrEqual(0);
    }
  });
  it('self-distance is zero', () => {
    const o = hydro(100);
    expect(dtw(o, o, 0.1).normalized).toBeCloseTo(0, 12);
  });
});

describe('C7: Wasserstein mass normalisation', () => {
  const o = hydro(120, 0), s = hydro(120, 3);
  it('invariant to uniform scaling of either series', () => {
    expect(wasserstein1(o, Float64Array.from(s, v => v * 7.3))).toBeCloseTo(wasserstein1(o, s), 9);
    expect(wasserstein1(Float64Array.from(o, v => v * 0.2), s)).toBeCloseTo(wasserstein1(o, s), 9);
  });
  it('symmetric', () => {
    expect(wasserstein1(o, s)).toBeCloseTo(wasserstein1(s, o), 12);
  });
});

describe('C8: ranking respects metric polarity', () => {
  const mk = (nse: number, rmse: number) => ({ values: { nse, rmse } });
  it('error measure: smaller wins; skill score: larger wins', () => {
    const inputs = [mk(0.9, 2.0), mk(0.6, 0.5)] as any;
    const byRmse = rankRuns(inputs, [{ id: 'rmse', weight: 1 }]);
    const byNse = rankRuns(inputs, [{ id: 'nse', weight: 1 }]);
    // run 1 has the smaller RMSE → must rank first under rmse-only priorities
    expect(byRmse.map(r => r.rank)[1]).toBeLessThan(byRmse.map(r => r.rank)[0]);
    // run 0 has the larger NSE → must rank first under nse-only priorities
    expect(byNse.map(r => r.rank)[0]).toBeLessThan(byNse.map(r => r.rank)[1]);
  });
});

describe('C9: determinism', () => {
  it('same input, same full output object', () => {
    const o = hydro(200, 0), s = hydro(200, 3);
    const a = computeAll(o, s, ctx(200));
    const b = computeAll(o, s, ctx(200));
    expect(JSON.stringify(a.values)).toEqual(JSON.stringify(b.values));
  });
});
