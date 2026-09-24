/**
 * Repair round for the dtw-wass cluster (adversarial review of the first fix).
 *  1. W1 / W2^2 tooltips: a pure shift reads the lag only for an event with
 *     zero flow at both ends of the record; otherwise W1 can be smaller OR
 *     larger than the lag (a year of HYMOD that ends on a flood rise reads
 *     7.15 steps for a 1-step shift).
 *  2. Date rows absent from the file (not NaN values) are time too: the time
 *     axis of DTW, W1, W2^2 and Series Distance comes from the timestamps
 *     divided by the detected step (D1), calendar months for monthly data.
 *  3. DTW mean |warp| cannot exceed the band: when the alignment runs along
 *     the band limit, a note says so.
 *  4. Cached results keep a thinned DTW path, not one node per step.
 *  5. Exact, transitive tie rule: warp identical under time reversal and in
 *     any flow unit; the distance is the true banded optimum.
 *  6. The long-gap note counts a gap of exactly w missing steps.
 *  7. Above the cell budget, a full-resolution pass in a corridor around the
 *     block-mean path resolves lags shorter than the block; a block-only
 *     fallback says that such lags are not resolved.
 *  8. (Plots tab) the band is converted to the step of a resampled frame:
 *     see tests/dom/dtw-wass-repair.test.tsx and the ctxFor test below.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { computeAll, byId, dtwResolutionNote, pairTimeAxis } from '../src/metrics/registry'
import { dtw, dtwOnTimeAxis, DTW_PATH_KEEP } from '../src/metrics/timing/dtwWasserstein'
import { defaultView } from '../src/types'
import { useApp } from '../src/store/store'
import { parseDelimited, stage } from '../src/ingest/ingest'
import { computeForRun, ctxFor, frameFor, subsetFrameFor } from '../src/ui/compute'

const DAY = 86_400_000
const HOUR = 3_600_000
const ctx = (n: number, timing: Record<string, unknown> = {}, step = DAY, patch: Record<string, unknown> = {}) => {
  const v = defaultView(step, n)
  return { nanPolicy: v.nanPolicy, transform: v.transform, timing: { ...v.timingConfig, ...timing }, heavy: true, ...patch } as any
}
const csvCols = (file: string) => {
  const rows = readFileSync(file, 'utf8').trim().split(/\r?\n/).slice(1)
  return (c: number) => rows.map(l => { const v = l.split(',')[c]; return v === '' ? NaN : Number(v) })
}
const hymod = csvCols('public/samples/sample_hymod_raven.csv')
const synth = csvCols('public/samples/sample_synthetic.csv')

/** Plain banded DTW, minimum only (no tie rule), as a reference optimum. */
function refOptimum(a: ArrayLike<number>, b: ArrayLike<number>, w: number): number {
  const n = a.length
  let prev = new Float64Array(n).fill(Infinity), cur = new Float64Array(n).fill(Infinity)
  for (let i = 0; i < n; i++) {
    cur.fill(Infinity)
    for (let j = Math.max(0, i - w); j <= Math.min(n - 1, i + w); j++) {
      const c = Math.abs(a[i] - b[j])
      if (i === 0 && j === 0) { cur[j] = c; continue }
      const best = Math.min(i > 0 && j > 0 ? prev[j - 1] : Infinity, i > 0 ? prev[j] : Infinity, j > 0 ? cur[j - 1] : Infinity)
      cur[j] = c + best
    }
    [prev, cur] = [cur, prev]
  }
  return prev[n - 1]
}

describe('repair 1: W1 can read more than the lag when flow enters or leaves at the record ends', () => {
  it('a year of HYMOD that ends on a flood rise, shifted 1 day, reads W1 = 7.15 steps', () => {
    const q = hymod(1)
    const o = q.slice(1592, 1957), s = q.slice(1591, 1956)   // the same record exactly one day late
    expect(o.slice(-4)).toEqual([114, 120, 130, 151])
    const out = computeAll(o, s, ctx(o.length))
    expect(out.values.w1).toBeCloseTo(7.150106777931991, 9)  // scipy.stats.wasserstein_distance gives 7.150
    expect(out.values.w1).toBeGreaterThan(1)
    expect(out.values.w2sq).toBeGreaterThan(1)
  })
  it('the tooltips say it can be smaller or larger than the lag, never only "less"', () => {
    const w1 = byId.get('w1')!.blurb, w2 = byId.get('w2sq')!.blurb
    expect(w1).toMatch(/zero flow at both ends of the record/)
    expect(w1).toMatch(/smaller or larger than the lag/)
    expect(w1).not.toMatch(/record ends, it reads less/)
    expect(w2).toMatch(/smaller or larger/)
    expect(w2).not.toMatch(/less with baseflow/)
  })
})

