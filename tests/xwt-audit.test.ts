/** Cross-wavelet lag regressions (audit xwt-01..05, timing-sandbox-01). Inputs are the
 *  auditor's: flashy storm hydrographs delayed by exactly K steps, and a noisy 16-step
 *  sinusoid delayed by 7.5 steps (just under half its period). */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { xwtLag } from '../src/metrics/timing/xwt'
import { computeAll } from '../src/metrics/registry'
import { defaultView } from '../src/types'

const INPUTS = JSON.parse(readFileSync(new URL('./fixtures/xwt_audit_inputs.json', import.meta.url), 'utf8')) as
  Record<string, { o: number[]; s: number[]; K: number }>;

describe('xwt-01: a pure shift longer than half of a fast period is not folded toward zero', () => {
  for (const key of ['flashy_K6', 'flashy_K12']) {
    it(`${key}: headline lag within 10 % of K; every row that agrees with it is positive`, () => {
      const { o, s, K } = INPUTS[key];
      const r = xwtLag(o, s);
      expect(Math.abs(r.headlineLag - K)).toBeLessThan(0.1 * K);
      const agree = r.byScale.filter(x => Number.isFinite(x.meanLag) && !x.beyondHalfPeriod);
      expect(agree.length).toBeGreaterThan(0);
      expect(agree.every(x => x.meanLag > 0)).toBe(true);
      // rows whose half period is shorter than the lag hold aliased principal lags and are flagged
      expect(r.byScale.filter(x => Number.isFinite(x.meanLag) && x.period / 2 < Math.abs(r.headlineLag)).every(x => x.beyondHalfPeriod)).toBe(true);
    });
  }
});

it('xwt-03: phases near ±T/2 are averaged circularly (lag 7.5 at period 16 stays near 7.5)', () => {
  const { o, s, K } = INPUTS['sin16_k7.5_noise'];
  const r = xwtLag(o, s);
  const row = r.byScale.reduce((b, x) => (Math.abs(x.period - 16) < Math.abs(b.period - 16) ? x : b));
  expect(Math.abs(row.meanLag - K)).toBeLessThan(1);
});

describe('xwt-02 / timing-sandbox-01: per-scale rows are in native steps after block-averaging', () => {
  it('a 240-step cycle delayed 12 steps reads period ≈ 240 and lag ≈ 12 at n = 20000', () => {
    const n = 20000;
    const o = Array.from({ length: n }, (_, t) => 10 + Math.sin(2 * Math.PI * t / 240));
    const s = Array.from({ length: n }, (_, t) => 10 + Math.sin(2 * Math.PI * (t - 12) / 240));
    const r = xwtLag(o, s);
    expect(r.decimation).toBeGreaterThan(1);
    const row = r.byScale.filter(x => Number.isFinite(x.meanLag)).reduce((b, x) => (Math.abs(x.period - 240) < Math.abs(b.period - 240) ? x : b));
    expect(Math.abs(row.period - 240) / 240).toBeLessThan(0.12);
    expect(Math.abs(row.meanLag - 12)).toBeLessThan(1.5);
    expect(Math.abs(r.headlineLag - 12)).toBeLessThan(1.5);
  });
  it('computeAll says when the XWT was block-averaged', () => {
    const n = 20000, t0 = Date.UTC(2000, 0, 1);
    const o = Array.from({ length: n }, (_, t) => 10 + Math.sin(2 * Math.PI * t / 240));
    const s = Array.from({ length: n }, (_, t) => 10 + Math.sin(2 * Math.PI * (t - 12) / 240));
    const view = defaultView(3600_000, n);
    const out = computeAll(o, s, { nanPolicy: 'pairwise', transform: 'none', timing: view.timingConfig, datesMs: o.map((_, i) => t0 + i * 3600_000) } as any);
    expect(out.notes.join(' ')).toMatch(/Cross-wavelet analysis computed on a 1\/\d+ block-mean/);
  });
});

it('xwt-04: explicit wavelet scales are used', () => {
  const n = 1000;
  const o = Array.from({ length: n }, (_, t) => 5 + Math.sin(2 * Math.PI * t / 32));
  const s = Array.from({ length: n }, (_, t) => 5 + Math.sin(2 * Math.PI * (t - 3) / 32));
  const auto = xwtLag(o, s);
  const three = xwtLag(o, s, [2, 4, 8]);
  expect(auto.byScale.length).toBeGreaterThan(10);
  expect(three.byScale.map(x => x.scale)).toEqual([2, 4, 8]);
});

