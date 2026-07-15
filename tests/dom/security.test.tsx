/** AGENT F — client-side attack surface: XSS via user-supplied names, the
 *  print-report HTML path, and CSV export end-to-end. */
import { describe, it, expect, beforeAll } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { useApp } from '../../src/store/store'
import { stage, parseDelimited } from '../../src/ingest/ingest'
import App from '../../src/App'

const HOSTILE = `<img src=x onerror="(window as any).__pwned=1">`;
const HOSTILE_RUN = `=HYPERLINK("http://evil"),run<script>window.__pwned2=1</script>`;

beforeAll(() => {
  const rows = [`date,observed,"${HOSTILE_RUN.replace(/"/g, '""')}"`];
  for (let i = 0; i < 40; i++) rows.push(`${new Date(Date.UTC(2006, 0, 1) + i * 864e5).toISOString().slice(0, 10)},${(6 + Math.sin(i / 5)).toFixed(3)},${(6 + Math.sin((i - 2) / 5)).toFixed(3)}`);
  useApp.getState().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null });
  useApp.getState().commitDataset(stage(parseDelimited(rows.join('\n')), {
    name: HOSTILE, unit: 'm3s', dateFormat: 'auto', missingValue: null, roles: ['date', 'observed', 'run'],
  }).commit!);
});

describe('XSS: hostile dataset and run names render as text everywhere', () => {
  it('no script executes, no element is injected, names appear literally', async () => {
    render(<App />);
    for (const tab of ['Metrics', 'Compare', 'Report', 'Data']) {
      fireEvent.click(screen.getByRole('tab', { name: tab }));
      await new Promise(r => setTimeout(r, 40));
    }
    expect((window as any).__pwned).toBeUndefined();
    expect((window as any).__pwned2).toBeUndefined();
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(document.querySelector('script[data-injected], body script:not([src])')).toBeNull();
    expect(document.body.textContent).toContain('<img src=x');       // literal, escaped by React
  });
});

describe('print report: user strings are HTML-escaped into the print window', () => {
  it('captured document.write output contains no live tags from names', async () => {
    const { openPrintReport } = await import('../../src/report/report');
    const { frameFor, computeForRun } = await import('../../src/ui/compute');
    const ds = useApp.getState().project.datasets[0];
    const frame = frameFor(ds);
    const runs = ds.runs.filter(r => r.visible);
    const outputs = runs.map(r => computeForRun(ds, r));
    let captured = '';
    const fakeWin: any = {
      document: { write: (h: string) => { captured += h; }, close() {} },
      focus() {},
      print() {},   // openPrintReport calls this on a 350 ms timer
    };
    const origOpen = window.open;
    (window as any).open = () => fakeWin;
    try {
      openPrintReport({
        ds, frame, runs, outputs, images: [],
        sections: { summary: true, metrics: true, plots: false, timing: true, ranking: true, provenance: true },
        notes: 'note with <script>bad()</script>',
      } as any);
      expect(captured.length).toBeGreaterThan(100);
      expect(captured).not.toContain('<img src=x');
      expect(captured).toContain('&lt;img src=x');
      expect(captured).not.toContain('<script>window.__pwned2');
      expect(captured).not.toContain('<script>bad()');
    } finally {
      (window as any).open = origOpen;
    }
  });
});

describe('CSV export end-to-end: injection guard and quoting survive the UI path', () => {
  it('exported blob prefixes the formula and keeps columns intact', async () => {
    const blobs: Blob[] = [];
    const orig = URL.createObjectURL;
    (URL as any).createObjectURL = (b: Blob) => { blobs.push(b); return 'blob:capture'; };
    try {
      render(<App />);
      fireEvent.click(screen.getByRole('tab', { name: 'Metrics' }));
      const btn = await screen.findByRole('button', { name: /export csv/i }, { timeout: 3000 });
      fireEvent.click(btn);
      await waitFor(() => expect(blobs.length).toBeGreaterThan(0));
      const text = await blobs[0].text();
      const header = text.split('\n').find(l => l.startsWith('metric'))!;
      expect(header).toContain(`"'=HYPERLINK`);                        // apostrophe-prefixed AND quoted
      expect(header.match(/HYPERLINK/g)!.length).toBe(1);
      const dataLine = text.split('\n').find(l => l.startsWith('NSE') || l.includes('NSE'))!;
      expect(dataLine).toBeTruthy();
    } finally {
      (URL as any).createObjectURL = orig;
    }
  });
});
