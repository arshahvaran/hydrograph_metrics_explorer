/**
 * Audit finding report-03: the printed (PDF) report table showed a non-zero
 * MSE and MdSE as "0.000", the optimum printed in the next column, for a
 * river of mean flow ~1 m3/s. The report cells go through fmtNum, which now
 * shows significant figures for small magnitudes.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useApp } from '../../src/store/store'
import { stage, parseDelimited } from '../../src/ingest/ingest'
import { __resetComputeCachesForTests, frameFor, computeForRun } from '../../src/ui/compute'
import { openPrintReport } from '../../src/report/report'

const DAY = 86_400_000
const csv = () => {
  const rows = ['date,observed,A,B']
  for (let i = 0; i < 730; i++) {
    const q = 0.8 + 0.3 * Math.sin((2 * Math.PI * i) / 365) + 1.5 * Math.exp(-(((i % 40) - 15) ** 2) / 10)
    rows.push([new Date(Date.UTC(2003, 0, 1) + i * DAY).toISOString().slice(0, 10), q, q * 1.012 + 0.002 * Math.sin(i), q * 0.985 - 0.004].map(v => (typeof v === 'number' ? v.toFixed(6) : v)).join(','))
  }
  return rows.join('\n')
}

beforeEach(() => {
  __resetComputeCachesForTests()
  useApp.getState().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null })
})

describe('report-03: printed report keeps small errors non-zero', () => {
  it('MSE and MdSE rows show significant figures, not 0.000', () => {
    useApp.getState().commitDataset(stage(parseDelimited(csv()), {
      name: 'small', unit: 'm3s', dateFormat: 'auto', missingValue: null, roles: ['date', 'observed', 'run', 'run'],
    }).commit!)
    const ds = useApp.getState().project.datasets[0]
    const runs = ds.runs.filter(r => r.visible)
    const outputs = runs.map(r => computeForRun(ds, r))
    let html = ''
    const fakeWin: any = { document: { write: (h: string) => { html += h }, close() {} }, focus() {}, print() {} }
    const orig = window.open
    ;(window as any).open = () => fakeWin
    try {
      openPrintReport({ ds, frame: frameFor(ds), runs, outputs, images: [], notes: '',
        sections: { summary: false, metrics: true, plots: false, events: false, ranking: false } } as any)
    } finally {
      ;(window as any).open = orig
    }
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const row = (label: string) => Array.from(doc.querySelectorAll('tr'))
      .map(tr => Array.from(tr.querySelectorAll('td')).map(td => td.textContent ?? ''))
      .find(c => c[0] === label)!
    for (const label of ['MSE', 'MdSE']) {
      const cells = row(label)
      expect(cells[1]).toBe('0')                                   // the optimum column
      for (const c of cells.slice(2)) expect(c).not.toMatch(/^-?0(\.0*)?$/)
      expect(cells[2]).not.toBe(cells[3])                           // the two runs differ
    }
    expect(Number(row('MSE')[2])).toBeCloseTo(outputs[0].values.mse, 6)
  })
})
