/**
 * QA charters, encoded. Each charter is a session a rushed
 * hydrologist might actually have. Assertions are "no crash + coherent state",
 * with a console.error trap for React render errors throughout.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react'
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
  // hard-reset the store between charters
  useApp.getState().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null });
});
afterEach(() => {
  console.error = origErr;
  const fatal = errs.filter(e => /Rendered more hooks|Cannot read propert|Maximum update depth|not wrapped in act/i.test(e))
    .filter(e => !/not wrapped in act/i.test(e)); // act noise from async worker fallback is not a product defect
  expect(fatal, fatal.join('\n')).toEqual([]);
  cleanup();
});

function csv(n = 90, phase = 0) {
  const rows = ['date,observed,modelA,modelB'];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2003, 0, 1) + i * 864e5).toISOString().slice(0, 10);
    const o = 6 + 4 * Math.sin(i / 7);
    rows.push(`${d},${o.toFixed(3)},${(6 + 4 * Math.sin((i - 2 - phase) / 7)).toFixed(3)},${(0.7 * o + 1).toFixed(3)}`);
  }
  return rows.join('\n');
}
const commit = (name = 'charter', n = 90, phase = 0) =>
  useApp.getState().commitDataset(stage(parseDelimited(csv(n, phase)), {
    name, unit: 'm3s', dateFormat: 'auto', missingValue: null, roles: ['date', 'observed', 'run', 'run'],
  }).commit!);

describe('QA charters', () => {
  it('A1: cold start; touch every reachable control before any data exists', () => {
    render(<App />);
    // every non-data tab must be disabled and clicking must not navigate or throw
    for (const t of ['Metrics', 'Plots', 'Timing', 'Sandbox', 'Compare', 'Map', 'Report']) {
      const tab = screen.getByRole('tab', { name: t });
      expect(tab).toBeDisabled();
      fireEvent.click(tab);
    }
    fireEvent.click(screen.getByRole('button', { name: /toggle colour theme/i }));
    fireEvent.click(screen.getByRole('button', { name: /toggle colour theme/i }));
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'New' })).toBeDisabled();
    expect(screen.getByRole('tab', { name: 'Data' })).not.toBeDisabled();
  });

  it('A2: full feature walk in order, then the same walk in an awkward order', () => {
    commit();
    render(<App />);
    const walk = ['Metrics', 'Plots', 'Timing', 'Sandbox', 'Compare', 'Map', 'Report', 'Data'];
    for (const t of walk) fireEvent.click(screen.getByRole('tab', { name: t }));
    const awkward = ['Report', 'Sandbox', 'Report', 'Timing', 'Compare', 'Metrics', 'Timing', 'Plots', 'Map', 'Sandbox'];
    for (const t of awkward) fireEvent.click(screen.getByRole('tab', { name: t }));
    expect(screen.getAllByText(/Perturbation sandbox/i).length).toBeGreaterThan(0);
  });

  it('A3: sandbox abuse; extremes, rapid drags, presets, nonsense combos', async () => {
    commit();
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Sandbox' }));
    await screen.findAllByRole('slider', {}, { timeout: 3000 });
    const sliders = () => screen.getAllByRole('slider') as HTMLInputElement[];
    for (let round = 0; round < 3; round++) {
      for (const s of sliders()) {
        fireEvent.change(s, { target: { value: s.max } });
        fireEvent.change(s, { target: { value: s.min } });
        fireEvent.change(s, { target: { value: String((Number(s.min) + Number(s.max)) / 2) } });
      }
    }
    for (const preset of ['Double penalty', 'Bias blindness', 'Variance damping', 'Noise', 'Reset']) {
      const b = screen.queryByRole('button', { name: new RegExp(preset, 'i') });
      if (b) fireEvent.click(b);
    }
    // nonsense: everything at extreme simultaneously
    for (const s of sliders()) fireEvent.change(s, { target: { value: s.max } });
    expect((await screen.findAllByText(/Lag sweep/i, {}, { timeout: 3000 })).length).toBeGreaterThan(0);
    // the readout must never literally render the string NaN
    expect(document.body.textContent).not.toMatch(/\bNaN\b/);
  });

  it('A4: switch datasets, transforms, windows and tabs mid-flow; repeat-determinism', () => {
    commit('ds-one', 90, 0);
    commit('ds-two', 120, 4);
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Metrics' }));
    const grab = () => (screen.getByRole('table', { name: /metric values per simulation/i }).textContent ?? '');
    const first = grab();
    // hammer settings back and forth
    const st = useApp.getState();
    st.updateView({ transform: 'log' }); st.updateView({ transform: 'none' });
    st.updateView({ window: [Date.UTC(2003, 0, 10), Date.UTC(2003, 1, 20)] });
    st.updateView({ window: null });
    st.setActiveDataset(useApp.getState().project.datasets[0].id);
    st.setActiveDataset(useApp.getState().project.datasets[1].id);
    st.setActiveDataset(useApp.getState().project.datasets[0].id);
    const second = grab();
    expect(second).toEqual(first); // same input, same answer
  });

  it('A5: soak-lite; 200 rapid mixed interactions without degradation', () => {
    commit();
    render(<App />);
    const tabs = ['Metrics', 'Plots', 'Timing', 'Sandbox', 'Compare', 'Map', 'Report'];
    for (let i = 0; i < 200; i++) {
      fireEvent.click(screen.getByRole('tab', { name: tabs[i % tabs.length] }));
      if (i % 17 === 0) useApp.getState().updateView({ transform: i % 34 ? 'log' : 'none' });
      if (i % 23 === 0) fireEvent.click(screen.getByRole('button', { name: /toggle colour theme/i }));
    }
    expect(screen.getByRole('tab', { name: 'Metrics' })).toBeInTheDocument();
  });
});
