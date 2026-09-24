/**
 * Plots tab, time series and DTW alignment: dates absent from the frame (a
 * season join, dates skipped in the file) break the line, and the derivative
 * and the moving average do not reach across them (follow-up to the
 * resample-subset repair, which leaves out-of-season rows out of the frame).
 */
import { describe, it, expect } from 'vitest'
import { segmentStarts, breakAtGaps, applyMode } from '../src/ui/PlotsTab'

const DAY = 86_400_000
const d = (k: number) => Date.UTC(2001, 0, 1) + k * DAY

describe('segmentStarts', () => {
  it('a new run starts after absent dates, not after a blank value', () => {
    // days 0-3, then 10-12 (days 4-9 absent)
    const dates = [0, 1, 2, 3, 10, 11, 12].map(d)
    expect(segmentStarts(dates)).toEqual([true, false, false, false, true, false, false])
  })
  it('complete regular dates are one run', () => {
    expect(segmentStarts([0, 1, 2, 3].map(d))).toEqual([true, false, false, false])
  })
  it('monthly dates: a skipped month starts a run, month lengths do not', () => {
    const m = [0, 1, 2, 4, 5].map(k => Date.UTC(2001, k, 1))
    expect(segmentStarts(m)).toEqual([true, false, false, true, false])
  })
})

describe('breakAtGaps', () => {
  it('puts one blank point before each later run start', () => {
    const x = ['a', 'b', 'c', 'd'], y = [1, 2, 3, 4]
    expect(breakAtGaps(x, y, [true, false, true, false])).toEqual({ x: ['a', 'b', 'c', 'c', 'd'], y: [1, 2, null, 3, 4] })
  })
  it('returns the arrays unchanged when there is no gap', () => {
    const x = ['a', 'b'], y = [1, 2]
    const r = breakAtGaps(x, y, [true, false])
    expect(r.x).toBe(x)
    expect(r.y).toBe(y)
  })
})

describe('applyMode across absent dates', () => {
  const starts = [true, false, false, true, false]
  const y = [1, 2, 3, 100, 101]
  it('the derivative has no value at the first step after the gap (was 97)', () => {
    expect(applyMode(y, 'derivative', null, starts)).toEqual([null, 1, 1, null, 1])
    expect(applyMode(y, 'derivative', null)).toEqual([null, 1, 1, 97, 1])   // without run starts, as before
  })
  it('the trailing moving average restarts after the gap', () => {
    expect(applyMode(y, 'none', 3, starts)).toEqual([1, 1.5, 2, 100, 100.5])
  })
  it('cumulative and departure-from-mean modes are unchanged', () => {
    expect(applyMode(y, 'cumulative', null, starts)).toEqual([1, 3, 6, 106, 207])
    expect(applyMode(y, 'fromMean', null, starts)).toEqual(applyMode(y, 'fromMean', null))
  })
})
