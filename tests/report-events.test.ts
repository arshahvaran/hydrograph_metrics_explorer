/** Round 7 regression: 'Report generation failed: Invalid time value'.
 *  Both report renderers read fields that never existed on EventError
 *  (e.start, e.obsPeak, e.simPeak, e.volBiasPct) behind an 'any' cast; the
 *  date lookup then indexed with undefined and Date.toISOString threw as soon
 *  as one event existed, aborting every report on realistic data. These tests
 *  pin the shared row builder and prove the DOCX path survives events. */
import { describe, it, expect, beforeEach } from 'vitest'
import { useApp } from '../src/store/store'
import { stage, parseDelimited } from '../src/ingest/ingest'
import { frameFor, computeForRun, __resetComputeCachesForTests } from '../src/ui/compute'
import { buildDocx, eventTableRows, isoDay } from '../src/report/report'
import { fmtNum } from '../src/ui/format'
import type { EventReport } from '../src/metrics/timing/events'

const csv = (n = 120) => {
  const rows = ['date,observed,m'];
  for (let i = 0; i < n; i++) rows.push(`${new Date(Date.UTC(2001, 0, 1) + i * 864e5).toISOString().slice(0, 10)},${(5 + 3 * Math.sin(i / 5)).toFixed(4)},${(5 + 3 * Math.sin((i - 2) / 5)).toFixed(4)}`);
  return rows.join('\n');
};
const commit = () => useApp.getState().commitDataset(stage(parseDelimited(csv()), {
  name: 'reportcase', unit: 'm3s', dateFormat: 'auto', missingValue: null, roles: ['date', 'observed', 'run'],
}).commit!);

beforeEach(() => {
  __resetComputeCachesForTests();
  useApp.getState().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null });
});

describe('isoDay', () => {
  it('formats a finite stamp and never throws on missing ones', () => {
    expect(isoDay(Date.UTC(2001, 0, 6))).toBe('2001-01-06');
    expect(isoDay(undefined)).toBe('n/a');
    expect(isoDay(NaN)).toBe('n/a');
  });
});

describe('eventTableRows', () => {
  it('reads the real EventError shape (obs.start, obs.peakQ, peakMagErrPct, volumeErrPct)', () => {
    const dates = Array.from({ length: 12 }, (_, i) => Date.UTC(2001, 0, 1 + i));
    const ev: EventReport = {
      threshold: 8, hits: 1, misses: 0, falseAlarms: 0, threat: 1,
      meanAbsPeakLag: 2, medianPeakLag: 2, meanVolumeErrPct: 5, meanPeakErrPct: -10,
      events: [{
        obs: { start: 5, end: 9, peakIdx: 7, peakQ: 10 },
        peakLag: 2, peakMagErrPct: -10, volumeErrPct: 5,
      }],
    };
    const frame = { dates } as any;
    const ds = { dates } as any;
    const rows = eventTableRows(ev, frame, ds);
    expect(rows).toEqual([[
      '1', '2001-01-06', fmtNum(10, 2), fmtNum(9, 2), fmtNum(2, 1), fmtNum(5, 1),
    ]]);
  });

  it('an event whose window index is somehow out of range yields an n/a date, not a throw', () => {
    const ev: EventReport = {
      threshold: 8, hits: 0, misses: 1, falseAlarms: 0, threat: 0,
      meanAbsPeakLag: NaN, medianPeakLag: NaN, meanVolumeErrPct: NaN, meanPeakErrPct: NaN,
      events: [{ obs: { start: 99, end: 100, peakIdx: 99, peakQ: 1 }, peakLag: NaN, peakMagErrPct: NaN, volumeErrPct: NaN }],
    };
    const short = { dates: [Date.UTC(2001, 0, 1)] } as any;
    const rows = eventTableRows(ev, short, short);
    expect(rows[0][1]).toBe('n/a');
  });
});

describe('DOCX build with events present (used to throw Invalid time value)', () => {
  it('resolves to a non-empty blob when every section is on and events exist', async () => {
    commit();
    const ds = useApp.getState().project.datasets[0];
    const runs = ds.runs.filter(r => r.visible);
    const outputs = runs.map(r => computeForRun(ds, r));
    // Precondition: this dataset genuinely produces events, so the event table renders.
    expect(outputs[0].extras.events?.events.length ?? 0).toBeGreaterThan(0);
    const frame = frameFor(ds);
    const blob = await buildDocx({
      ds, frame, runs, outputs, images: [],
      sections: { summary: true, metrics: true, plots: true, events: true, ranking: true },
      notes: '',
    } as any);
    expect(blob.size).toBeGreaterThan(1000);
  });
});
