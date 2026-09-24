/**
 * Audit regressions for DTW and the Wasserstein transport distances
 * (cluster dtw-wass; design rules D1 and D6).
 *  - dtw-wass-01 / claims-08: DTW runs at full resolution with banded storage;
 *    the old point-decimation above 6,000 pairs made dtw_dist collapse to the
 *    MAE and quantised dtw_warp, and ignored every other step.
 *  - dtw-wass-02: W1, W2^2 and the DTW warp are measured on the original time
 *    axis (the step index of each surviving pair), not on the NaN-compacted
 *    pair index, so a gap no longer shortens a lag.
 *  - dtw-wass-04: the Sakoe-Chiba band is a number of time steps (default: the
 *    peak-match tolerance), not 10 % of the record; old project files migrate.
 *  - dtw-wass-05: mean |warp| has a tie rule (fewest warping moves, then the
 *    least total warp), so it does not depend on the direction of time or on
 *    floating-point noise.
 *  - dtw-wass-06 / compute-11 / claims-02 / samples-e2e-06: W1 equals the lag
 *    only for an event with zero flow at both ends of the record.
 *  - dtw-wass-07: W1 is blind to proportional volume error only.
 *  - dtw-wass-08: negative flow makes W1/W2^2 n/a with a note.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { computeAll, byId } from '../src/metrics/registry'
import { dtw, dtwOnTimeAxis, wasserstein1, wasserstein2sq } from '../src/metrics/timing/dtwWasserstein'
import { defaultView, defaultTimingConfig, clampTimingConfig, migrateDtwBand, dtwBandMax } from '../src/types'
import { perturb } from '../src/ui/compute'
import { parseProjectFile } from '../src/store/projectLoad'
import { useApp, serialiseProject } from '../src/store/store'
import { parseDelimited, stage } from '../src/ingest/ingest'

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

describe('dtw-wass-01 / claims-08: DTW at full resolution on long records', () => {
  const hy = csvCols('public/samples/sample_hymod_raven.csv')(2)
  const x: number[] = []
  for (let r = 0; r < 6; r++) x.push(...hy)

  it('an exact k-day lag keeps near-zero DTW distance and a warp of k on both sides of 6,000 pairs', () => {
    for (const n of [5999, 6001, 12000]) {
      for (const k of [1, 2]) {
        const o = x.slice(10, 10 + n), s = x.slice(10 - k, 10 - k + n)
        const out = computeAll(o, s, ctx(n))
        expect(out.extras.dtw!.decim, `n=${n}`).toBe(1)
        // the old 1/2 and 1/3 point samples read dtw_dist ~ MAE (0.96 vs 0.99)
        expect(out.values.dtw_dist, `n=${n} k=${k}`).toBeLessThan(0.02 * out.values.mae)
        expect(Math.abs(out.values.dtw_warp - k), `n=${n} k=${k}`).toBeLessThan(0.05)
      }
    }
  }, 60_000)

  it('every step counts: a simulation wrong on every other step has a non-zero DTW distance', () => {
    const n = 7000
    const o = Array.from({ length: n }, (_, i) => 20 + 10 * Math.sin(2 * Math.PI * i / 365) + 30 * Math.exp(-(((i % 90) - 45) ** 2) / 20))
    const s = o.map((v, i) => (i % 2 === 1 ? v + 25 : v))
    const out = computeAll(o, s, ctx(n))
    expect(out.values.mae).toBeCloseTo(12.5, 9)
    expect(out.values.dtw_dist).toBeGreaterThan(5)
    expect(out.notes.some(t => /decimation/.test(t))).toBe(false)
  }, 60_000)
})

describe('dtw-wass-02: W1, W2^2 and DTW on the time axis, not the compacted pair index', () => {
  const bump = (lag: number) => Array.from({ length: 200 }, (_, i) => 10 * Math.exp(-((i - lag - 100) ** 2) / 2))
  const o = bump(0), s = bump(10)
  const oGap = o.slice()
  for (let t = 103; t <= 107; t++) oGap[t] = NaN   // five missing observed days between the peaks

  it('a gap between the peaks does not shorten W1 or W2^2 (scipy reference on the same pairs)', () => {
    const out = computeAll(oGap, s, ctx(200))
    expect(out.n).toBe(195)
    // scipy.stats.wasserstein_distance(t, t, O, S) with t = surviving original indices
    expect(out.values.w1).toBeCloseTo(10.027803656428237, 8)
    // exact quantile-form W2^2 on the same support
    expect(out.values.w2sq).toBeCloseTo(100.58443263135946, 6)
    const clean = computeAll(o, s, ctx(200))
    expect(clean.values.w1).toBeCloseTo(10, 8)
    expect(clean.values.w2sq).toBeCloseTo(100, 6)
  })

  it('the DTW warp is measured in record steps and the band holds in record steps', () => {
    const band = 15
    for (const [x, y] of [[oGap, s], [s, oGap]]) {
      const gap = computeAll(x, y, ctx(200, { dtwBand: band }))
      const idx = gap.pairedIndex!
      let warp = 0, idxWarp = 0
      for (const [i, j] of gap.extras.dtw!.path) {
        const d = Math.abs(idx[i] - idx[j])
        expect(d).toBeLessThanOrEqual(band)
        warp += d; idxWarp += Math.abs(i - j)
      }
      expect(warp).not.toBe(idxWarp)   // the path does cross the gap off the diagonal
      expect(gap.values.dtw_warp).toBeCloseTo(warp / gap.extras.dtw!.path.length, 12)
    }
  })

  it('a gap inside a lagged record leaves the DTW warp close to the gap-free value', () => {
    const f = (t: number) => 5 + 3 * Math.sin(t / 7) + 2 * Math.sin(t / 23 + 1) + 0.02 * t
    const n = 300, k = 8
    const a = Array.from({ length: n }, (_, i) => f(i)), b = Array.from({ length: n }, (_, i) => f(i - k))
    const aGap = a.slice()
    for (let t = 150; t < 155; t++) aGap[t] = NaN
    const clean = computeAll(a, b, ctx(n, { dtwBand: 15 })), gap = computeAll(aGap, b, ctx(n, { dtwBand: 15 }))
    expect(Math.abs(gap.values.dtw_warp - clean.values.dtw_warp)).toBeLessThan(0.02 * clean.values.dtw_warp)
    expect(gap.notes.some(t => /longer than the DTW band/.test(t))).toBe(false)
    // a gap longer than the band pins the alignment, and the notes say so
    const aLong = a.slice()
    for (let t = 150; t < 170; t++) aLong[t] = NaN
    expect(computeAll(aLong, b, ctx(n, { dtwBand: 15 })).notes).toContain(
      '1 gap is longer than the DTW band (±15 steps); the DTW alignment cannot warp across it, so the pairs at its edges are aligned with zero warp.')
  })

  it('dtw() with a time axis: the band and the warp are differences of times, not of positions', () => {
    const t = [0, 1, 2, 3, 10, 11, 12, 13]
    const a = [0, 0, 0, 5, 0, 0, 0, 0], b = [0, 0, 0, 0, 5, 0, 0, 0]   // peaks 7 steps apart in time
    const narrow = dtw(a, b, 6, t), wide = dtw(a, b, 7, t)
    expect(narrow.distance).toBeGreaterThan(0)          // one position apart, but 7 steps: outside ±6
    expect(wide.distance).toBe(0)
    expect(wide.path).toContainEqual([3, 4])
    const w = wide.path.reduce((acc, [i, j]) => acc + Math.abs(t[i] - t[j]), 0) / wide.path.length
    expect(wide.meanAbsWarp).toBeCloseTo(w, 12)
    const byPosition = wide.path.reduce((acc, [i, j]) => acc + Math.abs(i - j), 0) / wide.path.length
    expect(wide.meanAbsWarp).toBeGreaterThan(byPosition)
  })
})

describe('dtw-wass-04: the DTW band is a number of time steps', () => {
  // the peak window follows Gauch et al. (2021): ±12 h hourly (audit events-05), ±3 daily
  it('the default band is the peak-match tolerance: 3 daily steps, 12 hourly steps', () => {
    const d = defaultTimingConfig(DAY, 10_000) as any, h = defaultTimingConfig(HOUR, 10_000) as any
    expect(d.dtwBand).toBe(3)
    expect(h.dtwBand).toBe(12)
    expect(d.dtwBand).toBe(d.peakMatchTolerance)
    expect(h.dtwBand).toBe(h.peakMatchTolerance)
    // never above 10 % of a very short record
    expect((defaultTimingConfig(DAY, 25) as any).dtwBand).toBe(2)
  })

  it('a perfectly timed biased or scaled run no longer reads tens of steps of warp', () => {
    const col = csvCols('public/samples/sample_synthetic.csv')
    const o = col(1), biased = col(3), n = o.length
    const scaled = o.map(v => 1.5 * v)
    for (const s of [biased, scaled]) {
      const out = computeAll(o, s, ctx(n))
      expect(out.extras.dtw!.band).toBe(3)
      // the old 10 % band (73 steps) read 23.2 and 32.3 steps
      expect(out.values.dtw_warp).toBeLessThanOrEqual(3)
    }
  })

  it('a band of one step is accepted and used', () => {
    const col = csvCols('public/samples/sample_synthetic.csv')
    const o = col(1), s = col(2)
    const out = computeAll(o, s, ctx(o.length, { dtwBand: 1 }))
    expect(out.extras.dtw!.band).toBe(1)
    expect(out.values.dtw_warp).toBeLessThanOrEqual(1)
  })
})

describe('dtw-wass-05: mean |warp| does not depend on tie-breaking', () => {
  // two triangular storms on zero flow; the simulation is 4 steps late
  const q = (lag: number) => Array.from({ length: 300 }, (_, i) =>
    Math.max(0, 10 - Math.abs(i - lag - 80)) + Math.max(0, 6 - Math.abs(i - lag - 200)))
  const o = q(0), s = q(4)

  it('reversing time leaves mean |warp| and the per-step distance unchanged', () => {
    for (const band of [5, 30]) {
      const f = computeAll(o, s, ctx(300, { dtwBand: band }))
      const r = computeAll([...o].reverse(), [...s].reverse(), ctx(300, { dtwBand: band }))
      expect(r.values.dtw_warp).toBeCloseTo(f.values.dtw_warp, 12)
      expect(r.values.dtw_dist).toBeCloseTo(f.values.dtw_dist, 12)
    }
  })

  it('a flow-unit change under the log transform (floating-point noise only) leaves mean |warp| unchanged', () => {
    // smooth daily hydrograph, 0.3..5.3 m3/s, simulation 3 days late; the old
    // tie-breaking read 1.981 steps in m3/s and 1.965 in L/s
    const h = (lag: number) => Array.from({ length: 365 }, (_, i) =>
      0.3 + 5 * Math.exp(-((i - lag - 150) ** 2) / 200) + 0.5 * Math.exp(-((i - lag - 60) ** 2) / 50))
    const ho = h(0), hs = h(3)
    for (const timing of [{}, { dtwBand: 36 }]) {
      const m3s = computeAll(ho, hs, ctx(365, timing, DAY, { transform: 'log' }))
      for (const f of [1000, 35.3147]) {
        const other = computeAll(ho.map(v => v * f), hs.map(v => v * f), ctx(365, timing, DAY, { transform: 'log' }))
        expect(other.values.dtw_warp).toBeCloseTo(m3s.values.dtw_warp, 9)
        expect(other.values.dtw_dist).toBeCloseTo(m3s.values.dtw_dist, 9)
      }
    }
  })
})

describe('dtw-wass-06 / compute-11 / claims-02 / samples-e2e-06: W1 equals the lag only for an event inside the record', () => {
  const pulse = (base: number, lag: number) => Array.from({ length: 200 }, (_, i) => base + 10 * Math.exp(-((i - lag - 100) ** 2) / 8))

  it('W1 = k and W2^2 = k^2 for an isolated event on zero flow; W1 = k x moving-mass share with baseflow', () => {
    for (const k of [1, 5, 10]) {
      expect(wasserstein1(pulse(0, 0), pulse(0, k))).toBeCloseTo(k, 9)
      expect(wasserstein2sq(pulse(0, 0), pulse(0, k))).toBeCloseTo(k * k, 6)
      const o = pulse(2, 0), s = pulse(2, k)
      const E = o.reduce((a, v) => a + v - 2, 0), M = o.reduce((a, v) => a + v, 0)
      expect(wasserstein1(o, s)).toBeCloseTo(k * E / M, 6)
      expect(wasserstein1(o, s)).toBeLessThan(k)
    }
  })

  it('the W1 and W2^2 tooltips state the condition instead of "equals the lag exactly"', () => {
    const w1 = byId.get('w1')!.blurb, w2 = byId.get('w2sq')!.blurb
    expect(w1).not.toMatch(/equals the lag exactly under a pure shift/)
    expect(w1).toMatch(/zero flow at both ends/)
    expect(w1).toMatch(/baseflow/)
    expect(w2).toMatch(/zero flow at both ends/)
  })
})

describe('dtw-wass-07: W1 is blind to proportional volume error only', () => {
  it('scaling is free, an additive bias costs transport', () => {
    const col = csvCols('public/samples/sample_synthetic.csv')
    const o = col(1), biased = col(3)
    expect(computeAll(o, o.map(v => 1.5 * v), ctx(o.length)).values.w1).toBeLessThan(1e-9)
    expect(computeAll(o, biased, ctx(o.length)).values.w1).toBeGreaterThan(1)
  })
  it('the tooltip no longer claims W1 is volume-blind', () => {
    const w1 = byId.get('w1')!.blurb
    expect(w1).not.toMatch(/volume-blind/)
    expect(w1).toMatch(/proportional/)
    expect(w1).toMatch(/additive/)
  })
})

describe('dtw-wass-08: negative flow makes W1/W2^2 n/a with a note', () => {
  it('one negative simulated value', () => {
    const col = csvCols('public/samples/sample_synthetic.csv')
    const o = col(1), s = col(2).slice()
    s[400] = -0.001
    const out = computeAll(o, s, ctx(o.length))
    expect(Number.isNaN(out.values.w1)).toBe(true)
    expect(Number.isNaN(out.values.w2sq)).toBe(true)
    expect(out.notes.some(t => /W₁ and W₂²/.test(t) && /1 negative value/.test(t) && /simulat/.test(t))).toBe(true)
  })
  it('a Sandbox negative offset', () => {
    const o = Array.from({ length: 365 }, (_, i) => 2 + 8 * Math.exp(-(((i % 60) - 30) ** 2) / 30))
    const s = perturb(o, { mode: 'perturb', targetRunId: null, shiftSteps: 3, offset: -3, scale: 1, dampen: 0, noiseAmp: 0, noiseKind: 'uniform', noiseSeed: 1 } as any)
    const out = computeAll(o, s, ctx(365))
    expect(Number.isNaN(out.values.w1)).toBe(true)
    expect(out.notes.some(t => /W₁ and W₂²/.test(t) && /negative/.test(t))).toBe(true)
  })
  it('the tooltip states the non-negativity requirement', () => {
    expect(byId.get('w1')!.blurb).toMatch(/non-negative/)
  })
})

describe('dtw() keeps its contract', () => {
  it('a pure shift of an isolated storm reads the full lag where the hydrograph has shape', () => {
    const o = Array.from({ length: 120 }, (_, i) => 1 + 10 * Math.exp(-((i - 60) ** 2) / 50) + 0.01 * i)
    const s = Array.from({ length: 120 }, (_, i) => 1 + 10 * Math.exp(-((i - 64) ** 2) / 50) + 0.01 * (i - 4))
    const r = dtw(o, s, 6)
    expect(r.band).toBe(6)
    for (const [i, j] of r.path) expect(Math.abs(i - j)).toBeLessThanOrEqual(6)
  })
})

describe('dtw-wass-01: block-average fallback above the cell budget', () => {
  const n = 4000
  const o = Array.from({ length: n }, (_, i) => 20 + 10 * Math.sin(i / 11) + 30 * Math.exp(-(((i % 90) - 45) ** 2) / 20))
  const t = Array.from({ length: n }, (_, i) => i)
  it('averages blocks, never point-samples: a simulation wrong on every other step still counts', () => {
    const s = o.map((v, i) => (i % 2 === 1 ? v + 25 : v))
    const r = dtwOnTimeAxis(o, s, t, 10, 20_000)
    expect(r.decim).toBeGreaterThan(1)
    expect(r.normalized).toBeGreaterThan(5)
  })
  it('a pure shift keeps its warp in native steps, to the block resolution', () => {
    const k = 6
    const f = (i: number) => 20 + 10 * Math.sin(i / 11) + 30 * Math.exp(-(((i % 90) - 45) ** 2) / 20)
    const a = t.map(f), b = t.map(i => f(i - k))
    const full = dtwOnTimeAxis(a, b, t, 10)
    const blk = dtwOnTimeAxis(a, b, t, 10, 20_000)
    expect(full.decim).toBe(1)
    expect(blk.decim).toBe(3)             // 1,334 blocks x 9 cells fit 20,000; blocks of 2 do not
    expect(blk.bandSteps).toBe(12)        // the band rounded up to whole blocks
    expect(blk.band * blk.decim).toBe(blk.bandSteps)
    expect(Math.abs(blk.meanAbsWarp - full.meanAbsWarp)).toBeLessThanOrEqual(blk.decim / 2)
    expect(full.meanAbsWarp).toBeGreaterThan(k - 0.5)
  })
})

describe('dtw-wass-04: band range and old project files', () => {
  const DAYS = 40
  const csv = () => {
    const rows = ['date,observed,sim1']
    for (let i = 0; i < DAYS; i++) rows.push(`${new Date(Date.UTC(2001, 0, 1) + i * DAY).toISOString().slice(0, 10)},${(5 + 3 * Math.sin(i / 6)).toFixed(3)},${(5 + 3 * Math.sin((i - 1) / 6)).toFixed(3)}`)
    return rows.join('\n')
  }
  const projectWith = (patch: (tc: any) => void) => {
    useApp.getState().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null })
    useApp.getState().commitDataset(stage(parseDelimited(csv()), { name: 'old', roles: ['date', 'observed', 'run'], dateFormat: 'auto', unit: 'm3s', missingValue: null }).commit!)
    const raw = JSON.parse(serialiseProject(useApp.getState().project))
    patch(raw.datasets[0].view.timingConfig)
    return parseProjectFile(JSON.stringify(raw))
  }
  it('the band range is 1 step to 10 % of n', () => {
    expect(dtwBandMax(40)).toBe(4)
    expect(dtwBandMax(5)).toBe(1)
    const base = defaultTimingConfig(DAY, 40)
    expect(clampTimingConfig({ ...base, dtwBand: 0 }, base, 40).config.dtwBand).toBe(1)
    expect(clampTimingConfig({ ...base, dtwBand: 50 }, base, 40).config.dtwBand).toBe(4)
    expect(clampTimingConfig({ ...base, dtwBand: 2.6 }, base, 40).config.dtwBand).toBe(3)
  })
  it('a saved project keeps its band in steps', () => {
    const { project, warnings } = projectWith(tc => { tc.dtwBand = 2 })
    expect(project.datasets[0].view.timingConfig.dtwBand).toBe(2)
    expect(warnings).toEqual([])
  })
  it('an old file with a custom fraction is converted to steps with a note', () => {
    const { project, warnings } = projectWith(tc => { delete tc.dtwBand; tc.dtwBandFraction = 0.05 })
    expect(project.datasets[0].view.timingConfig.dtwBand).toBe(2)
    expect('dtwBandFraction' in project.datasets[0].view.timingConfig).toBe(false)
    expect(warnings).toEqual(['dataset "old": the DTW band of 5% of the record was converted to 2 time steps'])
  })
  it('a fraction above 10 % is capped, with the cap named', () => {
    const { project, warnings } = projectWith(tc => { delete tc.dtwBand; tc.dtwBandFraction = 0.5 })
    expect(project.datasets[0].view.timingConfig.dtwBand).toBe(4)
    expect(warnings).toEqual(['dataset "old": the DTW band of 50% of the record was converted to 4 time steps (the band is limited to 10% of the record)'])
  })
  it('the old default of 10 % becomes the new default band, with a note', () => {
    const { project, warnings } = projectWith(tc => { delete tc.dtwBand; tc.dtwBandFraction = 0.1 })
    expect(project.datasets[0].view.timingConfig).toEqual(defaultTimingConfig(DAY, DAYS))
    expect(warnings).toEqual(['dataset "old": the DTW band was the old default of 10% of the record; the band is now set in time steps, and the default of 3 steps (the peak window) is used'])
  })
  it('an unreadable fraction falls back to the default and never fails the load', () => {
    for (const bad of ['x', null, -0.2, 0]) {
      const { project, warnings } = projectWith(tc => { delete tc.dtwBand; tc.dtwBandFraction = bad })
      expect(project.datasets[0].view.timingConfig.dtwBand).toBe(3)
      expect(warnings).toEqual(['dataset "old": the DTW band in the file was not a valid fraction of the record; the default of 3 steps is used'])
    }
  })
  it('migrateDtwBand leaves a current config untouched', () => {
    const base = defaultTimingConfig(DAY, 40)
    expect(migrateDtwBand({ ...base }, 40, base)).toEqual({ raw: { ...base }, note: null })
  })
})
