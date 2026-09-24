/** Diagnostic Efficiency and Series Distance regressions (audit de-sd-03..07, samples-e2e-02). */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { diagnosticEfficiency, seriesDistance } from '../src/metrics/timing/deSd'
import { detectEvents, type EventSpan } from '../src/metrics/timing/events'
import { computeAll } from '../src/metrics/registry'
import { defaultView } from '../src/types'
import { alignByDate } from '../src/store/store'
import { detectStep } from '../src/units/stepDetect'
import { parseDelimited, stage, guessRoles } from '../src/ingest/ingest'
import { mulberry32 } from '../src/metrics/support/stats'

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
    // 3 missing steps just after the observed peak (150), before the simulated
    // one (156), as in the audit repro. The parts of the flood are 4 steps
    // apart, closer than the 5-step daily event gap, so they stay one event for
    // the event metrics and Series Distance alike (a longer gap splits the
    // event: see sd-R2 below).
    for (let i = 151; i <= 153; i++) holed[i] = NaN;
    const view = defaultView(864e5, n);
    const ctx = { nanPolicy: 'pairwise', transform: 'none', timing: { ...view.timingConfig, eventThreshold: { kind: 'absolute', value: 5 } }, datesMs: obs.map((_, i) => t0 + i * 864e5) } as any;
    const full = computeAll(obs, sim, ctx).values.sd_time;
    const out = computeAll(holed, sim, ctx);
    expect(full).toBeCloseTo(k, 0);
    expect(out.values.sd_time).toBeCloseTo(k, 9);
    expect(out.values.sd_occ).toBe(1);
    // the gap lies inside one observed and one simulated matched event, and a note says the shape is interpolated
    expect(out.extras.sd!.gapSpans).toBe(2);
    expect(out.extras.sd!.gapEdges).toBe(0);
    expect(out.notes.join(' ')).toMatch(/2 matched events contain missing steps/);
  });
});

// ---- review sd-R1..sd-R4 (science3 review of the de-sd fix) ----

/** Piecewise-linear events: 2 at `start` and `end`, `h` at `peak`, 0 elsewhere,
 *  so with an absolute threshold of 1 each event is exactly [start, end]. */
const spans = (n: number, list: [number, number, number][], h = 10) => {
  const a = new Array<number>(n).fill(0);
  for (const [s, p, e] of list) {
    for (let i = s; i <= e; i++) a[i] += i <= p ? 2 + (h - 2) * (p === s ? 1 : (i - s) / (p - s)) : 2 + (h - 2) * (e - i) / (e - p);
  }
  return a;
};
const DAY = 864e5, T0 = Date.UTC(2001, 0, 1);
const ctxFor = (n: number, timing: Record<string, unknown>) => {
  const view = defaultView(DAY, n);
  return { nanPolicy: 'pairwise', transform: 'none', timing: { ...view.timingConfig, ...timing }, datesMs: Array.from({ length: n }, (_, i) => T0 + i * DAY) } as any;
};

function loadSample(file: string) {
  const txt = readFileSync(resolve(__dirname, '../public/samples', file), 'utf8');
  const t = parseDelimited(txt);
  const st = stage(t, { name: file, unit: 'm3s', dateFormat: 'auto', missingValue: null, roles: guessRoles(t.header) });
  const input = alignByDate(st.commit!);
  return { input, view: defaultView(detectStep(input.dates).ms, input.dates.length) };
}

