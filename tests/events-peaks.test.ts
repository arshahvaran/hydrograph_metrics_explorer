// Regression tests for the events-peaks audit cluster: peak timing (Gauch et
// al., 2021), per-event errors and the lag sweep. Each block names the audit
// finding it pins. Reference values are analytic (pure shifts) or come from
// the audit's independent numpy/scipy ports of neuralhydrology
// mean_peak_timing (scratch/events-0N/ref.py).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { computeAll } from '../src/metrics/registry'
import { peakTiming, eventErrors, lagSweep, type EventOptions } from '../src/metrics/timing/events'
import { timePositions } from '../src/metrics/timing/timeAxis'
import { defaultTimingConfig, defaultView, clampTimingConfig } from '../src/types'
import { alignByDate } from '../src/store/store'
import { detectStep } from '../src/units/stepDetect'
import { parseDelimited, stage, guessRoles } from '../src/ingest/ingest'
import { perturb } from '../src/ui/compute'
import { mulberry32 } from '../src/metrics/support/stats'

const DAY = 86_400_000, HOUR = 3_600_000
const T0 = Date.UTC(2020, 0, 1)
const run = (o: ArrayLike<number>, s: ArrayLike<number>, timing: any, datesMs?: number[]) =>
  computeAll(o, s, { nanPolicy: 'pairwise', transform: 'none', timing, datesMs })
const trueOrExcluded = (v: number, truth: number, what: string) =>
  expect(Number.isNaN(v) || Math.abs(v - truth) < 1e-9, `${what}: got ${v}, expected ${truth} or NaN (excluded)`).toBe(true)
const tri = (n: number, peaks: { t: number; h: number; w: number }[], base = 1) => {
  const a = new Array(n).fill(base)
  for (const p of peaks) for (let i = 0; i < n; i++) { const d = Math.abs(i - p.t); if (d < p.w) a[i] += p.h * (1 - d / p.w) }
  return a
}

function loadSample(file: string) {
  const txt = readFileSync(resolve(__dirname, '../public/samples', file), 'utf8')
  const t = parseDelimited(txt)
  const st = stage(t, { name: file, unit: 'm3s', dateFormat: 'auto', missingValue: null, roles: guessRoles(t.header) })
  const input = alignByDate(st.commit!)
  const step = detectStep(input.dates)
  return { input, view: defaultView(step.ms, input.dates.length) }
}

