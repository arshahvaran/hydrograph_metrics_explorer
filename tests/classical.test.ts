import { describe, it, expect } from 'vitest'
import fixture from './fixtures/reference_vectors.json'
import { applyNanPolicy } from '../src/ingest/missing'
import * as C from '../src/metrics/classical/catalogue'

const F = fixture as any
const num = (v: string | number) => (typeof v === 'number' ? v : Number(v))
const series = (name: string) => {
  const s = F.series[name]
  const parse = (a: string[]) => a.map((v: string) => (v === 'NaN' ? NaN : Number(v)))
  const p = applyNanPolicy(parse(s.obs), parse(s.sim), 'pairwise')
  return { o: p.obs, s: p.sim }
}
const close = (a: number, b: number, tol = 1e-9) => {
  expect(Number.isFinite(a)).toBe(true)
  expect(Math.abs(a - b)).toBeLessThanOrEqual(tol * Math.max(1, Math.abs(b)))
}

// my function -> executed HydroErr 2.0.0 key
const MAP: [keyof typeof C, string][] = [
  ['me', 'me'], ['mae', 'mae'], ['mdae', 'mdae'], ['mse', 'mse'], ['rmse', 'rmse'],
  ['mde', 'mde'], ['mdse', 'mdse'],
  // mle/male/msle/rmsle intentionally NOT mapped to HydroErr: its code computes
  // log1p(S)−log1p(O), contradicting its own paper's ln(S/O). See the paper-form
  // block below, pinned against independent NumPy references.
  ['mape', 'mape'], ['maape', 'maape'], ['smape', 'smape2'], ['mase', 'mase'],
  ['nrmseMean', 'nrmse_mean'], ['nrmseRange', 'nrmse_range'], ['nrmseIqr', 'nrmse_iqr'],
  ['r', 'pearson_r'], ['r2', 'r_squared'], ['spearman', 'spearman_r'],
  ['d', 'd'], ['d1', 'd1'], ['dr', 'dr'], ['drel', 'drel'], ['lmIndex', 'lm_index'],
  ['nse', 'nse'], ['nseMod', 'nse_mod'], ['nseRel', 'nse_rel'], ['ve', 've'],
]

const CASES = ['tiny6', 'nan8', 'synth730_shift3', 'synth730_offset', 'synth730_scale', 'synth730_dampen', 'synth730_noise', 'synth730_combo']

describe('classical catalogue vs executed HydroErr 2.0.0 (every implemented metric, every fixture series)', () => {
  for (const name of CASES) {
    it(name, () => {
      const { o, s } = series(name)
      const ref = F.results[name]['HydroErr_2.0.0']
      for (const [fn, key] of MAP) {
        const mine = (C[fn] as (a: any, b: any) => number)(o, s)
        close(mine, num(ref[key]))
      }
      close(C.kge2009(o, s).value, num(ref.kge_2009))
      close(C.kge2012(o, s).value, num(ref.kge_2012))
      // HydroErr's mapd returns the fraction; ours is the paper's percent form.
      close(C.mapd(o, s) / 100, num(ref.mapd))
    })
  }
})

// Paper-form log-error family (Jackson et al., 2019 Table 1: error term ln(S/O)).
// Reference values computed independently with NumPy float64 on the fixture series.
const PAPER_LOG_FAMILY: Record<string, { mle: number; male: number; msle: number; rmsle: number }> = {
  tiny6: { mle: -0.006416261738116603, male: 0.11768596813869303, msle: 0.017379398944911514, rmsle: 0.13183094835777945 },
  nan8: { mle: -0.021821933649532922, male: 0.11165115333676838, msle: 0.01735328082964503, rmsle: 0.131731851993529 },
  synth730_shift3: { mle: 9.33045253565622e-05, male: 0.12174877476754921, msle: 0.03815175610047314, rmsle: 0.19532474523335014 },
  synth730_offset: { mle: 0.13998961144553612, male: 0.13998961144553612, msle: 0.022138879265286914, rmsle: 0.14879139513186546 },
  synth730_scale: { mle: 0.22314355131420976, male: 0.22314355131420976, msle: 0.049793044493117375, rmsle: 0.2231435513142098 },
  synth730_dampen: { mle: 0.08881625726297145, male: 0.18118434383799314, msle: 0.04199251096049126, rmsle: 0.2049207431191173 },
  synth730_noise: { mle: -0.028515095421128563, male: 0.15663325755272908, msle: 0.04863136331606176, rmsle: 0.22052519882331306 },
  synth730_combo: { mle: -0.22304977601808432, male: 0.2350222725152894, msle: 0.06784780831790949, rmsle: 0.26047611851743624 },
}

