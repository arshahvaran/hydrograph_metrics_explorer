/**
 * Plots-tab audit regressions (plots-01, fdc-05, plots-03, -04, -05, -06, -07,
 * -08 / de-sd-08 / timing-sandbox-06, -09, -10). Each test renders the real
 * App with Plotly stubbed and reads the traces, layouts and CSV exports.
 *
 *  - plots-01 / fdc-05: FDC, Q-Q and DOY climatology use the same paired
 *    sample as the metrics (applyNanPolicy, 'pairwise' by default). Expected
 *    values were computed independently in numpy (audit scratch
 *    plots-01/ref.py).
 *  - plots-03: on a log y axis, Plotly shape positions are data values
 *    (plotly.js 2.35 shapePositionToRange uses d2r), so the threshold line
 *    is passed in data units.
 *  - plots-04: the DTW alignment plot draws the aligned run itself, never a
 *    series looked up by display name.
 *  - plots-05 / plots-06: day-of-year plots bin on the calendar day (since the
 *    repair plots-06-r1/r2 the 365-day Season calendar: Mar 1 is 60 in every
 *    year) and average sub-daily samples to one value per day.
 *  - plots-07 / plots-08 / plots-09: the CSV holds what is plotted, with
 *    self-describing trace names.
 *  - plots-10: the y-axis title follows the view mode.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import Plotly from 'plotly.js-dist-min'
import { readFileSync } from 'node:fs'
import { useApp } from '../../src/store/store'
import { stage, parseDelimited } from '../../src/ingest/ingest'
import { __resetComputeCachesForTests, computeForRun } from '../../src/ui/compute'
import App from '../../src/App'

const DAY = 86_400_000, HOUR = 3_600_000;

beforeEach(() => {
  __resetComputeCachesForTests();
  vi.mocked(Plotly.react).mockClear();
  useApp.getState().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null });
});
afterEach(() => cleanup());

const commitCsv = (csv: string) =>
  useApp.getState().commitDataset(stage(parseDelimited(csv), {
    name: 'audit', unit: 'm3s' as any, dateFormat: 'auto', missingValue: null, roles: ['date', 'observed', 'run'],
  }).commit!);

const lastCall = (pred: (t: any) => boolean): { traces: any[]; layout: any } | null => {
  const calls = vi.mocked(Plotly.react).mock.calls;
  for (let k = calls.length - 1; k >= 0; k--) {
    const tr = calls[k][1] as any[];
    if (Array.isArray(tr) && tr.some(pred)) return { traces: tr, layout: calls[k][2] as any };
  }
  return null;
};

async function openPlot(label: string, pred: (t: any) => boolean): Promise<any[]> {
  fireEvent.click(await screen.findByText(label));
  await waitFor(() => expect(lastCall(pred)).toBeTruthy());
  return lastCall(pred)!.traces;
}

async function captureCsv(button: HTMLElement): Promise<string> {
  let captured: Blob | null = null;
  const orig = window.URL.createObjectURL;
  window.URL.createObjectURL = ((b: Blob) => { captured = b; return 'blob:x'; }) as any;
  try { fireEvent.click(button); } finally { window.URL.createObjectURL = orig; }
  expect(captured).toBeTruthy();
  return await (captured as unknown as Blob).text();
}

const dailyCsv = (start: number, n: number, f: (i: number, t: number) => [string, string], header = 'date,observed,modelA') => {
  const rows = [header];
  for (let i = 0; i < n; i++) {
    const t = start + i * DAY;
    const [o, s] = f(i, t);
    rows.push(`${new Date(t).toISOString().slice(0, 10)},${o},${s}`);
  }
  return rows.join('\n');
};

// sim == obs on every observed day; obs missing on the 60 wettest days (70..129)
const perfectSimWithObsGap = () => dailyCsv(Date.UTC(2003, 0, 1), 365, i => {
  const f = (2 + 20 * Math.exp(-(((i - 100) / 15) ** 2)) + Math.sin(i / 5)).toFixed(4);
  return [i >= 70 && i < 130 ? '' : f, f];
});

const openPlots = () => { render(<App />); fireEvent.click(screen.getByRole('tab', { name: 'Plots' })); };

describe('plots-01 / fdc-05: FDC, Q-Q and DOY use the paired sample of the metrics', () => {
  it('perfect simulation with observed gaps: FDC curves coincide (305 paired steps)', async () => {
    commitCsv(perfectSimWithObsGap());
    openPlots();
    const tr = await openPlot('Flow duration', t => t.name === 'modelA' && Array.isArray(t.x) && t.x[0] < 1);
    const obsT = tr[0], simT = tr.find(t => t.name === 'modelA');
    expect(obsT.y.length).toBe(305);
    expect(simT.y.length).toBe(305);
    expect(simT.y.slice(0, 3)).toEqual([3.223, 3.1654, 3.1552]);
    expect(simT.y).toEqual(obsT.y);
    expect(screen.getByText(/paired time steps.*n = 305/)).toBeInTheDocument();
  });

  it('perfect simulation with observed gaps: Q-Q lies on the 1:1 line', async () => {
    commitCsv(perfectSimWithObsGap());
    openPlots();
    const tr = await openPlot('Q-Q', t => t.mode === 'lines+markers');
    const q = tr.find(t => t.mode === 'lines+markers');
    expect(q.x[98]).toBeCloseTo(3.151844, 6);   // numpy.quantile(paired, 0.99)
    expect(q.y[98]).toBeCloseTo(3.151844, 6);
    for (let k = 0; k < 99; k++) expect(q.y[k]).toBeCloseTo(q.x[k], 9);
  });

  it('perfect simulation with observed gaps: DOY medians coincide', async () => {
    commitCsv(perfectSimWithObsGap());
    openPlots();
    const tr = await openPlot('DOY climatology', t => t.name === 'modelA (median)');
    const obsMed = tr.find(t => t.name === 'observed (median)');
    const simMed = tr.find(t => t.name === 'modelA (median)');
    expect(simMed.x.length).toBe(305);
    expect(simMed.x).toEqual(obsMed.x);
    expect(simMed.y).toEqual(obsMed.y);
  });

  it('shipped Sample 1 (HYMOD, 123 obs gaps): FDC and Q-Q are the paired ones', async () => {
    commitCsv(readFileSync('public/samples/sample_hymod_raven.csv', 'utf8'));
    openPlots();
    const f = await openPlot('Flow duration', t => t.name === 'HYMOD' && Array.isArray(t.x) && t.x[0] < 1);
    const sim = f.find(t => t.name === 'HYMOD'), obs = f[0];
    const ds = useApp.getState().project.datasets[0];
    expect(computeForRun(ds, ds.runs[0]).n).toBe(2068);   // the metrics' paired n
    expect(obs.y.length).toBe(2068);
    expect(sim.y.length).toBe(2068);
    const at = (pct: number) => sim.y[sim.x.findIndex((p: number) => p >= pct)];
    // numpy on the 2068 paired days (unpaired curve: 0.354308, 11.13, 22.6348)
    expect(at(95)).toBeCloseTo(0.488244, 6);
    expect(at(70)).toBeCloseTo(13.69, 2);
    expect(at(50)).toBeCloseTo(24.5667, 4);
    const q = (await openPlot('Q-Q', t => t.mode === 'lines+markers')).find(t => t.mode === 'lines+markers');
    expect(q.x[6]).toBeCloseTo(4.67, 6);          // numpy.quantile(paired obs, 0.07)
    expect(q.y[6]).toBeCloseTo(2.0086706, 6);     // unpaired: 0.6293855
    expect(q.y[49]).toBeCloseTo(24.65745, 5);
  }, 30000);

  it('two simulations with different gaps: one observed curve per pairing', async () => {
    const rows = ['date,observed,A,B'];
    for (let i = 0; i < 100; i++) {
      const d = new Date(Date.UTC(2003, 0, 1) + i * DAY).toISOString().slice(0, 10);
      rows.push(`${d},${10 + i},${i < 50 ? '' : 10 + i},${10 + i}`);
    }
    useApp.getState().commitDataset(stage(parseDelimited(rows.join('\n')), {
      name: 'two', unit: 'm3s' as any, dateFormat: 'auto', missingValue: null, roles: ['date', 'observed', 'run', 'run'],
    }).commit!);
    openPlots();
    const tr = await openPlot('Flow duration', t => t.name === 'B');
    const a = tr.find(t => t.name === 'A'), b = tr.find(t => t.name === 'B');
    const obsCurves = tr.filter(t => /^observed/.test(t.name));
    expect(a.y.length).toBe(50);
    expect(b.y.length).toBe(100);
    expect(obsCurves.map(t => t.y.length).sort((x, y) => x - y)).toEqual([50, 100]);
    expect(obsCurves.find(t => t.y.length === 50).y).toEqual(a.y);
    expect(obsCurves.find(t => t.y.length === 100).y).toEqual(b.y);
  });
});

describe('plots-03: threshold line on a log y axis', () => {
  it('passes the threshold in data units on linear and log axes', async () => {
    commitCsv(dailyCsv(Date.UTC(2003, 0, 1), 90, i => [(6 + 4 * Math.sin(i / 7)).toFixed(3), '5']));
    openPlots();
    const thr = await screen.findByLabelText(/Threshold/);
    fireEvent.change(thr, { target: { value: '100' } });
    fireEvent.click(screen.getByLabelText('Log(y)'));
    await waitFor(() => {
      const L = vi.mocked(Plotly.react).mock.calls.at(-1)?.[2] as any;
      expect(L?.yaxis?.type).toBe('log');
      expect(L?.shapes?.[0]?.y0).toBe(100);
      expect(L?.shapes?.[0]?.y1).toBe(100);
    });
  });
});

describe('plots-04: DTW alignment draws the aligned run, not a name match', () => {
  it("headers 'Q [obs]' and 'Q [sim]' give equal names; the simulated trace is still the simulation", async () => {
    const rows = ['date,Q [obs],Q [sim]'];
    for (let i = 0; i < 300; i++) {
      const t = Date.UTC(2003, 0, 1) + i * DAY;
      const o = 5 + 4 * Math.exp(-(((i % 60) - 20) ** 2) / 20);
      const s = 5 + 4 * Math.exp(-(((i % 60) - 25) ** 2) / 20) + 1;
      rows.push(`${new Date(t).toISOString().slice(0, 10)},${o.toFixed(4)},${s.toFixed(4)}`);
    }
    commitCsv(rows.join('\n'));
    const ds = useApp.getState().project.datasets[0];
    expect(ds.observed.name).toBe(ds.runs[0].name);
    openPlots();
    fireEvent.click(await screen.findByText('DTW alignment'));
    await waitFor(() => expect(lastCall(t => t.name === 'DTW alignment')).toBeTruthy(), { timeout: 20000 });
    const tr = lastCall(t => t.name === 'DTW alignment')!.traces;
    const trueSim = Array.from(ds.runs[0].values as ArrayLike<number>).slice(0, 5);
    const trueObs = Array.from(ds.observed.values as ArrayLike<number>).slice(0, 5);
    expect(tr[1].y.slice(0, 5)).toEqual(trueSim);
    expect(tr[0].y.slice(0, 5)).toEqual(trueObs);
    expect(trueSim[0]).not.toBe(trueObs[0]);
  }, 30000);
});

describe('plots-05: sub-daily heatmap and spaghetti show the daily mean', () => {
  it('hourly record: one cell per day = mean of the finite samples of that day', async () => {
    // 3 days hourly; 1 m3/s except 50 at 12:00 on day 1; day 2 = 2.00..2.22 and its 23:00 sample missing
    const rows = ['date,observed,modelA'];
    for (let i = 0; i < 72; i++) {
      const t = Date.UTC(2003, 0, 1) + i * HOUR;
      const h = i % 24, d = Math.floor(i / 24);
      let o = '1';
      if (d === 0 && h === 12) o = '50';
      if (d === 1) o = String(2 + h / 100);
      if (d === 1 && h === 23) o = '';
      rows.push(`${new Date(t).toISOString().slice(0, 16).replace('T', ' ')},${o},1`);
    }
    commitCsv(rows.join('\n'));
    openPlots();
    const hm = (await openPlot('Annual heatmap', t => t.type === 'heatmap'))[0];
    expect(hm.z[0][0]).toBeCloseTo(73 / 24, 12);   // (23 x 1 + 50) / 24
    expect(hm.z[0][1]).toBeCloseTo(2.11, 12);      // mean of 2.00..2.22 (23 samples)
    expect(hm.z[0][2]).toBe(1);
    expect(screen.getByText(/daily mean of the sub-daily values/)).toBeInTheDocument();
    const sp = (await openPlot('Spaghetti', t => t.name === '2003' && t.mode === 'lines'))[0];
    expect(sp.y[0]).toBeCloseTo(73 / 24, 12);
    expect(sp.y[1]).toBeCloseTo(2.11, 12);
    expect(sp.y[2]).toBe(1);
  });
});

describe('plots-06: calendar-day bins do not shift in leap years', () => {
  it('monthly resample 2001-2008: one DOY point per month, same heatmap columns every year', async () => {
    const start = Date.UTC(2001, 0, 1), n = Math.round((Date.UTC(2009, 0, 1) - start) / DAY);
    commitCsv(dailyCsv(start, n, (_i, t) => {
      const d = new Date(t); const v = (d.getUTCMonth() + 1 + 0.1 * (d.getUTCFullYear() - 2001)).toFixed(3);
      return [v, v];
    }));
    useApp.getState().updateView({ resample: 'monthly' });
    openPlots();
    const tr = await openPlot('DOY climatology', t => t.name === 'observed (median)');
    const med = tr.find(t => t.name === 'observed (median)');
    expect(med.x).toEqual([1, 32, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335]);
    expect(med.y[2]).toBeCloseTo(3.35, 12);        // median March over all 8 years
    const hm = (await openPlot('Annual heatmap', t => t.type === 'heatmap'))[0];
    const cols = hm.z.map((row: any[]) => row.flatMap((v, k) => (v === null ? [] : [k + 1])));
    for (const c of cols) expect(c).toEqual([1, 32, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335]);
  });
});

describe('plots-07 / plots-09: Plots-tab CSV exports hold what is plotted', () => {
  it('annual heatmap CSV has one row per plotted cell with its value', async () => {
    commitCsv(dailyCsv(Date.UTC(2003, 0, 1), 730, i => [(5 + Math.sin(i / 9)).toFixed(3), '1']));
    openPlots();
    const hm = (await openPlot('Annual heatmap', t => t.type === 'heatmap'))[0];
    const lines = (await captureCsv(screen.getByTitle('Download plotted data as CSV'))).split('\n');
    expect(lines[0]).toBe('trace,DOY (365-day calendar; 1 Mar = 60),year,Q [m³/s]');
    expect(lines.length - 1).toBe(729);          // 365 cells in 2003; 2004 to Dec 30 with Feb 28 and 29 in one cell
    expect(lines[1]).toBe(`observed,1,2003,${hm.z[0][0]}`);
    expect(lines).toContain(`observed,1,2004,${hm.z[1][0]}`);
    expect(hm.z[1][0]).toBe(5.281);
  });

  it('DOY climatology CSV names the quartile traces P75 and P25', async () => {
    commitCsv(dailyCsv(Date.UTC(2003, 0, 1), 20, i => [String(10 + i), String(11 + i)]));
    openPlots();
    await openPlot('DOY climatology', t => /\(median\)$/.test(t.name ?? ''));
    const lines = (await captureCsv(screen.getByTitle('Download plotted data as CSV'))).split('\n');
    const names = new Set(lines.slice(1).map(l => l.split(',')[0]));
    expect(names).toEqual(new Set(['observed P75', 'observed P25', 'observed (median)', 'modelA (median)']));
  });
});

describe('plots-08 / de-sd-08 / timing-sandbox-06: DE polar CSV on the Timing tab', () => {
  it('exports r, theta and the timing r of every plotted point', async () => {
    commitCsv(dailyCsv(Date.UTC(2003, 0, 1), 400, i => [(5 + 3 * Math.sin(i / 9)).toFixed(3), (5.5 + 2 * Math.sin((i - 2) / 9)).toFixed(3)]));
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Timing' }));
    await waitFor(() => expect(lastCall(t => t.type === 'scatterpolar')).toBeTruthy(), { timeout: 20000 });
    const pol = lastCall(t => t.type === 'scatterpolar')!.traces;
    const section = screen.getByText(/Diagnostic-efficiency polar/).closest('section') as HTMLElement;
    const lines = (await captureCsv(within(section).getByTitle('Download plotted data as CSV'))).split('\n');
    expect(lines[0]).toBe('trace,r,theta_deg,timing r');
    expect(lines[1]).toBe('Observed,0,0,');
    expect(lines[2]).toBe(`modelA,${pol[1].r[0]},${pol[1].theta[0]},${pol[1].marker.color[0]}`);
    expect(lines.length).toBe(3);
  }, 30000);
});

describe('plots-10: y-axis title follows the view mode', () => {
  it('cumulative, derivative and departure-from-mean views name their quantity', async () => {
    commitCsv(dailyCsv(Date.UTC(2003, 0, 1), 10, () => ['2', '3']));
    openPlots();
    const sel = await screen.findByLabelText('Plot mode');
    const titleFor = async (mode: string, y9: number) => {
      fireEvent.change(sel, { target: { value: mode } });
      await waitFor(() => expect(lastCall(t => t.name === 'observed' && t.y?.[9] === y9)).toBeTruthy());
      return lastCall(t => t.name === 'observed' && t.y?.[9] === y9)!.layout.yaxis.title;
    };
    expect(await titleFor('cumulative', 20)).toBe('Cumulative Q [m³/s · steps]');
    expect(await titleFor('derivative', 0)).toBe('ΔQ per step [m³/s]');
    fireEvent.change(sel, { target: { value: 'none' } });
    await waitFor(() => expect(lastCall(t => t.name === 'observed' && t.y?.[9] === 2)).toBeTruthy());
    expect(lastCall(t => t.name === 'observed' && t.y?.[9] === 2)!.layout.yaxis.title).toBe('Q [m³/s]');
    fireEvent.change(sel, { target: { value: 'fromMean' } });
    await waitFor(() => expect(lastCall(t => t.name === 'observed' && t.y?.[9] === 0)?.layout.yaxis.title).toBe('Q − mean [m³/s]'));
  });
});
