/**
 * Plots repair after the adversarial review of the plots fixes (DOM side).
 * Each test renders the real App with Plotly stubbed and reads the traces,
 * layouts, notes and CSV exports.
 *
 *  - plots-01-r1: a season keeps its out-of-season steps as NaN gaps in the
 *    frame. The 'zero' and 'mean' NaN policies once filled every one of them
 *    (FDC n = 396 with 334 zeros, a DOY climatology over the whole year with
 *    median 0 outside March). Out-of-season steps are now left out of the
 *    FDC, Q-Q and DOY plots whatever the policy; only missing values inside
 *    the season follow the policy, and the note says so.
 *  - plots-06-r1: the day-of-year plots use the 365-day calendar of the
 *    Season fields (1 Mar = 60 in every year, 29 Feb pooled with 28 Feb), so
 *    a complete record has no false gap on day 60 in common years.
 *  - plots-06-r2: the Season fields and the plot axis use one numbering; the
 *    axis title and the CSV headers say which.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import Plotly from 'plotly.js-dist-min'
import { useApp } from '../../src/store/store'
import { stage, parseDelimited } from '../../src/ingest/ingest'
import { __resetComputeCachesForTests } from '../../src/ui/compute'
import App from '../../src/App'

const DAY = 86_400_000;

beforeEach(() => {
  __resetComputeCachesForTests();
  vi.mocked(Plotly.react).mockClear();
  useApp.getState().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null });
});
afterEach(() => cleanup());

const commitCsv = (csv: string) =>
  useApp.getState().commitDataset(stage(parseDelimited(csv), {
    name: 'repair', unit: 'm3s' as any, dateFormat: 'auto', missingValue: null, roles: ['date', 'observed', 'run'],
  }).commit!);

const lastCall = (pred: (t: any) => boolean): { traces: any[]; layout: any } | null => {
  const calls = vi.mocked(Plotly.react).mock.calls;
  for (let k = calls.length - 1; k >= 0; k--) {
    const tr = calls[k][1] as any[];
    if (Array.isArray(tr) && tr.some(pred)) return { traces: tr, layout: calls[k][2] as any };
  }
  return null;
};

async function openPlot(label: string, pred: (t: any) => boolean): Promise<{ traces: any[]; layout: any }> {
  fireEvent.click(await screen.findByText(label));
  await waitFor(() => expect(lastCall(pred)).toBeTruthy());
  return lastCall(pred)!;
}

async function captureCsv(button: HTMLElement): Promise<string> {
  let captured: Blob | null = null;
  const orig = window.URL.createObjectURL;
  window.URL.createObjectURL = ((b: Blob) => { captured = b; return 'blob:x'; }) as any;
  try { fireEvent.click(button); } finally { window.URL.createObjectURL = orig; }
  expect(captured).toBeTruthy();
  return await (captured as unknown as Blob).text();
}

const openPlots = () => { render(<App />); fireEvent.click(screen.getByRole('tab', { name: 'Plots' })); };

// The reviewer's input: daily 2001-2002, obs = 10 + i % 7, sim = 11 + i % 5;
// `gapAt` blanks the observed value on those record rows.
const START = Date.UTC(2001, 0, 1), N = 730;
const obsAt = (i: number) => 10 + (i % 7), simAt = (i: number) => 11 + (i % 5);
const reviewerCsv = (gapAt: number[] = []) => {
  const rows = ['date,observed,modelA'];
  for (let i = 0; i < N; i++) {
    rows.push(`${new Date(START + i * DAY).toISOString().slice(0, 10)},${gapAt.includes(i) ? '' : obsAt(i)},${simAt(i)}`);
  }
  return rows.join('\n');
};
/** Record rows in March (DOY 60-90 on the 365-day calendar). */
const marchRows = Array.from({ length: N }, (_, i) => i).filter(i => new Date(START + i * DAY).getUTCMonth() === 2);
const MAR15_2001 = Math.round((Date.UTC(2001, 2, 15) - START) / DAY);

// the FDC trace of modelA: numeric x (exceedance), 'lines' (the Q-Q uses 'lines+markers', the time series date strings)
const isFdc = (t: any) => t.name === 'modelA' && t.mode === 'lines' && Array.isArray(t.x) && typeof t.x[0] === 'number';

