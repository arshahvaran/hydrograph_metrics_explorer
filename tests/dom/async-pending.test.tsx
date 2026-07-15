/**
 * Behavioural regression for QA-001/002 (S1): with a real async Worker, the
 * Timing and Sandbox tabs render a pending card first, then the resolved
 * panel. Before the guard/inner split this transition changed the hook count
 * and crashed React ("Rendered more hooks than during the previous render").
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { computeAll } from '../../src/metrics/registry'
import { bootstrapCIs } from '../../src/metrics/bootstrap'
import { useApp } from '../../src/store/store'
import { __resetComputeCachesForTests } from '../../src/ui/compute'
import { stage, parseDelimited } from '../../src/ingest/ingest'
import App from '../../src/App'

class MockAsyncWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: unknown = null;
  postMessage(msg: any) {
    setTimeout(() => {
      try {
        const out = msg.task === 'bootstrap'
          ? bootstrapCIs(msg.obs, msg.sim, { nanPolicy: msg.ctx.nanPolicy, transform: msg.ctx.transform }, { ...msg.boot, B: 40 })
          : computeAll(msg.obs, msg.sim, msg.ctx);
        this.onmessage?.({ data: { id: msg.id, out } });
      } catch (err) {
        this.onmessage?.({ data: { id: msg.id, error: String(err) } });
      }
    }, 0);
  }
  terminate() {}
}

function loadSyntheticDataset() {
  const rows = ['date,observed,modelA'];
  for (let i = 0; i < 200; i++) {
    const d = new Date(Date.UTC(2001, 0, 1) + i * 86400000).toISOString().slice(0, 10);
    const o = 5 + 4 * Math.exp(-(((i % 40) - 12) ** 2) / 30);
    const s = 5 + 4 * Math.exp(-(((i % 40) - 15) ** 2) / 30);
    rows.push(`${d},${o.toFixed(3)},${s.toFixed(3)}`);
  }
  const staged = stage(parseDelimited(rows.join('\n')), {
    name: 'async-ds', unit: 'm3s', dateFormat: 'auto', missingValue: null,
    roles: ['date', 'observed', 'run'],
  });
  expect(staged.commit).toBeTruthy();
  useApp.getState().commitDataset(staged.commit!);
}

beforeAll(() => {
  (globalThis as any).Worker = MockAsyncWorker; // opt-in async lane for this file
  loadSyntheticDataset();
});

describe('async pending → ready transitions (S1 regression)', () => {
  beforeEach(() => {
    __resetComputeCachesForTests();
    useApp.getState().updateView({ activeTab: 'data' });
  });

  it('Timing tab survives the worker round-trip', async () => {
    const errs: string[] = [];
    const orig = console.error; console.error = (...a: any[]) => { errs.push(a.map(String).join(' ')); orig(...a); };
    try {
      render(<App />);
      fireEvent.click(screen.getByRole('tab', { name: 'Timing' }));
      expect((await screen.findAllByText(/Peak timing/i, {}, { timeout: 4000 })).length).toBeGreaterThan(0);
      expect(errs.join('\n')).not.toMatch(/Rendered more hooks|Cannot read propert/i);
    } finally { console.error = orig; }
  });

  it('Sandbox tab survives the worker round-trip and slider hammering', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Sandbox' }));
    await screen.findByText(/perturbation sandbox/i, {}, { timeout: 4000 });
    const sliders = screen.getAllByRole('slider');
    for (let k = 0; k < 12; k++) {
      const s = sliders[k % sliders.length] as HTMLInputElement;
      fireEvent.change(s, { target: { value: s.max || '10' } });
      fireEvent.change(s, { target: { value: s.min || '0' } });
    }
    expect(await screen.findByText(/lag sweep/i, {}, { timeout: 4000 })).toBeInTheDocument();
  });

  it('Metrics CI toggle streams bootstrap without breaking the table', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Metrics' }));
    const toggle = await screen.findByLabelText(/95% CIs/i);
    fireEvent.click(toggle);
    expect((await screen.findAllByText(/\[.+,.+\]/, {}, { timeout: 5000 })).length).toBeGreaterThan(0);
  });
});
