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
    it(`${key}: headline lag within 10 % of K, no per-scale lag of the wrong sign`, () => {
      const { o, s, K } = INPUTS[key];
      const r = xwtLag(o, s);
      expect(Math.abs(r.headlineLag - K)).toBeLessThan(0.1 * K);
      const signed = r.byScale.filter(x => Number.isFinite(x.meanLag));
      expect(signed.length).toBeGreaterThan(5);
      expect(signed.every(x => x.meanLag > 0)).toBe(true);
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
