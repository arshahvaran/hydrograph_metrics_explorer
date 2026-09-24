/**
 * tb-rev-03: under the log transform KGE (2009), PBIAS, VE and 14 other
 * metrics read n/a, and the default ranking leaves KGE out of the composite.
 * The reason was shown on the Metrics tab only: the report (settings, metrics
 * table, ranking), the Compare tab and the Sandbox tab showed the n/a values
 * with no word of why, and the Compare tab counted KGE among the metrics of
 * the composite. Each assertion below failed before the fix.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import JSZip from 'jszip'
import { useApp } from '../../src/store/store'
import { stage, parseDelimited } from '../../src/ingest/ingest'
import { frameFor, computeForRun, __resetComputeCachesForTests } from '../../src/ui/compute'
import { openPrintReport, buildDocx } from '../../src/report/report'
import { CompareTab } from '../../src/ui/CompareTab'
import { SandboxTab } from '../../src/ui/SandboxTab'
import { LOG_NA_NOTE, TRANSFORM_NOTES } from '../../src/metrics/classical/catalogue'
import { transformScopeNote } from '../../src/metrics/registry'

beforeEach(() => {
  __resetComputeCachesForTests()
  const rows = ['date,observed,simA,simB']
  for (let i = 0; i < 120; i++) {
    const d = new Date(Date.UTC(2006, 0, 1) + i * 864e5).toISOString().slice(0, 10)
    const q = (k: number, a: number) => (a + 8 * Math.exp(-(((i % 30) - 12 - k) ** 2) / 6)).toFixed(3)
    rows.push(`${d},${q(0, 6)},${q(2, 6)},${q(0, 6.5)}`)
  }
  useApp.getState().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null })
  useApp.getState().commitDataset(stage(parseDelimited(rows.join('\n')), {
    name: 'notes', unit: 'm3s', dateFormat: 'auto', missingValue: null, roles: ['date', 'observed', 'run', 'run'],
  }).commit!)
})
afterEach(() => cleanup())

type Sections = { summary: boolean; metrics: boolean; plots: boolean; events: boolean; ranking: boolean }
const ALL: Sections = { summary: true, metrics: true, plots: false, events: false, ranking: true }
function payload(sections: Sections = ALL) {
  const ds = useApp.getState().project.datasets[0]
  const runs = ds.runs.filter(r => r.visible)
  return { ds, frame: frameFor(ds), runs, outputs: runs.map(r => computeForRun(ds, r)), images: [], notes: '', sections } as any
}
function printHtml(sections: Sections = ALL): string {
  let captured = ''
  const fakeWin: any = { document: { write: (h: string) => { captured += h }, close() {} }, focus() {}, print() {} }
  const origOpen = window.open
  ;(window as any).open = () => fakeWin
  try { openPrintReport(payload(sections)) } finally { (window as any).open = origOpen }
  return captured
}
const count = (hay: string, needle: string) => hay.split(needle).length - 1
const KGE_OMITTED = /Left out of the composite because no simulation has a value: [^.]*KGE \(2009\)[^.]*\. [^.]*KGE \(2009\)[^.]* n\/a on log flows/

describe('report (tb-rev-03)', () => {
  it('PDF under log: the transform notes appear once, and the ranking says KGE is left out and why', () => {
    useApp.getState().updateView({ transform: 'log' })
    const html = printHtml()
    expect(count(html, LOG_NA_NOTE)).toBe(1)
    expect(html).toContain(TRANSFORM_NOTES.log)
    expect(html).toContain(transformScopeNote('log'))
    expect(html).toMatch(KGE_OMITTED)
  })

  it('PDF under log with only the ranking section: the notes still come with the n/a values', () => {
    useApp.getState().updateView({ transform: 'log' })
    const html = printHtml({ summary: false, metrics: false, plots: false, events: false, ranking: true })
    expect(count(html, LOG_NA_NOTE)).toBe(1)
    expect(html).toMatch(KGE_OMITTED)
  })

  it('Word under log: the notes and the omission are in the document', async () => {
    useApp.getState().updateView({ transform: 'log' })
    const blob = await buildDocx(payload())
    const xml = await (await JSZip.loadAsync(await blob.arrayBuffer())).file('word/document.xml')!.async('string')
    expect(xml).toContain('read n/a: log flows have no natural zero, so a ratio to their level is arbitrary (Santos et al., 2018)')
    expect(xml).toContain('Computation notes')
    expect(xml).toMatch(/Left out of the composite because no simulation has a value: [^<]*KGE \(2009\)/)
  })

  it('no transform: no transform note and nothing left out', () => {
    const html = printHtml()
    expect(html).not.toContain('untransformed flows')
    expect(html).not.toContain(LOG_NA_NOTE)
    expect(html).not.toMatch(/Left out of the composite/)
  })
})

describe('Compare and Sandbox tabs (tb-rev-03)', () => {
  it('Compare under log: the notes, the omission, and the composite counts only the metrics it averages', async () => {
    useApp.getState().updateView({ transform: 'log' })
    const { container } = render(<CompareTab />)
    expect(await screen.findByText(LOG_NA_NOTE, undefined, { timeout: 20000 })).toBeTruthy()
    expect(screen.getByText(TRANSFORM_NOTES.log)).toBeTruthy()
    expect(screen.getByRole('note').textContent).toMatch(KGE_OMITTED)
    const ds = useApp.getState().project.datasets[0]
    const outs = ds.runs.map(r => computeForRun(ds, r))
    const averaged = ['nse', 'kge2009', 'w1', 'peak_lag_abs'].filter(id => outs.some(o => Number.isFinite(o.values[id])))
    expect(averaged).not.toContain('kge2009')
    expect(container.textContent).toMatch(new RegExp(`across ${averaged.length} priority metrics`))
  }, 30000)

  it('Compare with no transform: no transform note, no omission', async () => {
    render(<CompareTab />)
    await screen.findByText(/Recommended simulation|Tie between/, undefined, { timeout: 20000 })
    expect(screen.queryByText(LOG_NA_NOTE)).toBeNull()
    expect(screen.queryByRole('note')).toBeNull()
  }, 30000)

  it('Sandbox under log: the n/a note sits with the KGE and PBIAS readout', async () => {
    useApp.getState().updateView({ transform: 'log' })
    render(<SandboxTab />)
    await waitFor(() => { if (!screen.queryByText(/Metrics comparison/)) throw new Error('pending') }, { timeout: 20000 })
    expect(screen.getByText(LOG_NA_NOTE)).toBeTruthy()
    expect(screen.getByText(TRANSFORM_NOTES.log)).toBeTruthy()
  }, 30000)
})
