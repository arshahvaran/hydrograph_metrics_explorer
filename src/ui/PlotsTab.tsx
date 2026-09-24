import { useMemo, useState } from 'react'
import { useApp } from '../store/store'
import { PlotHost, type CsvColumns } from './PlotHost'
import { NumField } from './NumField'
import { useSubsetRunOutput, useComputeError, subsetFrameFor } from './compute'
import { dtwTies } from './alignment'
import { decimateMinMax, decimationNote } from './decimate'
import { fmtNum, fmtStamp } from './format'
import { binByDoy, binByYear, isSubDaily, DOY_SLOTS, MONTH_START_DOYS } from './plotBins'
import { AnalysisBar } from './AnalysisBar'
import { quantile } from '../metrics/support/stats'
import { OBSERVED_COLOR } from '../types'
import { arrMax } from '../metrics/support/stats'
import { UNITS } from '../units/registry'
import { applyNanPolicy, type NanPolicy } from '../ingest/missing'
import { timePositions } from '../metrics/timing/timeAxis'
import type { Dataset } from '../types'

const PLOTS = [
  ['timeseries', 'Time series'], ['scatter', '1:1 scatter'], ['fdc', 'Flow duration'],
  ['qq', 'Q-Q'], ['doy', 'DOY climatology'], ['heatmap', 'Annual heatmap'],
  ['spaghetti', 'Spaghetti'], ['alignment', 'DTW alignment'],
] as const;

export type Mode = 'none' | 'derivative' | 'cumulative' | 'fromMean';

const clean = (v: ArrayLike<number>) => Array.from(v, x => (isFinite(x as number) ? (x as number) : null));

interface Series { name: string; color: string; raw: Float64Array; y: (number | null)[]; width: number; dash: string }

function seriesOf(ds: Dataset, frame: { obs: Float64Array; apply: (v: ArrayLike<number>) => Float64Array }): Series[] {
  return [
    { name: ds.observed.name || 'Observed', color: OBSERVED_COLOR, raw: frame.obs, y: clean(frame.obs), width: 2.2, dash: 'solid' },
    ...ds.runs.filter(r => r.visible).map(r => {
      const raw = frame.apply(r.values);
      return { name: r.name, color: r.color, raw, y: clean(raw), width: 1.7, dash: 'solid' };
    }),
  ];
}

/** The observed series paired with one or more simulations over the SAME
 *  time steps (index into the frame), as the metrics pair them. */
interface PairGroup { label: string; dash: string; index: number[]; obs: Float64Array; members: { s: Series; sim: Float64Array }[] }

const OBS_DASHES = ['solid', 'dot', 'dash', 'dashdot', 'longdash'];

/**
 * The frame steps inside the season, or null when no season is set. The
 * frame of a season holds only in-season steps (makeSubsetter leaves the
 * others out, and the dates keep the time between them), so every step of
 * the frame is in the selection and no NaN policy can fill an out-of-season
 * step.
 */
function seasonSteps(ds: Dataset, frameLen: number): number[] | null {
  if (!ds.view.season) return null;
  return Array.from({ length: frameLen }, (_, i) => i);
}

/** applyNanPolicy on the in-season steps only (all steps when `sel` is
 *  null); the returned index points into the frame. */
function pairOn(obs: Float64Array, sim: Float64Array, policy: NanPolicy, sel: number[] | null): { obs: Float64Array; sim: Float64Array; index: number[] } {
  if (!sel) return applyNanPolicy(obs, sim, policy);
  const p = applyNanPolicy(Float64Array.from(sel, i => obs[i]), Float64Array.from(sel, i => sim[i]), policy);
  return { obs: p.obs, sim: p.sim, index: p.index.map(k => sel[k]) };
}

