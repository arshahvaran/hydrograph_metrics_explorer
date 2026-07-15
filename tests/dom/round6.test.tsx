/**
 * Round 6 regressions (author comments, 2026-07-15):
 *  1. DE polar: the colour axis floats with the runs in view so nearby timing-r
 *     values render as different colours (Sample 2 previously showed both runs
 *     as the same near-black although r = 0.974 vs 1.000).
 *  2. Timing "Default settings" is a visual toggle switch but keeps native
 *     checkbox semantics (label association, fieldset enable/disable).
 *  3. Sandbox: "Simulation to perturb" label; all six Metrics-comparison
 *     header cells are plain bold header cells (no muted class).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, within, cleanup, waitFor } from '@testing-library/react'
import Plotly from 'plotly.js-dist-min'
import { useApp } from '../../src/store/store'
import { stage, parseDelimited } from '../../src/ingest/ingest'
import { __resetComputeCachesForTests } from '../../src/ui/compute'
import { deColorFloor } from '../../src/ui/TimingTab'
import App from '../../src/App'

beforeEach(() => {
  __resetComputeCachesForTests();
  vi.mocked(Plotly.react).mockClear();
  useApp.getState().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null });
});
afterEach(() => cleanup());

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
    name: 'round6', unit: 'm3s', dateFormat: 'auto', missingValue: null, roles: ['date', 'observed', 'run', 'run'],
  }).commit!);

describe('deColorFloor (DE polar colour axis lower bound)', () => {
  it('floats one 0.05 step below the worst finite r', () => {
    expect(deColorFloor([0.974, 1])).toBeCloseTo(0.90, 12);
    expect(deColorFloor([0.42])).toBeCloseTo(0.35, 12);
    expect(deColorFloor([NaN, 0.98, 1])).toBeCloseTo(0.90, 12);
  });
  it('never exceeds 0.9 (span at least 0.1 even when every run is perfect)', () => {
    expect(deColorFloor([1])).toBeCloseTo(0.9, 12);
    expect(deColorFloor([1, 1, 1])).toBeCloseTo(0.9, 12);
  });
  it('never drops below -1 and defaults to 0 without finite input', () => {
    expect(deColorFloor([-0.9])).toBeCloseTo(-0.95, 12);
    expect(deColorFloor([-1])).toBe(-1);
    expect(deColorFloor([])).toBe(0);
    expect(deColorFloor([NaN])).toBe(0);
  });
});

describe('Timing tab, round 6', () => {
  it('DE polar uses the adaptive floor and keeps distinct r values distinguishable', async () => {
    commit();
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Timing' }));
    await screen.findByText(/Diagnostic-efficiency polar/);
    const polarCall = await waitFor(() => {
      const c = vi.mocked(Plotly.react).mock.calls.find((call: any[]) =>
        Array.isArray(call[1]) && (call[1] as any[]).some(t => t.type === 'scatterpolar'));
      expect(c, 'a scatterpolar plot should have rendered').toBeTruthy();
      return c;
    });
    const runsTrace = (polarCall![1] as any[]).find(t => t.marker?.colorscale === 'Magma');
    expect(runsTrace).toBeTruthy();
    const m = runsTrace.marker;
    expect(m.cmax).toBe(1);
    expect(m.cmin).toBeCloseTo(deColorFloor(m.color), 12);
    // The substance of the fix: both runs sit inside the working range, above
    // the floor, and at clearly different positions on the colour axis.
    expect(m.cmin).toBeGreaterThan(0);
    expect(m.cmin).toBeLessThan(1);
    const [r0, r1] = m.color as number[];
    expect(r0).toBeGreaterThan(m.cmin);
    expect(r1).toBeGreaterThan(m.cmin);
    expect(Math.abs(r0 - r1)).toBeGreaterThan(0.001);
  });

  it('Default settings renders as a switch and keeps checkbox + fieldset semantics', async () => {
    commit();
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Timing' }));
    const toggle = await screen.findByLabelText(/Default settings \(switch off to customise\)/) as HTMLInputElement;
    expect(toggle.type).toBe('checkbox');
    expect(toggle.closest('.switch'), 'checkbox should be dressed as a switch').toBeTruthy();
    expect(toggle).toBeChecked();
    const gap = screen.getByLabelText(/Min event gap/) as HTMLInputElement;
    expect(gap).toBeDisabled();
    fireEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(screen.getByLabelText(/Min event gap/)).toBeEnabled();
    fireEvent.click(toggle);
    expect(screen.getByLabelText(/Min event gap/)).toBeDisabled();
  });
});

describe('Sandbox tab, round 6', () => {
  it('names the target picker "Simulation to perturb"', async () => {
    commit();
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Sandbox' }));
    await screen.findByText(/Simulation to perturb/);
    // and the picker itself is still the same accessible control
    expect(screen.getByLabelText('Perturbation target simulation')).toBeTruthy();
  });

  it('all six Metrics-comparison header cells are plain bold headers (none muted)', async () => {
    commit();
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Sandbox' }));
    const section = (await screen.findByText(/Metrics comparison/)).closest('section')!;
    const headers = within(section as HTMLElement).getAllByRole('columnheader');
    expect(headers.map(h => h.textContent)).toEqual([
      'Classical', 'Perturbed series', 'Original series',
      '⏱ Timing & shape', 'Perturbed series', 'Original series',
    ]);
    for (const h of headers) expect(h.className).not.toMatch(/\bmuted\b/);
  });
});
