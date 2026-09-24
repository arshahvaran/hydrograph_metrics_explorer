/** Diagnostic Efficiency and Series Distance regressions (audit de-sd-03..07, samples-e2e-02). */
import { describe, it, expect } from 'vitest'
import { diagnosticEfficiency, seriesDistance } from '../src/metrics/timing/deSd'
import { computeAll } from '../src/metrics/registry'
import { defaultView } from '../src/types'

const bump = (n: number, c: number, w: number, h: number) => Array.from({ length: n }, (_, i) => h * Math.exp(-0.5 * ((i - c) / w) ** 2));
const add = (...xs: number[][]) => xs[0].map((_, i) => xs.reduce((a, x) => a + x[i], 0));

describe('Diagnostic Efficiency follows diag-eff', () => {
  it('de-sd-03: a pure time shift plots at phi = 0 (half-curve artefacts zeroed), not at pi', () => {
    const n = 730;
    const obs = Array.from({ length: n }, (_, i) => 10 + 5 * Math.sin(2 * Math.PI * i / 365) + 2 * Math.sin(2 * Math.PI * i / 29));
    for (const k of [3, -3]) {
      const sim = obs.map((_, i) => obs[Math.min(n - 1, Math.max(0, i - k))]);   // plain shift: FDC differs only by rounding-size residue
      const de = diagnosticEfficiency(obs, sim);
      expect(Math.abs(de.brelMean)).toBeLessThan(0.001);
      expect(de.phi).toBe(0);
    }
  });
  it('de-sd-07: a constant simulation gets r = 0 and a finite DE, as diag-eff', () => {
    const obs = Array.from({ length: 200 }, (_, i) => 5 + Math.sin(i / 9));
    const sim = obs.map(() => 5);
    const de = diagnosticEfficiency(obs, sim);
    expect(de.rUndefined).toBe(true);
    expect(de.temporalR).toBe(0);
    expect(de.de).toBeCloseTo(Math.sqrt(de.brelMean ** 2 + de.bArea ** 2 + 1), 12);
  });
});

describe('Series Distance', () => {
  const opt = { thresholdKind: 'absolute' as const, thresholdValue: 3, minDistance: 1, warmup: 0 };
  it('de-sd-05: a matchable pair is not lost to greedy time-order matching', () => {
    // obs A (peak 100) and B (140); sim X (118) overlaps both, sim Y (80) only A.
    // Greedy in time order gave A->X and left B unmatched (1 hit); a matching gives A->Y, B->X.
    const n = 240;
    const obs = add(bump(n, 100, 3, 10), bump(n, 140, 3, 10));
    const sim = add(bump(n, 118, 3, 10), bump(n, 80, 3, 10));
    const sd = seriesDistance(obs, sim, opt, 15);   // event windows about ±4.6 steps around each peak
    expect(sd.matchedEvents).toBe(2);
    expect(sd.occurrence).toBe(1);
    expect(sd.pairedPeaks).toEqual([[100, 80], [140, 118]]);
  });
  it('samples-e2e-02: sim = obs + 1.5 (no timing error): each observed flood keeps its own simulated peak', () => {
    const n = 400;
    const obs = add(bump(n, 100, 6, 10), bump(n, 125, 6, 8), bump(n, 260, 6, 10), bump(n, 290, 6, 9)).map(v => v + 1);
    const sim = obs.map(v => v + 1.5);
    const sd = seriesDistance(obs, sim, { ...opt, thresholdValue: 4 }, 3);
    // every observed event is paired with the simulated event that has ITS peak
    expect(sd.pairedPeaks.every(([po, ps]) => po === ps)).toBe(true);
  });
  it('de-sd-06: amplitude is S - O in flow units', () => {
    const n = 300;
    const obs = add(bump(n, 150, 10, 10)).map(v => v + 1);
    const sim = obs.map(v => v * 1.2);
    const sd = seriesDistance(obs, sim, opt, 3);
    const mo = obs.filter(v => v >= 3);
    expect(sd.meanAmplitudeErr).toBeGreaterThan(0.1 * Math.min(...mo));
    expect(sd.meanAmplitudeErr).toBeLessThan(0.2 * Math.max(...mo) + 1e-9);
  });
  it('de-sd-04: rows missing inside an event do not shrink the timing error', () => {
    const n = 400, k = 6, t0 = Date.UTC(2001, 0, 1);
    const obs = add(bump(n, 150, 12, 20), bump(n, 290, 12, 20)).map(v => v + 1);
    const sim = obs.map((_, i) => obs[Math.max(0, i - k)]);
    const holed = obs.slice();
    for (let i = 151; i < 156; i++) holed[i] = NaN;     // gap between the observed (150) and simulated (156) peaks
    const view = defaultView(864e5, n);
    const ctx = { nanPolicy: 'pairwise', transform: 'none', timing: { ...view.timingConfig, eventThreshold: { kind: 'absolute', value: 5 } }, datesMs: obs.map((_, i) => t0 + i * 864e5) } as any;
    const full = computeAll(obs, sim, ctx).values.sd_time;
    const gap = computeAll(holed, sim, ctx).values.sd_time;
    expect(full).toBeCloseTo(k, 0);
    expect(Math.abs(gap - k)).toBeLessThan(0.5);
  });
});
