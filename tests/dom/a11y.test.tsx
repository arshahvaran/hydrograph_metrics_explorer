/** AGENT E — accessibility. axe-core structural scan across every populated
 *  tab, plus keyboard semantics for the tab strip. Color-contrast rules need
 *  real layout (measured analytically in ACCESSIBILITY.md instead). */
import { describe, it, expect, beforeAll } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import axe from 'axe-core'
import { useApp } from '../../src/store/store'
import { stage, parseDelimited } from '../../src/ingest/ingest'
import App from '../../src/App'

beforeAll(() => {
  const rows = ['date,observed,modelA,modelB'];
  for (let i = 0; i < 80; i++) rows.push(`${new Date(Date.UTC(2005, 0, 1) + i * 864e5).toISOString().slice(0, 10)},${(6 + 3 * Math.sin(i / 6)).toFixed(3)},${(6 + 3 * Math.sin((i - 2) / 6)).toFixed(3)},${(5 + 3 * Math.sin(i / 6)).toFixed(3)}`);
  useApp.getState().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null });
  useApp.getState().commitDataset(stage(parseDelimited(rows.join('\n')), { name: 'a11y', unit: 'm3s', dateFormat: 'auto', sentinels: true, roles: ['date', 'observed', 'run', 'run'] }).commit!);
});

const AXE_OPTS: axe.RunOptions = {
  rules: {
    'color-contrast': { enabled: false },       // needs layout; measured analytically
    'scrollable-region-focusable': { enabled: false }, // jsdom has no scroll geometry
  },
};

describe('AGENT E: axe structural scan per tab', () => {
  for (const tab of ['Data', 'Metrics', 'Plots', 'Timing', 'Sandbox', 'Compare', 'Report']) {
    it(`${tab} tab has no axe violations`, async () => {
      render(<App />);
      fireEvent.click(screen.getByRole('tab', { name: tab }));
      await new Promise(r => setTimeout(r, 60));   // let panels resolve
      const res = await axe.run(document.body, AXE_OPTS);
      const summary = res.violations.map(v => `${v.id}: ${v.nodes.length}× — ${v.help}`);
      expect(summary, summary.join('\n')).toEqual([]);
    }, 20_000);
  }
});

describe('AGENT E: keyboard semantics', () => {
  it('skip link targets #main', () => {
    render(<App />);
    const skip = screen.getByText(/skip to content/i);
    expect(skip).toHaveAttribute('href', '#main');
    expect(document.getElementById('main')).toBeTruthy();
  });
  it('tab strip: ArrowRight/Left and Home/End move selection', async () => {
    useApp.getState().updateView({ activeTab: 'data' });   // arrows move relative to the selected tab
    render(<App />);
    const dataTab = screen.getByRole('tab', { name: 'Data' });
    dataTab.focus();
    fireEvent.keyDown(dataTab, { key: 'ArrowRight' });
    await new Promise(r => setTimeout(r, 30));
    expect(screen.getByRole('tab', { name: 'Metrics' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Metrics' }), { key: 'End' });
    await new Promise(r => setTimeout(r, 30));
    expect(screen.getByRole('tab', { name: 'Report' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Report' }), { key: 'Home' });
    await new Promise(r => setTimeout(r, 30));
    expect(screen.getByRole('tab', { name: 'Data' })).toHaveAttribute('aria-selected', 'true');
  });
});