// ------------------------------------------------------------------ D1 ------
describe('compute-01 / events-01 / samples-e2e-01: lags count time steps, not compacted rows', () => {
  // Daily flood, obs peak 52 on row 100, sim = obs 3 d late.
  const N = 200
  const flood = () => {
    const obs = new Array<number>(N).fill(2)
    obs[98] = 12; obs[99] = 32; obs[100] = 52
    for (let t = 101; t < N; t++) obs[t] = 2 + 50 * Math.pow(0.75, t - 100)
    const sim = new Array<number>(N).fill(2)
    for (let t = 3; t < N; t++) sim[t] = obs[t - 3]
    return { obs, sim }
  }
  const dates = Array.from({ length: N }, (_, i) => T0 + i * DAY)

  it('control: no gap -> every lag metric is 3 d', () => {
    const { obs, sim } = flood()
    const out = run(obs, sim, defaultTimingConfig(DAY, N), dates)
    expect(out.values.peak_lag_abs).toBe(3)
    expect(out.values.event_lag).toBe(3)
    expect(out.values.lag_best).toBe(3)
  })

  it('two missing observed values after the peak: lags are 3 d or excluded, never 1; the sweep finds 3', () => {
    const { obs, sim } = flood()
    obs[101] = NaN; obs[102] = NaN
    const out = run(obs, sim, defaultTimingConfig(DAY, N), dates)
    trueOrExcluded(out.values.peak_lag_abs, 3, 'peak_lag_abs')
    trueOrExcluded(out.values.peak_lag_signed, 3, 'peak_lag_signed')
    trueOrExcluded(out.values.event_lag, 3, 'event_lag')
    for (const e of out.extras.events!.events) trueOrExcluded(e.peakLag, 3, 'event-table peak lag')
    expect(out.values.lag_best).toBe(3)            // NSE = 1 exactly at lag 3 on the real grid
    // an excluded peak is said so
    if (Number.isNaN(out.values.peak_lag_abs)) expect(out.notes.some(s => /skipped by peak timing/.test(s))).toBe(true)
  })

  it('two dates absent from the file: the dates carry the time axis', () => {
    const { obs, sim } = flood()
    const keep = Array.from({ length: N }, (_, i) => i).filter(i => i !== 101 && i !== 102)
    const aligned = alignByDate({
      name: 'gap', dates: keep.map(i => T0 + i * DAY),
      observed: { name: 'obs', values: keep.map(i => obs[i]), unit: 'm3/s' as any },
      runs: [{ name: 'sim', values: keep.map(i => sim[i]), unit: 'm3/s' as any }],
    } as any)
    expect(detectStep(aligned.dates).label).toBe('1d')
    const out = run(aligned.observed.values, aligned.runs[0].values, defaultTimingConfig(DAY, keep.length), aligned.dates)
    trueOrExcluded(out.values.peak_lag_abs, 3, 'peak_lag_abs')
    trueOrExcluded(out.values.event_lag, 3, 'event_lag')
    expect(out.values.lag_best).toBe(3)
  })

  it('obs missing for 2 days after every storm, sim 3 d late: no lag metric reads 1', () => {
    // compute-01 repro E: 730 daily steps, a storm every 60 d.
    const n = 730
    const base = Float64Array.from({ length: n }, (_, i) => {
      let v = 5
      for (let c = 50; c < n + 60; c += 60) v += 40 * Math.exp(-((i - c) ** 2) / 18)
      return v
    })
    const sim = Float64Array.from(base, (_, i) => base[Math.max(0, i - 3)])
    const obs = Float64Array.from(base)
    for (let c = 50; c < n; c += 60) { if (c + 1 < n) obs[c + 1] = NaN; if (c + 2 < n) obs[c + 2] = NaN }
    const out = run(obs, sim, defaultTimingConfig(DAY, n))
    trueOrExcluded(out.values.peak_lag_abs, 3, 'peak_lag_abs')
    trueOrExcluded(out.values.peak_lag_signed, 3, 'peak_lag_signed')
    trueOrExcluded(out.values.event_lag, 3, 'event_lag')
    expect(out.values.lag_best).toBe(3)
  })

  it('10 % of observed days missing at random, sim 4 d late: lag_best 4; peak timing does not invent a 3', () => {
    // compute-01 repro E3 (mulberry32 seed 7). The true lag 4 exceeds the ±3-day
    // window, so every peak is unresolved or skipped: peak_lag_abs must be n/a.
    const n = 3 * 365
    const base = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      let v = 4 + 2 * Math.sin((2 * Math.PI * i) / 365)
      for (let c = 20; c < n + 40; c += 37) v += 30 * Math.exp(-((i - c) ** 2) / 12)
      base[i] = v
    }
    const sim = Float64Array.from(base, (_, i) => base[Math.max(0, i - 4)])
    const rng = mulberry32(7)
    const obs = Float64Array.from(base, v => (rng() < 0.10 ? NaN : v))
    const out = run(obs, sim, defaultTimingConfig(DAY, n))
    expect(out.values.lag_best).toBe(4)
    expect(Number.isNaN(out.values.peak_lag_abs)).toBe(true)
  })

  it('bundled HYMOD sample (122-day observed gap): lag-sweep NSE at ±30 is the true-grid value', () => {
    // numpy: pair obs[t] with sim[t+L] on the date grid, drop non-finite pairs.
    const { input, view } = loadSample('sample_hymod_raven.csv')
    const out = computeAll(input.observed.values, input.runs[0].values,
      { nanPolicy: view.nanPolicy, transform: view.transform, timing: view.timingConfig, datesMs: input.dates })
    const rows = out.extras.sweep!.rows
    const at = (L: number) => rows.find(r => r.lag === L)!.nse
    expect(at(30)).toBeCloseTo(-0.07632745675414432, 10)
    expect(at(-30)).toBeCloseTo(-0.5911175241682143, 10)
    expect(at(5)).toBeCloseTo(0.3389617184934173, 10)
    expect(out.values.lag_best).toBe(5)
  })

  it('peak separation and the event gap count time steps across a gap', () => {
    // Two obs peaks 8 steps apart in time but 4 rows apart after a 4-step gap:
    // with a separation of 6 steps both are kept.
    const n = 60
    const obs = tri(n, [{ t: 20, h: 30, w: 3 }, { t: 28, h: 20, w: 3 }], 2)
    const sim = obs.slice()
    const pos = Array.from({ length: n }, (_, i) => i).filter(i => i < 22 || i > 25)
    const o = pos.map(i => obs[i]), s = pos.map(i => sim[i])
    const p = peakTiming(o, s, { prominence: 1, minDistance: 6, window: 1 }, pos)
    expect(p.peaks.map(q => pos[q.tObs])).toEqual([20, 28])
    expect(p.peaks.map(q => q.lag)).toEqual([0, 0])
  })
})

