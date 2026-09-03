/** QA performance and memory. Measured, not guessed. Budgets are loose
 *  (CI-safe); the printed numbers are the deliverable. */
import { describe, it, expect } from 'vitest'
import { computeAll, classicalValues } from '../src/metrics/registry'
import { bootstrapCIs } from '../src/metrics/bootstrap'
import { lagSweep } from '../src/metrics/timing/events'
import { defaultView } from '../src/types'
import { parseDelimited, stage, type ColumnRole } from '../src/ingest/ingest'
import { alignByDate } from '../src/store/store'
import { LIMITS, inspectDelimited, tableShapeMessage, largeTableNotice } from '../src/ingest/limits'
import { decimateMinMax } from '../src/ui/decimate'

const mk = (n: number, lag = 0) =>
  Float64Array.from({ length: n }, (_, i) => 3 + 2 * Math.sin(i / 9) + 1.5 * Math.sin(i / 137) + (i % 97 === 0 ? 4 : 0) + (lag ? 0.2 * Math.sin((i - lag) / 9) : 0));
const ctxFor = (n: number) => {
  const v = defaultView(86_400_000, n);
  return { nanPolicy: v.nanPolicy, transform: v.transform, timing: v.timingConfig, heavy: true } as any;
};
const time = (f: () => void): number => { const t0 = performance.now(); f(); return performance.now() - t0; };

