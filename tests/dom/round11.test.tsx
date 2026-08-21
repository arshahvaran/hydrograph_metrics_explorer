/**
 * Round 11 regressions (author comments):
 *  - Sandbox card order: the hydrograph plot card sits ABOVE the metrics
 *    comparison card; the lag sweep stays last.
 *  - Upload flow: a freshly loaded table (all roles = Ignore by design) shows
 *    ONE guidance message, no red errors; mapping the roles clears it and
 *    enables the commit button.
 *  - DTW alignment plot: computed on the displayed subset frame (ties stay
 *    inside the analysis window) and the subtitle names an active transform.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import Plotly from 'plotly.js-dist-min'
import { useApp } from '../../src/store/store'
import { stage, parseDelimited } from '../../src/ingest/ingest'
import { __resetComputeCachesForTests } from '../../src/ui/compute'
import App from '../../src/App'

beforeEach(() => {
  __resetComputeCachesForTests();
  vi.mocked(Plotly.react).mockClear();
  useApp.getState().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null });
});
afterEach(() => cleanup());

const csv = (n = 90, shift = 2) => {
  const rows = ['date,observed,modelA'];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2003, 0, 1) + i * 864e5).toISOString().slice(0, 10);
    rows.push(`${d},${(6 + 4 * Math.sin(i / 7)).toFixed(3)},${(6 + 4 * Math.sin((i - shift) / 7)).toFixed(3)}`);
  }
  return rows.join('\n');
};
const commit = () => useApp.getState().commitDataset(stage(parseDelimited(csv()), {
  name: 'round11', unit: 'm3s', dateFormat: 'auto', missingValue: null, roles: ['date', 'observed', 'run'],
}).commit!);

const precedes = (a: HTMLElement, b: HTMLElement) =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

describe('Sandbox card order, round 11', () => {
  it('hydrograph card above the metrics card; lag sweep last', async () => {
    commit();
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Sandbox' }));
    const hydro = await screen.findByText(/Hydrograph of the perturbed series/);
    const metrics = await screen.findByText(/Metrics comparison/);
    const sweep = await screen.findByText(/Lag sweep of the perturbed series/);
    expect(precedes(hydro, metrics)).toBe(true);
    expect(precedes(metrics, sweep)).toBe(true);
  });
});

describe('Upload guidance, round 11', () => {
  it('fresh table: one guidance message, no red errors; mapping enables commit', async () => {
    render(<App />);
    const ta = screen.getByPlaceholderText(/date,observed,simulated_1/);
    fireEvent.change(ta, { target: { value: 'date,observed,sim\n2001-01-01,1,2\n2001-01-02,2,3\n2001-01-03,3,4' } });
    fireEvent.click(screen.getByText('Parse pasted data'));

    const status = await screen.findByRole('status');
    expect(status.textContent).toMatch(/assign one Date column, one Observed column and at least one Simulated column/);
    expect(document.querySelector('.error')).toBeNull();

    fireEvent.change(screen.getByLabelText('Role for column date'), { target: { value: 'date' } });
    const partial = await screen.findByRole('status');
    expect(partial.textContent).toMatch(/one Observed column and at least one Simulated column/);
    expect(document.querySelector('.error')).toBeNull();

    fireEvent.change(screen.getByLabelText('Role for column observed'), { target: { value: 'observed' } });
    fireEvent.change(screen.getByLabelText('Role for column sim'), { target: { value: 'run' } });
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(document.querySelector('.error')).toBeNull();
    expect(screen.getByText('Use this data →')).toBeEnabled();
  });
});

describe('DTW alignment on the subset frame, round 11', () => {
  it('ties stay inside the analysis window and the note names the transform', async () => {
    commit();
    useApp.getState().updateView({ window: [Date.UTC(2003, 0, 11), Date.UTC(2003, 1, 19)], transform: 'log' });
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Plots' }));
    fireEvent.click(await screen.findByText('DTW alignment'));
    await screen.findByText(/alignment computed on log-transformed flows/);
    const call = await waitFor(() => {
      const c = vi.mocked(Plotly.react).mock.calls.find((cc: any[]) =>
        Array.isArray(cc[1]) && (cc[1] as any[]).some((t: any) => t.name === 'DTW alignment'));
      expect(c).toBeTruthy();
      return c!;
    });
    const ties = (call[1] as any[]).find((t: any) => t.name === 'DTW alignment');
    const xs = (ties.x as (string | null)[]).filter((v): v is string => v != null);
    expect(xs.length).toBeGreaterThan(0);
    for (const x of xs) {
      expect(x >= '2003-01-11', `${x} before the window`).toBe(true);
      expect(x <= '2003-02-19', `${x} after the window`).toBe(true);
    }
  });
});
