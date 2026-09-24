/** Regression for audit finding events-10 (moved from the verifier's tests/audit/events-10.test.ts).
 *  Claim: the report's event table heads the per-event volume column
 *  'Volume bias %' (DOCX) / 'Vol bias %' (PDF/HTML) with no sign convention,
 *  yet fills it with 100(Vs - Vo)/Vo (+ = over-estimation), while the SAME
 *  report's metric table defines bias as 'PBIAS % (+ = under)', following the
 *  paper's Table 2 footnote: PBIAS = 100 x (Qobs - Qsim)/Qobs, positive =
 *  model underestimation.
 *
 *  Correct behaviour asserted here: the column header must either state a
 *  sign convention that matches the numbers it carries, or, if it states none,
 *  its numbers must follow the only bias convention the report declares
 *  (PBIAS, + = under).
 *
 *  Reference values (numpy, scratch/events-10/ref.py): obs = 2 baseline with an
 *  integer flood 20,40,60,44,32,24,18,14,10,8,6,4 at days 58..69; sim = obs/2
 *  exactly. Whole-series PBIAS = +50.0; event-window volume in the PBIAS
 *  convention (Vo - Vs)/Vo = +50.0; in the (Vs - Vo)/Vo convention = -50.0.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import JSZip from 'jszip'
import { useApp } from '../src/store/store'
import { stage, parseDelimited } from '../src/ingest/ingest'
import { frameFor, computeForRun, __resetComputeCachesForTests } from '../src/ui/compute'
import { buildDocx, openPrintReport } from '../src/report/report'

const N = 120
const FLOOD = [20, 40, 60, 44, 32, 24, 18, 14, 10, 8, 6, 4]
const obs = Array.from({ length: N }, () => 2)
FLOOD.forEach((v, k) => { obs[58 + k] = v })
const sim = obs.map(v => v / 2)

const EXPECTED_PBIAS = 50.0            // numpy: 100*sum(O-S)/sum(O)
const EXPECTED_EVENT_UNDER = 50.0      // numpy: 100*(Vo-Vs)/Vo over the event window
const EXPECTED_EVENT_OVER = -50.0      // numpy: 100*(Vs-Vo)/Vo over the event window

const csv = () => {
  const rows = ['date,observed,m']
  for (let i = 0; i < N; i++) rows.push(`${new Date(Date.UTC(2001, 0, 1) + i * 864e5).toISOString().slice(0, 10)},${obs[i]},${sim[i]}`)
  return rows.join('\n')
}

function payload() {
  useApp.getState().commitDataset(stage(parseDelimited(csv()), {
    name: 'events10', unit: 'm3s', dateFormat: 'auto', missingValue: null, roles: ['date', 'observed', 'run'],
  }).commit!)
  const ds = useApp.getState().project.datasets[0]
  const runs = ds.runs.filter(r => r.visible)
  const outputs = runs.map(r => computeForRun(ds, r))
  const frame = frameFor(ds)
  return { ds, frame, runs, outputs, images: [], notes: '',
    sections: { summary: false, metrics: true, plots: false, events: true, ranking: false } } as any
}

/** Given the header text and the signed number in that column, decide whether
 *  the number is consistent with what the header tells a reader. */
function expectedSignFor(header: string): 'over' | 'under' {
  if (/\+\s*=\s*over/i.test(header) || /S\s*[-−]\s*O|sim\s*[-−]\s*obs/i.test(header)) return 'over'
  if (/\+\s*=\s*under/i.test(header) || /O\s*[-−]\s*S|obs\s*[-−]\s*sim/i.test(header)) return 'under'
  // No convention stated: the only bias convention this report declares is
  // PBIAS '(+ = under)' (paper Table 2 footnote), so that is what a reader applies.
  return 'under'
}

beforeEach(() => {
  __resetComputeCachesForTests()
  useApp.getState().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null })
})
afterEach(() => { delete (globalThis as any).window })

describe('events-10: report event-table volume column sign vs. its label', () => {
  it('precondition: the report itself declares PBIAS with + = under, and PBIAS = +50 here', () => {
    const p = payload()
    expect(p.outputs[0].values.pbias).toBeCloseTo(EXPECTED_PBIAS, 9)
    expect(p.outputs[0].extras.events.events.length).toBe(1)
    expect(p.outputs[0].extras.events.events[0].volumeErrPct).toBeCloseTo(EXPECTED_EVENT_OVER, 9)
  })

  it('DOCX: the volume column header and its value agree on the sign convention', async () => {
    const p = payload()
    const blob = await buildDocx(p)
    const zip = await JSZip.loadAsync(await blob.arrayBuffer())
    const xml = await zip.file('word/document.xml')!.async('string')
    const texts = [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map(m => m[1])
    // The PBIAS label in the metric table of the same document
    expect(texts).toContain('PBIAS % (+ = under)')
    const iLag = texts.indexOf('Peak lag [steps]')
    expect(iLag).toBeGreaterThan(-1)
    const header = texts[iLag + 1]
    expect(texts[iLag + 2]).toBe('Matched')
    // first data row follows: '#', start, obs peak, sim peak, lag, volume, matched
    const row = texts.slice(iLag + 3, iLag + 10)
    expect(row[0]).toBe('1')
    expect(row[6]).toBe('hit')
    const value = Number(row[5])
    const want = expectedSignFor(header) === 'under' ? EXPECTED_EVENT_UNDER : EXPECTED_EVENT_OVER
    expect({ header, value }).toEqual({ header, value: want })
  })

  it('PDF/HTML: the volume column header and its value agree on the sign convention', () => {
    let html = ''
    ;(globalThis as any).window = {
      open: () => ({ document: { write: (s: string) => { html = s }, close() {} }, focus() {}, print() {} }),
    }
    const p = payload()
    openPrintReport(p)
    expect(html).toContain('PBIAS % (+ = under)')
    const m = html.match(/<h2>4\. Event summary<\/h2>[\s\S]*?<thead><tr class="">((?:<th>[^<]*<\/th>)+)<\/tr><\/thead><tbody><tr class="">((?:<td>[^<]*<\/td>)+)<\/tr>/)
    expect(m).not.toBeNull()
    const heads = [...m![1].matchAll(/<th>([^<]*)<\/th>/g)].map(x => x[1])
    const cells = [...m![2].matchAll(/<td>([^<]*)<\/td>/g)].map(x => x[1])
    const header = heads[5]
    const value = Number(cells[5])
    const want = expectedSignFor(header) === 'under' ? EXPECTED_EVENT_UNDER : EXPECTED_EVENT_OVER
    expect({ header, value }).toEqual({ header, value: want })
  })
})