describe('Series Distance: minimum-cost maximum-cardinality matching on the time axis', () => {
  const opt1 = { thresholdKind: 'absolute' as const, thresholdValue: 1, minDistance: 1, warmup: 0 };

  it('sd-R1: among the matchings with the most hits, the least total peak distance wins', () => {
    // obs A 95-105 (peak 100), B 107-113 (110); sim Z 78-84 (80), X 94-104 (100), Y 120-130 (125).
    // Two-hit matchings: A-X + B-Y (distance 0 + 15) and A-Z + B-X (20 + 10), among others.
    // Kuhn's augmenting path moved A to Z (SD timing -15); the flood that coincides with X must keep X.
    const n = 300;
    const obs = spans(n, [[95, 100, 105], [107, 110, 113]]);
    const sim = spans(n, [[78, 80, 84], [94, 100, 104], [120, 125, 130]]);
    const sd = seriesDistance(obs, sim, opt1, 15);
    expect(sd.matchedEvents).toBe(2);
    expect(sd.pairedPeaks).toEqual([[100, 100], [110, 125]]);
    expect(sd.meanTimingErr).toBeGreaterThan(0);
  });

  it('sd-R1: agrees with exhaustive search (most hits, then least total peak distance) on 400 random layouts', () => {
    const rnd = mulberry32(20260924);
    const ri = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
    const layout = (n: number, k: number): [number, number, number][] => {
      const out: [number, number, number][] = [];
      let t = ri(0, 10);
      for (let e = 0; e < k && t < n - 12; e++) {
        const s = t, en = s + ri(0, 8), p = ri(s, en);
        out.push([s, p, en]);
        t = en + ri(2, 14);                         // at least one step below the threshold between events
      }
      return out;
    };
    for (let c = 0; c < 400; c++) {
      const n = 160, tol = ri(0, 12);
      const obs = spans(n, layout(n, ri(1, 6))), sim = spans(n, layout(n, ri(1, 6)));
      const oe = detectEvents(obs, opt1).events, se = detectEvents(sim, opt1).events;
      const ov = (a: EventSpan, b: EventSpan) => a.start - tol <= b.end && b.start - tol <= a.end;
      let best: [number, number] = [0, 0];
      const used = new Array<boolean>(se.length).fill(false);
      const search = (i: number, hits: number, dist: number) => {
        if (i === oe.length) {
          if (hits > best[0] || (hits === best[0] && dist < best[1])) best = [hits, dist];
          return;
        }
        search(i + 1, hits, dist);
        for (let j = 0; j < se.length; j++) {
          if (used[j] || !ov(oe[i], se[j])) continue;
          used[j] = true;
          search(i + 1, hits + 1, dist + Math.abs(se[j].peakIdx - oe[i].peakIdx));
          used[j] = false;
        }
      };
      search(0, 0, 0);
      const sd = seriesDistance(obs, sim, opt1, tol);
      const got: [number, number] = [sd.matchedEvents, sd.pairedPeaks.reduce((a, [po, ps]) => a + Math.abs(ps - po), 0)];
      expect(got, `case ${c}`).toEqual(best);
      // deterministic: the same input gives the same pairs
      expect(seriesDistance(obs, sim, opt1, tol).pairedPeaks).toEqual(sd.pairedPeaks);
    }
  });

  it('sd-R2: a data gap splits events for Series Distance exactly as for the event metrics, with a note', () => {
    // obs = 1 + triangles (peaks 100 and 160, half-width 10, height 20); sim = obs 3 steps late.
    const n = 300;
    const obs = Array.from({ length: n }, (_, i) => 1 + Math.max(0, 20 * (1 - Math.abs(i - 100) / 10)) + Math.max(0, 20 * (1 - Math.abs(i - 160) / 10)));
    const sim = obs.map((_, i) => obs[Math.max(0, i - 3)]);
    const ctx = ctxFor(n, { eventThreshold: { kind: 'absolute', value: 5 }, eventMinDistance: 3, peakMatchTolerance: 5 });
    const full = computeAll(obs, sim, ctx);
    expect(full.values.sd_occ).toBe(1);
    expect(full.values.sd_time).toBeCloseTo(3, 9);
    expect(full.values.sd_amp).toBeCloseTo(0, 9);
    expect(full.notes.join(' ')).not.toMatch(/missing/i);

    // obs missing on steps 108-152: steps 107 and 153 (both above the threshold)
    // became neighbours on the compacted index and the two floods merged into one.
    const holed = obs.slice();
    for (let i = 108; i <= 152; i++) holed[i] = NaN;
    const gap = computeAll(holed, sim, ctx);
    const ev = gap.extras.events!, sd = gap.extras.sd!;
    expect(gap.values.sd_occ).toBe(1);                 // the compacted index gave 0.5
    expect(gap.values.sd_occ).toBe(gap.values.event_threat);
    // flood 1 is cut at step 107 on both series: rise +3, recession 3 - 3u (mean 1.5);
    // flood 2 starts after the gap on both series: rise +3, recession +3
    expect(gap.values.sd_time).toBeCloseTo((3 + 1.5 + 3 + 3) / 4, 9);   // the compacted index gave -13
    expect(sd.obsEvents).toBe(ev.events.length);
    expect(sd.obsEvents).toBe(2);
    expect(sd.simEvents).toBe(ev.hits + ev.falseAlarms);
    expect(sd.gapEdges).toBe(3);
    expect(gap.notes.join(' ')).toMatch(/start or end at missing values/);
  });

  it('sd-R3 / samples-e2e-02: bundled sample_synthetic.csv, run_biased (observed + 1.5, no timing error), default daily timing', () => {
    const { input, view } = loadSample('sample_synthetic.csv');
    const run = input.runs.find(r => /biased/.test(r.name))!;
    expect(run.values.every((v, i) => Math.abs(v - input.observed.values[i] - 1.5) < 1e-9)).toBe(true);
    const out = computeAll(input.observed.values, run.values,
      { nanPolicy: view.nanPolicy, transform: view.transform, timing: view.timingConfig, datesMs: input.dates });
    // time-order greedy paired (159, 202) and (525, 567) and gave SD timing +16.375
    expect(out.extras.sd!.pairedPeaks).toEqual([[111, 111], [202, 202], [476, 476], [567, 567]]);
    expect(out.values.sd_time).toBeCloseTo(-4.25, 9);
  });

  it('sd-R4: 10,000 closely spaced events finish without a stack overflow; big groups fall back to greedy with a note', () => {
    // obs pulses (2, 5, 2) every 10 steps; sim the same pulses 5 steps later. Each
    // observed event overlaps two simulated ones, so all 20,000 events form one chain.
    const pulses = (N: number) => {
      const n = 10 * N + 20, obs = new Float64Array(n), sim = new Float64Array(n);
      for (let k = 0; k < N; k++) {
        const c = 10 + 10 * k;
        obs[c - 1] = 2; obs[c] = 5; obs[c + 1] = 2;
        sim[c + 4] = 2; sim[c + 5] = 5; sim[c + 6] = 2;
      }
      return { obs, sim };
    };
    const big = pulses(10_000);
    const t0 = performance.now();
    const sd = seriesDistance(big.obs, big.sim, opt1, 5);
    expect(performance.now() - t0).toBeLessThan(20_000);
    expect(sd.matchedEvents).toBe(10_000);
    expect(sd.meanTimingErr).toBeCloseTo(5, 9);
    expect(sd.greedyEvents).toBe(20_000);

    // 200 + 200 events (at the size limit) are still solved exactly
    const mid = pulses(200);
    const sdMid = seriesDistance(mid.obs, mid.sim, opt1, 5);
    expect(sdMid.greedyEvents).toBe(0);
    expect(sdMid.matchedEvents).toBe(200);
    expect(sdMid.meanTimingErr).toBeCloseTo(5, 9);

    // through computeAll the fallback is reported
    const small = pulses(250);
    const out = computeAll(small.obs, small.sim, ctxFor(small.obs.length, { eventThreshold: { kind: 'absolute', value: 1 }, eventMinDistance: 1, peakMatchTolerance: 5 }));
    expect(out.values.sd_occ).toBe(1);
    expect(out.notes.join(' ')).toMatch(/Series Distance paired 500 events.*nearest peaks first/);
  }, 120_000);
});
