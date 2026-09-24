/** Events review follow-ups: irregular dates are announced; old projects get the Gauch defaults. */
import { it, expect } from 'vitest'
import { computeAll } from '../src/metrics/registry'
import { defaultView } from '../src/types'
import { parseProjectFile } from '../src/store/projectLoad'

const bump = (n: number, c: number, w: number) => Array.from({ length: n }, (_, i) => 1 + 20 * Math.exp(-0.5 * ((i - c) / w) ** 2));

it('irregular dates: the timing metrics say they count rows', () => {
  const n = 300, t0 = Date.UTC(2001, 0, 1);
  const o = bump(n, 150, 6), s = o.map((_, i) => o[Math.max(0, i - 3)]);
  const dates = o.map((_, i) => t0 + i * 864e5 + (i % 3 === 0 ? 3 * 3600e3 : 0));   // a third of the readings are 3 h late
  const out = computeAll(o, s, { nanPolicy: 'pairwise', transform: 'none', timing: defaultView(864e5, n).timingConfig, datesMs: dates } as any);
  expect(out.notes.join(' ')).toMatch(/dates are irregular/);
});

it('rows closer than one step are announced', () => {
  const n = 300, t0 = Date.UTC(2001, 0, 1), step = 900e3;
  const o = bump(n, 150, 6), s = o.map((_, i) => o[Math.max(0, i - 2)]);
  const dates = o.map((_, i) => t0 + i * step);
  dates[150] = dates[149] + step / 3;                   // one 5-minute reading in a 15-minute record
  const out = computeAll(o, s, { nanPolicy: 'pairwise', transform: 'none', timing: defaultView(step, n).timingConfig, datesMs: dates } as any);
  expect(out.notes.join(' ')).toMatch(/closer to the previous row than one time step/);
});

it('a pre-1.14 hourly project gets the Gauch peak window and separation, with notes', () => {
  const n = 200, t0 = Date.UTC(2001, 0, 1);
  const dates = Array.from({ length: n }, (_, i) => t0 + i * 3600e3);
  const obs = bump(n, 100, 5);
  const file = { schemaVersion: 1, datasets: [{ name: 'old', dates, observed: { name: 'o', values: obs, inputUnit: 'm3s' },
    runs: [{ name: 's', values: obs, inputUnit: 'm3s', visible: true }], targetUnit: 'm3s', location: null, area: null,
    view: { timingConfig: { dtwBandFraction: 0.1, waveletScales: 'auto', eventThreshold: { kind: 'percentile', value: 90 }, eventMinDistance: 24, eventWarmup: 0, peakMatchTolerance: 24, peakProminence: 'auto' } } }] };
  const { project, warnings } = parseProjectFile(JSON.stringify(file));
  expect(project.datasets[0].view.timingConfig.peakMatchTolerance).toBe(12);
  expect(project.datasets[0].view.timingConfig.peakMinDistance).toBe(100);
  expect(warnings.join(' ')).toMatch(/saved before v1\.14/);
});
