/**
 * report-02: under the log transform with sub-unit flows the Metrics tab
 * underlined the WORSE simulation for VE (VE = 1.019 vs 1.337, both above
 * the bound of 1, because the log flows summed to a negative number). After
 * the fix VE reads n/a on log flows with a note, the better run keeps the NSE
 * and RMSE underline, and no row underlines the worse run.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup, waitFor } from '@testing-library/react'
import { useApp } from '../../src/store/store'
import { stage, parseDelimited } from '../../src/ingest/ingest'
import { __resetComputeCachesForTests } from '../../src/ui/compute'
import { MetricsTab } from '../../src/ui/MetricsTab'

beforeEach(() => {
  __resetComputeCachesForTests()
  useApp.getState().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null })
})
afterEach(() => cleanup())

const DAY = 86_400_000
const rowCells = (label: RegExp) => {
  const tr = Array.from(document.querySelectorAll('table.metricstable tr')).find(r => label.test(r.querySelector('td')?.textContent ?? ''))
  return tr ? Array.from(tr.querySelectorAll('td')).slice(2).map(td => ({ text: td.textContent ?? '', best: td.className === 'best' })) : []
}

describe('report-02: underline under the log transform', () => {
  it('sub-unit flows: VE is n/a and the worse run is never underlined', async () => {
    const rows = ['date,observed,Good,Bad']
    for (let i = 0; i < 400; i++) {
      const q = 0.05 + 0.4 * Math.exp(-(((i % 50) - 20) ** 2) / 20) + 0.02 * Math.sin(i / 7)
      rows.push([new Date(Date.UTC(2003, 0, 1) + i * DAY).toISOString().slice(0, 10), q, q * 1.05, q * 1.6 + 0.05].map(v => (typeof v === 'number' ? v.toFixed(6) : v)).join(','))
    }
    useApp.getState().commitDataset(stage(parseDelimited(rows.join('\n')), {
      name: 'sub1', unit: 'm3s', dateFormat: 'auto', missingValue: null, roles: ['date', 'observed', 'run', 'run'],
    }).commit!)
    useApp.getState().updateView({ transform: 'log' })
    render(<MetricsTab />)
    await waitFor(() => {
      if (/Computing in a background/.test(document.body.textContent ?? '')) throw new Error('pending')
      if (!/\d/.test(rowCells(/^NSE$/)[0]?.text ?? '')) throw new Error('pending')
    }, { timeout: 20000 })
    const ve = rowCells(/^VE \(volumetric\)$/)
    expect(ve.map(c => c.text)).toEqual(['n/a', 'n/a'])
    expect(ve.some(c => c.best)).toBe(false)
    expect(rowCells(/^NSE$/).map(c => c.best)).toEqual([true, false])
    expect(rowCells(/^RMSE$/).map(c => c.best)).toEqual([true, false])
    // the classical rows (the transform applies to them); timing rows measure other things
    for (const tr of Array.from(document.querySelectorAll('table.metricstable tr:not(.timingrow)'))) {
      const cells = Array.from(tr.querySelectorAll('td')).slice(2)
      expect(cells[1]?.className === 'best', tr.querySelector('td')?.textContent ?? '').toBe(false)
    }
    expect(document.body.textContent).toMatch(/On log flows, NRMSE \(mean\)/)
  }, 30000)
})
