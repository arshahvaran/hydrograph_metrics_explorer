/**
 * AnalysisBar audit fixes: subset-03 (the end date is a whole day),
 * subset-06 (clearing one field never rewrites the other bound) and
 * subset-08 (resample options that cannot aggregate are disabled).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { useApp } from '../../src/store/store'
import { __resetComputeCachesForTests } from '../../src/ui/compute'
import { AnalysisBar } from '../../src/ui/AnalysisBar'
import type { UnitId } from '../../src/types'

const H = 3_600_000, DAY = 86_400_000;
const S = () => useApp.getState();
const active = () => S().project.datasets.find(d => d.id === S().project.activeDatasetId)!;
const status = () => (document.querySelector('.analysisbar .muted') as HTMLElement).textContent ?? '';
const iso = (m: number) => new Date(m).toISOString().slice(0, 10);
const load = (dates: number[], unit: UnitId = 'm3s') => {
  const v = dates.map((_, i) => 5 + Math.sin(i / 7));
  S().commitDataset({ name: 'd', dates, observed: { name: 'obs', values: v, unit }, runs: [{ name: 'sim', values: v.slice(), unit }] });
};

beforeEach(() => {
  __resetComputeCachesForTests();
  S().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null });
  cleanup();
});

describe('subset-03: window end date', () => {
  it('hourly record, 2001-01-03 to 2001-01-05: 72 steps shown and committed', () => {
    load(Array.from({ length: 240 }, (_, i) => Date.UTC(2001, 0, 1) + i * H));
    render(<AnalysisBar />);
    fireEvent.change(screen.getByLabelText('window start'), { target: { value: '2001-01-03' } });
    fireEvent.change(screen.getByLabelText('window end'), { target: { value: '2001-01-05' } });
    expect(status()).toContain('window 2001-01-03–2001-01-05 · 72 steps shown');
    S().commitSubsetDataset();
    const sub = active();
    expect(sub.dates.length).toBe(72);
    expect(new Date(sub.dates[71]).toISOString()).toBe('2001-01-05T23:00:00.000Z');
  });
});

describe('subset-06: editing one bound through an empty field', () => {
  it('season start retyped 305 -> 300 keeps the end at 59', () => {
    load(Array.from({ length: 730 }, (_, i) => Date.UTC(2001, 0, 1) + i * DAY));
    render(<AnalysisBar />);
    const st = screen.getByLabelText('season start day-of-year') as HTMLInputElement;
    fireEvent.change(st, { target: { value: '305' } });
    fireEvent.change(screen.getByLabelText('season end day-of-year'), { target: { value: '59' } });
    for (const s of ['30', '3', '', '3', '30', '300']) fireEvent.change(st, { target: { value: s } });
    expect(active().view.season).toEqual({ startDoy: 300, endDoy: 59 });
    expect(status()).toContain('season DOY 300–59');
  });

  it('an empty season field leaves the stored season alone and shows it again on blur', () => {
    load(Array.from({ length: 730 }, (_, i) => Date.UTC(2001, 0, 1) + i * DAY));
    render(<AnalysisBar />);
    const st = screen.getByLabelText('season start day-of-year') as HTMLInputElement;
    fireEvent.change(st, { target: { value: '120' } });
    fireEvent.change(screen.getByLabelText('season end day-of-year'), { target: { value: '200' } });
    fireEvent.change(st, { target: { value: '' } });
    expect(active().view.season).toEqual({ startDoy: 120, endDoy: 200 });
    fireEvent.blur(st);
    expect(st.value).toBe('120');
  });

  it('window end cleared then retyped keeps the start date', () => {
    load(Array.from({ length: 120 }, (_, i) => Date.UTC(2001, 0, 1) + i * DAY));
    render(<AnalysisBar />);
    fireEvent.change(screen.getByLabelText('window start'), { target: { value: '2001-01-15' } });
    fireEvent.change(screen.getByLabelText('window end'), { target: { value: '2001-02-20' } });
    fireEvent.change(screen.getByLabelText('window end'), { target: { value: '' } });
    expect(active().view.window!.map(iso)).toEqual(['2001-01-15', '2001-02-20']);
    fireEvent.change(screen.getByLabelText('window end'), { target: { value: '2001-02-25' } });
    expect(active().view.window!.map(iso)).toEqual(['2001-01-15', '2001-02-25']);
  });

  it('the clear buttons still clear the whole selection', () => {
    load(Array.from({ length: 120 }, (_, i) => Date.UTC(2001, 0, 1) + i * DAY));
    render(<AnalysisBar />);
    fireEvent.change(screen.getByLabelText('window start'), { target: { value: '2001-01-15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear analysis window' }));
    expect(active().view.window).toBeNull();
    expect((screen.getByLabelText('window start') as HTMLInputElement).value).toBe('');
  });
});

describe('subset-08: resample options', () => {
  const opt = (v: string) => (screen.getByLabelText('Resample') as HTMLSelectElement).querySelector(`option[value="${v}"]`) as HTMLOptionElement;

  it('monthly record: neither daily nor monthly resampling is offered', () => {
    load(Array.from({ length: 24 }, (_, i) => Date.UTC(2001, i, 1)));
    render(<AnalysisBar />);
    expect(opt('daily').disabled).toBe(true);
    expect(opt('monthly').disabled).toBe(true);
  });

  it('daily record: monthly only; hourly record: both', () => {
    load(Array.from({ length: 90 }, (_, i) => Date.UTC(2001, 0, 1) + i * DAY));
    const { unmount } = render(<AnalysisBar />);
    expect(opt('daily').disabled).toBe(true);
    expect(opt('monthly').disabled).toBe(false);
    unmount();
    S().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null });
    load(Array.from({ length: 96 }, (_, i) => Date.UTC(2001, 0, 1) + i * H));
    render(<AnalysisBar />);
    expect(opt('daily').disabled).toBe(false);
    expect(opt('monthly').disabled).toBe(false);
  });

  it('depth per interval is offered as totals, not means', () => {
    load(Array.from({ length: 96 }, (_, i) => Date.UTC(2001, 0, 1) + i * H), 'mm_step');
    render(<AnalysisBar />);
    expect(opt('daily').textContent).toBe('daily totals');
    expect(opt('monthly').textContent).toBe('monthly totals');
  });
});
