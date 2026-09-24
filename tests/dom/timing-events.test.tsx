/**
 * Timing tab regressions from the events-peaks audit cluster:
 *  - timing-sandbox-07: the event table and its CSV keep the time of day for
 *    sub-daily records (several events on one day stay distinct).
 *  - timing-sandbox-08: the configuration card no longer claims that every
 *    setting applies to every timing metric; the warm-up is labelled as an
 *    event setting.
 *  - events-04: peak timing has its own peak-separation control (Gauch: 100).
 *  - events-02: the event table marks which observed events are matched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react'
import Plotly from 'plotly.js-dist-min'
import { useApp } from '../../src/store/store'
import { stage, parseDelimited } from '../../src/ingest/ingest'
import { __resetComputeCachesForTests } from '../../src/ui/compute'
import App from '../../src/App'

beforeEach(() => {
  __resetComputeCachesForTests()
  vi.mocked(Plotly.react).mockClear()
  useApp.getState().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null })
})
afterEach(() => cleanup())

const HOUR = 3_600_000, DAY = 86_400_000

function commitSeries(stepMs: number, obs: number[], sim: number[]) {
  const rows = ['date,observed,modelA']
  const t0 = Date.UTC(2010, 0, 1)
  for (let i = 0; i < obs.length; i++) {
    const iso = new Date(t0 + i * stepMs).toISOString()
    const d = stepMs >= DAY ? iso.slice(0, 10) : iso.slice(0, 16).replace('T', ' ')
    rows.push(`${d},${obs[i].toFixed(5)},${sim[i].toFixed(5)}`)
  }
  useApp.getState().commitDataset(stage(parseDelimited(rows.join('\n')), {
    name: 'timing', unit: 'm3s', dateFormat: 'auto', missingValue: null, roles: ['date', 'observed', 'run'],
  }).commit!)
}

describe('Timing tab event table and settings', () => {
  it('hourly record: event windows and the CSV carry the time of day', async () => {
    const n = 2000
    const f = (t: number) => 5 + 8 * Math.exp(-(((t % 100) - 50) ** 2) / 20)
    const obs: number[] = [], sim: number[] = []
    for (let t = 0; t < n; t++) { obs.push(f(t)); sim.push(f(t - 3)) }
    commitSeries(HOUR, obs, sim)
    render(<App />)
    fireEvent.click(screen.getByRole('tab', { name: 'Timing' }))
    const table = await screen.findByRole('table', { name: 'Detected events and per-event errors' })
    const first = within(table).getAllByRole('row')[1]
    expect(first.textContent).toMatch(/2010-01-0\d \d\d:\d\d → 2010-01-0\d \d\d:\d\d/)
    expect(first.textContent).toContain('hit')
    let captured: Blob | null = null
    const orig = window.URL.createObjectURL
    window.URL.createObjectURL = ((b: Blob) => { captured = b; return 'blob:x' }) as any
    fireEvent.click(screen.getByText('Export CSV'))
    window.URL.createObjectURL = orig
    const lines = (await (captured as unknown as Blob).text()).split('\n')
    expect(lines[0]).toBe('event,window_start,window_end,obs_peak_m3s,matched,peak_lag_steps,peak_mag_err_pct,volume_err_pct')
    expect(lines[1]).toMatch(/^1,2010-01-0\d \d\d:\d\d,2010-01-0\d \d\d:\d\d,/)
  })

  it('the settings card says which metrics each setting drives; warm-up is an event setting; peak separation exists', async () => {
    const n = 300
    const obs: number[] = [], sim: number[] = []
    for (let i = 0; i < n; i++) { const o = 6 + 4 * Math.sin(i / 7); obs.push(o); sim.push(6 + 4 * Math.sin((i - 2) / 7)) }
    commitSeries(DAY, obs, sim)
    render(<App />)
    fireEvent.click(screen.getByRole('tab', { name: 'Timing' }))
    const heading = await screen.findByText(/Timing & shape configuration/)
    expect(heading.textContent).not.toMatch(/applies to every timing metric/)
    const warm = screen.getByLabelText(/Event warm-up/)
    expect(warm.closest('label')!.getAttribute('title')).toMatch(/event metrics and Series Distance only/)
    const sep = screen.getByLabelText(/Peak separation/) as HTMLInputElement
    expect(sep.value).toBe('100')
    expect(sep.closest('label')!.getAttribute('title')).toMatch(/Gauch et al\. \(2021\) use 100 steps/)
  })
})
