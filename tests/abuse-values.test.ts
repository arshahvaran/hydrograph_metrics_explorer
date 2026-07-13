/** AGENT B — values & timing-metric torture. The core contract under attack:
 *  degrade to NaN (rendered "n/a"), NEVER to ±Infinity or a throw, and never
 *  to a plausible-looking wrong number. */
import { describe, it, expect } from 'vitest'
import { computeAll } from '../src/metrics/registry'
import { defaultView } from '../src/types'
import { dtw, wasserstein1 } from '../src/metrics/timing/dtwWasserstein'
import { eventErrors, peakTiming, lagSweep, detectEvents } from '../src/metrics/timing/events'
import { xwtLag } from '../src/metrics/timing/xwt'
import { perturb } from '../src/ui/compute'

const ctx = () => {
  const v = defaultView(86_400_000, 200);
  return { nanPolicy: v.nanPolicy, transform: v.transform, timing: v.timingConfig, heavy: true } as any;
};
const seq = (n: number, f: (i: number) => number) => Float64Array.from({ length: n }, (_, i) => f(i));

function offenders(o: Float64Array, s: Float64Array): string[] {
  const out = computeAll(o, s, ctx());
  return Object.entries(out.values).filter(([, v]) => v === Infinity || v === -Infinity).map(([k]) => k);
}

describe('no metric value is ever ±Infinity (battery)', () => {
  const wave = seq(120, i => 5 + 3 * Math.sin(i / 5));
  const cases: [string, Float64Array, Float64Array][] = [
    ['constant observed vs wave', seq(120, () => 5), wave],
    ['wave vs constant simulated', wave, seq(120, () => 5)],
    ['both constant, equal', seq(60, () => 4), seq(60, () => 4)],
    ['both constant, different', seq(60, () => 4), seq(60, () => 9)],
    ['all zeros observed', seq(80, () => 0), seq(80, i => Math.sin(i / 3))],
    ['all zeros both', seq(80, () => 0), seq(80, () => 0)],
    ['negatives in observed', seq(90, i => Math.sin(i / 4) - 0.5), seq(90, i => Math.sin((i - 1) / 4) - 0.5)],
    ['huge and tiny magnitudes', seq(70, i => (i % 2 ? 1e12 : 1e-12)), seq(70, i => (i % 2 ? 1.1e12 : 0.9e-12))],
    ['±Inf contamination (pairwise drops it)', seq(100, i => (i === 5 ? Infinity : 5 + Math.sin(i / 4))), seq(100, i => (i === 9 ? -Infinity : 5 + Math.sin((i - 1) / 4)))],
    ['zero-mean observed with variance', seq(100, i => (i % 2 ? 1 : -1)), seq(100, i => (i % 2 ? 0.9 : -1.1))],
    ['99% missing', seq(200, i => (i % 100 === 0 ? 5 + i / 50 : NaN)), seq(200, i => (i % 100 === 0 ? 5.2 + i / 50 : NaN))],
  ];
  for (const [name, o, s] of cases) {
    it(name, () => expect(offenders(o, s)).toEqual([]));
  }
});

describe('constant observed: zero-denominator metrics answer n/a (NaN), not numbers', () => {
  const o = seq(100, () => 5), s = seq(100, i => 5 + Math.sin(i / 6));
  const out = computeAll(o, s, ctx());
  for (const id of ['nse', 'rsr', 'mase', 'kge2009', 'kge2012', 'kge2021', 'kgenp', 'alpha', 'r', 'nrmse_range', 'nrmse_iqr']) {
    it(`${id} is NaN`, () => expect(Number.isNaN(out.values[id])).toBe(true));
  }
  it('but plain error measures still answer', () => {
    expect(isFinite(out.values.rmse)).toBe(true);
    expect(isFinite(out.values.me)).toBe(true);
  });
});

describe('all-NaN pair: nothing throws, n=0, everything n/a', () => {
  it('survives', () => {
    const o = seq(50, () => NaN), s = seq(50, () => NaN);
    const out = computeAll(o, s, ctx());
    expect(out.n).toBe(0);
    expect(Object.values(out.values).every(v => !isFinite(v as number) || v === 0)).toBe(true);
  });
});

