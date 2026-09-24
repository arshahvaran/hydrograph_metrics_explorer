/**
 * Final sweep, timing:
 *  1. XWT ran on the compacted pairs, so every gap counted as one step (D1).
 *     It now runs on the time grid: gaps of up to XWT_FILL_MAX missing steps
 *     are filled by linear interpolation, longer gaps are joined, and notes
 *     say which.
 *  2. The event metrics paired events with a first-overlap pass in time
 *     order, Series Distance with the optimal matching; both now use the same
 *     matching (eventMatch.ts), so they mark the same events as matched.
 *  3. MASE says that its naive scale is taken over the pairs the NaN policy
 *     keeps (HydroErr parity).
 *  4. The Timing tab shows every timing note, not only notes with listed words.
 */
import { describe, it, expect } from 'vitest'
import { computeAll, xwtGrid, XWT_FILL_MAX, isTimingNote, byId } from '../src/metrics/registry'
import { xwtLag } from '../src/metrics/timing/xwt'
import { eventErrors, detectEvents } from '../src/metrics/timing/events'
import { seriesDistance } from '../src/metrics/timing/deSd'
import * as C from '../src/metrics/classical/catalogue'
import { defaultTimingConfig } from '../src/types'

const DAY = 864e5

describe('1. XWT on the time grid', () => {
  it('xwtGrid fills gaps of up to XWT_FILL_MAX steps linearly and joins longer ones', () => {
    expect(XWT_FILL_MAX).toBe(3)
    const g = xwtGrid([0, 3, 4, 9], [10, 13, 14, 19], [0, 3, 4, 9])
    expect(Array.from(g.o)).toEqual([0, 1, 2, 3, 4, 9])        // 2 missing steps filled; 4 missing joined
    expect(Array.from(g.s)).toEqual([10, 11, 12, 13, 14, 19])
    expect([g.filledGaps, g.filledSteps, g.joinedGaps, g.joinedSteps]).toEqual([1, 2, 1, 4])
  })
  it('pairs at fractional times (irregular dates) are left as they are', () => {
    const g = xwtGrid([1, 2, 3], [1, 2, 3], [0, 1.5, 4])
    expect(Array.from(g.o)).toEqual([1, 2, 3])
    expect(g.filledGaps + g.joinedGaps).toBe(0)
  })
  it('isolated missing days no longer shrink the XWT lag by the missing fraction', () => {
    const n = 1200, L = 4
    const f = (i: number) => 10 + 4 * Math.sin(2 * Math.PI * i / 30) + 3 * Math.sin(2 * Math.PI * i / 90) + 6 * Math.exp(-(((i % 60) - 20) ** 2) / 20)
    const obs = Array.from({ length: n }, (_, i) => f(i)), sim = Array.from({ length: n }, (_, i) => f(i - L))
    const holes = obs.map((v, i) => (i % 7 === 3 ? NaN : v))           // 1 day in 7 missing
    const dates = Array.from({ length: n }, (_, i) => Date.UTC(2001, 0, 1) + i * DAY)
    const ctx = { nanPolicy: 'pairwise' as const, transform: 'none' as const, timing: defaultTimingConfig(DAY, n), datesMs: dates }
    const full = computeAll(obs, sim, ctx).values.xwt_lag
    const out = computeAll(holes, sim, ctx)
    expect(out.values.xwt_lag).toBeCloseTo(full, 2)                    // 3.827 both
    const keep = holes.map((_, i) => i).filter(i => Number.isFinite(holes[i]))
    const compacted = xwtLag(keep.map(i => obs[i]), keep.map(i => sim[i])).headlineLag
    expect(Math.abs(compacted - full)).toBeGreaterThan(0.4)             // the old reading, about 6/7 of it
    expect(out.notes).toContain('Cross-wavelet analysis: 171 gaps of up to 3 missing steps (171 steps in all) were filled by linear interpolation in time, because the wavelet transform needs evenly spaced values.')
  })
  it('a long gap is joined and named', () => {
    const n = 400
    const obs = Array.from({ length: n }, (_, i) => 5 + 3 * Math.sin(i / 6) + (i >= 200 && i < 210 ? NaN : 0))
    const sim = obs.map((_, i) => 5 + 3 * Math.sin((i - 2) / 6))
    const dates = Array.from({ length: n }, (_, i) => Date.UTC(2001, 0, 1) + i * DAY)
    const out = computeAll(obs, sim, { nanPolicy: 'pairwise', transform: 'none', timing: defaultTimingConfig(DAY, n), datesMs: dates })
    expect(out.notes).toContain('Cross-wavelet analysis: 1 gap of more than 3 missing steps (10 steps in all) was joined, so the values on its two sides are treated as adjacent; the XWT lag is not resolved across it.')
  })
})

