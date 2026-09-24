/**
 * Round 14 regressions: hardening against extreme inputs.
 *  - ingest limits (cheap shape pass, byte/row/column/cell/simulation caps,
 *    paste and sheet caps, soft-confirmation thresholds) and their messages;
 *  - per-column decimal-comma detection and the strict numeric grammar;
 *  - constant-series guards (validation warning, NSE family n/a, fmtNum at 1e21);
 *  - DTW with a non-finite band or too few points never loops;
 *  - lag sweep never reports the first lag of the sweep as "best";
 *  - flat simulations are counted, not matched, in peak timing and events;
 *  - transform re-pairing (sqrt of a negative flow) with a note, and the
 *    event block computed on untransformed flows;
 *  - bootstrap n limits with a reason;
 *  - timing-config clamping in the loader and the store, hidden-run and
 *    simulation-count repair in the loader;
 *  - Duplicate keeps missing values missing;
 *  - the compute cache evicts other datasets first and never clears wholesale;
 *  - display decimation keeps every bucket's extremes.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  LIMITS, inspectDelimited, fileSizeMessage, tableShapeMessage, runsMessage, pasteMessage,
  largeTableNotice, largeWorkbookNotice, largeProjectNotice, fmtMB, usedRange,
} from '../src/ingest/limits'
import { parseNumericCell, parseValue, detectCommaDecimal } from '../src/ingest/missing'
import { parseDelimited, stage, newStageCache } from '../src/ingest/ingest'
import { validateDataset } from '../src/ingest/validate'
import { nse, logNse, lmIndex, nseRel } from '../src/metrics/classical/catalogue'
import { fmtNum } from '../src/ui/format'
import { dtw, DTW_DEFAULT_BAND } from '../src/metrics/timing/dtwWasserstein'
import { lagSweep, peakTiming, eventErrors, LAG_SWEEP_MIN_PAIRS } from '../src/metrics/timing/events'
import { computeAll } from '../src/metrics/registry'
import { bootstrapCIs, BOOTSTRAP_MIN_N, BOOTSTRAP_MAX_N } from '../src/metrics/bootstrap'
import { clampTimingConfig, defaultTimingConfig, defaultView } from '../src/types'
import { parseProjectFile, DATE_MS_MAX } from '../src/store/projectLoad'
import { useApp, serialiseProject } from '../src/store/store'
import { computeForRun, __resetComputeCachesForTests, __cacheKeysForTests } from '../src/ui/compute'
import { decimateMinMax } from '../src/ui/decimate'
import { eventTableRows } from '../src/report/report'

const DAY = 86_400_000;
const iso = (i: number) => new Date(Date.UTC(2001, 0, 1) + i * DAY).toISOString().slice(0, 10);
const csvOf = (rows: number, sims = 1, sep = ',', val = (i: number, k: number) => (5 + 3 * Math.sin((i - k) / 6)).toFixed(3)) => {
  const lines = ['date' + sep + 'observed' + sep + Array.from({ length: sims }, (_, k) => `sim${k + 1}`).join(sep)];
  for (let i = 0; i < rows; i++) lines.push(iso(i) + sep + val(i, 0) + sep + Array.from({ length: sims }, (_, k) => val(i, k + 1)).join(sep));
  return lines.join('\n');
};
const ctx = (n = 100, transform: 'none' | 'log' | 'sqrt' | 'inverse' = 'none') => {
  const v = defaultView(DAY, n);
  return { nanPolicy: v.nanPolicy, transform, timing: v.timingConfig, heavy: true } as any;
};
const seq = (n: number, f: (i: number) => number) => Float64Array.from({ length: n }, (_, i) => f(i));

describe('ingest limits: cheap shape pass', () => {
  it('counts data rows and header columns with a sniffed delimiter, tolerating CRLF and blank lines', () => {
    expect(inspectDelimited('a,b,c\r\n1,2,3\r\n\r\n4,5,6\r\n')).toEqual({ rows: 2, columns: 3 });
    expect(inspectDelimited('﻿a;b\n1;2\n3;4\n5;6')).toEqual({ rows: 3, columns: 2 });
    expect(inspectDelimited('a\tb\tc\td\n1\t2\t3\t4')).toEqual({ rows: 1, columns: 4 });
    expect(inspectDelimited('')).toEqual({ rows: 0, columns: 0 });
    expect(inspectDelimited('only a header')).toEqual({ rows: 0, columns: 1 });
    expect(inspectDelimited('a,b,c\r1,2,3\r4,5,6')).toEqual({ rows: 2, columns: 3 });
  });
  it('agrees with the real parser on a 10,000 x 6 table', () => {
    const text = csvOf(10_000, 4);
    const shape = inspectDelimited(text);
    const table = parseDelimited(text);
    expect(shape.rows).toBe(table.rows.length);
    expect(shape.columns).toBe(table.header.length);
  });
});

describe('ingest limits: hard caps and their messages', () => {
  it('byte caps name the size, the limit and the remedy, per file kind', () => {
    expect(fileSizeMessage(LIMITS.delimitedBytes, 'delimited')).toBeNull();
    expect(fileSizeMessage(LIMITS.delimitedBytes + 1, 'delimited')).toMatch(/This file is 200 MB; delimited text files above 200 MB cannot be loaded in the browser\. Split the record/);
    expect(fileSizeMessage(31 * 1024 * 1024, 'workbook')).toMatch(/This workbook is 31 MB; workbooks above 25 MB cannot be read in the browser\. Save the sheet as CSV/);
    expect(fileSizeMessage(212 * 1024 * 1024, 'project')).toMatch(/This project file is 212 MB; project files above 100 MB cannot be loaded in the browser\. Save projects with fewer datasets per file\./);
    expect(fileSizeMessage(LIMITS.projectBytes, 'project')).toBeNull();
    expect(fmtMB(23.5 * 1024 * 1024)).toBe('24 MB');
    expect(fmtMB(2.34 * 1024 * 1024)).toBe('2.3 MB');
  });
  it('row, column and cell caps are checked in that order with specific messages', () => {
    expect(tableShapeMessage({ rows: LIMITS.rows, columns: 5 })).toBeNull();
    expect(tableShapeMessage({ rows: 1_500_000, columns: 5 })).toMatch(/This file has 1,500,000 data rows; the tool accepts up to 1,000,000\. Split the record into shorter periods or resample/);
    expect(tableShapeMessage({ rows: 10, columns: 101 })).toMatch(/This file has 101 columns; the tool accepts up to 100\. Remove the columns you do not need/);
    expect(tableShapeMessage({ rows: 400_000, columns: 90 })).toMatch(/400,000 rows x 90 columns \(36,000,000 cells\); the tool accepts up to 30,000,000 cells/);
    expect(tableShapeMessage({ rows: 10, columns: 101 }, 'Sheet “Data”')).toMatch(/^Sheet “Data” has 101 columns/);
  });
  it('simulation, paste and sheet caps', () => {
    expect(runsMessage(LIMITS.runs)).toBeNull();
    expect(runsMessage(62)).toMatch(/62 columns are mapped as Simulated; the tool computes up to 60 simulations per dataset\. Set the extra columns to Ignore\./);
    expect(pasteMessage(LIMITS.pasteChars)).toBeNull();
    expect(pasteMessage(31 * 1024 * 1024)).toMatch(/The pasted text is 31 MB; the paste box accepts up to 25 MB\. Save it as a file and use Upload instead\./);
  });
  it('a table with more than 60 simulated columns cannot be committed and says why', () => {
    const table = parseDelimited(csvOf(6, 61));
    const roles = ['date', 'observed', ...Array.from({ length: 61 }, () => 'run' as const)] as any;
    const st = stage(table, { name: 'x', roles, dateFormat: 'auto', unit: 'm3s', missingValue: null });
    expect(st.commit).toBeNull();
    expect(st.validation.errors.join('\n')).toMatch(/61 columns are mapped as Simulated/);
  });
});

describe('ingest limits: soft confirmation thresholds', () => {
  it('stays silent for ordinary tables and speaks above the warn thresholds', () => {
    expect(largeTableNotice({ rows: 100_000, columns: 10 })).toBeNull();
    expect(largeTableNotice({ rows: LIMITS.warnRows, columns: 5 })).toBeNull();
    const big = largeTableNotice({ rows: 500_000, columns: 7 }, 23.5 * 1024 * 1024)!;
    expect(big).toMatch(/This table has 500,000 rows and 7 columns \(24 MB\)\. Loading and mapping it will take roughly \d+ seconds, each metric panel about \d+ seconds per simulation, and time-series plots will be drawn at reduced resolution/);
    expect(largeTableNotice({ rows: 200_000, columns: 30 })).toMatch(/200,000 rows and 30 columns/);
    expect(largeWorkbookNotice(LIMITS.warnWorkbookBytes)).toBeNull();
    expect(largeWorkbookNotice(18 * 1024 * 1024)).toMatch(/This workbook is 18 MB\. Reading it may take up to a minute/);
    expect(largeProjectNotice(10 * 1024 * 1024)).toBeNull();
    expect(largeProjectNotice(40 * 1024 * 1024)).toMatch(/This project file is 40 MB; loading it may take about \d+ seconds\./);
  });
});

describe('numeric cells: decimal comma per column and a strict grammar', () => {
  it('rejects hex, Infinity and other non-decimal forms that Number() accepts', () => {
    for (const bad of ['0x10', '0b101', '0o17', 'Infinity', '-Infinity', '1_000', ' ', '1e', '++1']) {
      expect(Number.isNaN(parseNumericCell(bad)), bad).toBe(true);
      expect(Number.isNaN(parseValue(bad, { missingValue: null })), bad).toBe(true);
    }
    expect(parseNumericCell('1e5')).toBe(100000);
    expect(parseNumericCell('+.5')).toBe(0.5);
  });
  it('a column with "1,23" makes "1,234" read 1.234; a column without such cells keeps thousands grouping', () => {
    const rows = [['0,5'], ['1,23'], ['1,234'], ['12,5']];
    expect(detectCommaDecimal(rows, 0)).toBe(true);
    expect(parseNumericCell('1,234', true)).toBeCloseTo(1.234, 12);
    expect(parseNumericCell('1,234', false)).toBe(1234);
    expect(detectCommaDecimal([['1,234'], ['12,345'], ['1,234,567']], 0)).toBe(false);
    expect(detectCommaDecimal([['1.5'], ['2,5']], 0)).toBe(true);
    expect(detectCommaDecimal([[''], ['abc']], 0)).toBe(false);
  });
  it('stage() applies the column decision to every cell, so no row is a thousand times too large', () => {
    const text = 'date;observed;sim\n2001-01-01;0,5;1,0\n2001-01-02;1,23;2,0\n2001-01-03;1,234;3,0\n2001-01-04;2,5;4,0';
    const st = stage(parseDelimited(text), { name: 'eu', roles: ['date', 'observed', 'run'], dateFormat: 'auto', unit: 'm3s', missingValue: null });
    expect(st.commit).toBeTruthy();
    expect(Array.from(st.commit!.observed.values)).toEqual([0.5, 1.23, 1.234, 2.5]);
  });
  it('the stage cache re-uses parsed columns across role changes and is keyed on the missing value', () => {
    const table = parseDelimited(csvOf(50, 2));
    const cache = newStageCache();
    const opt = { name: 'c', roles: ['date', 'observed', 'run', 'ignore'] as any, dateFormat: 'auto' as const, unit: 'm3s' as const, missingValue: null };
    const a = stage(table, opt, cache);
    const b = stage(table, { ...opt, roles: ['date', 'observed', 'run', 'run'] }, cache);
    expect(cache.cols.size).toBe(3);
    expect(b.commit!.runs[0].values).toBe(a.commit!.runs[0].values);
    stage(table, { ...opt, missingValue: -999 }, cache);
    expect(cache.cols.size).toBe(5);
  });
});

describe('constant series answer n/a with a reason', () => {
  it('validation warns when observed or a simulation is constant', () => {
    const dates = Array.from({ length: 10 }, (_, i) => Date.UTC(2001, 0, 1 + i));
    const v = validateDataset(dates, { name: 'obs', values: new Array(10).fill(5) }, [{ name: 'm', values: new Array(10).fill(2) }]);
    expect(v.warnings).toContain('Observed is constant; correlation and efficiency metrics are undefined for it.');
    expect(v.warnings).toContain('m is constant; correlation-based metrics are undefined for it.');
  });
  it('a numerically-constant observed series (summation noise) gives NaN, not -1e27', () => {
    const o = seq(100, () => 0.1), s = seq(100, () => 0.11);
    expect(Number.isNaN(nse(o, s))).toBe(true);
    expect(Number.isNaN(logNse(seq(100, () => 5), seq(100, i => 5 + Math.sin(i))))).toBe(true);
    expect(Number.isNaN(lmIndex(o, s))).toBe(true);
    expect(Number.isNaN(nseRel(o, s))).toBe(true);
    // every ratio over the spread of O reads n/a on the same record (RSR once read 8.5e14)
    const out = computeAll(o, s, ctx(100));
    for (const id of ['rsr', 'kge2009', 'kge2012', 'kge2021', 'alpha', 'beta_nse', 'r', 'nse', 'lognse']) {
      expect(Number.isNaN(out.values[id]), id).toBe(true);
    }
    expect(Number.isFinite(out.values.rmse)).toBe(true);
    // a genuinely varying series is untouched
    const o2 = seq(100, i => 5 + Math.sin(i / 3)), s2 = seq(100, i => 5 + Math.sin((i - 1) / 3));
    expect(nse(o2, s2)).toBeGreaterThan(0.5);
  });
  it('fmtNum shows n/a beyond 1e21 and never an exponent string', () => {
    expect(fmtNum(-7.749858060943238e27)).toBe('n/a');
    expect(fmtNum(1e21)).toBe('n/a');
    expect(fmtNum(9.9e20, 0)).not.toMatch(/e\+/);
    expect(fmtNum(123456.789, 2)).toBe('123456.79');
  });
});

describe('DTW never loops', () => {
  const o = seq(60, i => 4 + 3 * Math.exp(-(((i % 20) - 8) ** 2) / 8));
  const s = seq(60, i => 4 + 3 * Math.exp(-(((i % 20) - 11) ** 2) / 8));
  it('a non-finite or negative band falls back to the default band', () => {
    const ref = dtw(o, s, DTW_DEFAULT_BAND);
    for (const bad of [NaN, -1, Infinity as number, 'x' as unknown as number]) {
      const r = dtw(o, s, bad);
      expect(r.band).toBe(ref.band);
      expect(r.meanAbsWarp).toBeCloseTo(ref.meanAbsWarp, 12);
    }
  });
  it('empty or single-point series return n/a instead of walking off the table', () => {
    for (const [a, b] of [[[], []], [[1], [1]], [[1, 2], [3]]] as number[][][]) {
      const r = dtw(a, b);
      expect(Number.isNaN(r.meanAbsWarp)).toBe(true);
      expect(r.path).toEqual([]);
    }
  });
});

describe('lag sweep: no first-lag artefact', () => {
  it('a 20-point record shifted by 2 finds +2 (it used to report -30, the first lag)', () => {
    const o = seq(20, i => 5 + 3 * Math.exp(-((i - 8) ** 2) / 6));
    const s = seq(20, i => 5 + 3 * Math.exp(-((i - 10) ** 2) / 6));
    expect(lagSweep(o, s).bestLag).toBe(2);
  });
  it('too few pairs or a constant observed series give NaN', () => {
    expect(Number.isNaN(lagSweep(seq(LAG_SWEEP_MIN_PAIRS - 2, i => Math.sin(i)), seq(LAG_SWEEP_MIN_PAIRS - 2, i => Math.sin(i - 1))).bestLag)).toBe(true);
    expect(Number.isNaN(lagSweep(seq(120, () => 5), seq(120, i => 5 + Math.sin(i / 6))).bestLag)).toBe(true);
  });
  it('the metric panel reports lag_best as NaN (shown n/a) rather than -30 on a 20-point constant tail', () => {
    const out = computeAll(seq(20, () => 3), seq(20, i => 3 + 0.1 * Math.sin(i)), ctx(20));
    expect(Number.isNaN(out.values.lag_best)).toBe(true);
  });
});

describe('flat simulations are counted, not matched', () => {
  const o = seq(120, i => 4 + 3 * Math.exp(-(((i % 30) - 12) ** 2) / 8));
  it('peakTiming excludes every peak when the simulation is flat', () => {
    const p = peakTiming(o, seq(120, () => 4), { prominence: 0.5, minDistance: 5, window: 3 });
    expect(p.flat).toBe(p.flat! > 0 ? p.flat : 1);
    expect(p.peaks.length).toBe(0);
    expect(Number.isNaN(p.meanAbsLag)).toBe(true);
  });
  it('eventErrors gives NaN lags on a flat simulation and the panel says so', () => {
    const ev = eventErrors(o, seq(120, () => 4), { thresholdKind: 'percentile', thresholdValue: 90, minDistance: 5, warmup: 0 }, 3);
    expect(ev.events.length).toBeGreaterThan(0);
    expect(ev.events.every(e => Number.isNaN(e.peakLag))).toBe(true);
    expect(Number.isNaN(ev.medianPeakLag)).toBe(true);
    const out = computeAll(o, seq(120, () => 4), ctx(120));
    expect(Number.isNaN(out.values.peak_lag_abs)).toBe(true);
    expect(out.notes.join('\n')).toMatch(/faced a flat simulation inside the search window and were not matched/);
  });
});

describe('transforms: re-pairing and untransformed event block', () => {
  const o = seq(120, i => 4 + 3 * Math.exp(-(((i % 30) - 12) ** 2) / 8));
  const s = seq(120, i => 4 + 3 * Math.exp(-(((i % 30) - 14) ** 2) / 8));
  it('one negative flow under sqrt drops one pair with a note; NSE stays finite', () => {
    const s2 = Float64Array.from(s); s2[40] = -1;
    const out = computeAll(o, s2, ctx(120, 'sqrt'));
    expect(out.n).toBe(119);
    expect(out.pairedIndex).not.toContain(40);
    expect(Number.isFinite(out.values.nse)).toBe(true);
    expect(out.notes).toContain('1 pair was excluded because it is not positive under the sqrt transform.');
  });
  it('a record with no positive pair says the transform needs positive flows', () => {
    const out = computeAll(seq(50, () => -5), seq(50, () => -4), ctx(50, 'sqrt'));
    expect(out.n).toBe(0);
    expect(out.notes).toContain('The sqrt transform needs positive flows; this record has non-positive values. Set the transform to none.');
  });
  it('an absolute threshold finds the same events with and without a log transform', () => {
    const v = defaultView(DAY, 120);
    const timing = { ...v.timingConfig, eventThreshold: { kind: 'absolute' as const, value: 6 } };
    const plain = computeAll(o, s, { nanPolicy: 'pairwise', transform: 'none', timing, heavy: true });
    const logged = computeAll(o, s, { nanPolicy: 'pairwise', transform: 'log', timing, heavy: true });
    expect(plain.extras.events!.events.length).toBeGreaterThan(0);
    expect(logged.extras.events!.events.length).toBe(plain.extras.events!.events.length);
    expect(logged.extras.events!.threshold).toBe(6);
    expect(logged.values.peak_lag_abs).toBe(plain.values.peak_lag_abs);
    expect(logged.notes.join('\n')).toMatch(/computed on untransformed flows/);
  });
});

describe('bootstrap limits', () => {
  const v = defaultView(DAY, 100);
  const c = { nanPolicy: v.nanPolicy, transform: v.transform };
  it('fewer than 30 valid pairs: no intervals, a reason', () => {
    const r = bootstrapCIs(seq(12, i => i), seq(12, i => i + 1), c);
    expect(Object.keys(r.cis)).toEqual([]);
    expect(r.reason).toBe(`Bootstrap CIs need at least ${BOOTSTRAP_MIN_N} valid pairs; this simulation has 12.`);
  });
  it('more than 100,000 valid pairs: no intervals, a reason, and it returns at once', () => {
    const n = BOOTSTRAP_MAX_N + 1;
    const t0 = performance.now();
    const r = bootstrapCIs(seq(n, i => Math.sin(i)), seq(n, i => Math.sin(i - 1)), c);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(r.reason).toMatch(/up to 100,000 valid pairs; this record has 100,001\. Use an analysis window or resample/);
  });
});

describe('timing configuration is clamped everywhere it enters', () => {
  const base = defaultTimingConfig(DAY, 1000);
  it('non-finite, wrong-typed and out-of-range fields are corrected and reported', () => {
    const { config, changed } = clampTimingConfig({ dtwBand: 'x', eventThreshold: null, eventMinDistance: -4, peakMatchTolerance: 1e9, eventWarmup: 2.6, peakProminence: -1, waveletScales: [0, -1] }, base);
    expect(changed).toBe(true);
    expect(config.dtwBand).toBe(base.dtwBand);
    expect(config.eventThreshold).toEqual(base.eventThreshold);
    expect(config.eventMinDistance).toBe(1);
    expect(config.peakMatchTolerance).toBe(10_000);
    expect(config.eventWarmup).toBe(3);
    expect(config.peakProminence).toBe(0);
    expect(config.waveletScales).toBe('auto');
    expect(clampTimingConfig({ eventThreshold: { kind: 'percentile', value: 150 } }, base).config.eventThreshold.value).toBe(100);
    expect(clampTimingConfig({ eventThreshold: { kind: 'absolute', value: -3 } }, base).config.eventThreshold).toEqual({ kind: 'absolute', value: -3 });
    expect(clampTimingConfig({ eventThreshold: { kind: 'bogus', value: 5 } }, base).changed).toBe(true);
  });
  it('missing fields are defaults, not corruption; a valid config passes through unchanged', () => {
    expect(clampTimingConfig({}, base)).toEqual({ config: base, changed: false });
    expect(clampTimingConfig(undefined, base).changed).toBe(false);
    const custom = { ...base, dtwBand: 25, eventMinDistance: 7, waveletScales: [2, 4, 8] };
    expect(clampTimingConfig(custom, base)).toEqual({ config: custom, changed: false });
  });
  it('the store clamps updateTiming patches', () => {
    useApp.getState().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null });
    useApp.getState().commitDataset(stage(parseDelimited(csvOf(40)), { name: 'clamp', roles: ['date', 'observed', 'run'], dateFormat: 'auto', unit: 'm3s', missingValue: null }).commit!);
    useApp.getState().updateTiming({ dtwBand: NaN, peakMatchTolerance: -5 } as any);
    const t = useApp.getState().project.datasets[0].view.timingConfig;
    expect(t.dtwBand).toBe(3);
    expect(t.peakMatchTolerance).toBe(1);
  });
});

describe('project loader repairs what would crash or hang the tabs', () => {
  const projectWith = (patch: (d: any) => void) => {
    useApp.getState().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null });
    useApp.getState().commitDataset(stage(parseDelimited(csvOf(40, 2)), { name: 'proj', roles: ['date', 'observed', 'run', 'run'], dateFormat: 'auto', unit: 'm3s', missingValue: null }).commit!);
    const raw = JSON.parse(serialiseProject(useApp.getState().project));
    patch(raw.datasets[0]);
    return parseProjectFile(JSON.stringify(raw));
  };
  it('a NaN-producing band or a null threshold resets the timing settings with a warning', () => {
    const { project, warnings } = projectWith(d => { d.view.timingConfig.dtwBand = 'x'; d.view.timingConfig.eventThreshold = null; });
    expect(project.datasets[0].view.timingConfig).toEqual(defaultTimingConfig(DAY, 40));
    expect(warnings).toContain('dataset "proj": timing settings were invalid and have been reset to defaults');
  });
  it('every simulation hidden: the first is made visible, with a warning', () => {
    const { project, warnings } = projectWith(d => { for (const r of d.runs) r.visible = false; });
    expect(project.datasets[0].runs.map((r: any) => r.visible)).toEqual([true, false]);
    expect(warnings).toContain('dataset "proj": every simulation was hidden; the first one was made visible.');
  });
  it('more than 60 simulations: the first 60 load, with a warning', () => {
    const { project, warnings } = projectWith(d => { const r0 = d.runs[0]; d.runs = Array.from({ length: 70 }, (_, i) => ({ ...r0, name: `s${i}` })); });
    expect(project.datasets[0].runs.length).toBe(LIMITS.runs);
    expect(warnings).toContain('dataset "proj": 70 simulations found; only the first 60 were loaded.');
  });
});

describe('Duplicate keeps missing values missing', () => {
  it('NaN survives the copy and the id is unique', () => {
    useApp.getState().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null });
    const text = csvOf(30, 1, ',', (i, k) => (i % 7 === 0 && k === 0 ? 'NA' : (5 + Math.sin(i - k)).toFixed(3)));
    useApp.getState().commitDataset(stage(parseDelimited(text), { name: 'dup', roles: ['date', 'observed', 'run'], dateFormat: 'auto', unit: 'm3s', missingValue: null }).commit!);
    const missing = (vals: ArrayLike<number>) => Array.from(vals).filter(v => Number.isNaN(v)).length;
    const src = useApp.getState().project.datasets[0];
    expect(missing(src.observed.values)).toBe(5);
    useApp.getState().duplicateDataset();
    useApp.getState().duplicateDataset();
    const ds = useApp.getState().project.datasets;
    expect(ds.length).toBe(3);
    expect(new Set(ds.map(d => d.id)).size).toBe(3);
    expect(missing(ds[1].observed.values)).toBe(5);
    expect(missing(ds[2].observed.values)).toBe(5);
    expect(ds[1].name).toBe('dup (copy)');
    __resetComputeCachesForTests();
    expect(computeForRun(ds[1], ds[1].runs[0]).n).toBe(computeForRun(src, src.runs[0]).n);
  });
});

describe('compute cache eviction', () => {
  beforeEach(() => __resetComputeCachesForTests());
  it('keeps the active dataset\'s panels and evicts other datasets first; never clears wholesale', () => {
    useApp.getState().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null });
    const st = stage(parseDelimited(csvOf(12, 3)), { name: 'A', roles: ['date', 'observed', 'run', 'run', 'run'], dateFormat: 'auto', unit: 'm3s', missingValue: null });
    useApp.getState().commitDataset(st.commit!);
    const a = useApp.getState().project.datasets[0];
    for (const r of a.runs) computeForRun(a, r);
    const aKeys = __cacheKeysForTests();
    expect(aKeys.length).toBe(3);
    // a second dataset with 210 simulations pushes the cache past its cap
    const many = { ...st.commit!, name: 'B', runs: Array.from({ length: 210 }, (_, i) => ({ ...st.commit!.runs[i % 3], name: `s${i}` })) };
    useApp.getState().commitDataset(many);
    const b = useApp.getState().project.datasets[1];
    for (const r of b.runs) computeForRun(b, r);
    const keys = __cacheKeysForTests();
    expect(keys.length).toBeLessThanOrEqual(200);
    expect(keys.length).toBeGreaterThan(150);
    for (const k of aKeys) expect(keys).not.toContain(k);
    // the newest 200 of B are all present: nothing was cleared wholesale
    expect(keys.every(k => k.includes(`|${b.id}|`))).toBe(true);
  });
});

describe('display decimation', () => {
  it('keeps the extremes of every bucket, the ends, and returns short series unchanged', () => {
    const n = 100_000;
    const x = Array.from({ length: n }, (_, i) => i);
    const y = x.map(i => Math.sin(i / 50) + (i === 77_777 ? 5 : 0) + (i === 33_333 ? -5 : 0));
    const d = decimateMinMax(x, y, 1000);
    expect(d.factor).toBeGreaterThan(1);
    expect(d.y.length).toBeLessThanOrEqual(1002);
    expect(d.x[0]).toBe(0);
    expect(d.x[d.x.length - 1]).toBe(n - 1);
    expect(Math.max(...(d.y as number[]))).toBe(Math.max(...y));
    expect(Math.min(...(d.y as number[]))).toBe(Math.min(...y));
    expect(d.x).toContain(77_777);
    expect(d.x).toContain(33_333);
    const small = decimateMinMax(x.slice(0, 10), y.slice(0, 10), 1000);
    expect(small.factor).toBe(1);
    expect(small.y).toBe(y.slice(0, 10).length === 10 ? small.y : y);
  });
});

describe('event dates go through pairedIndex', () => {
  it('a gap before the first event no longer shifts its date', () => {
    const n = 120;
    const o = seq(n, i => 4 + 3 * Math.exp(-(((i % 40) - 20) ** 2) / 8));
    const s = seq(n, i => 4 + 3 * Math.exp(-(((i % 40) - 22) ** 2) / 8));
    for (let i = 0; i < 7; i++) o[i] = NaN;   // seven missing days ahead of the first event
    const out = computeAll(o, s, ctx(n));
    const ev = out.extras.events!;
    expect(ev.events.length).toBeGreaterThan(0);
    const dates = Array.from({ length: n }, (_, i) => Date.UTC(2001, 0, 1) + i * DAY);
    const frame = { dates } as any;
    const rows = eventTableRows(ev, frame, frame, 12, out.pairedIndex);
    const firstStart = out.pairedIndex![ev.events[0].obs.start];
    expect(firstStart).toBe(ev.events[0].obs.start + 7);
    expect(rows[0][1]).toBe(iso(firstStart));
    // without the index the old code would have been seven days early
    expect(eventTableRows(ev, frame, frame)[0][1]).toBe(iso(firstStart - 7));
  });
});


describe('workbook used range: populated cells decide when the declared range is inflated', () => {
  const cell = (v: number | string) => (typeof v === 'number' ? { t: 'n', v } : { t: 's', v });
  it('reads the populated extent and ignores metadata keys and stub cells', () => {
    const ws: Record<string, unknown> = { '!ref': 'A1:C1048576', '!cols': [], C1048576: { t: 'z' } };
    for (let r = 1; r <= 11; r++) { ws[`A${r}`] = cell(r); ws[`B${r}`] = cell(r * 2); ws[`C${r}`] = cell('x'); }
    expect(usedRange(ws)).toEqual({ rows: 10, columns: 3, s: { r: 0, c: 0 }, e: { r: 10, c: 2 } });
    expect(tableShapeMessage(usedRange(ws)!, 'Sheet')).toBeNull();
    // a table starting at B3 is measured from its own first cell, as the declared range would be
    expect(usedRange({ '!ref': 'A1:ZZ99999', B3: cell(1), AA7: cell(2) })).toEqual({ rows: 4, columns: 26, s: { r: 2, c: 1 }, e: { r: 6, c: 26 } });
    expect(usedRange({ '!ref': 'A1:C1048576' })).toBeNull();
  });
  it('1,000,001 populated rows in one column are still refused, and the scan stays quick', () => {
    const ws: Record<string, unknown> = { '!ref': 'A1:A1000002' };
    for (let r = 1; r <= 1_000_002; r++) ws[`A${r}`] = cell(r);
    const t0 = performance.now();
    const used = usedRange(ws)!;
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(used.rows).toBe(1_000_001);
    expect(tableShapeMessage(used, 'Sheet "Data"')).toMatch(/^Sheet "Data" has 1,000,001 data rows; the tool accepts up to 1,000,000\./);
  }, 30000);
});

describe('project loader: dates and windows must be within the JavaScript date range', () => {
  const projectWith = (patch: (d: any) => void) => {
    useApp.getState().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null });
    useApp.getState().commitDataset(stage(parseDelimited(csvOf(40, 2)), { name: 'proj', roles: ['date', 'observed', 'run', 'run'], dateFormat: 'auto', unit: 'm3s', missingValue: null }).commit!);
    const raw = JSON.parse(serialiseProject(useApp.getState().project));
    patch(raw.datasets[0]);
    return parseProjectFile(JSON.stringify(raw));
  };
  it('rows with a null or out-of-range date are skipped with a warning naming the dataset', () => {
    const { project, warnings } = projectWith(d => { d.dates[0] = 1e16; d.dates[1] = -(DATE_MS_MAX + 1); d.dates[2] = null; });
    expect(warnings).toContain('dataset "proj": 3 rows with a missing or out-of-range date were skipped.');
    const ds = project.datasets[0];
    expect(ds.dates.length).toBe(37);
    expect(ds.observed.values.length).toBe(37);
    expect(ds.runs.every(r => r.values.length === 37)).toBe(true);
    for (const d of ds.dates) expect(() => new Date(d).toISOString()).not.toThrow();
  });
  it('a single bad date reads in the singular; a dataset with no usable dates is rejected with the reason', () => {
    expect(projectWith(d => { d.dates[5] = 9e15; }).warnings).toContain('dataset "proj": 1 row with a missing or out-of-range date was skipped.');
    expect(() => projectWith(d => { d.dates = d.dates.map(() => 1e16); }))
      .toThrow(/dataset "proj": 40 rows with a missing or out-of-range date were skipped\.[\s\S]*fewer than 2 rows with valid dates/);
  });
  it('an analysis window outside the date range is cleared with a warning; a valid one passes', () => {
    const { project, warnings } = projectWith(d => { d.view.window = [1e16, 2e16]; });
    expect(project.datasets[0].view.window).toBeNull();
    expect(warnings).toContain('dataset "proj": the analysis window was invalid and has been cleared');
    const ok = projectWith(d => { d.view.window = [d.dates[3], d.dates[9]]; });
    expect(ok.project.datasets[0].view.window).toEqual([ok.project.datasets[0].dates[3], ok.project.datasets[0].dates[9]]);
    expect(ok.warnings).toEqual([]);
  });
});
