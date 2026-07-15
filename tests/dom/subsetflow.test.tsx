/** The subset bar lives ONLY in the Plots tab; "Use this data" adds a new,
 *  selectable dataset. */
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { useApp } from '../../src/store/store'
import { stage, parseDelimited } from '../../src/ingest/ingest'
import { __resetComputeCachesForTests } from '../../src/ui/compute'
import App from '../../src/App'

const csv = () => {
  const rows = ['date,observed,m'];
  for (let i = 0; i < 90; i++) rows.push(`${new Date(Date.UTC(2002, 0, 1) + i * 864e5).toISOString().slice(0, 10)},${(5 + Math.sin(i / 4)).toFixed(3)},${(5 + Math.sin((i - 2) / 4)).toFixed(3)}`);
  return rows.join('\n');
};
beforeEach(() => {
  __resetComputeCachesForTests();
  useApp.getState().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null });
  useApp.getState().commitDataset(stage(parseDelimited(csv()), { name: 'flow', unit: 'm3s', dateFormat: 'auto', missingValue: null, roles: ['date', 'observed', 'run'] }).commit!);
  useApp.getState().updateView({ activeTab: 'data' });
  cleanup();
});

describe('Plots-only subset bar', () => {
  it('the window/season/resample bar appears on Plots and on no other tab', async () => {
    render(<App />);
    for (const tab of ['Metrics', 'Timing', 'Sandbox', 'Compare', 'Report']) {
      fireEvent.click(screen.getByRole('tab', { name: tab }));
      expect(screen.queryByLabelText('window start')).toBeNull();
    }
    fireEvent.click(screen.getByRole('tab', { name: 'Plots' }));
    expect(await screen.findByLabelText('window start')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /use this data/i })).toBeDisabled();
  });

  it('choosing a window enables the button; pressing it adds a selectable dataset', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Plots' }));
    const start = await screen.findByLabelText('window start');
    fireEvent.change(start, { target: { value: '2002-01-15' } });
    fireEvent.change(screen.getByLabelText('window end'), { target: { value: '2002-02-20' } });
    const btn = screen.getByRole('button', { name: /use this data/i });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    const st = useApp.getState().project;
    expect(st.datasets.length).toBe(2);
    expect(st.activeDatasetId).toBe(st.datasets[1].id);
    // the new dataset is offered in the header dropdown
    const select = screen.getByLabelText('Active dataset') as HTMLSelectElement;
    expect(select.options.length).toBe(2);
    expect(select.value).toBe(st.datasets[1].id);
  });
});
