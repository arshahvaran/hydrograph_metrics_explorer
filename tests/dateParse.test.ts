import { describe, it, expect } from 'vitest'
import { parseDates } from '../src/ingest/dateParse'

describe('date parsing (§6.0)', () => {
  it('ISO and datetime', () => {
    const p = parseDates(['2023-01-05', '2023-01-06 12:30'])
    expect(p.used).toBe('iso'); expect(p.failures).toBe(0)
    expect(p.ms[0]).toBe(Date.UTC(2023, 0, 5))
    expect(p.ms[1]).toBe(Date.UTC(2023, 0, 6, 12, 30))
  })
  it('infers DMY when a leading value exceeds 12', () => {
    const p = parseDates(['13/01/2023', '14/01/2023'])
    expect(p.used).toBe('dmy'); expect(p.ambiguous).toBe(false)
    expect(p.ms[0]).toBe(Date.UTC(2023, 0, 13))
  })
  it('infers MDY when a second value exceeds 12', () => {
    const p = parseDates(['01/13/2023'])
    expect(p.used).toBe('mdy'); expect(p.ms[0]).toBe(Date.UTC(2023, 0, 13))
  })
  it('flags ambiguous day/month order for the UI to force a choice', () => {
    const p = parseDates(['01/02/2023', '03/04/2023'])
    expect(p.ambiguous).toBe(true)
  })
  it('Julian ordinal dates', () => {
    const p = parseDates(['2023-045', '2023046'])
    expect(p.used).toBe('julian'); expect(p.failures).toBe(0)
    expect(p.ms[0]).toBe(Date.UTC(2023, 1, 14))
    expect(p.ms[1]).toBe(Date.UTC(2023, 1, 15))
    expect(parseDates(['2023-366'], 'julian').failures).toBe(1) // 2023 is not a leap year
  })
  it('forced formats override inference and invalid dates fail cleanly', () => {
    expect(parseDates(['01/02/2023'], 'dmy').ms[0]).toBe(Date.UTC(2023, 1, 1))
    expect(parseDates(['01/02/2023'], 'mdy').ms[0]).toBe(Date.UTC(2023, 0, 2))
    expect(parseDates(['2023-13-01']).failures).toBe(1)
  })
  it('two-digit years follow the POSIX pivot: 00-68 read as 2000s, 69-99 as 1900s', () => {
    expect(parseDates(['12/31/68']).ms[0]).toBe(Date.UTC(2068, 11, 31))   // mdy inferred (31 > 12)
    expect(parseDates(['31/12/69']).ms[0]).toBe(Date.UTC(1969, 11, 31))   // dmy inferred
    expect(parseDates(['05/03/99'], 'dmy').ms[0]).toBe(Date.UTC(1999, 2, 5))
    expect(parseDates(['05/03/00'], 'mdy').ms[0]).toBe(Date.UTC(2000, 4, 3))
    expect(parseDates(['99-01-05'], 'ymd').ms[0]).toBe(Date.UTC(1999, 0, 5))
  })
  it('month-name dates parse unambiguously in auto mode', () => {
    const p = parseDates(['01-Jan-2020', 'Jan 2, 2020', '3 February 2020', 'sep 4 1999'])
    expect(p.used).toBe('month-name')
    expect(p.ambiguous).toBe(false)
    expect(p.failures).toBe(0)
    expect(p.ms[0]).toBe(Date.UTC(2020, 0, 1))
    expect(p.ms[1]).toBe(Date.UTC(2020, 0, 2))
    expect(p.ms[2]).toBe(Date.UTC(2020, 1, 3))
    expect(p.ms[3]).toBe(Date.UTC(1999, 8, 4))
  })
  it('month-name edge cases: two-digit year, time part, unknown month, ISO mixture', () => {
    expect(parseDates(['01-Jan-20']).ms[0]).toBe(Date.UTC(2020, 0, 1))
    expect(parseDates(['02-Mar-2020 06:30']).ms[0]).toBe(Date.UTC(2020, 2, 2, 6, 30))
    expect(parseDates(['01-Foo-2020']).failures).toBe(1)
    expect(parseDates(['2020-01-02', 'Jan 3, 2020']).used).toBe('mixed')
    expect(parseDates(['30-Feb-2020']).failures).toBe(1)  // rollover still rejected
    expect(parseDates(['May-2020']).failures).toBe(1)     // month-year label is not a date
  })
})