describe('timePositions', () => {
  it('counts absent days, calendar months, and falls back to rows for an irregular record', () => {
    const days = [0, 1, 2, 5, 6].map(i => T0 + i * DAY)
    expect(timePositions(days, 5)).toEqual([0, 1, 2, 5, 6])
    // calendar months (28 to 31 days) with month 21 absent
    const m = Array.from({ length: 40 }, (_, i) => i).filter(i => i !== 21)
    expect(timePositions(m.map(i => Date.UTC(2001, i, 1)), m.length)).toEqual(m)
    expect(timePositions(undefined, 3)).toEqual([0, 1, 2])
    const irregular = [0, 1.3, 2, 3.7, 4.1, 6.6, 7.2].map(d => T0 + d * DAY)
    expect(timePositions(irregular, 7)).toEqual([0, 1, 2, 3, 4, 5, 6])
  })
})

// ------------------------------------------------------ matched events ------
describe('events-02 / samples-e2e-03: event peak, volume and lag errors use matched events', () => {
  const flood = (n: number, ev: { t: number; h: number }[], base = 2, k = 0.75) => {
    const a = new Array(n).fill(base)
    for (const e of ev) { a[e.t - 2] += 0.3 * e.h; a[e.t - 1] += 0.7 * e.h; for (let i = e.t; i < n; i++) a[i] += e.h * Math.pow(k, i - e.t) }
    return a
  }
  // obs floods 40@80 and 30@200; sim reproduces flood 1 and has only a bump of 6 near 203.
  const obs = flood(300, [{ t: 80, h: 40 }, { t: 200, h: 30 }])
  const sim = flood(300, [{ t: 80, h: 40 }, { t: 203, h: 6 }])

  it('eventErrors averages over the hit only (1 hit, 1 miss)', () => {
    const r = eventErrors(obs, sim, { thresholdKind: 'absolute', thresholdValue: 10, minDistance: 5, warmup: 0 }, 3)
    expect([r.hits, r.misses, r.events.length]).toEqual([1, 1, 2])
    expect(r.events.map(e => e.matched)).toEqual([true, false])
    expect(r.meanPeakErrPct).toBeCloseTo(0, 9)
    expect(r.medianPeakLag).toBe(0)
    expect(r.meanVolumeErrPct).toBeCloseTo(0, 9)
  })

  it('bundled HYMOD sample: matched-only values (4 hits, 4 misses), not the all-event -48.98 / -46.85 / 4', () => {
    // Reference: scratch/samples-e2e/evmatched.py (numpy over HME's own hits).
    const { input, view } = loadSample('sample_hymod_raven.csv')
    const out = computeAll(input.observed.values, input.runs[0].values,
      { nanPolicy: view.nanPolicy, transform: view.transform, timing: view.timingConfig, datesMs: input.dates })
    expect([out.extras.events!.hits, out.extras.events!.misses]).toEqual([4, 4])
    expect(out.values.event_peak).toBeCloseTo(-34.187358, 5)
    expect(out.values.event_vol).toBeCloseTo(-28.722505, 5)
    expect(out.values.event_lag).toBe(3.5)
  })

  it('panel values event_peak / event_vol / event_lag follow the "matched events" definition', () => {
    const cfg = { ...defaultTimingConfig(DAY, 300), eventThreshold: { kind: 'absolute' as const, value: 10 } }
    const o = run(obs, sim, cfg)
    expect(o.values.event_peak).toBeCloseTo(0, 9)
    expect(o.values.event_vol).toBeCloseTo(0, 9)
    expect(o.values.event_lag).toBe(0)
    expect(o.values.event_threat).toBeCloseTo(0.5, 12)
  })
})