/**
 * Flow-duration, Q-Q and DOY plots compare observed and simulated flows on
 * the sample the metric panel uses: applyNanPolicy with the dataset's NaN
 * policy ('pairwise' keeps the steps where both are valid). Simulations with
 * the same pairing share one observed curve; when they differ, each pairing
 * gets its own observed curve. With no simulation shown, the observed curve
 * uses every valid observed step. (Each curve once used all of its own valid
 * steps, so a simulated curve included steps with no observation.)
 * With a season (`sel`), the out-of-season steps are left out before the
 * policy is applied, so 'zero' and 'mean' fill only missing values inside
 * the season; they once filled every out-of-season step with 0 or the mean.
 */
function pairGroups(all: Series[], policy: NanPolicy, sel: number[] | null): PairGroup[] {
  const [obs, ...sims] = all;
  if (!sims.length) {
    const index: number[] = [];
    (sel ?? Array.from(obs.raw, (_, i) => i)).forEach(i => { if (isFinite(obs.raw[i])) index.push(i); });
    return [{ label: obs.name, dash: 'solid', index, obs: Float64Array.from(index, i => obs.raw[i]), members: [] }];
  }
  const groups: PairGroup[] = [];
  const same = (a: number[], b: number[]) => a.length === b.length && a.every((v, k) => v === b[k]);
  for (const s of sims) {
    const p = pairOn(obs.raw, s.raw, policy, sel);
    const g = groups.find(gr => same(gr.index, p.index));
    if (g) g.members.push({ s, sim: p.sim });
    else groups.push({ label: obs.name, dash: 'solid', index: p.index, obs: p.obs, members: [{ s, sim: p.sim }] });
  }
  if (groups.length > 1) groups.forEach((g, k) => {
    g.label = `${obs.name} (paired with ${g.members.map(m => m.s.name).join(', ')})`;
    g.dash = OBS_DASHES[k % OBS_DASHES.length];
  });
  return groups;
}

function pairNote(groups: PairGroup[], policy: NanPolicy, seasonal: boolean): string {
  const season = seasonal ? 'out-of-season steps left out, never filled; ' : '';
  if (!groups[0].members.length) return `${season}observed record only, n = ${groups[0].index.length}`;
  const ns = groups.length === 1
    ? `n = ${groups[0].index.length}`
    : `n = ${groups.map(g => `${g.index.length} (${g.members.map(m => m.s.name).join(', ')})`).join(', ')}; one observed curve per pairing`;
  // A dataset made from a season uses pairwise deletion (store subsetView),
  // so a fill inside the season is not claimed to be "as in the metrics".
  if (policy === 'zero') return seasonal
    ? `${season}missing in-season values set to zero (NaN policy): ${ns}`
    : `missing values set to zero, as in the metrics (NaN policy): ${ns}`;
  if (policy === 'mean') return seasonal
    ? `${season}missing in-season values set to the in-season mean (NaN policy): ${ns}`
    : `missing values set to the series mean, as in the metrics (NaN policy): ${ns}`;
  return `${season}paired time steps only (observed and simulated both valid, as in the metrics): ${ns}`;
}

/** y-axis title of the time-series view: the plotted quantity per mode. */
export function timeSeriesYTitle(mode: Mode, unit: string): string {
  if (mode === 'cumulative') return `Cumulative Q [${unit} · steps]`;
  if (mode === 'derivative') return `ΔQ per step [${unit}]`;
  if (mode === 'fromMean') return `Q − mean [${unit}]`;
  return `Q [${unit}]`;
}

// The day-of-year plots number days as the Season fields do (calendarDoy,
// src/metrics/subset.ts): a 365-day calendar, 1 Mar = 60 in every year and
// 29 Feb pooled with 28 Feb. Ticks at the 1st of each month keep the axis
// readable as dates.
const DOY_AXIS_TITLE = 'DOY (365-day calendar as in the Season field: 1 Mar = 60, 29 Feb pooled with 28 Feb)';
const DOY_TICKS = { tickvals: MONTH_START_DOYS, ticktext: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] };
/** CSV column of the day numbers (the CSV has no axis title to explain them). */
const DOY_CSV_X = 'DOY (365-day calendar; 1 Mar = 60)';
const DOY_X = Array.from({ length: DOY_SLOTS }, (_, k) => k + 1);

