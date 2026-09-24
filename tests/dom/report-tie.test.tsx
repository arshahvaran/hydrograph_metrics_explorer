/** Audit report-08 / review br-R4: the report calls an exact tie a tie, as the Compare tab does. */
import { it, expect } from 'vitest'
import { useApp } from '../../src/store/store'
import { stage, parseDelimited } from '../../src/ingest/ingest'
import { frameFor, computeForRun, __resetComputeCachesForTests } from '../../src/ui/compute'
import { openPrintReport } from '../../src/report/report'

it('two simulations with equal composites are reported as a tie, not as a recommendation', () => {
  __resetComputeCachesForTests();
  const rows = ['date,observed,twinA,twinB'];
  for (let i = 0; i < 80; i++) {
    const o = (6 + Math.sin(i / 5)).toFixed(3), s = (6.2 + Math.sin(i / 5)).toFixed(3);
    rows.push(`${new Date(Date.UTC(2006, 0, 1) + i * 864e5).toISOString().slice(0, 10)},${o},${s},${s}`);
  }
  useApp.getState().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null });
  useApp.getState().commitDataset(stage(parseDelimited(rows.join('\n')), { name: 'tie', unit: 'm3s', dateFormat: 'auto', missingValue: null, roles: ['date', 'observed', 'run', 'run'] }).commit!);
  useApp.getState().updateView({ priorityMetrics: [{ id: 'nse', weight: 1 }] });
  const ds = useApp.getState().project.datasets[0];
  const runs = ds.runs.filter(r => r.visible);
  let html = '';
  const orig = window.open;
  (window as any).open = () => ({ document: { write: (h: string) => { html += h; }, close() {} }, focus() {}, print() {} });
  try {
    openPrintReport({ ds, frame: frameFor(ds), runs, outputs: runs.map(r => computeForRun(ds, r)), images: [], notes: '',
      sections: { summary: false, metrics: false, plots: false, events: false, ranking: true } } as any);
  } finally { (window as any).open = orig; }
  expect(html).toContain('Tie between twinA and twinB');
  expect(html).not.toContain('Recommended simulation');
});
