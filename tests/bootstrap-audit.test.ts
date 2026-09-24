/** Bootstrap regressions (audit norms-01, stats-01, stats-02, stats-04, corr-01, compute-10). */
import { describe, it, expect } from 'vitest'
import { bootstrapCIs, autoBlockLen } from '../src/metrics/bootstrap'
import { computeAll } from '../src/metrics/registry'
import { defaultView } from '../src/types'
import { median, quantile, ranksAverage, mulberry32 } from '../src/metrics/support/stats'
import { spearman } from '../src/metrics/classical/catalogue'

/** A persistent, hydrograph-like record: AR(1) flow and an AR(1) model error. */
function record(n: number, phiQ = 0.97, phiE = 0.9, seed = 7) {
  const rnd = mulberry32(seed);
  const g = () => { let u = 0; for (let k = 0; k < 12; k++) u += rnd(); return u - 6; };
  const o: number[] = [], s: number[] = [];
  let q = 0, e = 0;
  for (let i = 0; i < n; i++) {
    q = phiQ * q + g(); e = phiE * e + 0.4 * g();
    const flow = 20 + 4 * q;
    o.push(flow); s.push(flow + e + 1);
  }
  return { o, s };
}
const ctx = (transform: 'none' | 'log' | 'sqrt' = 'none') => ({ nanPolicy: 'pairwise' as const, transform, timing: defaultView(864e5, 2000).timingConfig });

describe('norms-01 / stats-01: MASE keeps the naive scale of the ordered record', () => {
  it('the 95% CI contains the MASE point estimate', () => {
    const { o, s } = record(1500);
    const point = computeAll(o, s, ctx()).values.mase;
    const ci = bootstrapCIs(o, s, ctx(), { B: 300 }).cis.mase;
    expect(ci[0]).toBeLessThanOrEqual(point);
    expect(ci[1]).toBeGreaterThanOrEqual(point);
  });
});

describe('stats-04 / corr-01 / compute-10: the bootstrap resamples the point estimate\'s own pairs', () => {
  it('one negative observed value under sqrt: CIs are still computed and Spearman\'s CI contains its estimate', () => {
    const { o, s } = record(800);
    o[100] = -1;                               // sqrt(-1) is not finite: that pair is dropped, as in computeAll
    const out = computeAll(o, s, ctx('sqrt')), point = out.values;
    const res = bootstrapCIs(o, s, ctx('sqrt'), { B: 300 });
    expect(res.n).toBe(out.n);                  // same sample as the point estimate
    expect(res.n).toBeLessThan(800);
    const finite = Object.values(res.cis).filter(c => Number.isFinite(c[0])).length;
    expect(finite).toBeGreaterThan(30);
    expect(res.cis.spearman[0]).toBeLessThanOrEqual(point.spearman);
    expect(res.cis.spearman[1]).toBeGreaterThanOrEqual(point.spearman);
  });
  it('order statistics return NaN for input holding NaN instead of a finite wrong number', () => {
    expect(median([1, NaN, 3, 2])).toBeNaN();
    expect(quantile([1, NaN, 3, 2], 0.5)).toBeNaN();
    expect(Array.from(ranksAverage([3, NaN, 1, 2])).every(Number.isNaN)).toBe(true);
    expect(spearman([1, 2, 3, 4, 5, 6], [1, 2, NaN, 4, 5, 6])).toBeNaN();
  });
});

describe('stats-02: the block length follows the persistence of the errors', () => {
  it('persistent errors get far longer blocks than white noise, within [3, n/4]', () => {
    const rnd = mulberry32(3);
    const white = Array.from({ length: 2000 }, () => rnd() - 0.5);
    let e = 0;
    const ar = Array.from({ length: 2000 }, () => (e = 0.95 * e + (rnd() - 0.5)));
    const lw = autoBlockLen(white), la = autoBlockLen(ar);
    expect(lw).toBeGreaterThanOrEqual(3);
    expect(la).toBeGreaterThan(3 * lw);
    expect(la).toBeLessThanOrEqual(500);
  });
  it('the interval is wider than with the fixed n^(1/3) block for persistent errors', () => {
    const { o, s } = record(1500);
    const auto = bootstrapCIs(o, s, ctx(), { B: 300 });
    const fixed = bootstrapCIs(o, s, ctx(), { B: 300, blockLen: Math.round(Math.cbrt(1500)) });
    expect(auto.blockLen).toBeGreaterThan(fixed.blockLen);
    const w = (r: typeof auto) => r.cis.rmse[1] - r.cis.rmse[0];
    expect(w(auto)).toBeGreaterThan(w(fixed));
  });
});
