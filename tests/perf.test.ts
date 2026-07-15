/** QA performance and memory. Measured, not guessed. Budgets are loose
 *  (CI-safe); the printed numbers are the deliverable. */
import { describe, it, expect } from 'vitest'
import { computeAll, classicalValues } from '../src/metrics/registry'
import { bootstrapCIs } from '../src/metrics/bootstrap'
import { lagSweep } from '../src/metrics/timing/events'
import { defaultView } from '../src/types'

const mk = (n: number, lag = 0) =>
  Float64Array.from({ length: n }, (_, i) => 3 + 2 * Math.sin(i / 9) + 1.5 * Math.sin(i / 137) + (i % 97 === 0 ? 4 : 0) + (lag ? 0.2 * Math.sin((i - lag) / 9) : 0));
const ctxFor = (n: number) => {
  const v = defaultView(86_400_000, n);
  return { nanPolicy: v.nanPolicy, transform: v.transform, timing: v.timingConfig, heavy: true } as any;
};
const time = (f: () => void): number => { const t0 = performance.now(); f(); return performance.now() - t0; };

describe('QA performance numbers', () => {
  it('heavy panel at 50k (spec-scale) and 500k (10x)', () => {
    const o50 = mk(50_000), s50 = mk(50_000, 4);
    const t50 = time(() => computeAll(o50, s50, ctxFor(50_000)));
    console.log(`[perf] computeAll heavy n=50k: ${t50.toFixed(0)} ms`);
    expect(t50).toBeLessThan(15_000);

    const o500 = mk(500_000), s500 = mk(500_000, 4);
    const t500 = time(() => computeAll(o500, s500, ctxFor(500_000)));
    console.log(`[perf] computeAll heavy n=500k (10x, decimated timing): ${t500.toFixed(0)} ms`);
    expect(t500).toBeLessThan(60_000);
  }, 120_000);

  it('classical block at 500k', () => {
    const o = mk(500_000), s = mk(500_000, 3);
    const t = time(() => classicalValues(o, s));
    console.log(`[perf] classicalValues n=500k: ${t.toFixed(0)} ms`);
    expect(t).toBeLessThan(8_000);
  }, 30_000);

  it('lag sweep at 50k and repeated-drag simulation (10 heavy recomputes)', () => {
    const o = mk(50_000), s = mk(50_000, 5);
    const t1 = time(() => lagSweep(o, s, -30, 30));
    console.log(`[perf] lagSweep ±30 n=50k: ${t1.toFixed(0)} ms`);
    const c = ctxFor(50_000);
    const t10 = time(() => { for (let k = 0; k < 10; k++) computeAll(o, s, c); });
    console.log(`[perf] 10x heavy recompute (slider-drag burst) n=50k: ${t10.toFixed(0)} ms → ${(t10 / 10).toFixed(0)} ms/frame`);
    expect(t10 / 10).toBeLessThan(15_000);
  }, 200_000);

  it('bootstrap CIs B=500 at n=20k', () => {
    const o = mk(20_000), s = mk(20_000, 2);
    const v = defaultView(86_400_000, 20_000);
    const t = time(() => bootstrapCIs(o, s, { nanPolicy: v.nanPolicy, transform: v.transform }, { B: 500, seed: 7 } as any));
    console.log(`[perf] bootstrapCIs B=500 n=20k: ${t.toFixed(0)} ms`);
    expect(t).toBeLessThan(90_000);
  }, 150_000);

  it('memory: 30 load/unload cycles of a 100k-row dataset stay bounded', () => {
    const before = process.memoryUsage().heapUsed;
    let peak = before;
    for (let k = 0; k < 30; k++) {
      const o = mk(100_000), s = mk(100_000, 3);
      classicalValues(o, s);
      const h = process.memoryUsage().heapUsed;
      if (h > peak) peak = h;
    }
    const after = process.memoryUsage().heapUsed;
    console.log(`[mem] heapUsed before=${(before / 1e6).toFixed(0)}MB after=${(after / 1e6).toFixed(0)}MB peak=${(peak / 1e6).toFixed(0)}MB over 30 cycles`);
    expect(after - before).toBeLessThan(400e6);
  }, 120_000);
});