describe('plots-01-r1: out-of-season steps are never filled by the NaN policy', () => {
  for (const policy of ['zero', 'mean'] as const) {
    it(`season DOY 60-90 with the '${policy}' policy: FDC, Q-Q and DOY use the 62 March days only`, async () => {
      commitCsv(reviewerCsv());
      useApp.getState().updateView({ season: { startDoy: 60, endDoy: 90 }, nanPolicy: policy });
      openPlots();
      const fdc = (await openPlot('Flow duration', isFdc)).traces;
      const obsT = fdc[0], simT = fdc.find(t => t.name === 'modelA');
      expect(obsT.y.length).toBe(62);
      expect(simT.y.length).toBe(62);
      const marchObs = marchRows.map(obsAt).sort((a, b) => b - a);
      expect(obsT.y).toEqual(marchObs);                 // no 0 and no mean fill
      expect(simT.y).toEqual(marchRows.map(simAt).sort((a, b) => b - a));
      expect(screen.getByText(/out-of-season steps left out, never filled.*n = 62/)).toBeInTheDocument();

      const q = (await openPlot('Q-Q', t => t.mode === 'lines+markers')).traces.find(t => t.mode === 'lines+markers');
      expect(Math.min(...q.x)).toBeGreaterThanOrEqual(10);   // no zeros among the observed quantiles

      const doy = await openPlot('DOY climatology', t => t.name === 'modelA (median)');
      const med = doy.traces.find(t => t.name === 'observed (median)');
      expect(med.x).toEqual(Array.from({ length: 31 }, (_, k) => 60 + k));   // the Season numbers
      expect(screen.getByText(/out-of-season steps left out, never filled/)).toBeInTheDocument();
    });
  }

  it('a missing value inside the season still follows the policy', async () => {
    commitCsv(reviewerCsv([MAR15_2001]));
    const inSeason = marchRows.filter(i => i !== MAR15_2001).map(obsAt);
    const inSeasonMean = inSeason.reduce((a, b) => a + b, 0) / inSeason.length;
    useApp.getState().updateView({ season: { startDoy: 60, endDoy: 90 }, nanPolicy: 'zero' });
    openPlots();
    let obsT = (await openPlot('Flow duration', isFdc)).traces[0];
    expect(obsT.y.length).toBe(62);
    expect(obsT.y.filter((v: number) => v === 0).length).toBe(1);   // only 15 March 2001
    expect(screen.getByText(/missing in-season values set to zero \(NaN policy\): n = 62/)).toBeInTheDocument();

    vi.mocked(Plotly.react).mockClear();
    useApp.getState().updateView({ nanPolicy: 'mean' });
    await waitFor(() => expect(lastCall(t => t.name === 'observed' && t.y?.length === 62 && t.y.includes(inSeasonMean))).toBeTruthy());
    obsT = lastCall(t => t.name === 'observed' && t.y?.length === 62)!.traces[0];
    expect(obsT.y.filter((v: number) => v === inSeasonMean).length).toBe(1);   // the in-season mean, not the record mean
    expect(screen.getByText(/missing in-season values set to the in-season mean \(NaN policy\): n = 62/)).toBeInTheDocument();

    vi.mocked(Plotly.react).mockClear();
    useApp.getState().updateView({ nanPolicy: 'pairwise' });
    await waitFor(() => expect(lastCall(t => t.name === 'observed' && t.y?.length === 61)).toBeTruthy());
    expect(screen.getByText(/out-of-season steps left out.*paired time steps only.*n = 61/)).toBeInTheDocument();
  });

  it('season with a monthly resample and the zero policy: only the two March bins are plotted', async () => {
    commitCsv(reviewerCsv());
    useApp.getState().updateView({ season: { startDoy: 60, endDoy: 90 }, resample: 'monthly', nanPolicy: 'zero' });
    openPlots();
    const fdc = (await openPlot('Flow duration', isFdc)).traces;
    expect(fdc[0].y.length).toBe(2);                 // March 2001 and March 2002, not 13 bins with 11 zeros
    expect(fdc[0].y.every((v: number) => v > 0)).toBe(true);
    expect(fdc.find(t => t.name === 'modelA').y.length).toBe(2);
  });

  it('no season: the zero policy still fills every missing value, as in the metrics', async () => {
    commitCsv(reviewerCsv([MAR15_2001]));
    useApp.getState().updateView({ nanPolicy: 'zero' });
    openPlots();
    const obsT = (await openPlot('Flow duration', isFdc)).traces[0];
    expect(obsT.y.length).toBe(730);
    expect(obsT.y.filter((v: number) => v === 0).length).toBe(1);
    expect(screen.getByText(/missing values set to zero, as in the metrics \(NaN policy\): n = 730/)).toBeInTheDocument();
  });
});

const MONTH_TICKS = [1, 32, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];