describe('repair 2: date rows absent from the file are time too', () => {
  const bump = (lag: number) => Array.from({ length: 200 }, (_, i) => 10 * Math.exp(-((i - lag - 100) ** 2) / 2))
  const o = bump(0), s = bump(10)
  const dates = Array.from({ length: 200 }, (_, i) => Date.UTC(2001, 0, 1) + i * DAY)
  const keep = dates.map((_, i) => i).filter(i => i < 103 || i > 107)

  it('computeAll with the dates of the surviving rows gives the same W1, W2^2 and DTW as blank values', () => {
    const oBlank = o.slice(); for (let t = 103; t <= 107; t++) oBlank[t] = NaN
    const blank = computeAll(oBlank, s, ctx(200, { dtwBand: 15 }))
    const absent = computeAll(keep.map(i => o[i]), keep.map(i => s[i]), { ...ctx(195, { dtwBand: 15 }), datesMs: keep.map(i => dates[i]) })
    expect(absent.values.w1).toBeCloseTo(10.027803656428237, 8)   // was 5.028
    expect(absent.values.w2sq).toBeCloseTo(100.58443263135946, 6) // was 25.31
    expect(absent.values.dtw_warp).toBeCloseTo(blank.values.dtw_warp, 12)
    expect(absent.values.dtw_dist).toBeCloseTo(blank.values.dtw_dist, 12)
    expect(absent.values.sd_time).toBe(blank.values.sd_time)
  })

  it('a staged CSV with the rows left out reads the same W1 through the store', () => {
    const rows = ['date,observed,sim']
    for (const i of keep) rows.push(`${new Date(dates[i]).toISOString().slice(0, 10)},${o[i]},${s[i]}`)
    useApp.getState().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null })
    useApp.getState().commitDataset(stage(parseDelimited(rows.join('\n')), { name: 'absent', roles: ['date', 'observed', 'run'], dateFormat: 'auto', unit: 'm3s', missingValue: null }).commit!)
    const ds = useApp.getState().project.datasets[0]
    const out = computeForRun(ds, ds.runs[0])
    expect(out.values.w1).toBeCloseTo(10.0278, 3)
    expect(out.values.w2sq).toBeCloseTo(100.584, 2)
  })

  it('without dates the index is the time axis; with complete regular dates the axis is the index', () => {
    const idx = [0, 1, 2, 5, 6]
    expect(Array.from(pairTimeAxis(idx).t)).toEqual(idx)
    const full = Array.from({ length: 7 }, (_, i) => Date.UTC(2001, 0, 1) + i * HOUR)
    expect(Array.from(pairTimeAxis(idx, full).t)).toEqual(idx)
    expect(Array.from(pairTimeAxis([0, 1, 2], [full[0], full[1], full[4]]).t)).toEqual([0, 1, 4])
  })

  it('monthly data use calendar months', () => {
    const md = [Date.UTC(2001, 0, 1), Date.UTC(2001, 1, 1), Date.UTC(2001, 2, 1), Date.UTC(2001, 5, 1), Date.UTC(2001, 6, 1), Date.UTC(2002, 0, 1)]
    // 31-, 28- and 31-day months: a 30-day step would read 2.97 and 4.07
    expect(Array.from(pairTimeAxis([0, 1, 2, 3, 4, 5], md).t)).toEqual([0, 1, 2, 5, 6, 12])
  })

  it('irregular dates keep their fractional time and get a note', () => {
    const n = 60
    const d = Array.from({ length: n }, (_, i) => Date.UTC(2001, 0, 1) + i * DAY + (i === 30 ? 12 * HOUR : 0))
    const ax = pairTimeAxis(Array.from({ length: n }, (_, i) => i), d)
    expect(ax.t[30]).toBe(30.5)
    expect(ax.offGrid).toBe(1)
    const a = Array.from({ length: n }, (_, i) => 5 + 3 * Math.sin(i / 5)), b = a.map((_, i) => 5 + 3 * Math.sin((i - 1) / 5))
    const out = computeAll(a, b, { ...ctx(n), datesMs: d })
    expect(out.notes.some(t => /1 pair falls between the steps of the 1d grid/.test(t))).toBe(true)
  })
})