// ----------------------------------------------------- window-edge clamp ----
describe('events-03 / timing-sandbox-05: no window-edge argmax as an event peak', () => {
  const opt: EventOptions = { thresholdKind: 'percentile', thresholdValue: 90, minDistance: 5, warmup: 0 }
  const floodA = () => {
    const n = 200
    const obs = new Array<number>(n).fill(2)
    obs[98] += 0.3 * 40; obs[99] += 0.7 * 40
    for (let i = 100; i < n; i++) obs[i] += 40 * Math.pow(0.75, i - 100)
    const sim = obs.map((_, i) => (i + 6 < n ? obs[i + 6] : 2))
    return { obs, sim }
  }

  it('identical flood 6 d early: lag -6 and 0 % or excluded, never the clamped -5 / -23.8 %', () => {
    const { obs, sim } = floodA()
    const r = eventErrors(obs, sim, opt, 3)
    expect(r.events).toHaveLength(1)
    expect(r.hits).toBe(1)
    trueOrExcluded(r.events[0].peakLag, -6, 'peak lag')
    trueOrExcluded(r.events[0].peakMagErrPct, 0, 'peak error %')
    const out = run(obs, sim, defaultTimingConfig(DAY, obs.length))
    trueOrExcluded(out.values.event_lag, -6, 'event_lag')
    trueOrExcluded(out.values.event_peak, 0, 'event_peak')
    if (Number.isNaN(out.values.event_lag)) expect(out.notes.some(s => /event peak\(s\) could not be resolved/.test(s))).toBe(true)
  })

  it('bundled HYMOD observed series shifted 6 d early: the t=725 event is not reported as +7 / +43 %', () => {
    const csv = readFileSync(resolve(__dirname, '../public/samples/sample_hymod_raven.csv'), 'utf8')
    const q = csv.trim().split(/\r?\n/).slice(1)
      .map(l => (l.split(',')[1] === '' ? NaN : Number(l.split(',')[1]))).filter(Number.isFinite)
    const n = q.length
    const sim = q.map((_, t) => q[Math.min(n - 1, t + 6)])
    const r = eventErrors(q, sim, opt, 3)
    const ev = r.events.find(e => e.obs.peakIdx === 725)!
    expect([ev.obs.start, ev.obs.end, ev.obs.peakQ]).toEqual([724, 729, 100])
    trueOrExcluded(ev.peakLag, -6, 'peak lag (t=725)')
    trueOrExcluded(ev.peakMagErrPct, 0, 'peak error % (t=725)')
  })

  it('synthetic sample shifted +8 d (Sandbox): no event lag is read from a clamped window edge', () => {
    // Before the fix: lags 5, -7, 4, 3 read from window edges (the simulation
    // still rising beyond the window) and a median event lag of 5.
    const txt = readFileSync(resolve(__dirname, '../public/samples/sample_synthetic.csv'), 'utf8').trim().split(/\r?\n/).slice(1)
    const obs = Float64Array.from(txt.map(l => Number(l.split(',')[1])))
    const t = defaultTimingConfig(DAY, obs.length)
    const sim = perturb(obs, { mode: 'synthetic', targetRunId: null, shiftSteps: 8, offset: 0, scale: 1, dampen: 0, noiseAmp: 0, noiseKind: 'uniform', noiseSeed: 42, enabled: true })
    const out = run(obs, sim, t)
    for (const e of out.extras.events!.events) {
      if (!Number.isFinite(e.peakLag)) continue
      const k = e.obs.peakIdx + e.peakLag
      // the matched simulated value is a local maximum of the simulation
      expect(sim[k] >= sim[k - 1] && sim[k] >= sim[k + 1], `event at ${e.obs.peakIdx}: lag ${e.peakLag} is not a simulated peak`).toBe(true)
    }
    // Every resolved flood above 10.3 is matched at +8 with 0 % peak error (the
    // event peaking at 187 has its +8 crest outside the window: unresolved, n/a).
    // A noise-level event near the threshold (peak 537) keeps a genuine noise
    // crest 5 steps away, because ±3 steps past its end cannot reach the +8 crest.
    expect(out.extras.events!.events.find(e => e.obs.peakIdx === 187)!.peakLag).toBeNaN()
    const big = out.extras.events!.events.filter(e => e.matched && e.obs.peakQ > 10.3 && Number.isFinite(e.peakLag))
    expect(big.map(e => e.peakLag)).toEqual([8, 8, 8])
    for (const e of big) expect(e.peakMagErrPct).toBeCloseTo(0, 12)
    expect(out.values.event_lag).toBe(8)
  })
})

