/**
 * Round 12 regressions (Plots tab and report wiring):
 *  - DOY climatology / annual heatmap bin the DISPLAYED subset frame on its
 *    own dates: a mid-year window starts the DOY axis at the window's true
 *    day of year, and a monthly resample keeps every year of the record on
 *    the heatmap (the old full-record indexing collapsed it into January of
 *    the first year).
 *  - Threshold line: data units on a linear y axis, log10 units on a log y
 *    axis, suppressed for non-positive thresholds on log.
 *  - Sub-daily records keep their time part on the x axis (Plots tab and
 *    report figures); daily records keep the date-only stamps.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import Plotly from 'plotly.js-dist-min'
import { useApp } from '../../src/store/store'
import { stage, parseDelimited } from '../../src/ingest/ingest'
import { __resetComputeCachesForTests } from '../../src/ui/compute'
import { buildReportImages } from '../../src/report/report'
import App from '../../src/App'

beforeEach(() => {
  __resetComputeCachesForTests();
  vi.mocked(Plotly.react).mockClear();
  vi.mocked(Plotly.newPlot).mockClear();
  useApp.getState().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null });
});
afterEach(() => cleanup());

const DAY = 86_400_000, HOUR = 3_600_000;
const val = (i: number) => (6 + 4 * Math.sin(i / 7)).toFixed(3);
const dailyCsv = (n: number) => {
  const rows = ['date,observed,modelA'];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2003, 0, 1) + i * DAY).toISOString().slice(0, 10);
    rows.push(`${d},${val(i)},${val(i - 2)}`);
  }
  return rows.join('\n');
};
const hourlyCsv = (n: number) => {
  const rows = ['date,observed,modelA'];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2003, 0, 1) + i * HOUR).toISOString().slice(0, 16).replace('T', ' ');
    rows.push(`${d},${val(i)},${val(i - 2)}`);
  }
  return rows.join('\n');
};
const commit = (csv: string) => useApp.getState().commitDataset(stage(parseDelimited(csv), {
  name: 'round12', unit: 'm3s', dateFormat: 'auto', missingValue: null, roles: ['date', 'observed', 'run'],
}).commit!);

const lastLayout = (): any => vi.mocked(Plotly.react).mock.calls.at(-1)?.[2];

describe('threshold line on linear and log y axes, round 12', () => {
  it('linear passes data units, log passes log10, non-positive on log suppresses', async () => {
    commit(dailyCsv(90));
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Plots' }));
    const thr = await screen.findByLabelText(/Threshold/);
    fireEvent.change(thr, { target: { value: '100' } });
    await waitFor(() => {
      const L = lastLayout();
      expect(L?.yaxis?.type).toBe('linear');
      expect(L?.shapes?.[0]?.y0).toBe(100);
      expect(L?.shapes?.[0]?.y1).toBe(100);
    });
    fireEvent.click(screen.getByLabelText('Log(y)'));
    await waitFor(() => {
      const L = lastLayout();
      expect(L?.yaxis?.type).toBe('log');
      expect(L?.shapes?.[0]?.y0).toBe(2);
      expect(L?.shapes?.[0]?.y1).toBe(2);
    });
    fireEvent.change(thr, { target: { value: '-5' } });
    await waitFor(() => {
      const L = lastLayout();
      expect(L?.yaxis?.type).toBe('log');
      expect(L?.shapes).toBeUndefined();
    });
  });
});

describe('subset-frame binning on the Plots tab, round 12', () => {
  it('DOY climatology under a mid-year window starts at the true day of year', async () => {
    commit(dailyCsv(90)); // 2003-01-01 to 2003-03-31
    useApp.getState().updateView({ window: [Date.UTC(2003, 1, 10), Date.UTC(2003, 2, 31)] });
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Plots' }));
    fireEvent.click(await screen.findByText('DOY climatology'));
    const call = await waitFor(() => {
      const c = vi.mocked(Plotly.react).mock.calls.find((cc: any[]) =>
        Array.isArray(cc[1]) && (cc[1] as any[]).some((t: any) => /^observed \(median\)$/.test(t.name ?? '')));
      expect(c).toBeTruthy();
      return c!;
    });
    const med = (call[1] as any[]).find((t: any) => /^observed \(median\)$/.test(t.name ?? ''));
    const xs = med.x as number[];
    expect(Math.min(...xs)).toBe(41);   // 2003-02-10 is DOY 41, not DOY 1
    expect(Math.max(...xs)).toBe(90);   // 2003-03-31 is DOY 90
    expect(xs.length).toBe(50);         // 19 February + 31 March days
    // the value plotted on DOY 41 is the sample of 2003-02-10 (record row 40)
    expect(med.y[0]).toBeCloseTo(6 + 4 * Math.sin(40 / 7), 2);
  });

  it('annual heatmap under a monthly resample keeps both years of the record', async () => {
    commit(dailyCsv(730)); // 2003-01-01 to 2004-12-30
    useApp.getState().updateView({ resample: 'monthly' });
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Plots' }));
    fireEvent.click(await screen.findByText('Annual heatmap'));
    const call = await waitFor(() => {
      const c = vi.mocked(Plotly.react).mock.calls.find((cc: any[]) =>
        Array.isArray(cc[1]) && (cc[1] as any[]).some((t: any) => t.type === 'heatmap'));
      expect(c).toBeTruthy();
      return c!;
    });
    const hm = (call[1] as any[]).find((t: any) => t.type === 'heatmap');
    expect(hm.y).toEqual([2003, 2004]); // the old indexing collapsed all bins into 2003
    const nonNull = (row: (number | null)[]) => row.filter(v => v !== null).length;
    expect(nonNull(hm.z[0])).toBe(12);  // twelve monthly bins per year
    expect(nonNull(hm.z[1])).toBe(12);
    expect(hm.z[0][0]).not.toBeNull();  // January bin sits on DOY 1
  });
});

describe('sub-daily x-axis stamps, round 12', () => {
  it('hourly dataset draws distinct hourly stamps on the time series', async () => {
    commit(hourlyCsv(96));
    expect(useApp.getState().project.datasets[0].step.label).toBe('1h');
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Plots' }));
    const call = await waitFor(() => {
      const c = vi.mocked(Plotly.react).mock.calls.find((cc: any[]) =>
        Array.isArray(cc[1]) && (cc[1] as any[]).some((t: any) => t.name === 'observed' && t.mode === 'lines'));
      expect(c).toBeTruthy();
      return c!;
    });
    const xs = ((call[1] as any[]).find((t: any) => t.name === 'observed').x) as string[];
    expect(xs.length).toBe(96);
    expect(new Set(xs).size).toBe(96);  // no stacking of a day's samples
    expect(xs[0]).toBe('2003-01-01 00:00');
    expect(xs[1]).toBe('2003-01-01 01:00');
  });

  it('daily dataset keeps the date-only stamps', async () => {
    commit(dailyCsv(30));
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Plots' }));
    const call = await waitFor(() => {
      const c = vi.mocked(Plotly.react).mock.calls.find((cc: any[]) =>
        Array.isArray(cc[1]) && (cc[1] as any[]).some((t: any) => t.name === 'observed' && t.mode === 'lines'));
      expect(c).toBeTruthy();
      return c!;
    });
    const xs = ((call[1] as any[]).find((t: any) => t.name === 'observed').x) as string[];
    expect(xs[0]).toBe('2003-01-01');
    expect(xs.every(x => /^\d{4}-\d{2}-\d{2}$/.test(x))).toBe(true);
  });

  it('report figures stamp hourly frames with times and daily frames with dates', async () => {
    const mkFrame = (stepMs: number, label: string, n: number) => {
      const dates = Array.from({ length: n }, (_, i) => Date.UTC(2003, 0, 1) + i * stepMs);
      return {
        dates,
        obs: Float64Array.from(dates, (_, i) => 5 + (i % 7)),
        step: { ms: stepMs, label },
        caption: '', key: `k${label}`,
        apply: (v: ArrayLike<number>) => Float64Array.from(v as ArrayLike<number>),
      };
    };
    const ds: any = { name: 'r12', targetUnit: 'm3s', observed: { name: 'obs', values: null } };
    const runs: any = [{ id: 'r1', name: 'sim', color: '#125599', values: Float64Array.from({ length: 48 }, (_, i) => 5 + ((i + 1) % 7)), visible: true }];
    const outputs: any = [{ extras: {} }];

    const hourly = mkFrame(HOUR, '1h', 48);
    ds.observed.values = hourly.obs;
    await buildReportImages(ds, hourly as any, runs, outputs);
    const hx = (vi.mocked(Plotly.newPlot).mock.calls[0][1] as any[])[0].x as string[];
    expect(hx[0]).toBe('2003-01-01 00:00');
    expect(hx[1]).toBe('2003-01-01 01:00');
    expect(new Set(hx).size).toBe(48);

    vi.mocked(Plotly.newPlot).mockClear();
    const daily = mkFrame(DAY, '1d', 48);
    ds.observed.values = daily.obs;
    runs[0].values = Float64Array.from({ length: 48 }, (_, i) => 5 + ((i + 1) % 7));
    await buildReportImages(ds, daily as any, runs, outputs);
    const dx = (vi.mocked(Plotly.newPlot).mock.calls[0][1] as any[])[0].x as string[];
    expect(dx[0]).toBe('2003-01-01');
    expect(dx[1]).toBe('2003-01-02');
    expect(dx.every(x => /^\d{4}-\d{2}-\d{2}$/.test(x))).toBe(true);
  });
});
