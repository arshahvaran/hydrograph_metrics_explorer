// @vitest-environment jsdom
/** Audit report-12 and claims-05 (review: D9 wanted tests that fail on the old code).
 *  report-12: Export CSV once wrote a well-formed file of blank cells while the panels or
 *  the CIs were still computing; it is now disabled until they have arrived.
 *  claims-05: the Report tab promised a provenance appendix that no longer exists. */
import { it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react'
import { computeAll } from '../../src/metrics/registry'
import { bootstrapCIs } from '../../src/metrics/bootstrap'
import { useApp } from '../../src/store/store'
import { __resetComputeCachesForTests } from '../../src/ui/compute'
import { stage, parseDelimited } from '../../src/ingest/ingest'
import App from '../../src/App'

/** A worker that answers only when the test releases it, so the pending state lasts. */
const held: (() => void)[] = [];
class GatedWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: unknown = null;
  postMessage(msg: any) {
    held.push(() => {
      try {
        const out = msg.task === 'bootstrap'
          ? bootstrapCIs(msg.obs, msg.sim, { nanPolicy: msg.ctx.nanPolicy, transform: msg.ctx.transform }, { ...msg.boot, B: 50 })
          : computeAll(msg.obs, msg.sim, msg.ctx);
        this.onmessage?.({ data: { id: msg.id, out } });
      } catch (err) { this.onmessage?.({ data: { id: msg.id, error: String(err) } }); }
    });
  }
  terminate() {}
}
const release = () => act(() => { for (const f of held.splice(0)) f(); });

let savedWorker: unknown;
beforeAll(() => { savedWorker = (globalThis as any).Worker; (globalThis as any).Worker = GatedWorker; });
afterAll(() => { (globalThis as any).Worker = savedWorker; });
beforeEach(() => {
  held.length = 0;
  __resetComputeCachesForTests();
  useApp.getState().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null });
  const rows = ['date,observed,modelA,modelB'];
  for (let i = 0; i < 120; i++) {
    const d = new Date(Date.UTC(2001, 0, 1) + i * 864e5).toISOString().slice(0, 10);
    const o = 5 + 4 * Math.sin(i / 6);
    rows.push(`${d},${o.toFixed(3)},${(5 + 4 * Math.sin((i - 2) / 6)).toFixed(3)},${(o * 1.2).toFixed(3)}`);
  }
  useApp.getState().commitDataset(stage(parseDelimited(rows.join('\n')), {
    name: 'pending', unit: 'm3s', dateFormat: 'auto', missingValue: null, roles: ['date', 'observed', 'run', 'run'],
  }).commit!);
});
afterEach(() => { cleanup(); __resetComputeCachesForTests(); });

it('report-12: Export CSV is disabled while the panels are computing, and enabled once they arrive', async () => {
  render(<App />);
  fireEvent.click(screen.getByRole('tab', { name: 'Metrics' }));
  const btn = await screen.findByRole('button', { name: /export csv/i }) as HTMLButtonElement;
  await waitFor(() => expect(held.length).toBeGreaterThan(0));
  expect(btn.disabled).toBe(true);
  expect(btn.title).toMatch(/finished computing/);
  release();
  await waitFor(() => expect(btn.disabled).toBe(false));
});

it('report-12: with CIs on, Export CSV stays disabled until the bootstrap has finished', async () => {
  render(<App />);
  fireEvent.click(screen.getByRole('tab', { name: 'Metrics' }));
  const btn = await screen.findByRole('button', { name: /export csv/i }) as HTMLButtonElement;
  await waitFor(() => expect(held.length).toBeGreaterThan(0));
  release();
  await waitFor(() => expect(btn.disabled).toBe(false));
  fireEvent.click(screen.getByLabelText(/Calculate 95% CIs/));
  await waitFor(() => expect(held.length).toBeGreaterThan(0));   // the bootstrap jobs are posted and held
  expect(btn.disabled).toBe(true);
  release();
  await waitFor(() => expect(btn.disabled).toBe(false), { timeout: 10000 });
}, 20000);

it('claims-05: the Report tab no longer promises a provenance appendix', async () => {
  render(<App />);
  fireEvent.click(screen.getByRole('tab', { name: 'Report' }));
  await screen.findByText(/Word or PDF, generated entirely in your browser/);
  const text = document.body.textContent ?? '';
  expect(text).not.toMatch(/provenance appendix/i);
  expect(text).not.toMatch(/all settings/i);
  expect(text).toContain('every setting that changes a reported value (section 1)');
});