describe('QA performance numbers', () => {
  it('heavy panel at 50k (spec-scale) and 500k (10x)', () => {
    const o50 = mk(50_000), s50 = mk(50_000, 4);
    const t50 = time(() => computeAll(o50, s50, ctxFor(50_000)));
    console.log(`[perf] computeAll heavy n=50k: ${t50.toFixed(0)} ms`);
    expect(t50).toBeLessThan(15_000);

    const o500 = mk(500_000), s500 = mk(500_000, 4);
    const t500 = time(() => computeAll(o500, s500, ctxFor(500_000)));
    console.log(`[perf] computeAll heavy n=500k (10x, decimated timing): ${t500.toFixed(0)} ms`);
    expect(t500).toBeLessThan(60_000);
  }, 120_000);

  it('classical block at 500k', () => {
    const o = mk(500_000), s = mk(500_000, 3);
    const t = time(() => classicalValues(o, s));
    console.log(`[perf] classicalValues n=500k: ${t.toFixed(0)} ms`);
    expect(t).toBeLessThan(8_000);
  }, 30_000);

  it('lag sweep at 50k and repeated-drag simulation (10 heavy recomputes)', () => {
    const o = mk(50_000), s = mk(50_000, 5);
    const t1 = time(() => lagSweep(o, s, -30, 30));
    console.log(`[perf] lagSweep ±30 n=50k: ${t1.toFixed(0)} ms`);
    const c = ctxFor(50_000);
    const t10 = time(() => { for (let k = 0; k < 10; k++) computeAll(o, s, c); });
    console.log(`[perf] 10x heavy recompute (slider-drag burst) n=50k: ${t10.toFixed(0)} ms → ${(t10 / 10).toFixed(0)} ms/frame`);
    expect(t10 / 10).toBeLessThan(15_000);
  }, 200_000);

  it('bootstrap CIs B=500 at n=20k', () => {
    const o = mk(20_000), s = mk(20_000, 2);
    const v = defaultView(86_400_000, 20_000);
    const t = time(() => bootstrapCIs(o, s, { nanPolicy: v.nanPolicy, transform: v.transform }, { B: 500, seed: 7 } as any));
    console.log(`[perf] bootstrapCIs B=500 n=20k: ${t.toFixed(0)} ms`);
    expect(t).toBeLessThan(90_000);
  }, 150_000);

  it('memory: 30 load/unload cycles of a 100k-row dataset stay bounded', () => {
    const before = process.memoryUsage().heapUsed;
    let peak = before;
    for (let k = 0; k < 30; k++) {
      const o = mk(100_000), s = mk(100_000, 3);
      classicalValues(o, s);
      const h = process.memoryUsage().heapUsed;
      if (h > peak) peak = h;
    }
    const after = process.memoryUsage().heapUsed;
    console.log(`[mem] heapUsed before=${(before / 1e6).toFixed(0)}MB after=${(after / 1e6).toFixed(0)}MB peak=${(peak / 1e6).toFixed(0)}MB over 30 cycles`);
    expect(after - before).toBeLessThan(400e6);
  }, 120_000);

  // Ingest path (the upload flow before any metric runs): PapaParse text ->
  // RawTable -> stage (dates, values, validation) -> alignByDate (commit).
  // Prints wall time per step; stage() is also what the Data tab re-runs on
  // every render, so its time is the per-keystroke cost of that tab.
  const csvOf = (rows: number, cols: number): string => {
    const lines: string[] = new Array(rows + 1);
    lines[0] = ['date', 'observed', ...Array.from({ length: cols }, (_, k) => `sim_${k + 1}`)].join(',');
    const t0 = Date.UTC(1900, 0, 1);
    for (let i = 0; i < rows; i++) {
      let s = new Date(t0 + i * 86_400_000).toISOString().slice(0, 10) + ',' + (4 + 2 * Math.sin(i / 9)).toFixed(3);
      for (let k = 0; k < cols; k++) s += ',' + (4 + 2 * Math.sin((i - k - 1) / 9) + 0.05 * k).toFixed(3);
      lines[i + 1] = s;
    }
    return lines.join('\n');
  };

  it.each([[100_000, 25], [500_000, 5]])('ingest path at %i rows x %i simulations: parse, stage, commit', (rows, cols) => {
    const text = csvOf(rows, cols);
    const bytes = text.length;
    let table!: ReturnType<typeof parseDelimited>;
    const tParse = time(() => { table = parseDelimited(text); });
    const roles: ColumnRole[] = ['date', 'observed', ...Array.from({ length: cols }, () => 'run' as ColumnRole)];
    const opt = { name: 'perf', roles, dateFormat: 'auto' as const, unit: 'm3s' as const, missingValue: null };
    let staged!: ReturnType<typeof stage>;
    const tStage = time(() => { staged = stage(table, opt); });
    expect(staged.commit).not.toBeNull();
    const tCommit = time(() => { alignByDate(staged.commit!); });
    console.log(`[ingest] ${rows}x${cols} (${(bytes / 1e6).toFixed(1)} MB text): parse ${tParse.toFixed(0)} ms, stage ${tStage.toFixed(0)} ms, commit ${tCommit.toFixed(0)} ms`);
    expect(table.rows.length).toBe(rows);
    expect(tParse).toBeLessThan(20_000);
    expect(tStage).toBeLessThan(20_000);
  }, 120_000);

  // The largest table the tool accepts (LIMITS.rows), end to end: the cheap
  // shape pass, the caps, the parser, staging, commit, one heavy metric panel
  // on the committed record and the display decimation of its time series.
  // Everything above must finish in bounded time; a table one row larger is
  // refused by the cheap pass alone.
  it(`largest allowed record (${LIMITS.rows.toLocaleString('en-US')} rows x 5 simulations) completes in bounded time`, () => {
    const rows = LIMITS.rows, cols = 5;
    const text = csvOf(rows, cols);
    let shape!: ReturnType<typeof inspectDelimited>;
    const tInspect = time(() => { shape = inspectDelimited(text); });
    expect(shape).toEqual({ rows, columns: cols + 2 });
    expect(tableShapeMessage(shape)).toBeNull();
    expect(largeTableNotice(shape, text.length)).toMatch(/1,000,000 rows/);
    expect(tableShapeMessage({ rows: rows + 1, columns: cols + 2 })).toMatch(/1,000,001 data rows/);
    let table!: ReturnType<typeof parseDelimited>;
    const tParse = time(() => { table = parseDelimited(text); });
    const roles: ColumnRole[] = ['date', 'observed', ...Array.from({ length: cols }, () => 'run' as ColumnRole)];
    let staged!: ReturnType<typeof stage>;
    const tStage = time(() => { staged = stage(table, { name: 'max', roles, dateFormat: 'auto', unit: 'm3s', missingValue: null }); });
    expect(staged.commit).not.toBeNull();
    let aligned!: ReturnType<typeof alignByDate>;
    const tCommit = time(() => { aligned = alignByDate(staged.commit!); });
    expect(aligned.dates.length).toBe(rows);
    const obs = Float64Array.from(aligned.observed.values), sim = Float64Array.from(aligned.runs[0].values);
    let out!: ReturnType<typeof computeAll>;
    const tPanel = time(() => { out = computeAll(obs, sim, ctxFor(rows)); });
    expect(out.n).toBe(rows);
    expect(Number.isFinite(out.values.nse)).toBe(true);
    const y = Array.from(obs, v => (Number.isFinite(v) ? v : null));
    let dec!: ReturnType<typeof decimateMinMax<number>>;
    const tDecim = time(() => { dec = decimateMinMax(aligned.dates, y); });
    expect(dec.y.length).toBeLessThanOrEqual(LIMITS.plotPoints + 2);
    console.log(`[max] ${rows}x${cols} (${(text.length / 1e6).toFixed(1)} MB): inspect ${tInspect.toFixed(0)} ms, parse ${tParse.toFixed(0)} ms, stage ${tStage.toFixed(0)} ms, commit ${tCommit.toFixed(0)} ms, heavy panel ${tPanel.toFixed(0)} ms, decimate ${tDecim.toFixed(0)} ms`);
    expect(tInspect).toBeLessThan(5_000);
    expect(tParse + tStage + tCommit).toBeLessThan(60_000);
    expect(tPanel).toBeLessThan(90_000);
    expect(tDecim).toBeLessThan(2_000);
  }, 300_000);
});
