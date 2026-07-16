/**
 * Round 10 regressions (author comments): DE polar restyle to match the
 * paper's figure, plus the sandbox noise label.
 *  - Observed label sits ABOVE its dot (clear of the radial tick labels).
 *  - Radial grid every 0.2.
 *  - Explicit reversed-plasma stops: yellow at the low end, #0d0887 at r = 1.
 *  - Colorbar sized to the circle: len 0.88, vertically centred.
 *  - Sandbox: "Noise type / seed".
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

const csv = (n = 90) => {
  const rows = ['date,observed,modelA,modelB'];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2003, 0, 1) + i * 864e5).toISOString().slice(0, 10);
    const o = 6 + 4 * Math.sin(i / 7);
    rows.push(`${d},${o.toFixed(3)},${(6 + 4 * Math.sin((i - 2) / 7)).toFixed(3)},${(0.7 * o + 1).toFixed(3)}`);
  }
  return rows.join('\n');
};
const commit = () => useApp.getState().commitDataset(stage(parseDelimited(csv()), {
  name: 'round10', unit: 'm3s', dateFormat: 'auto', missingValue: null, roles: ['date', 'observed', 'run', 'run'],
}).commit!);

describe('DE polar style, round 10', () => {
  it('observed label on top, radial dtick 0.2, reversed-plasma stops, tall centred colorbar', async () => {
    commit();
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Timing' }));
    await screen.findByText(/Diagnostic-efficiency polar/);
    const call = await waitFor(() => {
      const c = vi.mocked(Plotly.react).mock.calls.find((cc: any[]) =>
        Array.isArray(cc[1]) && (cc[1] as any[]).some(t => t.type === 'scatterpolar'));
      expect(c).toBeTruthy();
      return c!;
    });
    const traces = call[1] as any[];
    const observed = traces.find(t => t.name === 'Observed');
    expect(observed.textposition).toBe('top center');
    const runsTrace = traces.find(t => t.marker?.colorbar);
    const m = runsTrace.marker;
    expect(Array.isArray(m.colorscale)).toBe(true);
    expect(m.colorscale[0]).toEqual([0, '#f0f921']);              // yellow = mismatch end
    expect(m.colorscale[m.colorscale.length - 1]).toEqual([1, '#0d0887']); // dark = r 1
    expect(m.reversescale).toBeUndefined();
    expect(m.cmax).toBe(1);
    expect(m.colorbar).toMatchObject({ lenmode: 'pixels', len: 226, y: 0.5, yanchor: 'middle', thickness: 14 });
    const layout = call[2] as any;
    expect(layout.polar.radialaxis.dtick).toBe(0.2);
  });
});

describe('Sandbox label, round 10', () => {
  it('says "Noise type / seed" and the select is labelled Noise type', async () => {
    commit();
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Sandbox' }));
    await screen.findByText(/Perturbation sandbox/);
    expect(screen.getByText('Noise type / seed')).toBeTruthy();
    expect(screen.getByLabelText('Noise type')).toBeTruthy();
    expect(screen.queryByText(/Noise kind/)).toBeNull();
  });
});
