/** Audit timing-sandbox-09, claims-07, claims-09, claims-11, claims-12. */
import { it, expect, beforeAll, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { computeAll } from '../../src/metrics/registry'
import { useApp } from '../../src/store/store'
import { __resetComputeCachesForTests } from '../../src/ui/compute'
import { stage, parseDelimited } from '../../src/ingest/ingest'
import App from '../../src/App'

/** A worker that answers after 150 ms, so a pending state is observable. */
class SlowWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: unknown = null;
  postMessage(msg: any) {
    setTimeout(() => {
      try { this.onmessage?.({ data: { id: msg.id, out: computeAll(msg.obs, msg.sim, msg.ctx) } }); }
      catch (err) { this.onmessage?.({ data: { id: msg.id, error: String(err) } }); }
    }, 150);
  }
  terminate() {}
}

beforeAll(() => {
  (globalThis as any).Worker = SlowWorker;
});
beforeEach(() => {
  __resetComputeCachesForTests();
  useApp.getState().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null });
  const rows = ['date,observed,modelA,modelB'];
  for (let i = 0; i < 200; i++) {
    const d = new Date(Date.UTC(2001, 0, 1) + i * 864e5).toISOString().slice(0, 10);
    const o = 5 + 4 * Math.exp(-(((i % 40) - 12) ** 2) / 30);
    rows.push(`${d},${o.toFixed(3)},${(o * 1.02).toFixed(3)},${(o * 3).toFixed(3)}`);
  }
  useApp.getState().commitDataset(stage(parseDelimited(rows.join('\n')), {
    name: 'sb', unit: 'm3s', dateFormat: 'auto', missingValue: null, roles: ['date', 'observed', 'run', 'run'],
  }).commit!);
});

it('timing-sandbox-09: after switching the target, the old target\'s panel is not shown under the new name', async () => {
  render(<App />);
  fireEvent.click(screen.getByRole('tab', { name: 'Sandbox' }));
  await screen.findByText(/lag sweep/i, {}, { timeout: 5000 });
  const select = screen.getByLabelText('Perturbation target simulation') as HTMLSelectElement;
  const optB = Array.from(select.options).find(o => o.textContent === 'modelB')!;
  act(() => { fireEvent.change(select, { target: { value: optB.value } }); });
  // before the new panel arrives, a computing state is shown instead of modelA's numbers
  expect(screen.getByText(/Computing metric panel/i)).toBeInTheDocument();
  await screen.findByText(/lag sweep/i, {}, { timeout: 5000 });
});

it('claims-09: the Sandbox readout includes R²', async () => {
  render(<App />);
  fireEvent.click(screen.getByRole('tab', { name: 'Sandbox' }));
  await screen.findByText(/lag sweep/i, {}, { timeout: 5000 });
  expect(screen.getAllByText('R²').length).toBeGreaterThan(0);
});

it('claims-07: the page says that the Map tab loads OpenStreetMap tiles', () => {
  render(<App />);
  expect(document.body.textContent).toContain('The Map tab loads OpenStreetMap tiles');
  expect(readFileSync('README.md', 'utf8')).toMatch(/OpenStreetMap basemap tiles/);
});

it('claims-11/claims-12: the generator writes into the repo; npm test builds before the bundle scan', () => {
  const script = readFileSync('scripts/generate_reference_vectors.py', 'utf8');
  expect(script).not.toContain('/home/claude');
  expect(script).toContain('"tests", "fixtures", "reference_vectors.json"');
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  expect(pkg.scripts.test).toMatch(/vite build && vitest run/);
});
