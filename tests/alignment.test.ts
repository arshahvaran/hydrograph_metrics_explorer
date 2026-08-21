/**
 * Round 11 regressions: DTW alignment tie mapping.
 * The DTW path indexes the arrays the engine actually aligned (pairwise NaN
 * compaction, then 1/decim decimation for long records). dtwTies must map
 * every path node back to original frame rows so the grey ties in the Plots
 * tab join the true dates and values: under a pure shift, with gaps, with
 * decimation, and with an active analysis window.
 */
import { describe, it, expect } from 'vitest'
import { computeAll } from '../src/metrics/registry'
import { applySubset } from '../src/metrics/subset'
import { defaultView } from '../src/types'
import { dtwTies } from '../src/ui/alignment'

const DAY = 86_400_000
const ctx = (n: number) => {
  const v = defaultView(DAY, n)
  return { nanPolicy: v.nanPolicy, transform: v.transform, timing: v.timingConfig, heavy: true } as any
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

describe('DTW alignment ties: n > 6000 (decimated path rescaled to full resolution)', () => {
  const N = 7000, K = 4
  const o = hydro(N), s = hydro(N, K)
  const dstr = mkDates(N).map(iso)
  const out = computeAll(o, s, ctx(N))
  const trip = triples(dtwTies(out, dstr, Array.from(o), Array.from(s), Number.MAX_SAFE_INTEGER))
  it('reports the decimation factor', () => {
    expect(out.extras.dtw!.decim).toBe(2)
  })
  it('ties span the whole record, on the decimation grid, with true values', () => {
    // the old unscaled indices compressed every tie into the first half
    const last = trip[trip.length - 1]
    expect(last.xo).toBe(dstr[(Math.floor(N / 2) - 1) * 2])
    for (const { xo, xs, yo, ys } of trip) {
      const i = dstr.indexOf(xo), j = dstr.indexOf(xs)
      expect(i % 2).toBe(0)
      expect(j % 2).toBe(0)
      expect(yo).toBe(o[i])
      expect(ys).toBe(s[j])
    }
  })
  it('a grid-aligned observed peak ties to the simulated peak K days later', () => {
    const hit = trip.find(tt => tt.xo === dstr[2020] && tt.xs === dstr[2020 + K])
    expect(hit).toBeTruthy()
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
