/**
 * Round 9 (report content) regressions:
 *  - Fig. R2 renders on a square canvas (true 1:1) and embeds square in both
 *    formats (DOCX 320x320; print HTML width 58%, centred).
 *  - The Provenance section is gone from both renderers.
 *  - The privacy sentence is gone from both meta lines.
 *  - The old long citation is replaced by "Developed by Shahvaran et al., 2026"
 *    plus a real hyperlink "Source, License, & Citation" to the repository.
 *  - The user-visible version is two-digit (v1.5), never three-digit.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import Plotly from 'plotly.js-dist-min'
import { useApp } from '../../src/store/store'
import { stage, parseDelimited } from '../../src/ingest/ingest'
import { frameFor, computeForRun, __resetComputeCachesForTests } from '../../src/ui/compute'
import { buildReportImages, REPO_URL, REPORT_CREDIT, REPORT_CREDIT_LINK_TEXT } from '../../src/report/report'
import { APP_VERSION } from '../../src/version'
import App from '../../src/App'

beforeEach(() => {
  __resetComputeCachesForTests();
  vi.mocked(Plotly.toImage).mockClear();
  useApp.getState().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null });
});
afterEach(() => { vi.unstubAllGlobals(); cleanup(); });

const csv = (n = 120) => {
  const rows = ['date,observed,m'];
  for (let i = 0; i < n; i++) rows.push(`${new Date(Date.UTC(2001, 0, 1) + i * 864e5).toISOString().slice(0, 10)},${(5 + 3 * Math.sin(i / 5)).toFixed(4)},${(5 + 3 * Math.sin((i - 2) / 5)).toFixed(4)}`);
  return rows.join('\n');
};
const commit = () => useApp.getState().commitDataset(stage(parseDelimited(csv()), {
  name: 'r9', unit: 'm3s', dateFormat: 'auto', missingValue: null, roles: ['date', 'observed', 'run'],
}).commit!);

describe('report figures', () => {
  it('Fig. R2 is built on a square canvas and embeds square in the DOCX', async () => {
    commit();
    const ds = useApp.getState().project.datasets[0];
    const runs = ds.runs;
    const outputs = runs.map(r => computeForRun(ds, r));
    const images = await buildReportImages(ds, frameFor(ds), runs, outputs);
    const r2 = images.find(i => i.caption.startsWith('Fig. R2'))!;
    expect(r2).toBeTruthy();
    expect(r2.w).toBe(320);
    expect(r2.h).toBe(320);
    const square = vi.mocked(Plotly.toImage).mock.calls.filter((c: any[]) => c[1]?.width === c[1]?.height);
    expect(square.length).toBe(1);
    expect(square[0][1].width).toBe(460);
    const wide = vi.mocked(Plotly.toImage).mock.calls.filter((c: any[]) => c[1]?.width === 920 && c[1]?.height === 430);
    expect(wide.length).toBeGreaterThanOrEqual(1); // R1 (and R3 when a sweep exists)
  });
});

describe('print report content', () => {
  it('credit block with hyperlink present; provenance, privacy sentence, and 3-digit versions absent; square img centred', async () => {
    const writes: string[] = [];
    const fakeWin = {
      document: { write: (h: string) => writes.push(h), close: () => {} },
      focus: () => {}, print: () => {},
    };
    vi.stubGlobal('open', () => fakeWin as any);
    commit();
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Report' }));
    await screen.findByText(/Word or PDF, generated entirely in your browser/);
    fireEvent.click(screen.getByRole('button', { name: 'Print / save PDF' }));
    await waitFor(() => expect(writes.length).toBeGreaterThan(0), { timeout: 8000 });
    const html = writes.join('');
    expect(html).toContain(REPORT_CREDIT);
    expect(html).toContain(`<a href="${REPO_URL}">Source, License, &amp; Citation</a>`);
    expect(REPORT_CREDIT_LINK_TEXT).toBe('Source, License, & Citation');
    expect(html).not.toContain('Provenance');
    expect(html).not.toContain('All computation ran in the browser');
    expect(html).not.toContain('no data left the device');
    expect(APP_VERSION).toMatch(/^\d+\.\d+$/); // two-digit user-visible scheme
    expect(html).toContain(`Hydrograph Metrics Explorer v${APP_VERSION};`);
    expect(html).not.toMatch(/v\d+\.\d+\.\d+/);
    expect(html).toContain('width:58%'); // the square R2 embed
  });
});
