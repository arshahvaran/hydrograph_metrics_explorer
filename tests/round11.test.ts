/**
 * Round 11 ingest regressions:
 *  - a fresh upload (all roles = Ignore, the deliberate default) stages with a
 *    single guidance message and NO blocking errors; genuine data problems
 *    still surface as errors;
 *  - pipe- and semicolon-delimited files are sniffed;
 *  - the lazily loaded spreadsheet reader fails with an actionable
 *    reload-the-page message when its chunk cannot be fetched (stale deploy).
 * Two-digit-year and month-name date parsing live in dateParse.test.ts.
 */
import { describe, it, expect, vi } from 'vitest'
import { parseDelimited, parseWorkbook, stage } from '../src/ingest/ingest'

// Simulate the chunk-load failure of a stale deployment: the dynamic
// import('xlsx') inside parseWorkbook must reject.
vi.mock('xlsx', () => {
  throw new Error('Failed to fetch dynamically imported module: /assets/xlsx-BpR1x.js')
})

const CSV = 'date,observed,sim\n2001-01-01,1,2\n2001-01-02,2,3\n2001-01-03,3,4'
const opts = { name: 'u', unit: 'm3s' as const, dateFormat: 'auto' as const, missingValue: null }

describe('upload staging: unmapped roles are guidance, not errors', () => {
  it('all-Ignore stages with one guidance message and zero errors', () => {
    const st = stage(parseDelimited(CSV), { ...opts, roles: ['ignore', 'ignore', 'ignore'] })
    expect(st.validation.errors).toEqual([])
    expect(st.commit).toBeNull()
    expect(st.guidance).toMatch(/assign one Date column, one Observed column and at least one Simulated column\.$/)
  })
  it('partially mapped: guidance lists only the remaining roles', () => {
    const st = stage(parseDelimited(CSV), { ...opts, roles: ['date', 'ignore', 'ignore'] })
    expect(st.validation.errors).toEqual([])
    expect(st.guidance).toMatch(/one Observed column and at least one Simulated column\.$/)
    expect(st.guidance).not.toMatch(/one Date column/)
    const st2 = stage(parseDelimited(CSV), { ...opts, roles: ['date', 'observed', 'ignore'] })
    expect(st2.guidance).toMatch(/assign at least one Simulated column\.$/)
  })
  it('an unmapped Date column raises no phantom date-parse error', () => {
    const st = stage(parseDelimited(CSV), { ...opts, roles: ['ignore', 'observed', 'run'] })
    expect(st.validation.errors).toEqual([])
    expect(st.guidance).toMatch(/assign one Date column\.$/)
  })
  it('fully mapped: no guidance, commit ready', () => {
    const st = stage(parseDelimited(CSV), { ...opts, roles: ['date', 'observed', 'run'] })
    expect(st.guidance).toBeNull()
    expect(st.validation.errors).toEqual([])
    expect(st.commit).toBeTruthy()
  })
  it('genuine problems still surface as red errors once the role exists', () => {
    const bad = 'date,observed,sim\nnot-a-date,1,2\nalso-bad,2,3'
    const st = stage(parseDelimited(bad), { ...opts, roles: ['date', 'observed', 'run'] })
    expect(st.validation.errors.join(' ')).toMatch(/could not be parsed/)
    expect(st.commit).toBeNull()
  })
})

describe('delimiter sniffing: pipe and semicolon', () => {
  it('pipe-delimited files parse into columns', () => {
    const t = parseDelimited('date|observed|sim\n2001-01-01|1|2\n2001-01-02|2|3')
    expect(t.header).toEqual(['date', 'observed', 'sim'])
    expect(t.rows).toEqual([['2001-01-01', '1', '2'], ['2001-01-02', '2', '3']])
  })
  it('semicolon-delimited files with decimal commas stage to correct numbers', () => {
    const t = parseDelimited('date;observed;sim\n2001-01-01;3,5;2,5\n2001-01-02;4,5;3,5')
    expect(t.header).toEqual(['date', 'observed', 'sim'])
    const st = stage(t, { ...opts, roles: ['date', 'observed', 'run'] })
    expect(Array.from(st.commit!.observed.values as ArrayLike<number>)).toEqual([3.5, 4.5])
    expect(Array.from(st.commit!.runs[0].values as ArrayLike<number>)).toEqual([2.5, 3.5])
  })
})

describe('stale-deployment failure of the lazy spreadsheet reader', () => {
  it('surfaces an actionable reload message instead of a raw chunk error', async () => {
    await expect(parseWorkbook(new ArrayBuffer(8))).rejects.toThrow(/Reload the page and upload the file again/)
  })
})
