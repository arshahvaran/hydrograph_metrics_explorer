import Papa from 'papaparse'
import { parseDates, type DateFormat } from './dateParse'
import { parseValue } from './missing'
import { validateDataset, type ValidationResult } from './validate'
import type { UnitId } from '../types'
import type { CommitInput } from '../store/store'

export interface RawTable { header: string[]; rows: string[][]; note?: string }

/** Parse CSV/TSV/semicolon text with Papa's delimiter sniffing. First row = header. */
export function parseDelimited(text: string): RawTable {
  const res = Papa.parse<string[]>(text.trim(), { skipEmptyLines: true });
  const rows = (res.data as string[][]).filter(r => r.length > 1 || (r[0] ?? '').trim() !== '');
  if (!rows.length) return { header: [], rows: [] };
  return { header: rows[0].map(h => String(h ?? '').trim()), rows: rows.slice(1).map(r => r.map(c => String(c ?? ''))) };
}

/** Read the first sheet of an XLSX/XLS file into strings (dates → ISO). */
export async function parseWorkbook(buf: ArrayBuffer): Promise<RawTable> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(buf, { type: 'array', cellDates: true });
  const toStr = (c: any) => c instanceof Date
    ? new Date(Date.UTC(c.getFullYear(), c.getMonth(), c.getDate(), c.getHours(), c.getMinutes())).toISOString().slice(0, 16).replace('T', ' ')
    : String(c ?? '');
  // QA-009: the data is not always on the first sheet — take the first sheet
  // with at least a header and one data row, and say which one was used.
  for (const name of wb.SheetNames) {
    const aoa = XLSX.utils.sheet_to_json<any[]>(wb.Sheets[name], { header: 1, defval: '' });
    const rows = aoa.filter(r => r.some((c: any) => String(c ?? '').trim() !== ''));
    if (rows.length >= 2) {
      const note = wb.SheetNames.length > 1
        ? `Workbook has ${wb.SheetNames.length} sheets — using “${name}”. Move your data to a single sheet if this is the wrong one.`
        : undefined;
      return { header: rows[0].map(toStr).map((s: string) => s.trim()), rows: rows.slice(1).map(r => r.map(toStr)), note };
    }
  }
  return { header: [], rows: [] };
}

export type ColumnRole = 'date' | 'observed' | 'run' | 'ignore';

export interface StageOptions {
  name: string;
  roles: ColumnRole[];        // one per column
  dateFormat: DateFormat;
  unit: UnitId;               // applied to every value column
  sentinels: boolean;         // -9999/-999 → missing
}

export interface Staged {
  commit: CommitInput | null;
  validation: ValidationResult;
  dateInfo: { used: string; ambiguous: boolean; failures: number };
}

/** Guess sensible default roles: first column date, second observed, rest runs. */
export function guessRoles(header: string[]): ColumnRole[] {
  return header.map((h, i) => {
    const lo = h.toLowerCase();
    if (i === 0 || /date|time|day/.test(lo)) return i === 0 ? 'date' : (/date|time/.test(lo) ? 'ignore' : 'run');
    if (/obs/.test(lo)) return 'observed';
    return 'run';
  }).map((r, i, arr) => {
    // ensure exactly one date (the first) and one observed (first non-date if none matched)
    if (r === 'date' && arr.indexOf('date') !== i) return 'run';
    return r;
  }).map((r, i, arr) => (arr.includes('observed') ? r : (i === arr.indexOf('run') ? 'observed' : r)));
}

/** Apply the mapping and produce a validated, committable dataset. */
export function stage(table: RawTable, opt: StageOptions): Staged {
  const dateCol = opt.roles.indexOf('date');
  const obsCol = opt.roles.indexOf('observed');
  const runCols = opt.roles.map((r, i) => (r === 'run' ? i : -1)).filter(i => i >= 0);

  const dates = dateCol >= 0
    ? parseDates(table.rows.map(r => r[dateCol] ?? ''), opt.dateFormat)
    : { ms: table.rows.map(() => NaN), used: 'none', ambiguous: false, failures: table.rows.length };

  const col = (j: number) => table.rows.map(r => parseValue(r[j], { sentinels: opt.sentinels }));
  const label = (j: number) => (table.header[j] || `col ${j + 1}`).replace(/\s*\[.+?\]\s*/, '').trim();

  const observed = obsCol >= 0 ? { name: label(obsCol), values: col(obsCol) } : null;
  const runs = runCols.map(j => ({ name: label(j), values: col(j) }));

  const validation = validateDataset(dates.ms, observed, runs);
  if (dateCol < 0) validation.errors.unshift('No column is mapped as Date.');
  if (dates.ambiguous && opt.dateFormat === 'auto') {
    validation.errors.push('Day/month order is ambiguous in this file — pick MDY or DMY explicitly in the date-format selector.');
  }

  const ok = validation.errors.length === 0 && observed;
  return {
    commit: ok ? {
      name: opt.name,
      dates: dates.ms,
      observed: { ...observed!, unit: opt.unit },
      runs: runs.map(r => ({ ...r, unit: opt.unit })),
    } : null,
    validation: { ...validation, ok: !!ok },
    dateInfo: { used: dates.used, ambiguous: dates.ambiguous, failures: dates.failures },
  };
}

export async function fetchSample(file: string): Promise<string> {
  const url = `${import.meta.env.BASE_URL}samples/${file}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Could not load sample ${file} (${r.status})`);
  return r.text();
}
