/**
 * Round 13 regressions (small-screen layout).
 *
 * The desktop layout is deliberately untouched. Every responsive rule added
 * in this round lives inside a media query, so these tests pin two things:
 *  - the markup hooks the narrow-screen rules attach to (a scroll container
 *    around every wide table, the scroll class on the tab strip, the wrapper
 *    around the fixed-size plot canvas);
 *  - the fact that none of those rules can reach a desktop window, by
 *    stripping the media blocks out of theme.css and asserting the new
 *    selectors do not survive.
 * The square-figure contract is pinned here too: 1:1 figures stay 440 by 440
 * with autosize off, and every other figure keeps passing width null with
 * autosize true (Plotly.react retains layout keys that stop being passed).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import Plotly from 'plotly.js-dist-min'
import { readFileSync } from 'fs'
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

const DAY = 86_400_000;
const val = (i: number) => (6 + 4 * Math.sin(i / 7)).toFixed(3);
const csv = (n: number) => {
  const rows = ['date,observed,modelA,modelB'];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2003, 0, 1) + i * DAY).toISOString().slice(0, 10);
    rows.push(`${d},${val(i)},${val(i - 2)},${val(i + 1)}`);
  }
  return rows.join('\n');
};
const commit = (n = 120) => useApp.getState().commitDataset(stage(parseDelimited(csv(n)), {
  name: 'round13', unit: 'm3s', dateFormat: 'auto', missingValue: null,
  roles: ['date', 'observed', 'run', 'run'],
}).commit!);

const SCROLLERS = '.mapscroll, .tblscroll';
const scrolled = (el: Element | null) => Boolean(el?.closest(SCROLLERS));
const lastLayout = (): any => vi.mocked(Plotly.react).mock.calls.at(-1)?.[2];

const CSS = readFileSync('src/theme.css', 'utf8');
const HTML = readFileSync('index.html', 'utf8');

/** theme.css with every @media block removed: what a desktop window sees. */
function stripMediaBlocks(css: string): string {
  let out = '', i = 0;
  for (;;) {
    const at = css.indexOf('@media', i);
    if (at < 0) return out + css.slice(i);
    out += css.slice(i, at);
    let depth = 0, j = css.indexOf('{', at);
    if (j < 0) return out;
    for (; j < css.length; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}' && --depth === 0) { j++; break; }
    }
    i = j;
  }
}

describe('small screens: page chrome', () => {
  it('index.html declares the responsive viewport', () => {
    expect(HTML).toMatch(/<meta\s+name="viewport"\s+content="width=device-width,\s*initial-scale=1(\.0)?"/);
  });

  it('the tab strip carries the horizontal scroll class and the class scrolls only under a media query', () => {
    commit();
    const { container } = render(<App />);
    const nav = container.querySelector('nav.tabs')!;
    expect(nav, 'the tab strip should exist').toBeTruthy();
    expect(nav.classList.contains('tabs-scroll'), 'tab strip needs the scroll hook').toBe(true);
    expect(within(nav as HTMLElement).getAllByRole('tab')).toHaveLength(8);
    expect(CSS).toMatch(/\.tabs-scroll\s*\{[^}]*overflow-x:\s*auto/);
    expect(stripMediaBlocks(CSS)).not.toMatch(/\.tabs-scroll/);
  });

  it('the narrow-screen rules cannot reach a desktop window', () => {
    const desktop = stripMediaBlocks(CSS);
    for (const sel of ['.tabs-scroll', '.plotwrap']) {
      expect(desktop, `${sel} must not apply to a desktop window`).not.toContain(sel);
    }
    // the table wrapper is the one exception: it exists outside a media query
    // purely to take itself out of the layout, so the tables it wraps keep the
    // box role they had before (grid item, block in flow) on a desktop window
    expect(desktop).toMatch(/\.tblscroll\s*\{\s*display:\s*contents;\s*\}/);
    expect(desktop.match(/\.tblscroll/g)).toHaveLength(1);
    // and the touch sizing is gated on a coarse pointer, never on width alone
    expect(CSS).toMatch(/@media \(pointer: coarse\)\s*\{[\s\S]*?min-height:\s*40px/);
    expect(desktop).not.toMatch(/min-height:\s*40px/);
  });
});

describe('small screens: wide tables sit in scroll containers', () => {
  it('the staged column-mapping and validation tables are both scrollable', async () => {
    render(<App />);
    fireEvent.change(screen.getByPlaceholderText(/date,observed,simulated_1/), {
      target: { value: csv(30) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Parse pasted data' }));
    await screen.findByText(/data rows/, undefined, { timeout: 5000 });
    const tables = [...document.querySelectorAll('table.grid')];
    // editable sheet, column mapping, per-series validation
    expect(tables).toHaveLength(3);
    const validation = tables.find(t => /Valid pairs vs obs/.test(t.textContent ?? ''));
    expect(validation, 'the per-series validation table should be on screen').toBeTruthy();
    for (const t of tables) {
      expect(scrolled(t), `${t.querySelector('tr')?.textContent?.slice(0, 40)} is not in a scroll container`).toBe(true);
    }
  });

  it('Metrics, Timing, Compare and Sandbox tables are all scrollable', async () => {
    commit();
    render(<App />);
    for (const [tab, probe] of [
      ['Metrics', 'Metric values per simulation'],
      ['Timing', 'Timing summary per simulation'],
      ['Compare', 'Composite ranking of simulations'],
    ] as const) {
      fireEvent.click(screen.getByRole('tab', { name: tab }));
      const table = await screen.findByLabelText(probe, undefined, { timeout: 8000 });
      expect(scrolled(table), `${probe} is not in a scroll container`).toBe(true);
    }
    expect(scrolled(screen.getByLabelText('Selected priority metrics and weights'))).toBe(true);

    fireEvent.click(screen.getByRole('tab', { name: 'Sandbox' }));
    const section = (await screen.findByText(/Metrics comparison/, undefined, { timeout: 8000 })).closest('section')!;
    const tables = [...section.querySelectorAll('table.grid')];
    expect(tables).toHaveLength(2);
    for (const t of tables) expect(scrolled(t)).toBe(true);
    // the header cells stay plain bold headers (round 6 rule, unchanged here)
    for (const h of within(section as HTMLElement).getAllByRole('columnheader')) {
      expect(h.className).not.toMatch(/\bmuted\b/);
    }
  });
});

describe('small screens: figures', () => {
  it('the plot canvas sits in a wrapper the narrow rules can scroll', async () => {
    commit();
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Plots' }));
    await waitFor(() => expect(document.querySelector('.plothost')).toBeTruthy());
    const host = document.querySelector('.plothost')!;
    expect(host.parentElement?.classList.contains('plotwrap')).toBe(true);
    expect(CSS).toMatch(/\.plotwrap\s*\{[^}]*overflow-x:\s*auto/);
  });

  it('square figures stay 440 by 440 and other figures keep width null with autosize', async () => {
    commit();
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Plots' }));
    fireEvent.click(await screen.findByRole('button', { name: '1:1 scatter' }));
    await waitFor(() => {
      const L = lastLayout();
      expect(L?.width).toBe(440);
      expect(L?.height).toBe(440);
      expect(L?.autosize).toBe(false);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Time series' }));
    await waitFor(() => {
      const L = lastLayout();
      expect(L?.width).toBe(null);
      expect(L?.autosize).toBe(true);
    });
  });
});
