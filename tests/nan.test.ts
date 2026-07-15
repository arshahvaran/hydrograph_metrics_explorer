import { describe, it, expect } from 'vitest'
import fixture from './fixtures/reference_vectors.json'
import { applyNanPolicy, parseValue } from '../src/ingest/missing'

const parse = (a: string[]) => a.map(v => (v === 'NaN' ? NaN : Number(v)))

describe('NaN handling', () => {
  it('pairwise-drop matches the HydroErr-pinned semantics on nan8 (pairs 0,3,4,5)', () => {
    const s = (fixture as any).series.nan8
    const p = applyNanPolicy(parse(s.obs), parse(s.sim), 'pairwise')
    expect(p.index).toEqual([0, 3, 4, 5])
    expect(p.n).toBe(4)
    expect((fixture as any).results.nan8.note).toContain('0,3,4,5')
  })
  it('zero policy substitutes 0; mean policy substitutes the series mean', () => {
    const obs = [1, NaN, 3], sim = [NaN, 2, 4]
    const z = applyNanPolicy(obs, sim, 'zero')
    expect(Array.from(z.obs)).toEqual([1, 0, 3])
    expect(Array.from(z.sim)).toEqual([0, 2, 4])
    const m = applyNanPolicy(obs, sim, 'mean')
    expect(m.obs[1]).toBeCloseTo(2, 12)   // mean(1,3)
    expect(m.sim[0]).toBeCloseTo(3, 12)   // mean(2,4)
  })
  it('missing tokens and declared missing values parse to NaN; thousands separators tolerated', () => {
    expect(parseValue('')).toBeNaN()
    expect(parseValue('NA')).toBeNaN()
    expect(parseValue('---')).toBeNaN()
    expect(parseValue('-9999', { missingValue: -9999 })).toBeNaN()
    expect(parseValue('-999', { missingValue: -999 })).toBeNaN()
    expect(parseValue('-999', { missingValue: null })).toBe(-999)
    expect(parseValue('1,234.5')).toBe(1234.5)
  })
})