// ------------------------------------------------- Gauch et al. (2021) ------
describe('events-04: peak separation follows Gauch et al. (2021), 100 steps by default', () => {
  it('daily defaults: two prominent peaks 40 d apart count once (reference mean |lag| 0)', () => {
    const obs = tri(400, [{ t: 100, h: 60, w: 5 }, { t: 140, h: 40, w: 5 }, { t: 300, h: 50, w: 5 }], 2)
    const sim = tri(400, [{ t: 100, h: 60, w: 5 }, { t: 143, h: 40, w: 5 }, { t: 300, h: 50, w: 5 }], 2)
    const cfg = defaultTimingConfig(DAY, 400)
    expect(cfg.peakMinDistance).toBe(100)
    expect(cfg.eventMinDistance).toBe(5)       // the event gap is a separate setting
    const out = run(obs, sim, cfg)
    expect(out.extras.peaks!.peaks.map(p => p.tObs)).toEqual([100, 300])
    expect(out.values.peak_lag_abs).toBe(0)
    expect(out.values.peak_lag_signed).toBe(0)
  })

  it("paper Fig. 7 record with the hourly defaults: 4.5 h, second crest rejected", () => {
    const N = 640, T_PK = 12, SHAPE = 4, BASE = 0.08
    const EVENTS: [number, number, number, number][] = [
      [70, 0.95, 0.78, +7], [185, 0.09, 0.05, 0], [300, 0.65, 0.55, +6],
      [345, 0.52, 0.42, +6], [470, 0.58, 0.52, -3], [585, 0.62, 0.66, +2]]
    const pulse = (t: number) => { const tt = Math.max(t, 0) / T_PK; return tt ** SHAPE * Math.exp(SHAPE * (1 - tt)) }
    const obs: number[] = [], sim: number[] = []
    for (let t = 0; t < N; t++) {
      let o = BASE, s = BASE
      for (const [tc, ao, as, lag] of EVENTS) { o += ao * pulse(t - (tc - T_PK)); s += as * pulse(t - (tc + lag - T_PK)) }
      obs.push(o); sim.push(s)
    }
    const out = run(obs, sim, defaultTimingConfig(HOUR, N))
    expect(out.extras.peaks!.peaks.map(p => p.tObs)).toEqual([70, 300, 470, 585])
    expect(out.extras.peaks!.peaks.map(p => p.lag)).toEqual([7, 6, -3, 2])
    expect(out.values.peak_lag_abs).toBeCloseTo(4.5, 12)
    expect(out.values.peak_lag_signed).toBeCloseTo(3.0, 12)
  })

  it('an old project without the setting loads with the Gauch default', () => {
    const base = defaultTimingConfig(DAY, 100)
    const { peakMinDistance: _drop, ...old } = { ...base, eventMinDistance: 7 }
    const { config, changed } = clampTimingConfig(old, base)
    expect(config.peakMinDistance).toBe(100)
    expect(config.eventMinDistance).toBe(7)
    expect(changed).toBe(false)
  })
})

describe('events-05: default peak-match half-window is the Gauch reference max(floor(12 h / step), 3)', () => {
  it('daily 3, hourly 12, 15-min 48, 3-hourly 4', () => {
    expect(defaultTimingConfig(DAY, 1000).peakMatchTolerance).toBe(3)
    expect(defaultTimingConfig(HOUR, 1000).peakMatchTolerance).toBe(12)
    expect(defaultTimingConfig(HOUR / 4, 1000).peakMatchTolerance).toBe(48)
    expect(defaultTimingConfig(3 * HOUR, 1000).peakMatchTolerance).toBe(4)
  })

  it('hourly defaults on a two-crest simulation give the reference 2 h, not 18 h', () => {
    const obs = tri(400, [{ t: 200, h: 30, w: 6 }])
    const sim = tri(400, [{ t: 202, h: 20, w: 5 }, { t: 218, h: 35, w: 6 }])
    expect(run(obs, sim, defaultTimingConfig(HOUR, 400)).values.peak_lag_abs).toBe(2)
  })
})