/** Largest moving-average window; the loop is O(n x w) on every render. */
export const MOVING_AVG_MAX = 90;

/** Rows that start a run of consecutive time steps: the first row, and every
 *  row that follows dates absent from the frame (a season join, dates skipped
 *  in the file). Irregular dates, which have no step grid, never start one. */
export function segmentStarts(datesMs: ArrayLike<number>): boolean[] {
  const pos = timePositions(datesMs, datesMs.length);
  return Array.from({ length: datesMs.length }, (_, i) => i === 0 || pos[i] - pos[i - 1] > 1);
}

/** Put a blank point before every segment start after the first, so that the
 *  line breaks there instead of joining the two sides of absent dates. */
export function breakAtGaps<T>(x: T[], y: (number | null)[], starts: boolean[]): { x: T[]; y: (number | null)[] } {
  if (!starts.some((b, i) => b && i > 0)) return { x, y };
  const bx: T[] = [], by: (number | null)[] = [];
  for (let i = 0; i < y.length; i++) {
    if (i > 0 && starts[i]) { bx.push(x[i]); by.push(null); }
    bx.push(x[i]); by.push(y[i]);
  }
  return { x: bx, y: by };
}

/** The plotted quantity of the time-series view. The moving average and the
 *  derivative stay inside a run of consecutive steps (`starts`, from
 *  segmentStarts): neither reaches across absent dates. */
export function applyMode(y: (number | null)[], mode: Mode, movAvg: number | null, starts?: boolean[]): (number | null)[] {
  let out = y.slice();
  const newRun = (i: number) => i === 0 || !!starts?.[i];
  if (movAvg && movAvg > 1) {
    const w = Math.min(Math.floor(movAvg), MOVING_AVG_MAX, y.length);
    let s0 = 0;
    out = out.map((_, i) => {
      if (newRun(i)) s0 = i;
      let s = 0, c = 0;
      for (let k = Math.max(s0, i - w + 1); k <= i; k++) { const v = out[k]; if (v !== null) { s += v; c++; } }
      return c ? s / c : null;
    });
  }
  if (mode === 'derivative') {
    out = out.map((v, i) => (newRun(i) || v === null || out[i - 1] === null ? null : v - (out[i - 1] as number)));
  } else if (mode === 'cumulative') {
    let acc = 0;
    out = out.map(v => (v === null ? null : (acc += v)));
  } else if (mode === 'fromMean') {
    const fin = out.filter((v): v is number => v !== null);
    const m = fin.reduce((a, b) => a + b, 0) / (fin.length || 1);
    out = out.map(v => (v === null ? null : v - m));
  }
  return out;
}

export function PlotsTab() {
  const ds = useApp(s => s.project.datasets.find(d => d.id === s.project.activeDatasetId) ?? null);
  if (!ds) return null;
  return <PlotsTabInner ds={ds} />;
}

