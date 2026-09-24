/**
 * Final sweep, docs: README numbers and lists that the code decides are read
 * from the code, so a change in either fails this test until both agree.
 * Before the sweep the README said "any number of simulated discharge
 * columns" (the cap is 60), listed PNG/SVG/CSV export (JPG too), and said that
 * only tables above 250,000 rows are plotted at reduced resolution (the plots
 * decimate above 50,000 points).
 */
import { it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { LIMITS } from '../src/ingest/limits'
import { BOOTSTRAP_MIN_N, BOOTSTRAP_MAX_N } from '../src/metrics/bootstrap'

const README = readFileSync('README.md', 'utf8').replace(/\r?\n\s*/g, ' ')
const n = (v: number) => v.toLocaleString('en-US')
const MB = 1024 * 1024

it('input limits in the README are the LIMITS of the code', () => {
  expect(README).toContain(`up to ${LIMITS.runs} simulated discharge columns`)
  expect(README).not.toMatch(/any number of simulated/)
  expect(README).toContain(`delimited files up to ${LIMITS.delimitedBytes / MB} MB, workbooks up to ${LIMITS.workbookBytes / MB} MB, project files up to ${LIMITS.projectBytes / MB} MB`)
  expect(README).toContain(`tables up to ${n(LIMITS.rows)} rows, ${LIMITS.columns} columns and ${LIMITS.cells / 1e6} million cells, and up to ${LIMITS.runs} simulated columns per dataset`)
  expect(README).toContain(`Tables above ${n(LIMITS.warnRows)} rows or ${LIMITS.warnCells / 1e6} million cells ask for confirmation before loading`)
  expect(README).toContain(`Series longer than ${n(LIMITS.plotPoints)} steps are plotted at reduced resolution`)
  expect(README).toContain(`Bootstrap intervals need between ${BOOTSTRAP_MIN_N} and ${n(BOOTSTRAP_MAX_N)} valid pairs`)
})

it('plot export formats in the README are the buttons of every plot', () => {
  const host = readFileSync('src/ui/PlotHost.tsx', 'utf8')
  for (const f of ['JPG', 'PNG', 'SVG', 'CSV']) expect(host).toMatch(new RegExp(`>${f}<`))
  expect(README).toContain('with PNG, SVG, JPG and CSV export')
})
