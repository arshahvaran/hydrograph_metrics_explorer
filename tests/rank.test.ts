import { describe, it, expect } from 'vitest'
import { rankRuns, scoreMetric } from '../src/metrics/rank'
import { c2m } from '../src/metrics/classical/catalogue'

describe('composite priority ranking (spec §14, AC13)', () => {
  it('C2M normalisation keeps unbounded efficiencies from dominating', () => {
    // NSE -9 → C2M = -9/11 ≈ -0.818 → score ((−0.818)+1)/2 ≈ 0.0909 before min-max
    const s = scoreMetric('nse', [1, -9]);
    expect(s[0]).toBeCloseTo(1, 12);
    expect(s[1]).toBeCloseTo(0, 12); // min-max across the pair
    expect(c2m(-9)).toBeCloseTo(-9 / 11, 12);
  });

  it('target-zero metrics score by closeness to 0 regardless of sign', () => {
    const s = scoreMetric('peak_lag_signed', [-1, 3]); // |−1| beats |3|
    expect(s[0]).toBe(1);
    expect(s[1]).toBe(0);
  });

  it('all-equal values score 1 for every run (no spurious separation)', () => {
    const s = scoreMetric('rmse', [2.5, 2.5, 2.5]);
    expect(s).toEqual([1, 1, 1]);
  });

  it('weighted composite ranks a timing-strong run first when timing is weighted up', () => {
    const runs = [
      { runName: 'MagnitudeFit', values: { nse: 0.90, w1: 0.80 } },   // great NSE, poor transport
      { runName: 'TimingFit',    values: { nse: 0.70, w1: 0.10 } },   // decent NSE, near-perfect W1
    ];
    const balanced = rankRuns(runs, [{ id: 'nse', weight: 1 }, { id: 'w1', weight: 1 }]);
    const timingHeavy = rankRuns(runs, [{ id: 'nse', weight: 1 }, { id: 'w1', weight: 3 }]);
    expect(timingHeavy.find(r => r.runName === 'TimingFit')!.rank).toBe(1);
    // and the composite ordering responds to the weights
    const bTop = balanced.find(r => r.rank === 1)!;
    expect(['MagnitudeFit', 'TimingFit']).toContain(bTop.runName);
    expect(timingHeavy.find(r => r.runName === 'TimingFit')!.composite)
      .toBeGreaterThan(timingHeavy.find(r => r.runName === 'MagnitudeFit')!.composite);
  });

  it('missing values are excluded from the weighted mean, not treated as zero', () => {
    const rows = rankRuns(
      [{ runName: 'A', values: { nse: 0.8 } }, { runName: 'B', values: { nse: 0.8, w1: 0.5 } }],
      [{ id: 'nse', weight: 1 }, { id: 'w1', weight: 1 }],
    );
    const a = rows.find(r => r.runName === 'A')!;
    expect(Number.isFinite(a.composite)).toBe(true);
    expect(Number.isNaN(a.perMetric['w1'])).toBe(true);
  });
});