describe('events-06: a record-edge simulated value is not a matched peak', () => {
  const triF = (n: number, centers: number[]) => {
    const x = new Float64Array(n).fill(1)
    for (let t = 0; t < n; t++) for (const c of centers) x[t] += 2 * Math.max(0, 5 - Math.abs(t - c))
    return x
  }
  it('sim peak before the record start (4 steps early)', () => {
    const r = peakTiming(triF(120, [2, 60]), triF(120, [-2, 56]), { prominence: 'auto', minDistance: 5, window: 6 })
    expect(r.peaks.filter(p => p.tSim === 0 || p.tSim === 119)).toEqual([])
    expect(r.meanAbsLag).toBeCloseTo(4, 12)
    expect(r.meanSignedLag).toBeCloseTo(-4, 12)
    expect(r.skipped).toBe(1)
  })
  it('sim peak after the record end (4 steps late)', () => {
    const r = peakTiming(triF(120, [60, 117]), triF(120, [64, 121]), { prominence: 'auto', minDistance: 5, window: 6 })
    expect(r.peaks.filter(p => p.tSim === 0 || p.tSim === 119)).toEqual([])
    expect(r.meanAbsLag).toBeCloseTo(4, 12)
    expect(r.meanSignedLag).toBeCloseTo(4, 12)
  })
  it('the event table does not match an event to the record edge either', () => {
    const obs = triF(120, [3, 60]), sim = triF(120, [-3, 57])
    const r = eventErrors(obs, sim, { thresholdKind: 'absolute', thresholdValue: 4, minDistance: 3, warmup: 0 }, 6)
    trueOrExcluded(r.events[0].peakLag, -6, 'edge event lag')
    expect(r.events[1].peakLag).toBe(-3)
  })
})

describe('events-07: flat-topped peaks are dated at the plateau middle (scipy.find_peaks)', () => {
  const tail = [1, 1, 1, 1, 1, 1, 1]
  const opts = { prominence: 'auto' as const, minDistance: 5, window: 3 }
  it('odd width 5 (5..9): peak 7, lag 0', () => {
    const p = peakTiming([1, 1, 2, 5, 9, 12, 12, 12, 12, 12, 9, 5, 2, ...tail], [1, 1, 2, 5, 9, 11, 11.5, 12, 11.5, 11, 9, 5, 2, ...tail], opts)
    expect(p.peaks.map(q => q.tObs)).toEqual([7])
    expect(p.meanAbsLag).toBe(0)
  })
  it('even width 4 (5..8): peak 6 (rounded down), lag 0', () => {
    const p = peakTiming([1, 1, 2, 5, 9, 12, 12, 12, 12, 9, 5, 2, 1, ...tail], [1, 1, 2, 5, 9, 11, 12, 11.5, 11, 9, 5, 2, 1, ...tail], opts)
    expect(p.peaks.map(q => q.tObs)).toEqual([6])
    expect(p.meanAbsLag).toBe(0)
  })
  it('identical flat-topped series still give lag 0 in peak timing and in the event table', () => {
    const x = [1, 1, 2, 5, 9, 12, 12, 12, 12, 12, 9, 5, 2, ...tail, ...tail]
    expect(peakTiming(x, x, opts).meanAbsLag).toBe(0)
    const ev = eventErrors(x, x, { thresholdKind: 'absolute', thresholdValue: 3, minDistance: 3, warmup: 0 }, 3)
    expect(ev.events.map(e => [e.obs.peakIdx, e.peakLag])).toEqual([[7, 0]])
  })
  it('rating-capped daily flood (plateau 109..112), perfectly timed simulation: 0 lag', () => {
    const n = 200
    const hydro = (t0: number, h: number) => Array.from({ length: n }, (_, i) => {
      const d = i - t0
      if (d >= -3 && d < 0) return h * (1 + d / 3) * 0.9
      if (d >= 0) return h * Math.pow(0.7, d)
      return 0
    })
    const a = hydro(40, 50), b = hydro(110, 40), c = hydro(170, 60)
    const sim = a.map((_, i) => Math.round((2 + a[i] + b[i] + c[i]) * 1000) / 1000)
    const obs = sim.map((v, i) => (i >= 100 && i < 125 ? Math.min(v, 21) : v))
    const p = peakTiming(obs, sim, opts)
    expect(p.peaks.map(q => q.tObs)).toEqual([40, 110, 170])
    expect(p.meanAbsLag).toBe(0)
    expect(run(obs, sim, defaultTimingConfig(DAY, n)).values.peak_lag_abs).toBe(0)
  })
})