it('xwt-05: standardisation is not quadratic (4x the steps costs well under 16x the time)', () => {
  const series = (n: number) => {
    const o = Array.from({ length: n }, (_, t) => 5 + Math.sin(t / 40) + 0.3 * Math.sin(t / 7));
    return { o, s: o.map((_, t) => o[Math.max(0, t - 3)]) };
  };
  const time = (n: number) => {
    const { o, s } = series(n);
    let best = Infinity;
    for (let k = 0; k < 3; k++) { const t0 = performance.now(); xwtLag(o, s); best = Math.min(best, performance.now() - t0); }
    return best;
  };
  const ratio = time(16384) / time(4096);
  expect(ratio).toBeLessThan(9);          // n log n with J scales: about 4.5-5.5; the O(n^2) form gave about 16
});

// ---- review cases (science3 review, xwt-R1..R3, R5) -------------------------
import { mulberry32 } from '../src/metrics/support/stats'
function storms(n: number, p: number, meanDepth: number, shape: number, scale: number, len: number, seed: number) {
  const r = mulberry32(seed);
  const rain = Array.from({ length: n }, () => (r() < p ? -meanDepth * Math.log(1 - r()) : 0));
  const uh = Array.from({ length: len }, (_, k) => Math.pow(k + 0.5, shape - 1) * Math.exp(-(k + 0.5) / scale));
  const su = uh.reduce((a, b) => a + b, 0);
  const q = new Array(n).fill(0);
  for (let t = 0; t < n; t++) if (rain[t]) for (let k = 0; k < len && t + k < n; k++) q[t + k] += (rain[t] * uh[k]) / su;
  return q;
}

it('xwt-R1: a slow seasonal lag does not decide the branch of the storm scales', () => {
  const n = 3650, ev = storms(n + 5, 0.03, 10, 2, 2, 40, 1);
  const o = Array.from({ length: n }, (_, t) => 10 + 6 * Math.sin(2 * Math.PI * t / 365) + ev[t + 1]);
  const s = Array.from({ length: n }, (_, t) => 10 + 6 * Math.sin(2 * Math.PI * (t - 100) / 365) + ev[t]);
  const rows = xwtLag(o, s).byScale.filter(x => x.period < 80 && Number.isFinite(x.meanLag));
  expect(rows.length).toBeGreaterThan(5);
  expect(rows.every(x => Math.abs(x.meanLag - 1) < 0.5)).toBe(true);
});

it('xwt-R2: a diurnal lag of +10 h stays +10 h next to storms 5 h early', () => {
  const n = 8760, ev = storms(n + 10, 0.01, 10, 3, 4, 120, 2);
  const o = Array.from({ length: n }, (_, t) => 5 + Math.sin(2 * Math.PI * t / 24) + ev[t + 5]);
  const s = Array.from({ length: n }, (_, t) => 5 + Math.sin(2 * Math.PI * (t - 10) / 24) + ev[t + 10]);
  const r = xwtLag(o, s);
  const diurnal = r.byScale.filter(x => x.period > 18 && x.period < 30 && Number.isFinite(x.meanLag));
  expect(diurnal.length).toBeGreaterThan(0);
  expect(diurnal.every(x => x.meanLag > 6 && x.meanLag < 13)).toBe(true);
  expect(r.headlineLag).toBeGreaterThan(0);
});

it('xwt-R3: independent noise on a shared signal gives no coherent timing error', () => {
  const r3 = mulberry32(9);
  const g = () => { let u = 0; for (let k = 0; k < 12; k++) u += r3(); return u - 6; };
  const q = storms(2000, 0.02, 10, 2, 3, 60, 3).map(v => v + 1);
  const o = q.map(v => v + 1.5 * g()), s = q.map(v => v + 1.5 * g());
  const r = xwtLag(o, s);
  expect(Number.isNaN(r.headlineLag) || Math.abs(r.headlineLag) < 0.5).toBe(true);
  expect(r.byScale.filter(x => x.period < 6).every(x => Number.isNaN(x.meanLag) || Math.abs(x.meanLag) < 0.5)).toBe(true);
});

it('xwt-R5: explicit scales below 2 steps of the analysed series are reported as dropped', () => {
  const n = 20000;
  const o = Array.from({ length: n }, (_, t) => 10 + Math.sin(2 * Math.PI * t / 240));
  const s = o.map((_, t) => o[Math.max(0, t - 12)]);
  const r = xwtLag(o, s, [2, 4, 8, 60]);
  expect(r.decimation).toBe(3);
  expect(r.droppedScales).toEqual([2, 4]);
  expect(r.byScale.map(x => x.scale)).toEqual([8, 60]);
});