describe('repair 3: DTW mean |warp| cannot exceed the band, and a note says when it is at the limit', () => {
  const o = synth(1)
  const shifted = (k: number) => [o.slice(30), o.slice(30 - k, o.length - k)] as const
  it('a lag longer than the band gets the band-limit note; a lag inside the band does not', () => {
    for (const k of [5, 8, 15]) {
      const [a, b] = shifted(k)
      const out = computeAll(a, b, ctx(a.length))
      expect(out.values.dtw_warp).toBeLessThanOrEqual(3)
      expect(out.extras.dtw!.edgeShare, `k=${k}`).toBeGreaterThan(0.2)
      expect(out.notes.some(t => /DTW warp reached the band limit \(±3 steps\)/.test(t) && /widen the band on the Timing tab/.test(t)), `k=${k}`).toBe(true)
    }
    const [a, b] = shifted(2)
    const out = computeAll(a, b, ctx(a.length))
    expect(out.extras.dtw!.edgeShare).toBe(0)
    expect(out.notes.some(t => /band limit/.test(t))).toBe(false)
  })
  it('a wider band removes the note and recovers the lag', () => {
    const [a, b] = shifted(8)
    const out = computeAll(a, b, ctx(a.length, { dtwBand: 12 }))
    expect(out.notes.some(t => /band limit/.test(t))).toBe(false)
    expect(out.values.dtw_warp).toBeGreaterThan(7)
  })
  it('the tooltip says the warp cannot exceed the band', () => {
    expect(byId.get('dtw_warp')!.blurb).toMatch(/cannot exceed w/)
  })
})

describe('repair 4: a cached result keeps a thinned DTW path', () => {
  it('computeAll stores at most DTW_PATH_KEEP nodes and the exact statistics of the whole path', () => {
    const q = hymod(2), x: number[] = []
    for (let r = 0; r < 25; r++) x.push(...q.slice(1))
    const n = 50_000, k = 2
    const a = x.slice(10, 10 + n), b = x.slice(10 - k, 10 - k + n)
    const out = computeAll(a, b, ctx(n))
    const d = out.extras.dtw!
    expect(d.path.length).toBeLessThanOrEqual(DTW_PATH_KEEP)
    expect(d.pathLength).toBeGreaterThanOrEqual(n)
    expect(d.path[0]).toEqual([0, 0])
    expect(d.path[d.path.length - 1]).toEqual([n - 1, n - 1])
    const full = dtw(a, b, 3)
    expect(full.path.length).toBe(d.pathLength)
    expect(d.meanAbsWarp).toBeCloseTo(full.meanAbsWarp, 12)
    expect(d.distance).toBeCloseTo(full.distance, 9)
  }, 60_000)
})

