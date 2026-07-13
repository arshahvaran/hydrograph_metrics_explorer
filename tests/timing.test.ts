import { describe, it, expect } from 'vitest'
import fixture from './fixtures/reference_vectors.json'
import { applyNanPolicy } from '../src/ingest/missing'
import { diagnosticEfficiency, seriesDistance } from '../src/metrics/timing/deSd'
import { dtw, wasserstein1, wasserstein2sq } from '../src/metrics/timing/dtwWasserstein'
import { peakTiming, eventErrors, lagSweep } from '../src/metrics/timing/events'
import { xwtLag } from '../src/metrics/timing/xwt'

const F = fixture as any
const num = (v: string | number) => (typeof v === 'number' ? v : Number(v))
const series = (name: string) => {
  const s = F.series[name]
  const parse = (a: string[]) => a.map((v: string) => (v === 'NaN' ? NaN : Number(v)))
  const p = applyNanPolicy(parse(s.obs), parse(s.sim), 'pairwise')
  return { o: p.obs, s: p.sim }
}
const close = (a: number, b: number, tol = 1e-8) =>
  expect(Math.abs(a - b)).toBeLessThanOrEqual(tol * Math.max(1, Math.abs(b)))

describe('Diagnostic Efficiency vs executed diag-eff 1.1 (all fixture series)', () => {
  const CASES = ['tiny6', 'nan8', 'synth730_shift3', 'synth730_offset', 'synth730_scale', 'synth730_dampen', 'synth730_noise', 'synth730_combo']
  for (const name of CASES) {
    it(name, () => {
      const { o, s } = series(name)
      const ref = F.results[name]['diag_eff_1.1']
      const mine = diagnosticEfficiency(o, s)
      close(mine.brelMean, num(ref['brel_mean(constant)']))
      close(mine.bArea, num(ref['bias_area(dynamic)']))
      close(mine.temporalR, num(ref['temp_cor(timing)']))
      close(mine.de, num(ref.de))
      close(mine.phiFdc, num(ref.phi), 1e-6) // fixture pins the direction-less arctan2(B̄rel, Barea) form
    })
  }
  it('behavioural pins from the plan: pure shift loads timing only; offset loads the constant term', () => {
    const sh = series('synth730_shift3'); const off = series('synth730_offset')
    const dSh = diagnosticEfficiency(sh.o, sh.s)
    expect(dSh.brelMean).toBe(0); expect(dSh.bArea).toBe(0)
    close(dSh.de, 1 - dSh.temporalR, 1e-9)
    const dOff = diagnosticEfficiency(off.o, off.s)
    expect(Math.abs(dOff.brelMean)).toBeGreaterThan(0.1)
    expect(dOff.temporalR).toBeGreaterThan(0.999999)
  })
})

// ---- analytic pure-shift identities (the double-penalty story, in exact numbers) ----
function pulseSeries(n = 400, k = 5) {
  const obs = new Float64Array(n)
  for (const c of [80, 200, 320]) {
    for (let t = 0; t < n; t++) obs[t] += 10 * Math.exp(-((t - c) ** 2) / (2 * 8 ** 2))
  }
  for (let t = 0; t < n; t++) if (obs[t] < 1e-6) obs[t] = 0
  const sim = new Float64Array(n)
  for (let t = 0; t < n; t++) sim[t] = t - k >= 0 ? obs[t - k] : 0
  return { obs, sim, k }
}

describe('pure +k shift identities', () => {
  const { obs, sim, k } = pulseSeries()

  it(`Wasserstein: W₁ = k and W₂² = k² exactly`, () => {
    close(wasserstein1(obs, sim), k, 1e-10)
    close(wasserstein2sq(obs, sim), k * k, 1e-10)
  })
  it('W is volume-blind: doubling sim mass changes nothing', () => {
    const sim2 = Float64Array.from(sim, v => 2 * v)
    close(wasserstein1(obs, sim2), k, 1e-10)
  })
  it(`DTW: zero residual distance after warping; mean |warp| ≈ k`, () => {
    const res = dtw(obs, sim, 0.1)
    expect(res.distance).toBeLessThan(1e-9)
    expect(res.meanAbsWarp).toBeGreaterThan(k - 1)
    expect(res.meanAbsWarp).toBeLessThanOrEqual(k)
  })
  it(`Gauch peak timing: three prominent peaks, mean |lag| = mean signed lag = k`, () => {
    const pt = peakTiming(obs, sim, { prominence: 'auto', minDistance: 100, window: 15 })
    expect(pt.peaks.length).toBe(3)
    close(pt.meanAbsLag, k, 1e-12)
    close(pt.meanSignedLag, k, 1e-12)
  })
  it(`events: threat = 1, median peak lag = k, volume error small`, () => {
    const ev = eventErrors(obs, sim, { thresholdKind: 'percentile', thresholdValue: 90, minDistance: 20, warmup: 0 }, 15)
    expect(ev.threat).toBe(1)
    close(ev.medianPeakLag, k, 1e-12)
    expect(Math.abs(ev.meanVolumeErrPct)).toBeLessThan(20)
  })
  it(`Series Distance: occurrence 1, mean timing ≈ k, amplitude ≈ 0`, () => {
    const sd = seriesDistance(obs, sim, { thresholdKind: 'percentile', thresholdValue: 90, minDistance: 20, warmup: 0 }, 15)
    expect(sd.occurrence).toBe(1)
    expect(Math.abs(sd.meanTimingErr - k)).toBeLessThan(1)
    expect(Math.abs(sd.meanAmplitudeErrPct)).toBeLessThan(8)
  })
  it(`lag sweep: argmax at +k with NSE exactly 1`, () => {
    const sw = lagSweep(obs, sim)
    expect(sw.bestLag).toBe(k)
    const at = sw.rows.find(r => r.lag === k)!
    close(at.nse, 1, 1e-12)
    close(at.w1, 0, 1e-9)
  })
  it('XWT: phase lag recovers +k on a periodic signal (sign convention pin)', () => {
    const n = 512, kk = 4
    const o = new Float64Array(n), s = new Float64Array(n)
    for (let t = 0; t < n; t++) {
      o[t] = Math.sin((2 * Math.PI * t) / 32)
      s[t] = Math.sin((2 * Math.PI * (t - kk)) / 32)
    }
    const x = xwtLag(o, s)
    expect(x.fracSignificant).toBeGreaterThan(0.02)
    expect(Math.abs(x.headlineLag - kk)).toBeLessThan(0.5)
  })
})

describe('fixture lag-sweep truth also holds for the module (incl. W₁ shape)', () => {
  it('synth730_shift3: bestLag = 3 and W₁ is minimal there', () => {
    const { o, s } = series('synth730_shift3')
    const sw = lagSweep(o, s)
    expect(sw.bestLag).toBe(3)
    const w1AtBest = sw.rows.find(r => r.lag === 3)!.w1
    for (const row of sw.rows) expect(w1AtBest).toBeLessThanOrEqual(row.w1 + 1e-12)
  })
})
