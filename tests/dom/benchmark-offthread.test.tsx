/**
 * tb-rev-05: the benchmark skill rows of the Metrics tab were computed during
 * rendering, on the main thread, once per simulation (re-pairing the record,
 * rebuilding the benchmark and re-applying the transform): 1.6 to 3.5 s of
 * blocked UI at 1M rows with 5 simulations. The skill of all three benchmarks
 * is now part of the panel computed in the worker, so the tab only reads it and
 * a switch of benchmark computes nothing. Before the fix, the spy below was
 * called on every render that changed the benchmark.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor, act } from '@testing-library/react'

vi.mock('../../src/metrics/registry', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/metrics/registry')>()
  return { ...mod, benchmarkSkill: vi.fn(mod.benchmarkSkill) }
})

import * as registry from '../../src/metrics/registry'
import { useApp } from '../../src/store/store'
import { stage, parseDelimited } from '../../src/ingest/ingest'
import { __resetComputeCachesForTests, __cacheKeysForTests } from '../../src/ui/compute'
import { MetricsTab } from '../../src/ui/MetricsTab'
import { fmtNum } from '../../src/ui/format'

beforeEach(() => {
  __resetComputeCachesForTests()
  vi.mocked(registry.benchmarkSkill).mockClear()
  useApp.getState().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null })
})
afterEach(() => cleanup())

const DAY = 86_400_000
const N = 400
function commit() {
  const rows = ['date,observed,simA,simB']
  for (let i = 0; i < N; i++) {
    const d = new Date(Date.UTC(2004, 0, 1) + i * DAY).toISOString().slice(0, 10)
    const o = 20 + 10 * Math.sin((2 * Math.PI * i) / 365) + 25 * Math.exp(-(((i % 35) - 12) ** 2) / 5)
    const a = 19 + 9 * Math.sin((2 * Math.PI * i) / 365) + 24 * Math.exp(-(((i % 35) - 13) ** 2) / 6)
    const b = 21 + 10 * Math.sin((2 * Math.PI * i) / 365) + 20 * Math.exp(-(((i % 35) - 15) ** 2) / 8)
    rows.push(`${d},${o.toFixed(3)},${a.toFixed(3)},${b.toFixed(3)}`)
  }
  useApp.getState().commitDataset(stage(parseDelimited(rows.join('\n')), {
    name: 'offthread', unit: 'm3s', dateFormat: 'auto', missingValue: null, roles: ['date', 'observed', 'run', 'run'],
  }).commit!)
}

const cellOf = (label: RegExp, col: number) => {
  const row = screen.getAllByRole('row').find(r => label.test(r.querySelector('td')?.textContent ?? ''))
  return row ? row.querySelectorAll('td')[col]?.textContent ?? '' : ''
}

describe('benchmark skill off the render path (tb-rev-05)', () => {
  it('the rows are read from the panels; switching the benchmark computes nothing on the main thread', async () => {
    commit()
    useApp.getState().updateView({ transform: 'sqrt' })
    render(<MetricsTab />)
    await waitFor(() => { if (!/\d/.test(cellOf(/^NSE skill vs mean$/, 3))) throw new Error('pending') }, { timeout: 20000 })
    const keys = __cacheKeysForTests().length

    const ds = useApp.getState().project.datasets[0]
    const runs = ds.runs.filter(r => r.visible)
    const ctx = { nanPolicy: ds.view.nanPolicy, transform: ds.view.transform, datesMs: ds.dates }
    for (const kind of ['climatology', 'persistence', 'mean'] as const) {
      act(() => { useApp.getState().updateView({ benchmark: kind }) })
      const label = new RegExp(`^NSE skill vs ${kind}$`)
      await waitFor(() => { if (!/\d/.test(cellOf(label, 2))) throw new Error('pending') })
      runs.forEach((r, i) => {
        const want = registry.benchmarkSkill(ds.observed.values, r.values, kind, ctx)
        expect(cellOf(label, 2 + i), `${kind} ${r.name}`).toBe(fmtNum(want.nseSkill, 3))
        expect(cellOf(new RegExp(`^KGE skill vs ${kind}$`), 2 + i), `${kind} ${r.name}`).toBe(fmtNum(want.kgeSkill, 3))
      })
    }
    // the only calls are the reference values computed by this test (2 runs x 3 benchmarks)
    expect(vi.mocked(registry.benchmarkSkill)).toHaveBeenCalledTimes(6)
    // and no panel was recomputed for a new benchmark
    expect(__cacheKeysForTests().length).toBe(keys)
  }, 30000)
})