describe('repair 5: exact tie rule', () => {
  const h = (lag: number) => Array.from({ length: 365 }, (_, i) =>
    0.3 + 5 * Math.exp(-((i - lag - 150) ** 2) / 200) + 0.5 * Math.exp(-((i - lag - 60) ** 2) / 50))
  const ho = h(0), hs = h(3)
  it('reversing time leaves mean |warp| unchanged under every transform and band', () => {
    for (const transform of ['none', 'log', 'sqrt', 'inverse']) {
      for (const band of [3, 10, 36]) {
        const f = computeAll(ho, hs, ctx(365, { dtwBand: band }, DAY, { transform }))
        const r = computeAll([...ho].reverse(), [...hs].reverse(), ctx(365, { dtwBand: band }, DAY, { transform }))
        expect(r.values.dtw_warp, `${transform} band ${band}`).toBe(f.values.dtw_warp)
        expect(r.values.dtw_dist, `${transform} band ${band}`).toBeCloseTo(f.values.dtw_dist, 12)
      }
    }
  })
  it('the flow unit does not change mean |warp|', () => {
    for (const transform of ['none', 'log', 'sqrt']) {
      const m3s = computeAll(ho, hs, ctx(365, {}, DAY, { transform }))
      for (const f of [1000, 35.3147, 0.0283168]) {
        const u = computeAll(ho.map(v => v * f), hs.map(v => v * f), ctx(365, {}, DAY, { transform }))
        expect(u.values.dtw_warp, `${transform} x${f}`).toBe(m3s.values.dtw_warp)
      }
    }
  })
  it('the DTW distance is the true banded optimum, forward and reversed, on a long record', () => {
    const o = hymod(1), s = hymod(2), a: number[] = [], b: number[] = []
    for (let r = 0; r < 50; r++) for (let i = 0; i < o.length; i++) if (isFinite(o[i]) && isFinite(s[i])) { a.push(o[i]); b.push(s[i]) }
    const w = 24
    const opt = refOptimum(a, b, w)
    const fwd = dtw(a, b, w)
    const rev = dtw([...a].reverse(), [...b].reverse(), w)
    expect(Math.abs(fwd.distance - opt)).toBeLessThanOrEqual(1e-9 * opt)
    expect(Math.abs(rev.distance - opt)).toBeLessThanOrEqual(1e-9 * opt)
    expect(rev.meanAbsWarp).toBe(fwd.meanAbsWarp)
  }, 60_000)
})

describe('repair 6: the long-gap note counts a gap of exactly w missing steps', () => {
  const f = (t: number) => 5 + 3 * Math.sin(t / 7) + 2 * Math.sin(t / 23 + 1) + 0.02 * t
  const n = 300
  const a = Array.from({ length: n }, (_, i) => f(i)), b = Array.from({ length: n }, (_, i) => f(i - 8))
  const withGap = (g: number) => { const x = a.slice(); for (let t = 150; t < 150 + g; t++) x[t] = NaN; return x }
  it('15 missing steps block a band of 15; 14 do not', () => {
    const at = computeAll(withGap(15), b, ctx(n, { dtwBand: 15 }))
    expect(at.notes.some(t => /^1 gap of 15 or more missing steps blocks the DTW band \(±15 steps\)/.test(t))).toBe(true)
    // no path cell crosses the gap
    const idx = at.pairedIndex!
    for (const [i, j] of at.extras.dtw!.path) expect((idx[i] < 150) === (idx[j] < 150)).toBe(true)
    const below = computeAll(withGap(14), b, ctx(n, { dtwBand: 15 }))
    expect(below.notes.some(t => /blocks the DTW band/.test(t))).toBe(false)
  })
})

