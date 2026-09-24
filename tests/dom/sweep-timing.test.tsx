/**
 * Final sweep, timing (DOM): the Timing tab shows every timing note. It once
 * kept only notes with listed words, so notes such as the XWT gap note, the
 * DTW gap note and "No events at the current threshold" (now "No observed events") never showed there.
 */
import { it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { useApp } from '../../src/store/store'
import { stage, parseDelimited, type ColumnRole } from '../../src/ingest/ingest'
import { __resetComputeCachesForTests } from '../../src/ui/compute'
import App from '../../src/App'

const DAY = 864e5
const roles: ColumnRole[] = ['date', 'observed', 'run']

beforeEach(() => {
  __resetComputeCachesForTests()
  useApp.getState().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null })
})
afterEach(() => cleanup())

it('a 10-day outage in the observed record: the Timing tab shows the XWT and DTW gap notes', async () => {
  const rows = ['date,observed,late2']
  for (let i = 0; i < 300; i++) {
    const d = new Date(Date.UTC(2003, 0, 1) + i * DAY).toISOString().slice(0, 10)
    const o = i >= 150 && i < 160 ? '' : (6 + 4 * Math.sin(i / 7)).toFixed(3)
    rows.push(`${d},${o},${(6 + 4 * Math.sin((i - 2) / 7)).toFixed(3)}`)
  }
  useApp.getState().commitDataset(stage(parseDelimited(rows.join('\n')), { name: 'gap', unit: 'm3s', dateFormat: 'auto', missingValue: null, roles }).commit!)
  render(<App />)
  fireEvent.click(screen.getByRole('tab', { name: 'Timing' }))
  const xwt = await screen.findByText(/Cross-wavelet analysis: 1 gap of more than 3 missing steps \(10 steps in all\) was joined/, {}, { timeout: 15000 })
  expect(xwt.className).toBe('warning')
  expect(screen.getByText(/1 gap of 3 or more missing steps blocks the DTW band/)).toBeInTheDocument()
}, 30000)
