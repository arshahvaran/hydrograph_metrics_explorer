/**
 * Round 11 regressions: DTW alignment tie mapping.
 * The DTW path indexes the arrays the engine actually aligned (pairwise NaN
 * compaction, then block means in DTW's block-only fallback). dtwTies must map
 * every path node back to original frame rows so the grey ties in the Plots
 * tab join the true dates and values: under a pure shift, with gaps, in the
 * two-pass and block-only modes, and with an active analysis window. The
 * stored path is thinned to at most DTW_PATH_KEEP nodes (dtw-wass repair 4).
 */
import { describe, it, expect } from 'vitest'
import { computeAll } from '../src/metrics/registry'
import { applySubset } from '../src/metrics/subset'
import { defaultView } from '../src/types'
import { dtwTies } from '../src/ui/alignment'
import { dtwOnTimeAxis, DTW_PATH_KEEP } from '../src/metrics/timing/dtwWasserstein'

const DAY = 86_400_000
// The shifts below (K = 3, 4 days) exceed the default daily DTW band of 3
// steps, so these tie-mapping tests widen the band to 10 steps (or more).
const ctx = (n: number, dtwBand = 10) => {
  const v = defaultView(DAY, n)
  return { nanPolicy: v.nanPolicy, transform: v.transform, timing: { ...v.timingConfig, dtwBand }, heavy: true } as any
}
const mkDates = (n: number, start = Date.UTC(2001, 0, 1)) => Array.from({ length: n }, (_, i) => start + i * DAY)
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10)
// Gaussian bumps centred at i = 20 mod 40 (shifted right by `lag`).
const hydro = (n: number, lag = 0) =>
  Float64Array.from({ length: n }, (_, i) => 2 + 8 * Math.exp(-(((i - lag + 600) % 40 - 20) ** 2) / 18))

/** Decode the [xO, xS, null, ...] plotly encoding into tie objects. */
function triples(t: { x: (string | null)[]; y: (number | null)[] }) {
  const out: { xo: string; xs: string; yo: number | null; ys: number | null }[] = []
  for (let k = 0; k + 1 < t.x.length; k += 3) {
    out.push({ xo: t.x[k] as string, xs: t.x[k + 1] as string, yo: t.y[k], ys: t.y[k + 1] })
  }
  return out
}

describe('DTW alignment ties: pure +K shift on clean data', () => {
  const N = 240, K = 4
  const o = hydro(N), s = hydro(N, K)
  const dstr = mkDates(N).map(iso)
  const out = computeAll(o, s, ctx(N))
  const t = dtwTies(out, dstr, Array.from(o), Array.from(s), Number.MAX_SAFE_INTEGER)
  it('draws every path node when the tie budget allows', () => {
    expect(t.ties).toBe(out.extras.dtw!.path.length)
  })
  it('every tie joins a true date to its true value on both series', () => {
    for (const { xo, xs, yo, ys } of triples(t)) {
      const i = dstr.indexOf(xo), j = dstr.indexOf(xs)
      expect(i).toBeGreaterThanOrEqual(0)
      expect(j).toBeGreaterThanOrEqual(0)
      expect(yo).toBe(o[i])
      expect(ys).toBe(s[j])
    }
  })
  it('each observed peak ties to the simulated peak exactly K days later', () => {
    const trip = triples(t)
    for (let p = 20; p + K < N; p += 40) {
      const hit = trip.find(tt => tt.xo === dstr[p] && tt.xs === dstr[p + K])
      expect(hit, `peak at ${dstr[p]} should tie to ${dstr[p + K]}`).toBeTruthy()
    }
  })
})

describe('DTW alignment ties: missing values (pairwise compaction)', () => {
  const N = 240, K = 4
  const o = Array.from(hydro(N)), s = Array.from(hydro(N, K))
  const gaps = new Set<number>()
  for (let i = 7; i < N; i += 37) { o[i] = NaN; gaps.add(i) }
  for (let i = 11; i < N; i += 53) { s[i] = NaN; gaps.add(i) }
  const dstr = mkDates(N).map(iso)
  const out = computeAll(o, s, ctx(N))
  const oy = o.map(v => (isFinite(v) ? v : null)), sy = s.map(v => (isFinite(v) ? v : null))
  const trip = triples(dtwTies(out, dstr, oy, sy, Number.MAX_SAFE_INTEGER))
  it('exposes the compaction index of every used pair', () => {
    expect(out.pairedIndex!.length).toBe(out.n)
    expect(out.n).toBe(N - gaps.size)
  })
  it('no tie ever lands on a gap row, and values match the true rows', () => {
    expect(trip.length).toBeGreaterThan(0)
    for (const { xo, xs, yo, ys } of trip) {
      const i = dstr.indexOf(xo), j = dstr.indexOf(xs)
      expect(gaps.has(i), `obs tie on dropped row ${i}`).toBe(false)
      expect(gaps.has(j), `sim tie on dropped row ${j}`).toBe(false)
      expect(yo).toBe(o[i])
      expect(ys).toBe(s[j])
    }
  })
  it('surviving peaks still tie K days apart at the correct dates', () => {
    for (let p = 20; p + K < N; p += 40) {
      if (gaps.has(p) || gaps.has(p + K)) continue
      const hit = trip.find(tt => tt.xo === dstr[p] && tt.xs === dstr[p + K])
      expect(hit, `peak at ${dstr[p]} should tie to ${dstr[p + K]}`).toBeTruthy()
    }
  })
})

