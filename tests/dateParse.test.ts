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
})