describe('timing metrics at their edges', () => {
  const o = seq(60, i => 4 + 3 * Math.exp(-(((i % 20) - 8) ** 2) / 8));
  const s = seq(60, i => 4 + 3 * Math.exp(-(((i % 20) - 11) ** 2) / 8));
  it('DTW band fraction 0 clamps to a usable band; path is monotonic corner-to-corner', () => {
    for (const f of [0, 0.05, 5]) {
      const r = dtw(o, s, f);
      expect(r.path[0]).toEqual([0, 0]);
      expect(r.path[r.path.length - 1]).toEqual([o.length - 1, s.length - 1]);
      let [pi, pj] = r.path[0];
      for (const [i, j] of r.path.slice(1)) {
        expect(i >= pi && j >= pj && (i + j) > (pi + pj)).toBe(true);
        [pi, pj] = [i, j];
      }
    }
  });
  it('W1 of zero-mass series is n/a, never a throw', () => {
    expect(Number.isNaN(wasserstein1(seq(40, () => 0), seq(40, () => 0)))).toBe(true);
    expect(Number.isNaN(wasserstein1(seq(40, () => 0), o.slice(0, 40)))).toBe(true);
  });
  it('event threshold above the maximum: zero events, NaN scores, no throw', () => {
    const ev = eventErrors(o, s, { thresholdKind: 'absolute', thresholdValue: 99, minDistance: 3, warmup: 0 }, 5);
    expect(ev.threat === 0 || Number.isNaN(ev.threat)).toBe(true);
    expect(detectEvents(o, { thresholdKind: 'absolute', thresholdValue: 99, minDistance: 3, warmup: 0 }).events.length).toBe(0);
  });
  it('peak-matching window 0 does not throw', () => {
    const p = peakTiming(o, s, { prominence: 0.5, minDistance: 3, window: 0 });
    expect(typeof p.meanAbsLag).toBe('number');
  });
  it('cross-wavelet on a 6-point series degrades to n/a', () => {
    const r = xwtLag(seq(6, i => i), seq(6, i => i + 1));
    expect(Number.isNaN(r.headlineLag) || r.byScale.length === 0).toBe(true);
  });
  it('lag sweep on an 8-point series does not throw and stays in range', () => {
    const r = lagSweep(seq(8, i => Math.sin(i)), seq(8, i => Math.sin(i - 1)), -30, 30);
    expect(r.rows.length).toBeGreaterThan(0);
    if (isFinite(r.bestLag)) expect(Math.abs(r.bestLag)).toBeLessThanOrEqual(30);
  });
});

describe('sandbox perturbation extremes', () => {
  const base = Array.from({ length: 50 }, (_, i) => 5 + Math.sin(i / 4));
  const sb = (patch: object) => ({
    mode: 'synthetic', targetRunId: null, shiftSteps: 0, offset: 0, scale: 1, dampen: 0,
    noiseAmp: 0, noiseKind: 'gaussian', noiseSeed: 7, enabled: true, ...patch,
  }) as any;
  it('shift beyond the record length yields a finite flat-ish series, not garbage', () => {
    const out = perturb(base, sb({ shiftSteps: 500 }));
    expect(Array.from(out).every(isFinite)).toBe(true);
  });
  it('dampen=1 (flat line) and scale=0 stay finite', () => {
    expect(Array.from(perturb(base, sb({ dampen: 1 }))).every(isFinite)).toBe(true);
    expect(Array.from(perturb(base, sb({ scale: 0 }))).every(isFinite)).toBe(true);
  });
  it('seeded noise is reproducible and seeds differ', () => {
    const a = Array.from(perturb(base, sb({ noiseAmp: 2, noiseSeed: 11 })));
    const b = Array.from(perturb(base, sb({ noiseAmp: 2, noiseSeed: 11 })));
    const c = Array.from(perturb(base, sb({ noiseAmp: 2, noiseSeed: 12 })));
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });
});