function PlotsTabInner({ ds }: { ds: Dataset }) {
  const [plot, setPlot] = useState<(typeof PLOTS)[number][0]>('timeseries');
  const [mode, setMode] = useState<Mode>('none');
  const [logY, setLogY] = useState(false);
  const [movAvg, setMovAvg] = useState<number>(0);
  const [movNote, setMovNote] = useState<string | null>(null);
  const [threshold, setThreshold] = useState<string>('');
  const [focusIdx, setFocusIdx] = useState(0); // series selector for heatmap/spaghetti/alignment

  const frame = subsetFrameFor(ds);
  const dates = useMemo(() => frame.dates.map(m => fmtStamp(m, frame.step.ms)), [frame.key]);
  // runs of consecutive steps: lines break, and the derived modes restart, at absent dates
  const starts = useMemo(() => segmentStarts(frame.dates), [frame.key]);
  const alignRun = ds.runs.filter(r => r.visible)[Math.max(0, Math.min(focusIdx - 1, ds.runs.length - 1))] ?? ds.runs[0] ?? null;
  // Computed on the SAME subset frame the plot displays, so the ties always
  // join the series that were actually aligned (analysis tabs stay full-frame).
  const alignOut = useSubsetRunOutput(ds, plot === 'alignment' ? alignRun : null);
  const computeError = useComputeError(ds, frame);
  const all = useMemo(() => seriesOf(ds, frame), [ds, frame.key]);
  // keyed like the frame (dataset, length, window, season, resample): one
  // O(n) pass per selection, not per view change
  const sel = useMemo(() => seasonSteps(ds, frame.dates.length), [frame.key]);
  const unit = UNITS[ds.targetUnit].label;

  const { traces, layout, note, csv } = useMemo((): { traces: any[]; layout: any; note: string | null; csv?: CsvColumns } => {
    const yTitle = `Q [${unit}]`;
    const L: any = { yaxis: { title: yTitle, type: logY ? 'log' : 'linear' } };
    const thr = Number(threshold);
    // With a season, out-of-season steps never reach the NaN policy (see
    // pairGroups); if the season steps could not be told apart, nothing is
    // filled at all.
    const seasonal = !!ds.view.season;
    const policy: NanPolicy = seasonal && !sel ? 'pairwise' : ds.view.nanPolicy;
    const subDaily = isSubDaily(frame.step.ms);

    if (plot === 'timeseries') {
      // Long records are drawn at reduced resolution (min and max per bucket);
      // the derived modes run on the full series first so their values are exact.
      let factor = 1;
      const t = all.map(s => {
        const g = breakAtGaps(dates, applyMode(s.y, mode, movAvg || null, starts), starts);
        const d = decimateMinMax(g.x, g.y);
        factor = Math.max(factor, d.factor);
        return {
          x: d.x, y: d.y, name: s.name, type: 'scatter', mode: 'lines',
          line: { color: s.color, width: s.width, dash: s.dash },
        };
      });
      L.xaxis = { rangeslider: { visible: true }, title: 'Time', showline: false };
      // the title names the plotted quantity: a running sum of the values
      // (unit x steps), a step-to-step difference, or a departure from the mean
      L.yaxis = { ...L.yaxis, title: timeSeriesYTitle(mode, unit), zeroline: true };
      // Plotly shape positions are DATA values on linear and log axes alike
      // (plotly.js converts them with d2r on a log axis); passing log10(thr)
      // drew a 100 m3/s threshold at 2 m3/s. A non-positive threshold has no
      // place on a log axis at all.
      if (threshold && isFinite(thr) && mode === 'none' && !(logY && thr <= 0)) {
        L.shapes = [{ type: 'line', xref: 'paper', x0: 0, x1: 1, y0: thr, y1: thr, line: { color: '#888', dash: 'dot' } }];
      }
      const noteBits = [];
      if (mode !== 'none') noteBits.push(mode === 'fromMean' ? 'departure from mean' : mode);
      if (movAvg > 1) noteBits.push(`${movAvg}-step moving average (trailing)`);
      if (factor > 1) noteBits.push(decimationNote(factor));
      return { traces: t, layout: L, note: noteBits.join(' + ') || null };
    }

    if (plot === 'scatter') {
      const obs = all[0].y;
      const finiteMax = arrMax(all.flatMap(s => s.y.filter((v): v is number => v !== null)));
      const t = all.slice(1).map(s => ({
        x: obs, y: s.y, name: s.name, type: 'scattergl', mode: 'markers',
        marker: { color: s.color, size: 4, opacity: 0.55 },
      }));
      t.push({ x: [0, finiteMax], y: [0, finiteMax], name: '1:1', type: 'scatter', mode: 'lines', line: { color: '#555', dash: 'dash', width: 1 } } as any);
      return { traces: t, layout: { xaxis: { title: `Observed [${unit}]`, showline: false, zeroline: true }, yaxis: { title: `Simulated [${unit}]`, scaleanchor: 'x', showline: false, zeroline: true }, hovermode: 'closest' }, note: null };
    }

    if (plot === 'fdc') {
      const fdc = (v: ArrayLike<number>) => {
        const y = Array.from(v).filter(x => isFinite(x)).sort((a, b) => b - a);
        return { x: y.map((_, i) => (100 * (i + 1)) / (y.length + 1)), y };
      };
      const groups = pairGroups(all, policy, sel);
      const t = groups.flatMap(g => [
        { ...fdc(g.obs), name: g.label, type: 'scatter', mode: 'lines', line: { color: OBSERVED_COLOR, width: all[0].width, dash: g.dash } },
        ...g.members.map(m => ({ ...fdc(m.sim), name: m.s.name, type: 'scatter', mode: 'lines', line: { color: m.s.color, width: m.s.width, dash: m.s.dash } })),
      ]);
      return { traces: t, layout: { xaxis: { title: 'Exceedance probability [%]' }, yaxis: { title: yTitle, type: 'log' }, hovermode: 'closest' }, note: `Log(y) flow duration curves (Weibull plotting position); ${pairNote(groups, policy, seasonal)}` };
    }

    if (plot === 'qq') {
      const qs = Array.from({ length: 99 }, (_, i) => (i + 1) / 100);
      const groups = pairGroups(all, policy, sel);
      let mx = -Infinity;
      const t: any[] = groups.flatMap(g => {
        const oq = qs.map(q => quantile(g.obs, q));
        mx = Math.max(mx, arrMax(oq));
        return g.members.map(m => ({ x: oq, y: qs.map(q => quantile(m.sim, q)), name: m.s.name, type: 'scatter', mode: 'lines+markers', marker: { size: 4 }, line: { color: m.s.color } }));
      });
      t.push({ x: [0, mx], y: [0, mx], name: '1:1', type: 'scatter', mode: 'lines', line: { color: '#555', dash: 'dash', width: 1 } });
      return { traces: t, layout: { xaxis: { title: `Observed quantiles [${unit}]`, showline: false, zeroline: true }, yaxis: { title: `Simulated quantiles [${unit}]`, scaleanchor: 'x', showline: false, zeroline: true }, hovermode: 'closest' }, note: `Percentiles 1 to 99; ${pairNote(groups, policy, seasonal)}` };
    }

    if (plot === 'doy') {
      const t: any[] = [];
      const groups = pairGroups(all, policy, sel);
      // Bin on the subset frame's own dates (v1.11 regression), restricted to
      // each pairing's time steps.
      const series = (dts: number[], v: ArrayLike<number>) => {
        const byDoy = binByDoy(dts, Array.from(v, x => (isFinite(x) ? x : null)));
        const doys = [...byDoy.keys()].sort((a, b) => a - b);
        return { doys, q: (p: number) => doys.map(dd => quantile(byDoy.get(dd)!, p)) };
      };
      groups.forEach(g => {
        const dts = g.index.map(i => frame.dates[i]);
        const o = series(dts, g.obs);
        const iqr = groups.length === 1 ? 'obs IQR' : `obs IQR (paired with ${g.members.map(m => m.s.name).join(', ')})`;
        // meta.csvName labels the band edges in the CSV export (the legend shows one IQR entry)
        t.push({ x: o.doys, y: o.q(0.75), type: 'scatter', mode: 'lines', line: { width: 0 }, showlegend: false, hoverinfo: 'skip', name: `${g.label} P75`, meta: { csvName: `${g.label} P75` } });
        t.push({ x: o.doys, y: o.q(0.25), type: 'scatter', mode: 'lines', line: { width: 0 }, fill: 'tonexty', fillcolor: 'rgba(26,26,26,0.12)', name: iqr, hoverinfo: 'skip', meta: { csvName: `${g.label} P25` } });
        t.push({ x: o.doys, y: o.q(0.5), name: `${g.label} (median)`, type: 'scatter', mode: 'lines', line: { color: OBSERVED_COLOR, width: all[0].width, dash: g.dash } });
        for (const m of g.members) {
          const sv = series(dts, m.sim);
          t.push({ x: sv.doys, y: sv.q(0.5), name: `${m.s.name} (median)`, type: 'scatter', mode: 'lines', line: { color: m.s.color, width: m.s.width, dash: m.s.dash } });
        }
      });
      return {
        traces: t,
        layout: { xaxis: { title: DOY_AXIS_TITLE, ...DOY_TICKS, showline: false }, yaxis: { title: yTitle, type: logY ? 'log' : 'linear', zeroline: true } },
        csv: { x: DOY_CSV_X, y: yTitle },
        note: 'Medians by day of year; shaded band = observed interquartile range (IQR)'
          + (subDaily ? '; each day is the daily mean of the sub-daily values' : '')
          + `; ${pairNote(groups, policy, seasonal)}`,
      };
    }

    if (plot === 'heatmap' || plot === 'spaghetti') {
      const s = all[Math.min(focusIdx, all.length - 1)];
      // Same subset-frame rule as the DOY climatology (v1.11 regression).
      const byYear = binByYear(frame.dates, s.y);
      const years = [...byYear.keys()].sort((a, b) => a - b);
      const dailyNote = subDaily ? '; each day is the daily mean of the sub-daily values' : '';
      if (plot === 'heatmap') {
        return {
          traces: [{ name: s.name, z: years.map(y => byYear.get(y)!), x: DOY_X, y: years, type: 'heatmap', colorscale: 'Rainbow', colorbar: { title: { text: unit, side: 'right' }, lenmode: 'pixels', len: 370, y: 0.5, yanchor: 'middle', thickness: 14, outlinewidth: 0 } }],
          layout: { xaxis: { title: DOY_AXIS_TITLE, ...DOY_TICKS }, yaxis: { title: 'Year', dtick: 1 }, hovermode: 'closest' },
          csv: { x: DOY_CSV_X, y: 'year', z: yTitle },
          note: `Annual regime of ${s.name}${dailyNote}`,
        };
      }
      const t = years.map((y, i) => ({
        x: DOY_X, y: byYear.get(y)!, name: String(y), type: 'scatter', mode: 'lines',
        line: { color: i === years.length - 1 ? s.color : 'rgba(120,130,140,0.45)', width: i === years.length - 1 ? 2 : 1 },
      }));
      return { traces: t, layout: { xaxis: { title: DOY_AXIS_TITLE, ...DOY_TICKS, showline: false }, yaxis: { title: yTitle, type: logY ? 'log' : 'linear', zeroline: true }, hovermode: 'closest' }, csv: { x: DOY_CSV_X, y: yTitle }, note: `One line per year of ${s.name}; latest year highlighted in color${dailyNote}` };
    }

    // alignment
    const run = alignRun!;
    if (!alignOut) return { traces: [], layout: {}, note: 'computing DTW alignment in a background worker…' };
    // The simulated trace is the aligned run itself, mapped through the same
    // frame. It was once looked up by display name, and headers such as
    // 'Q [obs]' / 'Q [sim]' (equal names after ingest) drew the observed
    // series as the simulation.
    const paired = { o: all[0].y, s: clean(frame.apply(run.values)) };
    // dtwTies maps every path node back through decimation and the pairwise
    // NaN compaction, so ties land on the true dates and values.
    const tie = dtwTies(alignOut, dates, paired.o, paired.s ?? [], 160);
    const res = alignOut.extras.dtw;
    const decim = res?.decim ?? 1;
    // in steps of THIS frame: ctxFor converts the band when the view is resampled
    const band = res?.bandSteps ?? 0;
    const transform = ds.view.transform;
    // the two series are display-decimated like the time series; the ties
    // index the full frame and are drawn as they are (at most 160 of them)
    const gO = breakAtGaps(dates, paired.o, starts), gS = breakAtGaps(dates, paired.s, starts);
    const dO = decimateMinMax(gO.x, gO.y), dS = decimateMinMax(gS.x, gS.y);
    const factor = Math.max(dO.factor, dS.factor);
    return {
      traces: [
        { x: dO.x, y: dO.y, name: 'Observed', type: 'scatter', mode: 'lines', line: { color: OBSERVED_COLOR, width: 2.2 } },
        { x: dS.x, y: dS.y, name: run.name, type: 'scatter', mode: 'lines', line: { color: run.color, width: 1.7 } },
        { x: tie.x, y: tie.y, name: 'DTW alignment', type: 'scatter', mode: 'lines', line: { color: 'rgba(150,150,160,0.5)', width: 1 }, hoverinfo: 'skip' },
      ],
      layout: { xaxis: { rangeslider: { visible: true }, title: 'Time', showline: false }, yaxis: { title: yTitle, zeroline: true } },
      note: `Optimal Sakoe-Chiba alignment (band ±${band} step${band === 1 ? '' : 's'} of ${frame.step.label}); mean |warp| ${fmtNum(alignOut.values.dtw_warp, 2)} steps; grey ties connect matched points`
        + (res?.mode === 'blocks' ? `; path computed on means of ${decim} consecutive pairs`
          : res?.mode === 'corridor' ? `; path computed at full resolution around an alignment of means of ${res.coarseBlock} pairs`
          : res?.mode === 'narrow' ? `; the record is too long for a full-resolution band of ±${res.requestedBand} steps` : '')
        + (transform !== 'none' ? `; alignment computed on ${transform}-transformed flows` : '')
        + (factor > 1 ? `; ${decimationNote(factor)}` : ''),
    };
  }, [ds, plot, mode, logY, movAvg, threshold, focusIdx, dates, starts, all, sel, unit, frame.key, alignOut]);

  const needsFocus = plot === 'heatmap' || plot === 'spaghetti' || plot === 'alignment';
  const alignError = plot === 'alignment' && !alignOut ? computeError : null;

  return (
    <div>
      <AnalysisBar />
      <section className="card">
        <div className="controls">
          <span className="ctrl-label">Plot type:</span>
          {PLOTS.map(([id, label]) => (
            <button key={id} className={plot === id ? 'primary' : ''} onClick={() => setPlot(id)}>{label}</button>
          ))}
        </div>
        <div className="controls">
          {plot === 'timeseries' && (
            <>
              <label>View{' '}
                <select aria-label="Plot mode" value={mode} onChange={e => setMode(e.target.value as Mode)}>
                  <option value="none">values</option>
                  <option value="derivative">derivative (ΔQ)</option>
                  <option value="cumulative">cumulative</option>
                  <option value="fromMean">departure from mean</option>
                </select>
              </label>
              <label>Moving avg <NumField value={movAvg} min={0} max={MOVING_AVG_MAX} integer unit="steps" style={{ width: '4em' }}
                label="Moving average window" onCommit={setMovAvg}
                onClamp={(note, kind) => setMovNote(note === null ? null : kind === 'rounded' ? note : `Moving average window is limited to ${MOVING_AVG_MAX} steps.`)} /> steps</label>
              {movNote && <span className="muted" role="status">{movNote}</span>}
              <label>Threshold <input type="number" value={threshold} style={{ width: '6em' }} onChange={e => setThreshold(e.target.value)} /></label>
            </>
          )}
          {(plot === 'timeseries' || plot === 'doy' || plot === 'spaghetti') && (
            <label><input type="checkbox" checked={logY} onChange={e => setLogY(e.target.checked)} /> Log(y)</label>
          )}
          {needsFocus && (
            <label>Series{' '}
              <select aria-label="Focus series" value={focusIdx} onChange={e => setFocusIdx(Number(e.target.value))}>
                {(plot === 'alignment' ? all.slice(1) : all).map((s, i) => (
                  <option key={i} value={plot === 'alignment' ? i + 1 : i}>{s.name}</option>
                ))}
              </select>
            </label>
          )}
        </div>
        {note && <p className="muted">{note}</p>}
        {alignError && <div className="error" role="alert">{alignError}</div>}
        <PlotHost traces={traces} layout={layout} height={440} square={plot === 'scatter' || plot === 'fdc' || plot === 'qq'} csvColumns={csv} name={`${ds.name.replace(/[^\w-]+/g, '_')}_${plot}`} />
      </section>
    </div>
  );
}
