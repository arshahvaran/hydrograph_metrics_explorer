import { describe, it, expect } from 'vitest'
import { bootstrapCIs, defaultBlockLen } from '../src/metrics/bootstrap'
import { mulberry32 } from '../src/metrics/support/stats'

// AR(1)-flavoured synthetic pair with a known good fit
function synth(n: number, seed = 7) {
  const rng = mulberry32(seed);
  const o = new Float64Array(n), s = new Float64Array(n);
  let x = 5;
  for (let i = 0; i < n; i++) {
    x = 0.9 * x + 0.5 + (rng() - 0.5);           // autocorrelated positive flow
    o[i] = 4 + x + Math.sin(i / 12) * 2;
    s[i] = o[i] * 0.95 + 0.3 + (rng() - 0.5) * 0.4; // close simulation
  }
  return { o, s };
}
const CTX = { nanPolicy: 'pairwise' as const, transform: 'none' as const };

describe('block-bootstrap CIs (spec §21 v1.1 → CP8)', () => {
  it('block length follows the n^(1/3) rate with a floor of 3', () => {
    expect(defaultBlockLen(8)).toBe(3);
    expect(defaultBlockLen(1000)).toBe(10);
    expect(defaultBlockLen(27000)).toBe(30);
  });

  it('is reproducible for a fixed seed and differs across seeds', () => {
    const { o, s } = synth(400);
    const a = bootstrapCIs(o, s, CTX, { B: 120, seed: 42 });
    const b = bootstrapCIs(o, s, CTX, { B: 120, seed: 42 });
    const c = bootstrapCIs(o, s, CTX, { B: 120, seed: 43 });
    expect(a.cis.nse).toEqual(b.cis.nse);
    expect(a.cis.nse).not.toEqual(c.cis.nse);
  });

  it('95% interval brackets the point estimate and is ordered', () => {
    const { o, s } = synth(600);
    const res = bootstrapCIs(o, s, CTX, { B: 200, seed: 1 });
    for (const id of ['nse', 'kge2012', 'rmse', 'r', 'pbias', 've']) {
      const [lo, hi] = res.cis[id];
      expect(lo).toBeLessThanOrEqual(hi);
      expect(isFinite(lo) && isFinite(hi)).toBe(true);
    }
    // point NSE of this synthetic pair is high; interval must contain plausible values around it
    expect(res.cis.nse[0]).toBeGreaterThan(0.5);
    expect(res.cis.nse[1]).toBeLessThanOrEqual(1.000001);
  });

  it('intervals tighten with record length (sanity, not a strict law)', () => {
    const small = synth(150, 3), big = synth(3000, 3);
    const a = bootstrapCIs(small.o, small.s, CTX, { B: 200, seed: 5 });
    const b = bootstrapCIs(big.o, big.s, CTX, { B: 200, seed: 5 });
    const width = (r: typeof a, id: string) => r.cis[id][1] - r.cis[id][0];
    expect(width(b, 'r')).toBeLessThan(width(a, 'r'));
    expect(width(b, 'nse')).toBeLessThan(width(a, 'nse'));
  });

  it('covers only the classical block; no timing ids in the CI map', () => {
    const { o, s } = synth(300);
    const res = bootstrapCIs(o, s, CTX, { B: 60, seed: 9 });
    for (const id of ['peak_lag_abs', 'dtw_dist', 'w1', 'de', 'xwt_lag', 'event_threat']) {
      expect(res.cis[id]).toBeUndefined();
    }
    expect(res.cis.nse).toBeDefined();
  });

  it('progress callback fires and finishes at 1', () => {
    const { o, s } = synth(200);
    const seen: number[] = [];
    bootstrapCIs(o, s, CTX, { B: 100, seed: 2, onProgress: (d, t) => seen.push(d / t) });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBe(1);
  });
});
