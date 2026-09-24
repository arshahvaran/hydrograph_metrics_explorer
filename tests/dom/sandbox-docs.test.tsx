/** Audit timing-sandbox-09, claims-07, claims-09, claims-11, claims-12. */
import { it, expect, beforeAll, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { execSync } from 'child_process'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { computeAll } from '../../src/metrics/registry'
import { useApp } from '../../src/store/store'
import { __resetComputeCachesForTests } from '../../src/ui/compute'
import { stage, parseDelimited } from '../../src/ingest/ingest'
import App from '../../src/App'

/** A worker that answers after 150 ms, so a pending state is observable. */
class SlowWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: unknown = null;
  postMessage(msg: any) {
    setTimeout(() => {
      try { this.onmessage?.({ data: { id: msg.id, out: computeAll(msg.obs, msg.sim, msg.ctx) } }); }
      catch (err) { this.onmessage?.({ data: { id: msg.id, error: String(err) } }); }
    }, 150);
  }
  terminate() {}
}

beforeAll(() => {
  (globalThis as any).Worker = SlowWorker;
});
beforeEach(() => {
  __resetComputeCachesForTests();
  useApp.getState().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null });
  const rows = ['date,observed,modelA,modelB'];
  for (let i = 0; i < 200; i++) {
    const d = new Date(Date.UTC(2001, 0, 1) + i * 864e5).toISOString().slice(0, 10);
    const o = 5 + 4 * Math.exp(-(((i % 40) - 12) ** 2) / 30);
    rows.push(`${d},${o.toFixed(3)},${(o * 1.02).toFixed(3)},${(o * 3).toFixed(3)}`);
  }
  useApp.getState().commitDataset(stage(parseDelimited(rows.join('\n')), {
    name: 'sb', unit: 'm3s', dateFormat: 'auto', missingValue: null, roles: ['date', 'observed', 'run', 'run'],
  }).commit!);
});

it('timing-sandbox-09: after switching the target, the old target\'s panel is not shown under the new name', async () => {
  render(<App />);
  fireEvent.click(screen.getByRole('tab', { name: 'Sandbox' }));
  await screen.findByText(/lag sweep/i, {}, { timeout: 5000 });
  const select = screen.getByLabelText('Perturbation target simulation') as HTMLSelectElement;
  const optB = Array.from(select.options).find(o => o.textContent === 'modelB')!;
  act(() => { fireEvent.change(select, { target: { value: optB.value } }); });
  // before the new panel arrives, a computing state is shown instead of modelA's numbers
  expect(screen.getByText(/Computing metric panel/i)).toBeInTheDocument();
  await screen.findByText(/lag sweep/i, {}, { timeout: 5000 });
});

it('claims-09: the Sandbox readout includes R²', async () => {
  render(<App />);
  fireEvent.click(screen.getByRole('tab', { name: 'Sandbox' }));
  await screen.findByText(/lag sweep/i, {}, { timeout: 5000 });
  expect(screen.getAllByText('R²').length).toBeGreaterThan(0);
});

it('claims-07: the page says that the Map tab loads OpenStreetMap tiles', () => {
  render(<App />);
  expect(document.body.textContent).toContain('the Map tab loads OpenStreetMap tiles');
  expect(readFileSync('README.md', 'utf8')).toMatch(/OpenStreetMap basemap tiles/);
});

it('claims-07 (review): the fonts are served with the app, and the Map-tab tiles are named wherever the page promises privacy', () => {
  const html = readFileSync('index.html', 'utf8');
  const readme = readFileSync('README.md', 'utf8').replace(/\r?\n\s*/g, ' ');
  // the page itself loads nothing from a third-party host (the fonts are bundled)
  const hosts = new Set((html.match(/https:\/\/[a-z0-9.-]+/g) ?? []).map(u => u.slice(8)));
  hosts.delete('arshahvaran.github.io');           // og:url, the app itself
  expect([...hosts]).toEqual([]);
  expect(readFileSync('src/fonts.ts', 'utf8')).toMatch(/@fontsource-variable\/fraunces/);
  expect(readFileSync('src/main.tsx', 'utf8')).toMatch(/import '\.\/fonts'/);
  for (const f of ['src/theme.css', 'src/App.tsx', 'src/ui/PlotHost.tsx']) {
    expect(readFileSync(f, 'utf8')).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
  }
  // README: no font host, tiles on the Map tab, and what the tiles reveal
  expect(readme).not.toMatch(/Google Fonts/);
  expect(readme).toMatch(/typefaces are served with the app/);
  expect(readme).toMatch(/OpenStreetMap basemap tiles[^.]*station/);
  // og:description is qualified, not an unconditional promise
  const og = html.match(/property="og:description" content="([^"]*)"/)![1];
  expect(og).not.toMatch(/your data never leaves the page\.?$/);
  expect(og).not.toMatch(/Google Fonts/);
  expect(og).toMatch(/OpenStreetMap/);
  // the footer names the tiles and says where the fonts come from
  render(<App />);
  const footer = document.querySelector('footer')!.textContent!;
  expect(footer).not.toMatch(/Google Fonts/);
  expect(footer).toMatch(/fonts are served with the app/);
  expect(footer).toMatch(/OpenStreetMap/);
  // the Map tab does not call the station's area "not your data"
  const map = readFileSync('src/ui/MapTab.tsx', 'utf8');
  expect(map).not.toContain('(not your data)');
  expect(map).toMatch(/station location/);
});

it('claims-09 (review): the README headline claims a panel of metrics in the Sandbox, not every metric', () => {
  const readme = readFileSync('README.md', 'utf8').replace(/\r?\n\s*/g, ' ');
  expect(readme).not.toMatch(/updating every metric live/);
  expect(readme).toMatch(/updating a panel of conventional and shift-tolerant metrics live/);
});

it('claims-11 (review): Python bytecode is neither committed nor left unignored', () => {
  const ignore = readFileSync('.gitignore', 'utf8').split(/\r?\n/).map(s => s.trim());
  expect(ignore).toContain('__pycache__/');
  expect(ignore).toContain('*.pyc');
  let tracked = '';
  try { tracked = execSync('git ls-files', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return; /* not a git checkout */ }
  expect(tracked.split(/\r?\n/).filter(f => /__pycache__|\.pyc$/.test(f))).toEqual([]);
});

it('claims-11/claims-12: the generator writes into the repo; npm test builds before the bundle scan', () => {
  const script = readFileSync('scripts/generate_reference_vectors.py', 'utf8');
  expect(script).not.toMatch(/["']\/home\/[^"']*["']/);   // no absolute home-directory path
  expect(script).toContain('"tests", "fixtures", "reference_vectors.json"');
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  expect(pkg.scripts.test).toMatch(/vite build && vitest run/);
});
