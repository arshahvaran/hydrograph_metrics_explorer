/**
 * Calendar-aware step detection (audit findings units-02, units-05, units-08).
 * A record is '1mo' only when consecutive dates are whole calendar months
 * apart; missing months are missing rows, not irregularity. Fixed 28- and
 * 30-day steps are not months. A sustained run of a coarser spacing inside a
 * finer record is a second sampling regime and is flagged irregular.
 */
import { describe, it, expect } from 'vitest'
import { detectStep } from '../src/units/stepDetect'
import { convertSeries } from '../src/units/convert'

const H = 3600_000, D = 24 * H

describe('units-02: calendar-monthly detection survives missing months', () => {
  it('36 month starts with 5 months dropped are 1mo, and February converts with 28 days', () => {
    const all = Array.from({ length: 36 }, (_, i) => Date.UTC(2018 + Math.floor(i / 12), i % 12, 1))
    const drop = new Set([4, 11, 17, 25, 30])
    const dates = all.filter((_, i) => !drop.has(i))
    const info = detectStep(dates)
    expect(info).toEqual({ ms: 30 * D, label: '1mo', irregular: false, monthly: true })
    const q = convertSeries(dates.map(() => 28), { from: 'mm_step', to: 'm3s', area: { value: 100, unit: 'km2' }, stepMs: info.ms, monthly: info.monthly, dates })
    expect(q[dates.indexOf(Date.UTC(2019, 1, 1))]).toBeCloseTo(28 * 100 * 1000 / (28 * 86400), 9)
  })

  it('a Jan-Apr monthly subset of several years (one long gap per year) is 1mo', () => {
    const dates: number[] = []
    for (let y = 2010; y < 2015; y++) for (let m = 0; m < 4; m++) dates.push(Date.UTC(y, m, 1))
    expect(detectStep(dates).label).toBe('1mo')
  })

  it('month-end stamps are calendar months', () => {
    const dates = Array.from({ length: 24 }, (_, i) => Date.UTC(2020, i + 1, 0))
    expect(detectStep(dates).label).toBe('1mo')
  })

  it('annual data (whole months apart, but 12 of them) is not monthly', () => {
    const dates = Array.from({ length: 10 }, (_, i) => Date.UTC(2000 + i, 0, 1))
    expect(detectStep(dates).monthly).toBe(false)
  })
})

describe('units-05: fixed 28-day and 30-day steps are not calendar months', () => {
  it('28-day step', () => {
    const s28 = Array.from({ length: 26 }, (_, i) => Date.UTC(2021, 0, 1) + i * 28 * D)
    expect(detectStep(s28)).toEqual({ ms: 28 * D, label: '28d', irregular: false, monthly: false })
  })
  it('30-day step converts with a constant 30-day interval', () => {
    const s30 = Array.from({ length: 24 }, (_, i) => Date.UTC(2021, 0, 1) + i * 30 * D)
    const info = detectStep(s30)
    expect(info).toEqual({ ms: 30 * D, label: '30d', irregular: false, monthly: false })
    const q = convertSeries(s30.map(() => 30), { from: 'mm_step', to: 'm3s', area: { value: 100, unit: 'km2' }, stepMs: info.ms, monthly: info.monthly, dates: s30 })
    for (const v of q) expect(v).toBeCloseTo(30 * 100 * 1000 / (30 * 86400), 9)
  })
})

describe('units-08: a change of sampling resolution is flagged irregular', () => {
  it('200 daily rows followed by 2400 hourly rows', () => {
    const daily = Array.from({ length: 200 }, (_, i) => Date.UTC(2019, 0, 1) + i * D)
    const t0 = daily[daily.length - 1] + D
    const hourly = Array.from({ length: 2400 }, (_, i) => t0 + i * H)
    const info = detectStep([...daily, ...hourly])
    expect(info.label).toBe('1h')
    expect(info.irregular).toBe(true)
  })
  it('isolated gaps, even several of the same length, are still missing rows', () => {
    const d: number[] = []
    let t = Date.UTC(2020, 0, 1)
    for (let i = 0; i < 300; i++) { d.push(t); t += (i % 50 === 49 ? 3 : 1) * D }
    expect(detectStep(d)).toEqual({ ms: D, label: '1d', irregular: false, monthly: false })
  })
})