describe('2. one event matching for the event metrics and Series Distance', () => {
  const bump = (c: number, h: number, w: number) => (i: number) => (Math.abs(i - c) <= w ? h * (1 - Math.abs(i - c) / (w + 1)) : 0)
  const opt = { thresholdKind: 'absolute' as const, thresholdValue: 3, minDistance: 1, warmup: 0 }
  it('two observed floods compete for one simulated flood: the nearer peak is the hit (was the earlier one)', () => {
    const A = bump(12, 10, 2), B = bump(26, 10, 2), X = bump(21, 10, 2)
    const obs = Array.from({ length: 60 }, (_, i) => 1 + A(i) + B(i)), sim = Array.from({ length: 60 }, (_, i) => 1 + X(i))
    const ev = eventErrors(obs, sim, opt, 6)
    const sd = seriesDistance(obs, sim, opt, 6)
    expect(ev.events.map(e => [e.obs.peakIdx, e.matched])).toEqual([[12, false], [26, true]])
    expect(sd.pairedPeaks).toEqual([[26, 21]])
    expect(ev.threat).toBe(sd.occurrence)
  })
  it('on random layouts both mark the same observed events as matched and give the same threat score', () => {
    let seed = 7
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    for (let trial = 0; trial < 300; trial++) {
      const n = 200
      const obs = new Array(n).fill(1), sim = new Array(n).fill(1)
      for (let k = 0; k < 8; k++) {
        const c = Math.floor(rnd() * n), w = 1 + Math.floor(rnd() * 3), h = 4 + rnd() * 8
        for (let i = 0; i < n; i++) obs[i] += bump(c, h, w)(i)
        const c2 = Math.floor(rnd() * n)
        for (let i = 0; i < n; i++) sim[i] += bump(c2, h, w)(i)
      }
      const tol = Math.floor(rnd() * 8)
      const ev = eventErrors(obs, sim, opt, tol)
      const sd = seriesDistance(obs, sim, opt, tol)
      const obsEvents = detectEvents(obs, opt).events
      const sdObs = new Set(sd.pairedPeaks.map(p => p[0]))
      expect(ev.events.filter(e => e.matched).map(e => obsEvents.find(o => o.start === e.obs.start)!.peakIdx).sort((a, b) => a - b))
        .toEqual([...sdObs].sort((a, b) => a - b))
      expect(ev.hits).toBe(sd.matchedEvents)
      if (Number.isFinite(ev.threat)) expect(ev.threat).toBeCloseTo(sd.occurrence, 12)
    }
  })
})

describe('3. MASE tooltip', () => {
  it('says that the naive scale uses the pairs the NaN policy keeps, as in HydroErr', () => {
    expect(byId.get('mase')!.blurb).toMatch(/naive scale is the mean \|Oᵢ − Oᵢ₋₁\| over the pairs that the NaN policy keeps, as in HydroErr/)
  })
})

describe('4. isTimingNote (Timing tab)', () => {
  it('keeps every timing note and leaves out only the classical-metric notes', () => {
    expect(isTimingNote('No observed events: no observed flow after the warm-up exceeds the event threshold. Lower the threshold or the warm-up on the Timing tab.')).toBe(true)
    expect(isTimingNote('Cross-wavelet analysis: 1 gap of more than 3 missing steps (10 steps in all) was joined, so the values on its two sides are treated as adjacent; the XWT lag is not resolved across it.')).toBe(true)
    expect(isTimingNote(C.LOG_NA_NOTE)).toBe(false)
    expect(isTimingNote(C.fdcLogNote([0, 0, 0, 1, 2, 3, 4, 5, 6, 7], [0, 0, 0, 1, 2, 3, 4, 5, 6, 7])!)).toBe(false)
  })
})

describe('5. note wording', () => {
  it('no observed events: the note says why and what to change', () => {
    const n = 200
    const obs = Array.from({ length: n }, () => 5), sim = Array.from({ length: n }, (_, i) => 5 + Math.sin(i))
    const t = { ...defaultTimingConfig(DAY, n), eventThreshold: { kind: 'absolute' as const, value: 50 } }
    const out = computeAll(obs, sim, { nanPolicy: 'pairwise', transform: 'none', timing: t })
    expect(out.notes).toContain('No observed events: no observed flow after the warm-up exceeds the event threshold. Lower the threshold or the warm-up on the Timing tab.')
  })
  it('DE on a record with zero flows names the assumption it breaks', () => {
    const n = 200
    const obs = Array.from({ length: n }, (_, i) => (i % 10 === 0 ? 0 : 3 + Math.sin(i / 5))), sim = obs.map(v => v + 0.5)
    const out = computeAll(obs, sim, { nanPolicy: 'pairwise', transform: 'none', timing: defaultTimingConfig(DAY, n) })
    expect(out.notes).toContain('DE: the observed record has zero or negative flows, and Diagnostic Efficiency assumes perennial flow (Schwemmle et al., 2021), so read its value with care.')
  })
})