describe('plots-06-r1: day-of-year plots on the 365-day Season calendar', () => {
  // complete daily record 2001-2004; the value is the year's offset (2001 -> 1)
  const completeCsv = () => {
    const rows = ['date,observed,modelA'];
    for (let t = Date.UTC(2001, 0, 1); t < Date.UTC(2005, 0, 1); t += DAY) {
      const v = new Date(t).getUTCFullYear() - 2000;
      rows.push(`${new Date(t).toISOString().slice(0, 10)},${v},${v}`);
    }
    return rows.join('\n');
  };

  it('spaghetti: no common-year line breaks between 28 February and 1 March', async () => {
    commitCsv(completeCsv());
    openPlots();
    const { traces, layout } = await openPlot('Spaghetti', t => t.name === '2004' && t.mode === 'lines');
    for (const yr of ['2001', '2002', '2003', '2004']) {
      const tr = traces.find(t => t.name === yr);
      expect(tr.x).toEqual(Array.from({ length: 365 }, (_, k) => k + 1));
      expect(tr.y.every((v: number | null) => v !== null)).toBe(true);
    }
    expect(layout.xaxis.tickvals).toEqual(MONTH_TICKS);
    expect(layout.xaxis.ticktext[2]).toBe('Mar');
  });

  it('annual heatmap: no empty column on day 60 in common years', async () => {
    commitCsv(completeCsv());
    openPlots();
    const { traces, layout } = await openPlot('Annual heatmap', t => t.type === 'heatmap');
    const hm = traces[0];
    expect(hm.x).toEqual(Array.from({ length: 365 }, (_, k) => k + 1));
    for (const row of hm.z) expect(row.every((v: number | null) => v !== null)).toBe(true);
    expect(layout.xaxis.tickvals).toEqual(MONTH_TICKS);
  });

  it('DOY climatology: 1 March (day 60) is the median of all four years, not of the leap year alone', async () => {
    commitCsv(completeCsv());
    openPlots();
    const { traces, layout } = await openPlot('DOY climatology', t => t.name === 'modelA (median)');
    const med = traces.find(t => t.name === 'observed (median)');
    expect(med.x).toEqual(Array.from({ length: 365 }, (_, k) => k + 1));
    expect(med.y[59]).toBe(2.5);                     // median of 1, 2, 3, 4
    expect(med.y[58]).toBe(2.5);                     // 28 Feb (29 Feb 2004 pooled with it)
    const p25 = traces.find(t => t.meta?.csvName === 'observed P25'), p75 = traces.find(t => t.meta?.csvName === 'observed P75');
    expect(p75.y[59] - p25.y[59]).toBeGreaterThan(0);   // the IQR band does not pinch at day 60
    expect(layout.xaxis.tickvals).toEqual(MONTH_TICKS);
  });
});

describe('plots-06-r2: one day numbering for the Season fields, the axis and the CSV', () => {
  it('axis title and CSV headers name the 365-day calendar; the season caption and the axis agree', async () => {
    commitCsv(reviewerCsv());
    useApp.getState().updateView({ season: { startDoy: 60, endDoy: 90 } });
    openPlots();
    expect(await screen.findByText(/season DOY 60–90 \(1 Mar–31 Mar/)).toBeInTheDocument();
    const doy = await openPlot('DOY climatology', t => t.name === 'modelA (median)');
    const med = doy.traces.find(t => t.name === 'observed (median)');
    expect([Math.min(...med.x), Math.max(...med.x)]).toEqual([60, 90]);
    const title = doy.layout.xaxis.title;
    expect(title).toMatch(/365-day calendar/);
    expect(title).toMatch(/Season/);
    expect(title).toMatch(/1 Mar = 60/);
    expect(title).toMatch(/29 Feb/);
    let csv = (await captureCsv(screen.getByTitle('Download plotted data as CSV'))).split('\n');
    expect(csv[0]).toBe('trace,DOY (365-day calendar; 1 Mar = 60),Q [m³/s]');
    expect(csv).toContain('observed (median),60,' + med.y[0]);

    const hm = await openPlot('Annual heatmap', t => t.type === 'heatmap');
    expect(hm.layout.xaxis.title).toBe(title);
    csv = (await captureCsv(screen.getByTitle('Download plotted data as CSV'))).split('\n');
    expect(csv[0]).toBe('trace,DOY (365-day calendar; 1 Mar = 60),year,Q [m³/s]');
    expect(csv[1]).toBe(`observed,60,2001,${obsAt(59)}`);   // 1 March 2001 is record row 59

    const sp = await openPlot('Spaghetti', t => t.name === '2002' && t.mode === 'lines');
    expect(sp.layout.xaxis.title).toBe(title);
    csv = (await captureCsv(screen.getByTitle('Download plotted data as CSV'))).split('\n');
    expect(csv[0]).toBe('trace,DOY (365-day calendar; 1 Mar = 60),Q [m³/s]');
  });

  it('other plots keep the generic trace,x,y header', async () => {
    commitCsv(reviewerCsv());
    openPlots();
    await openPlot('Flow duration', isFdc);
    const csv = (await captureCsv(screen.getByTitle('Download plotted data as CSV'))).split('\n');
    expect(csv[0]).toBe('trace,x,y');
  });
});
