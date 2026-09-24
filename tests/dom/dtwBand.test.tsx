/**
 * dtw-wass-04 DOM regression: the Timing tab sets the DTW band in time steps,
 * from 1 step to 10 % of the record (it was a percentage of n with a floor of
 * 1 %, which could not express a catchment response time).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { useApp } from '../../src/store/store'
import { stage, parseDelimited, type ColumnRole } from '../../src/ingest/ingest'
import { __resetComputeCachesForTests } from '../../src/ui/compute'
import App from '../../src/App'

const DAY = 864e5
const iso = (i: number) => new Date(Date.UTC(2003, 0, 1) + i * DAY).toISOString().slice(0, 10)
const csv = (n: number) => {
  const rows = ['date,observed,sim1']
  for (let i = 0; i < n; i++) rows.push(`${iso(i)},${(6 + 4 * Math.sin(i / 7)).toFixed(3)},${(6 + 4 * Math.sin((i - 2) / 7)).toFixed(3)}`)
  return rows.join('\n')
}

beforeEach(() => {
  __resetComputeCachesForTests()
  useApp.getState().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null })
})
afterEach(() => cleanup())

describe('Timing tab: DTW band in steps', () => {
  it('shows the default band in steps, accepts 1 step and caps at 10 % of n with a note', async () => {
    const roles: ColumnRole[] = ['date', 'observed', 'run']
    const st = stage(parseDelimited(csv(120)), { name: 'band', unit: 'm3s', dateFormat: 'auto', missingValue: null, roles })
    useApp.getState().commitDataset(st.commit!)
    render(<App />)
    fireEvent.click(screen.getByRole('tab', { name: 'Timing' }))
    const field = async () => (await screen.findByLabelText(/DTW band/)) as HTMLInputElement
    const stored = () => useApp.getState().project.datasets[0].view.timingConfig.dtwBand
    expect((await field()).value).toBe('3')
    expect(screen.getByText(/DTW band ±/).textContent).toMatch(/steps/)
    fireEvent.click(await screen.findByLabelText(/Default settings/))
    fireEvent.change(await field(), { target: { value: '1' } })
    await waitFor(() => expect(stored()).toBe(1))
    fireEvent.change(await field(), { target: { value: '500' } })
    expect(await screen.findByText('DTW band is limited to 1 to 12; the value was set to 12.')).toBeTruthy()
    await waitFor(() => expect(stored()).toBe(12))
  })
})
