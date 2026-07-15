/**
 * Final-QA cross-feature stress journeys. Each reproduces a session that
 * previously exposed (or could expose) a defect:
 *  1. Unit switch mid-session: the Metrics tab must show unchanged NSE and a
 *     x1000 RMSE, not the mixed-unit garbage the stale frame cache produced.
 *  2. Compare: zeroing every weight through the new table must degrade to a
 *     readable message (never a literal NaN recommendation) and recover.
 *  3. Sandbox: slider ranges rescale after a unit conversion.
 *  4. Report: the Download DOCX button end-to-end (events + ranking on) must
 *     complete without the failure alert.
 * A console.error trap guards against React render errors throughout.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, within, cleanup, waitFor } from '@testing-library/react'
import { useApp } from '../../src/store/store'
import { stage, parseDelimited } from '../../src/ingest/ingest'
import { __resetComputeCachesForTests } from '../../src/ui/compute'
import App from '../../src/App'

let errs: string[] = [];
const origErr = console.error;
beforeEach(() => {
  errs = [];
  console.error = (...a: any[]) => { errs.push(a.map(String).join(' ')); };
  __resetComputeCachesForTests();
  useApp.getState().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null });
});
afterEach(() => {
  console.error = origErr;
  const fatal = errs.filter(e => /Rendered more hooks|Cannot read propert|Maximum update depth/i.test(e));
  expect(fatal, fatal.join('\n')).toEqual([]);
  cleanup();
});

function csv(n = 90) {
  const rows = ['date,observed,modelA,modelB'];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2003, 0, 1) + i * 864e5).toISOString().slice(0, 10);
    const o = 6 + 4 * Math.sin(i / 7);
    rows.push(`${d},${o.toFixed(3)},${(6 + 4 * Math.sin((i - 2) / 7)).toFixed(3)},${(0.7 * o + 1).toFixed(3)}`);
  }
  return rows.join('\n');
}
const commit = () =>
  useApp.getState().commitDataset(stage(parseDelimited(csv()), {
    name: 'stress', unit: 'm3s', dateFormat: 'auto', missingValue: null, roles: ['date', 'observed', 'run', 'run'],
  }).commit!);

const cellFor = (table: HTMLElement, rowLabel: RegExp) => {
  const row = within(table).getAllByRole('row').find(r => rowLabel.test(r.textContent ?? ''))!;
  return row.textContent ?? '';
};

describe('stress: unit switch mid-session', () => {
  it('Metrics tab: NSE identical, RMSE x1000 after m3/s to L/s', async () => {
    commit();
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Metrics' }));
    const table = await screen.findByRole('table', { name: /Metric values per simulation/i });
    const nseBefore = cellFor(table, /^NSE/);
    const rmseRowBefore = cellFor(table, /^RMSE/);
    const rmseBefore = parseFloat(rmseRowBefore.match(/(\d+\.\d+)/)?.[1] ?? 'NaN');
    expect(Number.isFinite(rmseBefore)).toBe(true);

    expect(useApp.getState().convertUnits('ls' as any)).toBeNull();
    await waitFor(() => {
      const t = screen.getByRole('table', { name: /Metric values per simulation/i });
      const rmseNow = parseFloat(cellFor(t, /^RMSE/).match(/(\d+\.\d+)/)?.[1] ?? 'NaN');
      expect(rmseNow).toBeCloseTo(rmseBefore * 1000, 0); // before was read off a 3-decimal display
      expect(cellFor(t, /^NSE/)).toBe(nseBefore); // scale-free, digit-for-digit
    });
  });

  it('Sandbox: the offset slider range rescales with the unit', async () => {
    commit();
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Sandbox' }));
    await screen.findByText(/Perturbation sandbox/);
    const offset = () => screen.getAllByRole('slider').find(s =>
      (s.closest('label')?.textContent ?? '').includes('Offset'))! as HTMLInputElement;
    const maxBefore = Number(offset().max);
    expect(useApp.getState().convertUnits('ls' as any)).toBeNull();
    await waitFor(() => {
      expect(Number(offset().max)).toBeCloseTo(maxBefore * 1000, 3);
    });
  });
});

describe('stress: Compare weight edge states', () => {
  it('zeroing every weight shows the guidance line, restoring one brings the ranking back', async () => {
    commit();
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Compare' }));
    await screen.findByText(/Priority metrics/);
    const table = screen.getByRole('table', { name: 'Selected priority metrics and weights' });
    for (const inp of within(table).getAllByRole('spinbutton')) {
      fireEvent.change(inp, { target: { value: '0' } });
    }
    expect(await screen.findByText(/All weights are zero; give at least one metric a weight above zero/)).toBeTruthy();
    expect(screen.queryByText(/Recommended simulation/)).toBeNull();
    expect(document.body.textContent).not.toContain('NaN');
    fireEvent.change(within(table).getAllByRole('spinbutton')[0], { target: { value: '1' } });
    expect(await screen.findByText(/Recommended simulation:/)).toBeTruthy();
  });

  it('a junk weight keystroke is treated as 0, never stored as NaN', async () => {
    commit();
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Compare' }));
    await screen.findByText(/Priority metrics/);
    const table = screen.getByRole('table', { name: 'Selected priority metrics and weights' });
    const first = within(table).getAllByRole('spinbutton')[0] as HTMLInputElement;
    fireEvent.change(first, { target: { value: '' } }); // Number('') = 0 path
    const ds = useApp.getState().project.datasets[0];
    for (const p of ds.view.priorityMetrics) expect(Number.isFinite(p.weight)).toBe(true);
  });
});

describe('stress: report generation through the UI', () => {
  it('Download DOCX completes without the failure alert (events + ranking on, figures off)', async () => {
    const alerts: string[] = [];
    vi.stubGlobal('alert', (m: string) => alerts.push(String(m)));
    commit();
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Report' }));
    await screen.findByText(/Word or PDF, generated entirely in your browser/);
    fireEvent.click(screen.getByLabelText(/Figures/)); // avoid canvas work in jsdom
    fireEvent.click(screen.getByRole('button', { name: 'Download DOCX' }));
    await waitFor(() => {
      expect(alerts.filter(a => /Report generation failed/.test(a))).toEqual([]);
      expect((screen.getByRole('button', { name: 'Download DOCX' }) as HTMLButtonElement).disabled).toBe(false);
    }, { timeout: 8000 });
    vi.unstubAllGlobals();
  });
});
