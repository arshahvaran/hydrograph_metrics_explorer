/**
 * Rendered benchmark-skill rows of the Metrics tab (design rule D4). Each case
 * failed before the fix:
 *  - default benchmark (mean): "KGE skill vs mean" showed n/a for every dataset
 *    (compute-06, eff-04, report-06, samples-e2e-05);
 *  - persistence + inverse transform: the benchmark was scored on raw flows
 *    while the model was scored on inverse flows (compute-05, eff-02,
 *    report-01, samples-e2e-04);
 *  - climatology with a simulation that has gaps: the benchmark was scored on
 *    every observed step, the model on its pairs only (compute-09, eff-03).
 * Expected values come from plain loops in this file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { useApp } from '../../src/store/store'
import { stage, parseDelimited } from '../../src/ingest/ingest'
import { __resetComputeCachesForTests } from '../../src/ui/compute'
import { MetricsTab } from '../../src/ui/MetricsTab'
import { fmtNum } from '../../src/ui/format'

beforeEach(() => {
  __resetComputeCachesForTests()
  useApp.getState().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null })
})
afterEach(() => cleanup())

const DAY = 86_400_000
const N = 730
const obsAt = (i: number) => Number((20 + 15 * Math.sin((2 * Math.PI * i) / 365) + 30 * Math.exp(-(((i % 40) - 15) ** 2) / 6)).toFixed(3))
const simAt = (i: number) => Number((18 + 14 * Math.sin((2 * Math.PI * i) / 365) + 28 * Math.exp(-(((i % 40) - 16) ** 2) / 7)).toFixed(3))
const gap = (i: number) => i < 90 || (i >= 400 && i < 430)

function commit(withGaps: boolean) {
  const rows = ['date,observed,modelA']
  for (let i = 0; i < N; i++) {
    const d = new Date(Date.UTC(2003, 0, 1) + i * DAY).toISOString().slice(0, 10)
    rows.push(`${d},${obsAt(i)},${withGaps && gap(i) ? '' : simAt(i)}`)
  }
  useApp.getState().commitDataset(stage(parseDelimited(rows.join('\n')), {
    name: 'bench', unit: 'm3s', dateFormat: 'auto', missingValue: null, roles: ['date', 'observed', 'run'],
  }).commit!)
}

const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length
const sd = (a: number[]) => { const m = avg(a); return Math.sqrt(avg(a.map(v => (v - m) ** 2))) }
const nseRef = (o: number[], s: number[]) => { const m = avg(o); let a = 0, b = 0; o.forEach((v, i) => { a += (s[i] - v) ** 2; b += (v - m) ** 2 }); return 1 - a / b }
const kgeRef = (o: number[], s: number[]) => {
  const mo = avg(o), ms = avg(s); let c = 0
  o.forEach((v, i) => { c += (v - mo) * (s[i] - ms) })
  const r = c / o.length / (sd(o) * sd(s))
  return 1 - Math.sqrt((r - 1) ** 2 + (sd(s) / sd(o) - 1) ** 2 + (ms / mo - 1) ** 2)
}
const skillRef = (m: number, b: number) => Math.min(1, (m - b) / (1 - b))

const cell = (label: RegExp) => {
  const row = screen.getAllByRole('row').find(r => label.test(r.querySelector('td')?.textContent ?? ''))
  return row ? row.querySelectorAll('td')[2]?.textContent ?? '' : ''
}
const settled = async () => waitFor(() => {
  if (/Computing in a background/.test(document.body.textContent ?? '')) throw new Error('pending')
  if (!/\d/.test(cell(/^NSE$/))) throw new Error('pending')
}, { timeout: 20000 })

describe('Metrics tab benchmark skill rows', () => {
  it('default mean benchmark: KGE skill vs mean = (KGE + 0.414)/1.414, NSE skill vs mean = NSE', async () => {
    commit(false)
    render(<MetricsTab />)
    await settled()
    const o = Array.from({ length: N }, (_, i) => obsAt(i)), s = Array.from({ length: N }, (_, i) => simAt(i))
    const kge = kgeRef(o, s)
    expect(cell(/^KGE skill vs mean$/)).toBe(fmtNum((kge + Math.SQRT2 - 1) / Math.SQRT2, 3))
    expect(cell(/^NSE skill vs mean$/)).toBe(fmtNum(nseRef(o, s), 3))
  }, 30000)

  it('persistence + inverse transform: both scores on inverse flows', async () => {
    commit(false)
    useApp.getState().updateView({ benchmark: 'persistence', transform: 'inverse' })
    render(<MetricsTab />)
    await settled()
    const o = Array.from({ length: N }, (_, i) => obsAt(i)), s = Array.from({ length: N }, (_, i) => simAt(i))
    const eps = 0.01 * avg(o), f = (v: number) => 1 / (v + eps)
    const to = o.map(f), ts = s.map(f), tb = o.map((_, i) => f(o[Math.max(0, i - 1)]))
    expect(cell(/^NSE skill vs persistence$/)).toBe(fmtNum(skillRef(nseRef(to, ts), nseRef(to, tb)), 3))
    expect(cell(/^KGE skill vs persistence$/)).toBe(fmtNum(skillRef(kgeRef(to, ts), kgeRef(to, tb)), 3))
  }, 30000)

  it('climatology with a simulation that has gaps: the benchmark is scored on the model pairs', async () => {
    commit(true)
    useApp.getState().updateView({ benchmark: 'climatology' })
    render(<MetricsTab />)
    await settled()
    const rows = Array.from({ length: N }, (_, i) => i)
    const month = (i: number) => new Date(Date.UTC(2003, 0, 1) + i * DAY).getUTCMonth()
    const clim = Array.from({ length: 12 }, (_, m) => avg(rows.filter(i => month(i) === m).map(obsAt)))
    const keep = rows.filter(i => !gap(i))
    const o = keep.map(obsAt), s = keep.map(simAt), b = keep.map(i => clim[month(i)])
    expect(cell(/^NSE skill vs climatology$/)).toBe(fmtNum(skillRef(nseRef(o, s), nseRef(o, b)), 3))
    expect(cell(/^KGE skill vs climatology$/)).toBe(fmtNum(skillRef(kgeRef(o, s), kgeRef(o, b)), 3))
  }, 30000)
})
