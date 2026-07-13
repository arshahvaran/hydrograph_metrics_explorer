/** AGENT C — property-based fuzz (fast-check). Universal invariants that must
 *  hold for ANY finite input, not just crafted cases. */
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { parseValue } from '../src/ingest/missing'
import { classicalValues } from '../src/metrics/registry'
import { dtw } from '../src/metrics/timing/dtwWasserstein'
import { stdPop } from '../src/metrics/support/stats'

const finiteDouble = fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true });

describe('parser properties', () => {
  it('String(x) round-trips exactly for finite doubles', () => {
    fc.assert(fc.property(finiteDouble, x => {
      // sentinel values are deliberately mapped to NaN — exclude them
      fc.pre(x !== -9999 && x !== -999);
      return parseValue(String(x), { sentinels: true }) === x;   // === so -0 and +0 compare equal
    }), { numRuns: 200 });
  });
  it('toFixed(k) round-trips within 10^-k', () => {
    fc.assert(fc.property(fc.double({ min: -1e5, max: 1e5, noNaN: true, noDefaultInfinity: true }), fc.integer({ min: 0, max: 8 }), (x, k) => {
      fc.pre(Math.abs(x - (-9999)) > 1 && Math.abs(x - (-999)) > 1);
      const v = parseValue(x.toFixed(k), { sentinels: true });
      return Math.abs(v - x) <= Math.pow(10, -k) / 2 + 1e-12;
    }), { numRuns: 200 });
  });
  it('anglophone thousands grouping parses back to the integer', () => {
    fc.assert(fc.property(fc.integer({ min: 1000, max: 999_999_999 }), n => {
      const grouped = n.toLocaleString('en-US');           // e.g. 1,234,567
      return parseValue(grouped, { sentinels: false }) === n;
    }), { numRuns: 200 });
  });
  it('single-comma decimals parse as decimals when the fraction is not 3 digits', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 9999 }), fc.integer({ min: 1, max: 99 }), (a, b) => {
      const s = `${a},${String(b).padStart(2, '0')}`;      // 2-digit fraction → decimal comma
      return Math.abs(parseValue(s, { sentinels: false }) - (a + b / 100)) < 1e-9;
    }), { numRuns: 200 });
  });
});

describe('metric invariants over arbitrary finite pairs', () => {
  const pair = fc.integer({ min: 5, max: 120 }).chain(n =>
    fc.tuple(
      fc.array(finiteDouble, { minLength: n, maxLength: n }),
      fc.array(finiteDouble, { minLength: n, maxLength: n }),
    ));

  it('rmse ≥ mae ≥ 0; mse ≥ 0; |r| ≤ 1 or n/a; kge ≤ 1 or n/a', () => {
    fc.assert(fc.property(pair, ([oA, sA]) => {
      const o = Float64Array.from(oA), s = Float64Array.from(sA);
      const { values: v } = classicalValues(o, s);
      expect(v.mae).toBeGreaterThanOrEqual(0);
      expect(v.mse).toBeGreaterThanOrEqual(0);
      expect(v.rmse + 1e-12).toBeGreaterThanOrEqual(v.mae);
      if (!Number.isNaN(v.r)) expect(Math.abs(v.r)).toBeLessThanOrEqual(1 + 1e-9);
      if (!Number.isNaN(v.kge2009)) expect(v.kge2009).toBeLessThanOrEqual(1 + 1e-12);
      // the QA-010 contract, fuzzed: never ±Infinity anywhere
      for (const [k, val] of Object.entries(v)) {
        expect(val === Infinity || val === -Infinity, `${k} = ${val}`).toBe(false);
      }
      return true;
    }), { numRuns: 60 });
  });

  it('perfect simulation scores its optimum (or n/a on degenerate obs)', () => {
    fc.assert(fc.property(fc.array(finiteDouble, { minLength: 5, maxLength: 100 }), oA => {
      const o = Float64Array.from(oA);
      const { values: v } = classicalValues(o, o);
      expect(v.rmse).toBe(0);
      expect(v.mae).toBe(0);
      if (stdPop(o) > 0) {
        expect(v.nse).toBe(1);
        if (!Number.isNaN(v.kge2009)) expect(v.kge2009).toBeCloseTo(1, 9);
      } else {
        expect(Number.isNaN(v.nse)).toBe(true);
      }
      return true;
    }), { numRuns: 80 });
  });

  it('DTW: self-distance 0, distance ≥ 0, path always corner-to-corner', () => {
    fc.assert(fc.property(fc.array(finiteDouble, { minLength: 6, maxLength: 80 }), oA => {
      const o = Float64Array.from(oA);
      const self = dtw(o, o, 0.1);
      expect(self.normalized).toBeCloseTo(0, 10);
      const shuffled = Float64Array.from(oA.slice().reverse());
      const r = dtw(o, shuffled, 0.2);
      expect(r.normalized).toBeGreaterThanOrEqual(0);
      expect(r.path[0]).toEqual([0, 0]);
      expect(r.path[r.path.length - 1]).toEqual([o.length - 1, o.length - 1]);
      return true;
    }), { numRuns: 40 });
  });
});