describe('DTW alignment ties: n > 6000 runs at full resolution (dtw-wass-01)', () => {
  const N = 7000, K = 4
  const o = hydro(N), s = hydro(N, K)
  const dstr = mkDates(N).map(iso)
  const out = computeAll(o, s, ctx(N))
  const trip = triples(dtwTies(out, dstr, Array.from(o), Array.from(s), Number.MAX_SAFE_INTEGER))
  it('no decimation below the cell budget; the stored path is thinned (dtw-wass repair 4)', () => {
    const d = out.extras.dtw!
    expect(d.decim).toBe(1)
    expect(d.pathLength).toBeGreaterThanOrEqual(N)
    expect(d.path.length).toBe(DTW_PATH_KEEP)
    expect(trip.length).toBe(DTW_PATH_KEEP)
    expect(trip[0].xo).toBe(dstr[0])
    expect(trip[trip.length - 1].xo).toBe(dstr[N - 1])
  })
  it('every drawn tie from an observed peak lands on the simulated peak K days later', () => {
    let hits = 0
    for (const { xo, xs, yo, ys } of trip) {
      const i = dstr.indexOf(xo), j = dstr.indexOf(xs)
      expect(yo).toBe(o[i])
      expect(ys).toBe(s[j])
      if (i % 40 === 20 && i + K < N) { expect(j, `peak at ${i}`).toBe(i + K); hits++ }
    }
    expect(hits).toBeGreaterThan(20)
  })
})

describe('DTW alignment ties: above the cell budget (full resolution in a narrower band or a corridor)', () => {
  // a band of 10 % of n (2,000 steps) needs 8e7 cells in one pass, above the
  // 5e7 budget: DTW aligns at full resolution within ±1,249 steps and around
  // an alignment of means of 2 consecutive pairs (dtw-wass repair 7)
  const N = 20_000, K = 4
  const o = hydro(N), s = hydro(N, K)
  const dstr = mkDates(N).map(iso)
  const out = computeAll(o, s, ctx(N, 2000))
  const trip = triples(dtwTies(out, dstr, Array.from(o), Array.from(s), Number.MAX_SAFE_INTEGER))
  it('stays at full resolution and says so in a note', () => {
    const d = out.extras.dtw!
    expect(d.decim).toBe(1)
    expect(d.mode).not.toBe('blocks')
    expect(d.coarseBlock).toBe(2)
    expect(d.narrowBand).toBe(1249)
    expect(out.notes.some(n => /^A full-resolution DTW alignment within ±2000 steps would need more than 50 million cells/.test(n) && /means of 2 consecutive pairs/.test(n))).toBe(true)
  })
  it('ties span the whole record at full resolution, with true values', () => {
    expect(trip[trip.length - 1].xo).toBe(dstr[N - 1])
    let hits = 0
    for (const { xo, xs, yo, ys } of trip) {
      const i = dstr.indexOf(xo), j = dstr.indexOf(xs)
      expect(yo).toBe(o[i])
      expect(ys).toBe(s[j])
      if (i % 40 === 20 && i + K < N) { expect(j, `peak at ${i}`).toBe(i + K); hits++ }
    }
    expect(hits).toBeGreaterThan(20)
  })
})

describe('DTW alignment ties: block-only fallback (the corridor does not fit either)', () => {
  // dtwTies must undo the block mapping when the path indexes block means
  const N = 20_000, K = 4
  const o = hydro(N), s = hydro(N, K)
  const dstr = mkDates(N).map(iso)
  const t = Array.from({ length: N }, (_, i) => i)
  const res = dtwOnTimeAxis(o, s, t, 2000, 5e4)
  const out = { extras: { dtw: res }, pairedIndex: t } as any
  const trip = triples(dtwTies(out, dstr, Array.from(o), Array.from(s), Number.MAX_SAFE_INTEGER))
  it('ties span the whole record, on the block grid, with true values', () => {
    const B = res.decim
    expect(B).toBeGreaterThan(1)
    expect(res.mode).toBe('blocks')
    const last = trip[trip.length - 1]
    expect(last.xo).toBe(dstr[(Math.ceil(N / B) - 1) * B])
    for (const { xo, xs, yo, ys } of trip) {
      const i = dstr.indexOf(xo), j = dstr.indexOf(xs)
      expect(i % B).toBe(0)
      expect(j % B).toBe(0)
      expect(yo).toBe(o[i])
      expect(ys).toBe(s[j])
    }
  })
})

describe('DTW alignment ties: active analysis window (subset frame)', () => {
  const N = 300, K = 3
  const dates = mkDates(N)
  const o = hydro(N), s = hydro(N, K)
  const v = defaultView(DAY, N)
  const view = { ...v, window: [dates[50], dates[249]] as [number, number] }
  const step = { ms: DAY, label: '1d' }
  const sub = applySubset(dates, [o], view, step)
  const subSim = applySubset(dates, [s], view, step).obs
  const dstr = sub.dates.map(iso)
  const out = computeAll(sub.obs, subSim, ctx(sub.dates.length))
  const trip = triples(dtwTies(out, dstr, Array.from(sub.obs), Array.from(subSim), Number.MAX_SAFE_INTEGER))
  it('all ties stay inside the window and match the subset rows', () => {
    const lo = iso(dates[50]), hi = iso(dates[249])
    expect(trip.length).toBeGreaterThan(0)
    for (const { xo, xs, yo, ys } of trip) {
      expect(xo >= lo && xo <= hi).toBe(true)
      expect(xs >= lo && xs <= hi).toBe(true)
      const i = dstr.indexOf(xo), j = dstr.indexOf(xs)
      expect(yo).toBe(sub.obs[i])
      expect(ys).toBe(subSim[j])
    }
  })
  it('a peak inside the window ties K days later in subset coordinates', () => {
    // global peak row 60 = subset row 10; simulated peak K steps later
    const hit = trip.find(tt => tt.xo === dstr[10] && tt.xs === dstr[10 + K])
    expect(hit).toBeTruthy()
  })
})
