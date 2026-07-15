/**
 * Round 7 regressions (author comments, 2026-07-15):
 *  Compare: split priority panel (checklist left, weights table right, weight
 *  defaults to 1), essentials-only candidates, lay wording, Simulation column,
 *  no bold outside table headers, "more proper time" sentence.
 *  Header: Load button precedes New. Map: two inactive beta upload
 *  placeholders; the OpenStreetMap caption paragraph is gone.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react'
import { useApp } from '../../src/store/store'
import { stage, parseDelimited } from '../../src/ingest/ingest'
import { __resetComputeCachesForTests } from '../../src/ui/compute'
import { CANDIDATE_IDS } from '../../src/ui/CompareTab'
import App from '../../src/App'

beforeEach(() => {
  __resetComputeCachesForTests();
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
    name: 'round7', unit: 'm3s', dateFormat: 'auto', missingValue: null, roles: ['date', 'observed', 'run', 'run'],
  }).commit!);

async function openCompare() {
  commit();
  render(<App />);
  fireEvent.click(screen.getByRole('tab', { name: 'Compare' }));
  await screen.findByText(/Priority metrics/);
}

describe('Compare tab, round 7', () => {
  it('shows the new subtitle and a checklist of exactly the essentials candidates', async () => {
    await openCompare();
    expect(screen.getByText('select the metrics that matter for your application, then enter the relative weights')).toBeTruthy();
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes.length).toBe(CANDIDATE_IDS.length);
  });

  it('ticking a metric adds a weight-1 row to the table; the weight is editable; unticking removes it', async () => {
    await openCompare();
    const table = screen.getByRole('table', { name: 'Selected priority metrics and weights' });
    // defaults (4) appear as rows until the user picks their own
    expect(within(table).getAllByRole('row').length).toBe(1 + 4);
    const rmseBox = screen.getByRole('checkbox', { name: /RMSE/i });
    fireEvent.click(rmseBox);
    const w = within(table).getByLabelText(/weight for RMSE/i) as HTMLInputElement;
    expect(w.value).toBe('1');
    fireEvent.change(w, { target: { value: '2.5' } });
    expect((within(table).getByLabelText(/weight for RMSE/i) as HTMLInputElement).value).toBe('2.5');
    fireEvent.click(screen.getByRole('checkbox', { name: /RMSE/i }));
    expect(within(table).queryByLabelText(/weight for RMSE/i)).toBeNull();
  });

  it('the remove button in the table clears the row and unticks the checklist', async () => {
    await openCompare();
    const table = screen.getByRole('table', { name: 'Selected priority metrics and weights' });
    fireEvent.click(within(table).getByRole('button', { name: /remove NSE/i }));
    expect(within(table).queryByLabelText(/weight for NSE/i)).toBeNull();
    expect((screen.getByRole('checkbox', { name: /^NSE/i }) as HTMLInputElement).checked).toBe(false);
  });

  it('ranking table: Simulation column, no strong/bold body cells, lay explanation, "more proper time" sentence', async () => {
    await openCompare();
    const rank = await screen.findByRole('table', { name: 'Composite ranking of simulations' });
    expect(within(rank).getByRole('columnheader', { name: /^Simulation$/ })).toBeTruthy();
    const body = rank.querySelector('tbody')!;
    expect(body.querySelectorAll('strong').length).toBe(0);
    for (const td of Array.from(body.querySelectorAll('td'))) {
      expect((td as HTMLElement).style.fontWeight).not.toBe('600');
    }
    expect(screen.getByText(/How scoring works: for each selected metric/)).toBeTruthy();
    // defaults include timing metrics, so the timing-aware sentence shows with the new wording
    expect(document.body.textContent).toContain('at a more proper time, not just a more proper average.');
    expect(document.body.textContent).toContain('Recommended simulation:');
  });
});

describe('header buttons, round 7', () => {
  it('Load comes before New', () => {
    commit();
    render(<App />);
    const load = screen.getByText('Load');
    const newBtn = screen.getByRole('button', { name: 'New' });
    // DOCUMENT_POSITION_FOLLOWING = 4: newBtn follows load in document order
    expect(load.compareDocumentPosition(newBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
});

describe('Map tab, round 7', () => {
  it('has two inactive beta upload placeholders and no OpenStreetMap caption', async () => {
    commit();
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Map' }));
    const gauge = await screen.findByRole('button', { name: /Add gauge station \(SHP or KML\/KMZ\) beta/i });
    const catchment = screen.getByRole('button', { name: /Add catchment \(SHP or KML\/KMZ\) beta/i });
    expect(gauge).toBeDisabled();
    expect(catchment).toBeDisabled();
    expect(screen.queryByText(/Map data © OpenStreetMap contributors/)).toBeNull();
  });
});
