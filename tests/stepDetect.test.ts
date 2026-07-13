import { describe, it, expect } from 'vitest'
import { detectStep } from '../src/units/stepDetect'

const DAY = 86400_000, HOUR = 3600_000
const seq = (n: number, step: number, start = Date.UTC(2020, 0, 1)) =>
  Array.from({ length: n }, (_, i) => start + i * step)

describe('time-step detection (§6.0)', () => {
  it('daily, tolerating a gap (missing rows are not irregularity)', () => {
    const d = [...seq(10, DAY), ...seq(10, DAY, Date.UTC(2020, 0, 13))]
    const s = detectStep(d)
    expect(s.label).toBe('1d'); expect(s.ms).toBe(DAY); expect(s.irregular).toBe(false)
  })
  it('hourly and six-hourly', () => {
    expect(detectStep(seq(48, HOUR)).label).toBe('1h')
    expect(detectStep(seq(48, 6 * HOUR)).label).toBe('6h')
  })
  it('calendar-monthly', () => {
    const d = Array.from({ length: 24 }, (_, i) => Date.UTC(2020 + Math.floor(i / 12), i % 12, 1))
    const s = detectStep(d)
    expect(s.label).toBe('1mo'); expect(s.monthly).toBe(true)
  })
  it('flags genuinely irregular spacing', () => {
    const d = [0, 1.3, 2.9, 4.1, 5.8, 7.7].map(x => Date.UTC(2020, 0, 1) + Math.round(x * DAY / 1.0))
    expect(detectStep(d).irregular).toBe(true)
  })
})