describe('repair 7: above the cell budget, lags shorter than the block are still resolved', () => {
  const q = hymod(2), x: number[] = []
  for (let r = 0; r < 12; r++) x.push(...q.slice(1))   // HYMOD simulated flow, repeated every 2,190 days
  const n = 20_000
  const t = Array.from({ length: n }, (_, i) => i)
  const pair = (k: number) => {
    const a = x.slice(200, 200 + n), b = x.slice(200 - k, 200 - k + n)
    let mae = 0
    for (let i = 0; i < n; i++) mae += Math.abs(a[i] - b[i]) / n
    return { a, b, mae }
  }

  it('a 2-day lag with blocks of 6 pairs: the exact narrow pass resolves it', () => {
    const { a, b, mae } = pair(2), w = 2000
    const full = dtwOnTimeAxis(a, b, t, w, 1e8)          // one pass: 8e7 cells
    expect(full.mode).toBe('full')
    expect(dtwResolutionNote(full)).toBeNull()
    expect(Math.abs(full.meanAbsWarp - 2)).toBeLessThan(0.01)
    // a budget that forces blocks of 6 pairs; the old block-only result read
    // dtw_dist 1.908 (MAE-like) and a warp of 0.039
    const r = dtwOnTimeAxis(a, b, t, w, 2.3e6)
    expect(r.coarseBlock).toBe(6)
    expect(r.narrowBand).toBe(57)
    expect(r.decim).toBe(1)
    expect(r.mode).not.toBe('blocks')
    expect(r.normalized).toBeLessThan(0.02 * mae)
    expect(Math.abs(r.meanAbsWarp - full.meanAbsWarp)).toBeLessThan(0.05)
    expect(dtwResolutionNote(r)).toMatch(/^A full-resolution DTW alignment within ±2000 steps would need more than 50 million cells/)
  }, 60_000)

  it('a lag longer than the narrow band is found in the corridor around the block-mean alignment', () => {
    const { a, b, mae } = pair(100), w = 2000
    const full = dtwOnTimeAxis(a, b, t, w, 1e8)
    const r = dtwOnTimeAxis(a, b, t, w, 2.3e6)
    expect(r.mode).toBe('corridor')
    expect(r.bandSteps).toBe(w)
    expect(r.normalized).toBeLessThan(0.02 * mae)
    expect(Math.abs(r.meanAbsWarp - full.meanAbsWarp)).toBeLessThan(0.05 * full.meanAbsWarp)
    expect(dtwResolutionNote(r)).toMatch(/twice, within ±57 steps and within about 6 steps of an alignment of means of 6 consecutive pairs/)
  }, 60_000)

  it('a coarse alignment that is cheap only at the block scale does not win', () => {
    // with blocks of 7 pairs, block means of the simulation 4,382 steps later
    // (two repeats plus the 2-day lag) equal those of the observed series, so
    // the coarse pass settles there; at full resolution that alignment is far
    // dearer than the 2-day lag, which the narrow pass finds exactly
    const { a, b, mae } = pair(2), w = 4400
    const r = dtwOnTimeAxis(a, b, t, w, 4e6)
    expect(r.coarseBlock).toBe(7)
    expect(r.mode).toBe('narrow')
    expect(r.normalized).toBeLessThan(0.02 * mae)
    expect(Math.abs(r.meanAbsWarp - 2)).toBeLessThan(0.05)
    expect(dtwResolutionNote(r)).toMatch(/the exact one within ±99 steps \(the one found around an alignment of means of 7 consecutive pairs was not cheaper\)/)
  }, 60_000)

  it('when no full-resolution pass fits, the block-only result says that short lags are not resolved', () => {
    const { a, b } = pair(2)
    const r = dtwOnTimeAxis(a, b, t, 2000, 5e4)
    expect(r.mode).toBe('blocks')
    expect(r.decim).toBeGreaterThan(1)
    expect(dtwResolutionNote(r)).toMatch(new RegExp(`lags shorter than ${r.decim} steps are not resolved`))
    expect(dtwResolutionNote(r)).toMatch(/DTW values are approximate/)
  }, 60_000)
})

describe('repair 8: the DTW band follows the step of a resampled Plots-tab frame', () => {
  it('±24 hourly steps become ±1 daily step on a daily resample', () => {
    const rows = ['date,observed,sim']
    for (let i = 0; i < 24 * 90; i++) rows.push(`${new Date(Date.UTC(2001, 0, 1) + i * HOUR).toISOString().slice(0, 16)},${(5 + 3 * Math.sin(i / 50)).toFixed(3)},${(5 + 3 * Math.sin((i - 12) / 50)).toFixed(3)}`)
    useApp.getState().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null })
    useApp.getState().commitDataset(stage(parseDelimited(rows.join('\n')), { name: 'hourly', roles: ['date', 'observed', 'run'], dateFormat: 'auto', unit: 'm3s', missingValue: null }).commit!)
    const ds0 = useApp.getState().project.datasets[0]
    expect(ds0.view.timingConfig.dtwBand).toBe(24)
    expect(ctxFor(ds0, frameFor(ds0)).timing.dtwBand).toBe(24)
    useApp.getState().updateView({ resample: 'daily' })
    const ds = useApp.getState().project.datasets[0]
    const frame = subsetFrameFor(ds)
    expect(frame.step.label).toBe('1d')
    expect(ctxFor(ds, frame).timing.dtwBand).toBe(1)
    expect(ds.view.timingConfig.dtwBand).toBe(24)   // the setting itself is unchanged
  })
})