// --------------------------------------------------------------- sweep ------
describe('events-09 / compute-07: lag_best never reports the ±30-step sweep edge as the offset', () => {
  const storms = (n: number) => Float64Array.from({ length: n }, (_, i) => {
    let v = 5
    for (let c = 50; c < n + 200; c += 200) v += 40 * Math.exp(-((i - c) ** 2) / (2 * 12 * 12))
    return v
  })
  const late = (x: Float64Array, k: number) => Float64Array.from(x, (_, i) => x[Math.max(0, i - k)])
  it('true offsets 10, 25, 30 are recovered; 36, 48, 72 read n/a with a note', () => {
    const obs = storms(2000)
    for (const k of [10, 25, 30]) expect(run(obs, late(obs, k), defaultTimingConfig(HOUR, 2000)).values.lag_best).toBe(k)
    for (const k of [36, 48, 72]) {
      const out = run(obs, late(obs, k), defaultTimingConfig(HOUR, 2000))
      expect(Number.isNaN(out.values.lag_best), `k=${k}: lag_best ${out.values.lag_best}`).toBe(true)
      expect(out.extras.sweep!.outOfRange).toBe(true)
      expect(out.notes.some(s => /beyond the ±30-step range/.test(s))).toBe(true)
    }
  })
  it('the sweep runs on untransformed flows (design rule D2) and says so under a transform', () => {
    const obs = storms(600), sim = late(obs, 7)
    const plain = computeAll(obs, sim, { nanPolicy: 'pairwise', transform: 'none', timing: defaultTimingConfig(HOUR, 600) })
    const logged = computeAll(obs, sim, { nanPolicy: 'pairwise', transform: 'log', timing: defaultTimingConfig(HOUR, 600) })
    expect(logged.extras.sweep!.rows.map(r => r.nse)).toEqual(plain.extras.sweep!.rows.map(r => r.nse))
    expect(logged.values.lag_best).toBe(7)
    expect(logged.notes.some(s => /lag-sweep metrics are computed on untransformed flows/.test(s))).toBe(true)
  })

  it('lagSweep itself flags a +40 offset and keeps the rows', () => {
    const obs = tri(600, [{ t: 100, h: 40, w: 10 }, { t: 300, h: 30, w: 10 }, { t: 480, h: 50, w: 10 }], 2)
    const sim = obs.map((_, i) => (i - 40 >= 0 ? obs[i - 40] : 2))
    const sw = lagSweep(obs, sim, -30, 30)
    expect(Number.isNaN(sw.bestLag)).toBe(true)
    expect(sw.outOfRange).toBe(true)
    expect(sw.rows).toHaveLength(61)
  })
})

// ------------------------------------------------------------- warm-up ------
describe('timing-sandbox-08 (scope of the warm-up): events only, as documented', () => {
  it('the warm-up changes the event metrics but not peak timing or the other timing metrics', () => {
    const obs = tri(300, [{ t: 20, h: 40, w: 5 }, { t: 150, h: 40, w: 5 }, { t: 250, h: 40, w: 5 }], 2)
    const sim = tri(300, [{ t: 28, h: 40, w: 5 }, { t: 150, h: 40, w: 5 }, { t: 250, h: 40, w: 5 }], 2)
    const base = { ...defaultTimingConfig(DAY, 300), peakMatchTolerance: 10 }
    const a = run(obs, sim, { ...base, eventWarmup: 0 })
    const b = run(obs, sim, { ...base, eventWarmup: 60 })
    expect(b.extras.events!.events.every(e => e.obs.start >= 60)).toBe(true)
    expect(b.values.event_lag).toBe(0)
    for (const id of ['peak_lag_abs', 'peak_lag_signed', 'dtw_warp', 'w1', 'xwt_lag', 'lag_best', 'nse']) expect(b.values[id], id).toEqual(a.values[id])
  })
})
