/**
 * Round 14 DOM regressions: hardening against extreme users.
 *  - the one modal dialog (role, aria-modal, focus trap, Escape, focus return);
 *  - uploads above the byte caps are refused before they are read, with the
 *    size, the limit and the remedy in the message;
 *  - the soft-confirmation flow for large tables (Cancel loads nothing,
 *    Continue loads the table);
 *  - extreme inputs end to end through the Data tab: row cap after the cheap
 *    pass, column cap, paste cap, sheet cap, simulation cap, constant
 *    observed, decimal commas per column, hex cells, a transform that
 *    empties pairs, 90 simulations, every simulation hidden, an invalid
 *    project timing block, a huge moving-average window, a dead worker and a
 *    failing job, too few pairs for a bootstrap, a huge project file, the
 *    render boundary, event dates through pairedIndex, and coalesced sandbox
 *    jobs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within, act } from '@testing-library/react'
import { useApp, serialiseProject } from '../../src/store/store'
import { stage, parseDelimited, type ColumnRole } from '../../src/ingest/ingest'
import { LIMITS } from '../../src/ingest/limits'
import { computeAll } from '../../src/metrics/registry'
import { __resetComputeCachesForTests, computeForRun, WORKER_STALE_MESSAGE } from '../../src/ui/compute'
import { ErrorBoundary, RENDER_FAILED_MESSAGE } from '../../src/ui/ErrorBoundary'
import { NO_VISIBLE_RUNS_MESSAGE } from '../../src/ui/TimingTab'
import { parseProjectFile } from '../../src/store/projectLoad'
import App from '../../src/App'

const MB = 1024 * 1024;
const DAY = 864e5;
const iso = (i: number) => new Date(Date.UTC(2003, 0, 1) + i * DAY).toISOString().slice(0, 10);
const wave = (i: number, k: number) => (6 + 4 * Math.sin((i - 2 * k) / 7)).toFixed(3);
const csv = (n: number, sims = 1, val: (i: number, k: number) => string = wave, sep = ',') => {
  const rows = ['date' + sep + 'observed' + sep + Array.from({ length: sims }, (_, k) => `sim${k + 1}`).join(sep)];
  for (let i = 0; i < n; i++) rows.push(iso(i) + sep + val(i, 0) + sep + Array.from({ length: sims }, (_, k) => val(i, k + 1)).join(sep));
  return rows.join('\n');
};
const commit = (text: string, sims = 1, name = 'round14') => {
  const roles: ColumnRole[] = ['date', 'observed', ...Array.from({ length: sims }, () => 'run' as ColumnRole)];
  const st = stage(parseDelimited(text), { name, unit: 'm3s', dateFormat: 'auto', missingValue: null, roles });
  expect(st.commit, st.validation.errors.join('; ')).toBeTruthy();
  return useApp.getState().commitDataset(st.commit!);
};
const pasteBox = () => screen.getByPlaceholderText(/date,observed,simulated_1/) as HTMLTextAreaElement;
const paste = (text: string) => {
  fireEvent.change(pasteBox(), { target: { value: text } });
  fireEvent.click(screen.getByText('Parse pasted data'));
};
const mapRoles = (sims: number) => {
  fireEvent.change(screen.getByLabelText('Role for column date'), { target: { value: 'date' } });
  fireEvent.change(screen.getByLabelText('Role for column observed'), { target: { value: 'observed' } });
  for (let k = 1; k <= sims; k++) fireEvent.change(screen.getByLabelText(`Role for column sim${k}`), { target: { value: 'run' } });
};
const fakeFile = (name: string, size: number, content = 'date,observed,sim\n2001-01-01,1,2\n2001-01-02,2,3') => {
  const f = new File([content], name, { type: 'text/plain' });
  Object.defineProperty(f, 'size', { value: size });
  return f;
};
const upload = async (file: File, label = 'Upload CSV, TXT, TSV or XLSX data files') => {
  await act(async () => { fireEvent.change(screen.getByLabelText(label), { target: { files: [file] } }); });
};
const alertText = async (timeout = 5000) => (await screen.findByRole('alert', {}, { timeout })).textContent ?? '';

beforeEach(() => {
  __resetComputeCachesForTests();
  useApp.getState().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (globalThis as any).Worker;
});

describe('the confirmation dialog', () => {
  it('New asks through an accessible modal: focus inside, Tab wraps, Escape cancels and returns focus, confirm clears', () => {
    commit(csv(60));
    render(<App />);
    const newBtn = screen.getByRole('button', { name: 'New' });
    newBtn.focus();
    fireEvent.click(newBtn);
    const dlg = screen.getByRole('dialog');
    expect(dlg).toHaveAttribute('aria-modal', 'true');
    expect(dlg).toHaveAccessibleName('Start a new project?');
    expect(within(dlg).getByText(/Clear all datasets and start a new project\? Unsaved work is lost\./)).toBeTruthy();
    const cancel = within(dlg).getByRole('button', { name: 'Cancel' });
    const confirm = within(dlg).getByRole('button', { name: 'Start new project' });
    expect(document.activeElement).toBe(cancel);
    confirm.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirm);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useApp.getState().project.datasets.length).toBe(1);
    expect(document.activeElement).toBe(newBtn);
    fireEvent.click(newBtn);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Start new project' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useApp.getState().project.datasets.length).toBe(0);
  });

  it('a notice has one OK button that takes focus, and the backdrop dismisses it', async () => {
    render(<App />);
    await upload(fakeFile('p.hme.json', 150 * MB), 'Load a saved .hme.json project');
    const dlg = await screen.findByRole('dialog');
    expect(dlg).toHaveAccessibleName('Could not load project');
    expect(dlg.textContent).toMatch(/This project file is 150 MB; project files above 100 MB cannot be loaded in the browser\. Save projects with fewer datasets per file\./);
    expect(within(dlg).queryByRole('button', { name: 'Cancel' })).toBeNull();
    const ok = within(dlg).getByRole('button', { name: 'OK' });
    expect(document.activeElement).toBe(ok);
    fireEvent.mouseDown(dlg.parentElement!);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('hard size rejections happen before the file is read', () => {
  it('delimited and workbook uploads above their byte caps are refused with size, limit and remedy', async () => {
    render(<App />);
    const spy = vi.spyOn(File.prototype, 'text');
    await upload(fakeFile('huge.csv', 250 * MB));
    expect(await alertText()).toMatch(/This file is 250 MB; delimited text files above 200 MB cannot be loaded in the browser\. Split the record into shorter periods, remove columns you do not need, or resample/);
    expect(spy).not.toHaveBeenCalled();
    expect(screen.queryByText('Map columns')).toBeNull();
    await upload(fakeFile('book.xlsx', 30 * MB));
    expect(await alertText()).toMatch(/This workbook is 30 MB; workbooks above 25 MB cannot be read in the browser\. Save the sheet as CSV/);
    expect(screen.queryByText('Map columns')).toBeNull();
  });

  it('a delimited file above the row cap is refused after the cheap pass, without parsing', async () => {
    render(<App />);
    const lines = new Array(LIMITS.rows + 2).fill('2001-01-01,1,2');
    lines[0] = 'date,observed,sim';
    await upload(new File([lines.join('\n')], 'rows.csv', { type: 'text/csv' }));
    expect(await alertText(20000)).toMatch(/This file has 1,000,001 data rows; the tool accepts up to 1,000,000\. Split the record into shorter periods or resample to daily or monthly means before uploading\./);
    expect(screen.queryByText('Map columns')).toBeNull();
  }, 40000);

  it('a table above the column cap is refused', () => {
    render(<App />);
    const cols = LIMITS.columns + 1;
    paste([Array.from({ length: cols }, (_, j) => `c${j}`).join(','), Array.from({ length: cols }, () => '1').join(',')].join('\n'));
    expect(screen.getByRole('alert').textContent).toMatch(/This file has 101 columns; the tool accepts up to 100\. Remove the columns you do not need before uploading\./);
    expect(screen.queryByText('Map columns')).toBeNull();
  });
});

describe('soft confirmation for large tables', () => {
  it('asks first; Cancel loads nothing, Continue loads the table', async () => {
    render(<App />);
    const text = csv(LIMITS.warnRows + 1);
    fireEvent.change(pasteBox(), { target: { value: text } });
    fireEvent.click(screen.getByText('Parse pasted data'));
    const dlg = await screen.findByRole('dialog');
    expect(dlg).toHaveAccessibleName('Large dataset');
    expect(dlg.textContent).toMatch(/This table has 250,001 rows and 3 columns \(\d+(\.\d)? MB\)\. Loading and mapping it will take roughly \d+ seconds, each metric panel about \d+ seconds per simulation, and time-series plots will be drawn at reduced resolution \(every point still counts in the metrics\)\./);
    fireEvent.click(within(dlg).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('Map columns')).toBeNull();
    fireEvent.click(screen.getByText('Parse pasted data'));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText(/250,001 data rows/, {}, { timeout: 30000 })).toBeTruthy();
  }, 60000);
});

describe('extreme inputs through the Data tab', () => {
  it('the paste box refuses text above 25 MB and keeps its previous content', () => {
    render(<App />);
    fireEvent.change(pasteBox(), { target: { value: 'a'.repeat(30 * MB) } });
    expect(screen.getByRole('alert').textContent).toMatch(/The pasted text is 30 MB; the paste box accepts up to 25 MB\. Save it as a file and use Upload instead\./);
    expect(pasteBox().value).toBe('');
  });

  it('the editable sheet refuses a paste beyond 2,000 rows and stops adding rows at the cap', () => {
    render(<App />);
    const cell = screen.getByLabelText('row 1 Date');
    const block = Array.from({ length: 2500 }, (_, i) => `${iso(i)}\t1\t2`).join('\n');
    fireEvent.paste(cell, { clipboardData: { getData: () => block } });
    expect(screen.getByRole('alert').textContent).toMatch(/The editable sheet holds up to 2,000 rows; this paste has 2,500 rows\. Paste larger tables into the text box below or upload a file\./);
    expect(screen.getAllByLabelText(/^row \d+ Date$/).length).toBe(8);
    const small = Array.from({ length: 12 }, (_, i) => `${iso(i)}\t1\t2`).join('\n');
    fireEvent.paste(screen.getByLabelText('row 1 Date'), { clipboardData: { getData: () => small } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getAllByLabelText(/^row \d+ Date$/).length).toBe(12);
  });

  it('mapping 61 Simulated columns blocks the commit with the simulation cap message', async () => {
    render(<App />);
    paste(csv(5, 61));
    await screen.findByText('Map columns');
    mapRoles(61);
    const msg = await screen.findByText(/61 columns are mapped as Simulated; the tool computes up to 60 simulations per dataset\. Set the extra columns to Ignore\./);
    expect(msg.className).toBe('error');
    expect(screen.getByText('Use this data →')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Role for column sim61'), { target: { value: 'ignore' } });
    await waitFor(() => expect(screen.getByText('Use this data →')).toBeEnabled());
  });

  it('a constant observed series warns at import and reads n/a, never an exponent, on Metrics', async () => {
    render(<App />);
    paste(csv(40, 1, (i, k) => (k === 0 ? '0.1' : (0.1 + 0.05 * Math.sin(i)).toFixed(4))));
    await screen.findByText('Map columns');
    mapRoles(1);
    expect(await screen.findByText('Observed is constant; correlation and efficiency metrics are undefined for it.')).toBeTruthy();
    fireEvent.click(screen.getByText('Use this data →'));
    fireEvent.click(screen.getByRole('tab', { name: 'Metrics' }));
    const table = await screen.findByRole('table', { name: 'Metric values per simulation' });
    const nseCell = within(table).getByText('NSE', { exact: true });
    await waitFor(() => expect(nseCell.closest('tr')!.querySelectorAll('td')[2].textContent).toBe('n/a'));
    // the table itself: no exponent strings and no raw NaN (the "NaN policy" control label lives outside it)
    expect(table.textContent).not.toMatch(/\d(e|E)\+\d/);
    expect(table.textContent).not.toMatch(/\bNaN\b/);
    for (const id of ['RSR (RMSE/σobs)', 'r (Pearson)', 'KGE (2009)']) {
      expect(within(table).getByText(id, { exact: true }).closest('tr')!.querySelectorAll('td')[2].textContent).toBe('n/a');
    }
  });

  it('decimal commas are decided per column: "1,234" next to "1,23" reads 1.234', async () => {
    render(<App />);
    paste('date;observed;sim1\n2003-01-01;0,5;1,0\n2003-01-02;1,23;2,0\n2003-01-03;1,234;3,0\n2003-01-04;0,9;4,0');
    await screen.findByText('Map columns');
    mapRoles(1);
    const row = (await screen.findByText('observed', { selector: 'td' })).closest('tr')!;
    await waitFor(() => expect(row.querySelectorAll('td')[5].textContent).toBe('1.234'));
  });

  it('a hexadecimal cell is missing, not sixteen', async () => {
    render(<App />);
    paste(csv(10, 1, (i, k) => (k === 1 && i === 3 ? '0x10' : wave(i, k))));
    await screen.findByText('Map columns');
    mapRoles(1);
    const row = (await screen.findByText('sim1', { selector: 'td' })).closest('tr')!;
    await waitFor(() => expect(row.querySelectorAll('td')[1].textContent).toBe('1'));
  });
});

describe('extreme inputs on the analysis tabs', () => {
  it('a sqrt transform on a record with one negative flow says which pairs were dropped', async () => {
    commit(csv(60, 1, (i, k) => (k === 1 && i === 20 ? '-2' : wave(i, k))));
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Metrics' }));
    fireEvent.change(await screen.findByDisplayValue('none'), { target: { value: 'sqrt' } });
    expect(await screen.findByText('1 pair was excluded because it is not positive under the sqrt transform.')).toBeTruthy();
    expect(screen.getByText(/sim1: 59/)).toBeTruthy();
  });

  it('90 simulations reach a complete Metrics table (the cache used to clear itself at the 81st panel)', async () => {
    const st = stage(parseDelimited(csv(30, 3)), { name: 'many', unit: 'm3s', dateFormat: 'auto', missingValue: null, roles: ['date', 'observed', 'run', 'run', 'run'] });
    useApp.getState().commitDataset({ ...st.commit!, runs: Array.from({ length: 90 }, (_, i) => ({ ...st.commit!.runs[i % 3], name: `s${i + 1}` })) });
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Metrics' }));
    const table = await screen.findByRole('table', { name: 'Metric values per simulation' });
    await waitFor(() => expect(screen.queryByText(/Computing in a background worker/)).toBeNull(), { timeout: 20000 });
    expect(within(table).getAllByRole('columnheader').length).toBe(92);
    const nse = within(table).getByText('NSE', { exact: true }).closest('tr')!;
    const cells = Array.from(nse.querySelectorAll('td')).slice(2).map(td => td.textContent);
    expect(cells.length).toBe(90);
    expect(cells.every(c => /^-?\d/.test(c ?? ''))).toBe(true);
  }, 40000);

  it('every simulation hidden: Timing explains instead of crashing', async () => {
    commit(csv(60, 2), 2);
    const ds = useApp.getState().project.datasets[0];
    for (const r of ds.runs) useApp.getState().toggleRunVisible(r.id);
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Timing' }));
    expect(await screen.findByText(NO_VISIBLE_RUNS_MESSAGE)).toBeTruthy();
  });

  it('a project with a null threshold and a NaN band loads with defaults and Timing renders', async () => {
    commit(csv(60));
    const raw = JSON.parse(serialiseProject(useApp.getState().project));
    raw.datasets[0].view.timingConfig.eventThreshold = null;
    raw.datasets[0].view.timingConfig.dtwBand = 'x';
    const { project, warnings } = parseProjectFile(JSON.stringify(raw));
    expect(warnings.join('\n')).toMatch(/timing settings were invalid and have been reset to defaults/);
    useApp.getState().loadProject(project);
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Timing' }));
    expect(await screen.findByText(/Timing summary/)).toBeTruthy();
    expect(screen.getByLabelText(/Default settings/)).toBeChecked();
  });

  it('a huge moving-average window is clamped to 90 with a note, and out-of-range timing values are clamped with a note', async () => {
    commit(csv(120));
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Plots' }));
    const mov = await screen.findByLabelText(/Moving avg/) as HTMLInputElement;
    fireEvent.change(mov, { target: { value: '999999999' } });
    expect(await screen.findByText('Moving average window is limited to 90 steps.')).toBeTruthy();
    expect(mov.value).toBe('90');
    fireEvent.click(screen.getByRole('tab', { name: 'Timing' }));
    fireEvent.click(await screen.findByLabelText(/Default settings/));
    // every timing change re-keys the panel, so the field is re-queried after each edit
    const gap = async () => (await screen.findByLabelText(/Min event gap/)) as HTMLInputElement;
    const stored = () => useApp.getState().project.datasets[0].view.timingConfig.eventMinDistance;
    fireEvent.change(await gap(), { target: { value: '-7' } });
    expect(await screen.findByText('Min event gap is limited to 1 to 100000; the value was set to 1.')).toBeTruthy();
    expect(stored()).toBe(1);
    fireEvent.change(await gap(), { target: { value: '' } });
    expect(stored()).toBe(1);
    fireEvent.change(await gap(), { target: { value: '4' } });
    await waitFor(() => expect(stored()).toBe(4));
    await waitFor(() => expect(screen.queryByText(/Min event gap is limited/)).toBeNull());
  });

  it('a worker that cannot run ends in a message on Metrics and Timing, never a permanent spinner', async () => {
    class DeadWorker { onmessage: unknown = null; onerror: null | (() => void) = null; postMessage() { setTimeout(() => this.onerror?.(), 0); } terminate() {} }
    (globalThis as any).Worker = DeadWorker;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    commit(csv(60));
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Metrics' }));
    expect(await alertText()).toBe(WORKER_STALE_MESSAGE);
    expect(screen.queryByText(/Computing in a background worker/)).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Timing' }));
    expect(await alertText()).toBe(WORKER_STALE_MESSAGE);
    expect(screen.queryByText(/Computing timing metrics/)).toBeNull();
  });

  it('a job that fails inside the worker names the failure', async () => {
    class ErrWorker {
      onmessage: ((e: { data: unknown }) => void) | null = null; onerror: unknown = null;
      postMessage(msg: any) { setTimeout(() => this.onmessage?.({ data: { id: msg.id, error: 'DTW alignment failed on this record' } }), 0); }
      terminate() {}
    }
    (globalThis as any).Worker = ErrWorker;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    commit(csv(60));
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Compare' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Metrics' }));
    expect(await alertText()).toBe('Metrics could not be computed for this simulation: DTW alignment failed on this record.');
  });

  it('too few pairs for a bootstrap: the checkbox produces a reason, not an endless ellipsis', async () => {
    commit(csv(20));
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Metrics' }));
    fireEvent.click(await screen.findByLabelText(/95% CIs/i));
    expect(await screen.findByText(/CIs for sim1: Bootstrap CIs need at least 30 valid pairs; this simulation has 20\./)).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('…', { exact: true })).toBeNull());
  });

  it('the render boundary keeps the page alive with a message', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const Boom = () => { throw new Error('null threshold'); };
    render(<ErrorBoundary><Boom /></ErrorBoundary>);
    expect(screen.getByRole('alert').textContent).toContain(RENDER_FAILED_MESSAGE);
    expect(screen.getByRole('alert').textContent).toContain('null threshold');
  });

  it('event dates in the Timing table go through pairedIndex (a gap ahead of the event no longer shifts it)', async () => {
    const peak = (i: number, k: number) => (4 + 3 * Math.exp(-(((i % 40) - 20 - 2 * k) ** 2) / 8)).toFixed(4);
    commit(csv(120, 1, (i, k) => (k === 0 && i < 7 ? 'NA' : peak(i, k))));
    const ds = useApp.getState().project.datasets[0];
    const out = computeForRun(ds, ds.runs[0]);
    const first = out.extras.events!.events[0];
    const mapped = iso(out.pairedIndex![first.obs.start]);
    const unmapped = iso(first.obs.start);
    expect(mapped).not.toBe(unmapped);
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Timing' }));
    const table = await screen.findByRole('table', { name: 'Detected events and per-event errors' });
    const firstRow = within(table).getAllByRole('row')[1];
    expect(firstRow.textContent).toContain(mapped);
    expect(firstRow.textContent).not.toContain(unmapped);
  });

  it('sandbox slider bursts are coalesced: far fewer panels are posted than positions dragged', async () => {
    let posted = 0;
    class SlowWorker {
      onmessage: ((e: { data: unknown }) => void) | null = null; onerror: unknown = null;
      postMessage(msg: any) {
        posted++;
        setTimeout(() => this.onmessage?.({ data: { id: msg.id, out: computeAll(msg.obs, msg.sim, msg.ctx) } }), 5);
      }
      terminate() {}
    }
    (globalThis as any).Worker = SlowWorker;
    commit(csv(80));
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Sandbox' }));
    const sliders = await screen.findAllByRole('slider', {}, { timeout: 5000 });
    const before = posted;
    const shift = sliders[0] as HTMLInputElement;
    for (let v = -20; v <= 20; v++) fireEvent.change(shift, { target: { value: String(v) } });
    await waitFor(() => expect(useApp.getState().project.datasets[0].view.sandbox.shiftSteps).toBe(20));
    await screen.findByText(/lag sweep/i, {}, { timeout: 5000 });
    await new Promise(r => setTimeout(r, 200));
    expect(posted - before).toBeLessThan(12);
    expect(screen.getAllByRole('slider').length).toBe(sliders.length);
  }, 20000);
});


describe('round 14 follow-ups: error scoping, project dates, correction notes', () => {
  it('a failure under one setting does not outlive it: the next settings that compute clear the message, the failed settings keep theirs', async () => {
    let failedOnce = false;
    class FlakyWorker {
      onmessage: ((e: { data: unknown }) => void) | null = null; onerror: unknown = null;
      postMessage(msg: any) {
        setTimeout(() => {
          if (!failedOnce) { failedOnce = true; this.onmessage?.({ data: { id: msg.id, error: 'DTW alignment failed on this record' } }); return; }
          this.onmessage?.({ data: { id: msg.id, out: computeAll(msg.obs, msg.sim, msg.ctx) } });
        }, 0);
      }
      terminate() {}
    }
    (globalThis as any).Worker = FlakyWorker;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    commit(csv(60));
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Metrics' }));
    const failure = 'Metrics could not be computed for this simulation: DTW alignment failed on this record.';
    expect(await alertText()).toBe(failure);
    // a transform change re-keys the panel: the new job succeeds and the message stays with the old settings
    fireEvent.change(screen.getByLabelText(/^Transform/), { target: { value: 'sqrt' } });
    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByText(/Computing in a background worker/)).toBeNull();
    }, { timeout: 5000 });
    // the settings that failed are never re-requested, so revisiting them shows their message again
    fireEvent.change(screen.getByLabelText(/^Transform/), { target: { value: 'none' } });
    expect(await alertText()).toBe(failure);
  });

  it('a project with dates beyond the JavaScript date range loads with a warning naming the dataset, and every tab renders', async () => {
    commit(csv(60));
    const raw = JSON.parse(serialiseProject(useApp.getState().project));
    raw.datasets[0].dates[0] = 1e16;
    raw.datasets[0].dates[1] = -8.64e15 - 1;
    raw.datasets[0].dates[2] = null;
    render(<App />);
    await upload(new File([JSON.stringify(raw)], 'dates.hme.json', { type: 'application/json' }), 'Load a saved .hme.json project');
    // a dataset is open, so Load first asks before replacing it (audit project-08)
    const ask = await screen.findByRole('dialog', {}, { timeout: 5000 });
    expect(ask).toHaveAccessibleName('Replace the open project?');
    await act(async () => { fireEvent.click(within(ask).getByRole('button', { name: 'Load project' })); });
    const dlg = await screen.findByRole('dialog', { name: 'Project loaded' }, { timeout: 5000 });
    expect(dlg).toHaveAccessibleName('Project loaded');
    expect(dlg.textContent).toContain('dataset "round14": 3 rows with a missing or out-of-range date were skipped.');
    fireEvent.click(within(dlg).getByRole('button', { name: 'OK' }));
    const ds = useApp.getState().project.datasets[0];
    expect(ds.dates.length).toBe(57);
    expect(ds.dates.every(d => Math.abs(d) <= 8.64e15)).toBe(true);
    const tabs: [string, () => Promise<unknown>][] = [
      ['Data', () => screen.findByRole('heading', { name: /Active dataset: round14/ }, { timeout: 5000 })],
      ['Plots', () => screen.findByLabelText(/Moving avg/, {}, { timeout: 5000 })],
      ['Metrics', () => screen.findByLabelText(/^Transform/, {}, { timeout: 5000 })],
      ['Timing', () => screen.findByRole('heading', { name: /Timing summary/ }, { timeout: 5000 })],
      ['Sandbox', () => screen.findByRole('heading', { name: /Perturbation sandbox/ }, { timeout: 5000 })],
      ['Compare', () => screen.findByRole('heading', { name: /Compare simulations/ }, { timeout: 5000 })],
      ['Map', () => screen.findByRole('heading', { name: /Station/ }, { timeout: 5000 })],
      ['Report', () => screen.findByRole('heading', { name: /^Report/ }, { timeout: 5000 })],
    ];
    for (const [tab, marker] of tabs) {
      fireEvent.click(screen.getByRole('tab', { name: tab }));
      await marker();
      expect(screen.queryByText(RENDER_FAILED_MESSAGE, { exact: false })).toBeNull();
    }
  }, 30000);

  it('a fractional value says it was rounded; only an out-of-range value gets the range wording', async () => {
    commit(csv(120));
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Plots' }));
    const mov = await screen.findByLabelText(/Moving avg/) as HTMLInputElement;
    fireEvent.change(mov, { target: { value: '2.5' } });
    expect(await screen.findByText('Moving average window must be a whole number of steps; 2.5 was rounded to 3.')).toBeTruthy();
    fireEvent.change(mov, { target: { value: '999' } });
    expect(await screen.findByText('Moving average window is limited to 90 steps.')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Timing' }));
    fireEvent.click(await screen.findByLabelText(/Default settings/));
    const peak = async () => (await screen.findByLabelText(/Peak window/)) as HTMLInputElement;
    const stored = () => useApp.getState().project.datasets[0].view.timingConfig.peakMatchTolerance;
    fireEvent.change(await peak(), { target: { value: '2.5' } });
    expect(await screen.findByText('Peak window must be a whole number of steps; 2.5 was rounded to 3.')).toBeTruthy();
    expect(stored()).toBe(3);
    fireEvent.change(await peak(), { target: { value: '99999' } });
    expect(await screen.findByText('Peak window is limited to 1 to 10000; the value was set to 10000.')).toBeTruthy();
    expect(stored()).toBe(10000);
    fireEvent.change(await peak(), { target: { value: '4' } });
    await waitFor(() => expect(stored()).toBe(4));
    await waitFor(() => expect(screen.queryByText(/Peak window (is limited|must be)/)).toBeNull());
  });
});