describe('log-error family follows the defining paper (ln S/O), not HydroErr\'s log1p code', () => {
  for (const name of CASES) {
    it(name, () => {
      const { o, s } = series(name)
      const ref = PAPER_LOG_FAMILY[name]
      close(C.mle(o, s), ref.mle)
      close(C.male(o, s), ref.male)
      close(C.msle(o, s), ref.msle)
      close(C.rmsle(o, s), ref.rmsle)
    })
  }
  it('ln(S/O) is scale-invariant; log1p is not (the property that decides the convention)', () => {
    const { o, s } = series('tiny6')
    const k = 1000 // convert units, e.g. m3/s -> L/s
    const ok = Array.from(o, v => v * k), sk = Array.from(s, v => v * k)
    close(C.mle(ok, sk), C.mle(o, s), 1e-12)
    const log1p = (a: ArrayLike<number>, b: ArrayLike<number>) => {
      let acc = 0; for (let i = 0; i < a.length; i++) acc += Math.log1p(b[i]) - Math.log1p(a[i]); return acc / a.length
    }
    expect(Math.abs(log1p(ok, sk) - log1p(o, s))).toBeGreaterThan(1e-6)
  })
})

describe('vs executed hydroeval 0.1.0 (PBIAS sign, KGEnp, C2M family, MARE)', () => {
  for (const name of CASES) {
    it(name, () => {
      const { o, s } = series(name)
      const he = F.results[name]['hydroeval_0.1.0']
      close(C.pbias(o, s), num(he.pbias), 1e-9)
      close(C.mapd(o, s) / 100, num(he.mare)) // hydroeval's "mare" = our MAPD/100
      close(C.c2m(C.nse(o, s)), num(he.nse_c2m))
      close(C.c2m(C.kge2009(o, s).value), num(he.kge_c2m))
      close(C.c2m(C.kge2012(o, s).value), num(he.kgeprime_c2m))
      // hydroeval breaks Spearman ties by numpy's unstable quicksort order;
      // ours are stable-by-index: identical when there are no ties, ≤1e-5 with.
      close(C.c2m(C.kgenp(o, s).value), num(he.kgenp_c2m), 1e-5)
    })
  }
})

describe('metrics without an executable oracle: pinned identities', () => {
  it('RSR = RMSE/σ, α, β-NSE, KGE″ reduce correctly on a known pair', () => {
    const { o, s } = series('tiny6')
    close(C.rsr(o, s), C.rmse(o, s) / Math.sqrt(o.reduce((a, v) => a + (v - 5.7) ** 2, 0) / o.length))
    // identical series ⇒ perfection
    close(C.kge2021(o, o).value, 1, 1e-12)
    close(C.alphaRatio(o, o), 1, 1e-12)
    expect(Math.abs(C.betaNse(o, o))).toBeLessThan(1e-12)
  })
  it('FDC signatures: exact zero for identical series; FHV sign tracks peak bias', () => {
    const { o } = series('synth730_shift3')
    close(C.fhv(o, o), 0, 1e-12); close(C.flv(o, o), 0, 1e-12)
    close(C.fms(o, o), 0, 1e-12); close(C.fmm(o, o), 0, 1e-12)
    const inflated = Array.from(o, v => v * 1.2)
    expect(C.fhv(o, inflated)).toBeGreaterThan(0)
  })
  it('benchmark skill: model at optimum ⇒ 1, model at benchmark ⇒ 0', () => {
    close(C.skill(1, -0.2, 1), 1, 1e-12)
    close(C.skill(-0.2, -0.2, 1), 0, 1e-12)
  })
})

