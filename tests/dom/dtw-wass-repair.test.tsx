/**
 * dtw-wass repair round, DOM regressions:
 *  - repair 8: the Plots-tab DTW alignment on a resampled view converts the
 *    band to the new step (±24 hourly steps are ±1 daily step, not ±24 days)
 *    and names the step in its note;
 *  - repair 3: the Timing tab says that DTW mean |warp| cannot exceed the band
 *    (control tooltip) and shows the band-limit note in the timing summary.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import Plotly from 'plotly.js-dist-min'
import { useApp } from '../../src/store/store'
import { stage, parseDelimited, type ColumnRole } from '../../src/ingest/ingest'
import { __resetComputeCachesForTests } from '../../src/ui/compute'
import App from '../../src/App'

const HOUR = 36e5, DAY = 864e5
const roles: ColumnRole[] = ['date', 'observed', 'run']

beforeEach(() => {
  __resetComputeCachesForTests()
  vi.mocked(Plotly.react).mockClear()
  useApp.getState().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null })
})
afterEach(() => cleanup())

describe('Plots tab: the DTW band follows a resampled view', () => {
  it('hourly data resampled to daily means use a band of ±1 day', async () => {
    const rows = ['date,observed,modelA']
    for (let i = 0; i < 24 * 60; i++) {
      const d = new Date(Date.UTC(2003, 0, 1) + i * HOUR).toISOString().slice(0, 16)
      rows.push(`${d},${(6 + 4 * Math.sin(i / 90)).toFixed(3)},${(6 + 4 * Math.sin((i - 30) / 90)).toFixed(3)}`)
    }
    useApp.getState().commitDataset(stage(parseDelimited(rows.join('\n')), { name: 'hourly', unit: 'm3s', dateFormat: 'auto', missingValue: null, roles }).commit!)
    expect(useApp.getState().project.datasets[0].view.timingConfig.dtwBand).toBe(12)
    useApp.getState().updateView({ resample: 'daily' })
    render(<App />)
    fireEvent.click(screen.getByRole('tab', { name: 'Plots' }))
    fireEvent.click(await screen.findByText('DTW alignment'))
    // was "band 12 steps": 12 days on the daily frame
    expect((await screen.findByText(/Optimal Sakoe-Chiba alignment/)).textContent).toMatch(/band ±1 step of 1d\)/)
  })
})

describe('Timing tab: DTW mean |warp| is limited by the band', () => {
  it('the band control says so, and a run later than the band gets the band-limit note', async () => {
    const rows = ['date,observed,late6']
    for (let i = 0; i < 150; i++) {
      const d = new Date(Date.UTC(2003, 0, 1) + i * DAY).toISOString().slice(0, 10)
      rows.push(`${d},${(6 + 4 * Math.sin(i / 7)).toFixed(3)},${(6 + 4 * Math.sin((i - 6) / 7)).toFixed(3)}`)
    }
    useApp.getState().commitDataset(stage(parseDelimited(rows.join('\n')), { name: 'late', unit: 'm3s', dateFormat: 'auto', missingValue: null, roles }).commit!)
    render(<App />)
    fireEvent.click(screen.getByRole('tab', { name: 'Timing' }))
    const label = (await screen.findByLabelText(/DTW band/)).closest('label')!
    expect(label.getAttribute('title')).toMatch(/cannot exceed it/)
    const warn = await screen.findByText(/DTW warp reached the band limit \(±3 steps\)/)
    expect(warn.className).toBe('warning')
    expect(warn.textContent).toMatch(/widen the band on the Timing tab/)
  })
})
