import Papa from 'papaparse'
import { parseDates } from './dateParse'
import { parseValue } from './missing'
import { validateDataset, type ValidationResult } from './validate'
import type { UnitId } from '../types'
import type { CommitInput } from '../store/store'

export interface LoadedCsv {
  commit: CommitInput;
  validation: ValidationResult;
  preview: { header: string[]; rows: string[][] };
}

/**
 * Load a simple date/observed/run… CSV (used for the bundled samples at CP1;
 * the full upload + column-mapping UI arrives at CP4). Column 0 = date,
 * column 1 = observed, columns 2+ = one run each. Units read from
 * bracketed header suffixes like "flow [m3/s]" when present.
 */
export function parseSampleCsv(text: string, name: string, fallbackUnit: UnitId = 'm3s'): LoadedCsv {
  const res = Papa.parse<string[]>(text.trim(), { skipEmptyLines: true });
  const rows = res.data as string[][];
  const header = rows[0].map(h => h.trim());
  const body = rows.slice(1);

  const unitOf = (h: string): UnitId => {
    const m = /\[(.+?)\]/.exec(h);
    if (!m) return fallbackUnit;
    const u = m[1].replace(/\s/g, '').toLowerCase();
    if (u === 'm3/s' || u === 'm³/s') return 'm3s';
    if (u === 'cfs' || u === 'ft3/s') return 'cfs';
    if (u === 'l/s') return 'ls';
    if (u === 'mm/d' || u === 'mm/day') return 'mm_step';
    return fallbackUnit;
  };
  const labelOf = (h: string) => h.replace(/\s*\[.+?\]\s*/, '').trim();

  const dates = parseDates(body.map(r => r[0] ?? ''));
  const col = (j: number) => body.map(r => parseValue(r[j]));

  const observed = { name: labelOf(header[1]), values: col(1), unit: unitOf(header[1]) };
  const runs = header.slice(2).map((h, k) => ({ name: labelOf(h), values: col(k + 2), unit: unitOf(h) }));

  const validation = validateDataset(dates.ms, observed, runs);
  return {
    commit: { name, dates: dates.ms, observed, runs },
    validation,
    preview: { header, rows: body.slice(0, 8) },
  };
}

export async function fetchSample(file: string): Promise<string> {
  const url = `${import.meta.env.BASE_URL}samples/${file}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Could not load sample ${file} (${r.status})`);
  return r.text();
}