describe('audit pins: polarity, sign conventions, ranges, edge cases', () => {
  const o6 = [4.7, 6, 10, 2.5, 4, 7]
  it('PBIAS: uniform 20% under-simulation gives +20 (paper/Moriasi convention; hydroGOF is the opposite sign)', () => {
    const under = o6.map(v => 0.8 * v)
    expect(C.pbias(o6, under)).toBeCloseTo(20, 10)
    expect(C.pbias(o6, o6.map(v => 1.2 * v))).toBeCloseTo(-20, 10)
  })
  it('VE range is (−∞,1], not the commonly misstated [0,1): a bad model goes negative, a perfect one hits 1', () => {
    expect(C.ve(o6, o6)).toBe(1)
    const awful = o6.map(v => v * 3)
    expect(C.ve(o6, awful)).toBeLessThan(0)
  })
  it('sMAPE respects its 0–200 bound and attains 200 at total mismatch', () => {
    expect(C.smape([1, 2, 3], [0, 0, 0])).toBeCloseTo(200, 10)
    expect(C.smape(o6, o6.map(v => v * 1.5))).toBeLessThan(200)
  })
  it('DE polarity: identical series score exactly 0 (0 is perfect, larger is worse)', async () => {
    const { diagnosticEfficiency } = await import('../src/metrics/timing/deSd')
    const d = diagnosticEfficiency(o6, o6)
    // adjudicated: DE is a float composite (Simpson quadrature + r); demanding
    // bit-exact zero over-pins a rounding accident of the old pearson formula.
    expect(d.de).toBeCloseTo(0, 12)
    expect(diagnosticEfficiency(o6, o6.map(v => v * 1.4)).de).toBeGreaterThan(0)
  })
  it('sqrt transform: negative flow propagates NaN instead of being silently clamped', () => {
    const { o } = { o: [4, -1, 9] }
    const t = C.applyTransform(o, [4, 1, 9], 'sqrt')
    expect(t.o[1]).toBeNaN()
    expect(t.o[2]).toBe(3)
  })
  it('benchmarks are NaN-safe: mean benchmark ignores gaps', () => {
    const b = C.benchmarkSeries([1, NaN, 3], 'mean')
    expect(Array.from(b)).toEqual([2, 2, 2])
  })
  it('skill: undefined when the benchmark already sits at the optimum', () => {
    expect(C.skill(0.9, 1, 1)).toBeNaN()
  })
  it('KGE component semantics: 2021 bias term is (μs−μo)/σo with optimum 0 (Tang et al., 2021)', () => {
    const shifted = o6.map(v => v + 1)
    const k = C.kge2021(o6, shifted)
    const sd = Math.sqrt(o6.reduce((a, v) => a + (v - 34.2 / 6) ** 2, 0) / 6)
    expect(k.bias).toBeCloseTo(1 / sd, 12)
    expect(C.kge2021(o6, o6).bias).toBeCloseTo(0, 12)
  })
})

describe('audit pins added for the Extended catalogue (v1.3.0)', () => {
  // wR²: Krause, Boyle & Bäse (2005): |b|·R² for b ≤ 1, R²/|b| otherwise,
  // with b the OLS slope of simulated on observed (hydroGOF br2 semantics).
  it('wr2 matches the Krause (2005) formula on a hand-worked vector', async () => {
    const { wr2, pearson } = { ...(await import('../src/metrics/classical/catalogue')), ...(await import('../src/metrics/support/stats')) } as any;
    const o = [1, 2, 3, 4, 5], s = [1.2, 1.9, 3.1, 3.9, 5.2];
    const mo = 3, ms = s.reduce((a, b) => a + b, 0) / 5;
    let num = 0, den = 0;
    for (let i = 0; i < 5; i++) { num += (o[i] - mo) * (s[i] - ms); den += (o[i] - mo) ** 2; }
    const b = num / den;
    const r2 = pearson(o, s) ** 2;
    const expected = Math.abs(b) <= 1 ? Math.abs(b) * r2 : r2 / Math.abs(b);
    expect(wr2(o, s)).toBeCloseTo(expected, 12);
  });
  // logNSE: NSE on ln(Q + ε), ε = mean(obs)/100 (Pushpalatha et al., 2012).
  it('logNse equals NSE of the ε-shifted logs, computed independently', async () => {
    const { logNse } = await import('../src/metrics/classical/catalogue') as any;
    const o = [2, 5, 9, 4, 7, 3], s = [2.4, 4.6, 8.1, 4.4, 7.9, 2.7];
    const eps = o.reduce((a, b) => a + b, 0) / o.length * 0.01;
    const lo = o.map(x => Math.log(x + eps)), ls = s.map(x => Math.log(x + eps));
    const mlo = lo.reduce((a, b) => a + b, 0) / lo.length;
    let num = 0, den = 0;
    for (let i = 0; i < lo.length; i++) { num += (ls[i] - lo[i]) ** 2; den += (lo[i] - mlo) ** 2; }
    expect(logNse(o, s)).toBeCloseTo(1 - num / den, 12);
  });
});
