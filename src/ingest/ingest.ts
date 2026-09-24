import Papa from 'papaparse'
import { parseDates, type DateFormat, type ParsedDates } from './dateParse'
import { parseColumn, readBoth, resolveDecimalMark, scanDecimalMarks, type ColumnParse, type ColumnScan, type DecimalMark } from './missing'
import { validateDataset, type ValidationResult } from './validate'
import { runsMessage, tableShapeMessage, usedRange } from './limits'
import { UNITS } from '../units/registry'
import type { UnitId } from '../types'
import type { CommitInput } from '../store/store'

/** One table cell: text as written, or a number read from a workbook cell
 *  (workbook numbers are exact and are never re-read from text). */
export type Cell = string | number;
export interface RawTable { header: string[]; rows: Cell[][]; note?: string }

/** 1-based line of a character offset (CRLF, LF or classic-Mac CR files). */
function lineOf(text: string, index: number): number {
  const nl = text.indexOf('\n') >= 0 ? '\n' : '\r';
  let line = 1;
  for (let p = text.indexOf(nl); p >= 0 && p < index; p = text.indexOf(nl, p + 1)) line++;
  return line;
}

/** Parse delimited text (comma, tab, semicolon or pipe) with Papa's delimiter
 *  sniffing. First row = header. Throws when the quoting is broken, since the
 *  parser would then read the rest of the file into one cell. */
export function parseDelimited(text: string): RawTable {
  // Only a byte-order mark is removed: a whole-text trim() would also remove
  // the TAB in front of an empty first header cell (pandas' unnamed index, a
  // pasted range with an empty A1) and shift every column name (ingest-05).
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  // 'greedy' also skips lines that hold only delimiters or whitespace, such
  // as the ",," rows Excel writes for formatted but empty rows (ingest-09).
  const res = Papa.parse<string[]>(text, { skipEmptyLines: 'greedy' });
  // A quote that opens a field and is never closed makes Papa read the rest
  // of the file into that one cell; the rows after it would be lost without
  // a word (ingest-03). Refuse the file and say where the quote is.
  const quote = res.errors.find(e => e.type === 'Quotes');
  if (quote) {
    const line = quote.index !== undefined ? lineOf(text, quote.index) : (quote.row ?? 0) + 1;
    throw new Error(`Line ${line.toLocaleString('en-US')} of the file has a double quote (") that opens a quoted cell which is not closed correctly, so the lines after it cannot be split into cells. Remove the stray quote or close the quoted cell, then load the file again.`);
  }
  const rows = (res.data as string[][]).filter(r => r.some(c => String(c ?? '').trim() !== ''));
  if (!rows.length) return { header: [], rows: [] };
  return { header: rows[0].map(h => String(h ?? '').trim()), rows: rows.slice(1).map(r => r.map(c => String(c ?? ''))) };
}

// ---------------------------------------------------------------- workbooks

const DAY_MS = 86_400_000;

/**
 * Excel serial day number to UTC epoch ms by plain arithmetic: a serial
 * carries no time zone and no daylight saving time (ECMA-376 Part 1,
 * 18.17.4.1), so it must not pass through the viewer's local clock
 * (ingest-04). The 1904 date system counts days from 1904-01-01 (ingest-06).
 * In the 1900 system serial 25569 is 1970-01-01 from serial 61 on; Excel's
 * serial 60 is the non-existent 1900-02-29 (NaN), and serials 1-59 are one
 * day later than the same formula gives. Rounded to the millisecond, which
 * keeps seconds and absorbs the floating-point noise of the stored serial.
 */
export function excelSerialToMs(serial: number, date1904 = false): number {
  if (!isFinite(serial)) return NaN;
  if (date1904) return Math.round(serial * DAY_MS) + Date.UTC(1904, 0, 1);
  if (serial >= 61) return Math.round((serial - 25569) * DAY_MS);
  if (serial >= 60) return NaN;
  return Math.round(serial * DAY_MS) + Date.UTC(1899, 11, 31);
}

/** "YYYY-MM-DD HH:MM", with ":SS" and ".sss" only when they are not zero. */
export function fmtStampUTC(ms: number): string {
  const iso = new Date(ms).toISOString();              // YYYY-MM-DDTHH:MM:SS.sssZ
  const sec = iso.slice(17, 19), milli = iso.slice(20, 23);
  const base = iso.slice(0, 16).replace('T', ' ');
  if (milli !== '000') return `${base}:${sec}.${milli}`;
  return sec !== '00' ? `${base}:${sec}` : base;
}

interface SheetCell { t?: string; v?: unknown; w?: string; z?: unknown }

/**
 * Run the spreadsheet reader and undo anything it adds to or changes on the
 * built-in prototypes. SheetJS 0.20.3 still assigns into a plain object
 * keyed by a sheet name taken from the file (ODS database ranges), so a
 * sheet called "__proto__" reaches Object.prototype (SEC-XLSX). The read is
 * synchronous, so no other code can observe the change before it is undone;
 * the file is then refused.
 */
function readGuarded<T>(read: () => T): T {
  const protos: object[] = [Object.prototype, Array.prototype, Function.prototype, String.prototype,
    Number.prototype, Boolean.prototype, Date.prototype, RegExp.prototype];
  const before = protos.map(p => new Map(Reflect.ownKeys(p).map(k => [k, Object.getOwnPropertyDescriptor(p, k)!] as const)));
  let out: T | undefined, err: unknown = null;
  try { out = read(); } catch (e) { err = e; }
  let tampered = false;
  protos.forEach((p, i) => {
    const was = before[i];
    for (const k of Reflect.ownKeys(p)) {
      const d = Object.getOwnPropertyDescriptor(p, k)!, old = was.get(k);
      if (!old) { tampered = true; Reflect.deleteProperty(p, k); continue; }
      if (d.value !== old.value || d.get !== old.get || d.set !== old.set) { tampered = true; Object.defineProperty(p, k, old); }
    }
    for (const [k, old] of was) if (!Object.prototype.hasOwnProperty.call(p, k)) { tampered = true; Object.defineProperty(p, k, old); }
  });
  if (tampered) throw new Error('This spreadsheet contains structures that would alter the page’s own program objects, so it was not read. Open it in a spreadsheet program, copy the data to a new workbook or save it as CSV, and upload that instead.');
  if (err) throw err;
  return out as T;
}

/** Read the first sheet with data of an XLSX/XLS file. Text cells stay text,
 *  numbers stay numbers, and date-formatted numbers become UTC date-time
 *  text (see excelSerialToMs). */
export async function parseWorkbook(buf: ArrayBuffer): Promise<RawTable> {
  let XLSX: typeof import('xlsx');
  try {
    // The spreadsheet reader is a lazily loaded chunk; if the deployed site
    // was updated while this page stayed open, the old chunk URL 404s.
    XLSX = await import('xlsx');
  } catch {
    throw new Error('The spreadsheet reader could not be loaded; this page is likely running a stale copy of the tool. Reload the page and upload the file again.');
  }
  // cellDates:false keeps the serial numbers Excel stores (SheetJS would
  // build Date objects through the local zone); cellNF:true keeps each
  // cell's number format so date cells can be told from plain numbers.
  const wb = readGuarded(() => XLSX.read(buf, { type: 'array', cellDates: false, cellNF: true }));
  const date1904 = !!wb.Workbook?.WBProps?.date1904;
  const isDate = (z: unknown) => typeof z === 'string' && !!XLSX.SSF.is_date(z);
  const cellOf = (c: SheetCell | undefined): Cell => {
    if (!c || c.t === 'z' || c.v === undefined || c.v === null) return '';
    if (c.t === 'n' && typeof c.v === 'number') {
      if (!isDate(c.z)) return c.v;
      const ms = excelSerialToMs(c.v, date1904);
      return isFinite(ms) ? fmtStampUTC(ms) : '1900-02-29';   // Excel's fictitious day: fails the date parser
    }
    if (c.t === 'd') {
      const ms = c.v instanceof Date ? c.v.getTime() : Date.parse(String(c.v));
      return isFinite(ms) ? fmtStampUTC(ms) : String(c.v);
    }
    if (c.t === 'b') return c.v ? 'TRUE' : 'FALSE';
    if (c.t === 'e') return c.w ?? '#ERROR';                 // #N/A, #DIV/0!: reported as unreadable numbers
    return String(c.v);
  };
  // QA-009: the data is not always on the first sheet: take the first sheet
  // with at least a header and one data row, and say which one was used.
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws || !ws['!ref']) continue;
    // The sheet's declared range is a free check on its size before the
    // rows are materialised. Excel inflates that range with formatted-but-
    // empty rows and columns, so above a cap the populated cells decide,
    // and the reader is then confined to them so the empty rows are never
    // materialised.
    let r = XLSX.utils.decode_range(ws['!ref']);
    const what = `Sheet “${name}”`;
    let bad = tableShapeMessage({ rows: r.e.r - r.s.r, columns: r.e.c - r.s.c + 1 }, what);
    if (bad) {
      const used = usedRange(ws);
      if (!used) continue;
      bad = tableShapeMessage(used, what);
      r = { s: used.s, e: used.e };
    }
    if (bad) throw new Error(bad);
    const cols: string[] = [];
    for (let c = r.s.c; c <= r.e.c; c++) cols.push(XLSX.utils.encode_col(c));
    const rows: Cell[][] = [];
    for (let i = r.s.r; i <= r.e.r; i++) {
      const row = new Array<Cell>(cols.length);
      let filled = false;
      for (let k = 0; k < cols.length; k++) {
        const v = cellOf(ws[cols[k] + (i + 1)] as SheetCell | undefined);
        row[k] = v;
        if (typeof v === 'number' || v.trim() !== '') filled = true;
      }
      if (filled) rows.push(row);
    }
    if (rows.length >= 2) {
      const note = wb.SheetNames.length > 1
        ? `Workbook has ${wb.SheetNames.length} sheets; using “${name}”. Move your data to a single sheet if this is the wrong one.`
        : undefined;
      return { header: rows[0].map(c => String(c).trim()), rows: rows.slice(1), note };
    }
  }
  return { header: [], rows: [] };
}

// --------------------------------------------------------- header units

/** Unit spellings found in "[...]" header brackets, after normalisation:
 *  no spaces, superscripts and "^" folded ("m³/s", "m^3/s" -> "m3/s"),
 *  "s-1"/"d-1" as "/s"/"/d", "sec" as "s" and "day" as "d". */
const HEADER_UNITS: Record<string, UnitId> = {
  'm3/s': 'm3s', 'cms': 'm3s', 'cumecs': 'm3s',
  'ft3/s': 'cfs', 'cfs': 'cfs', 'cusecs': 'cfs',
  'l/s': 'ls', 'lps': 'ls',
  'm3/d': 'm3day',
  'ml/d': 'MLday',
  'mgd': 'MGD',
  'ac-ft/d': 'acftday', 'acft/d': 'acftday', 'acre-ft/d': 'acftday', 'acre-feet/d': 'acftday', 'af/d': 'acftday',
  'mm': 'mm_step',
  'in/d': 'in_day',
};

function unitOfBracket(raw: string): UnitId | null {
  const k = raw.normalize('NFKC').replace(/\u2212/g, '-').toLowerCase()
    .replace(/[\s^\u00B7\u2022*]/g, '').replace(/\.(?=[a-z])/g, '')
    .replace(/(s|sec|d|day)-1$/, '/$1')
    .replace(/\/sec$/, '/s').replace(/\/day$/, '/d');
  const id = HEADER_UNITS[k] ?? null;
  // "ML/d" is megalitres; a lower-case "ml" (millilitres) is not a flow unit
  if (id === 'MLday' && !/^M[Ll]/.test(raw.trim())) return null;
  return id;
}

/**
 * The discharge unit named in the column headers ("obs [ft³/s]"), for the
 * Data tab's unit selector (ingest-08). Every bracket is read; one unit
 * found sets it. None found, or several different ones, returns null so the
 * selector goes back to its default rather than keeping the previous file's
 * unit; the note says what happened.
 */
export function unitFromHeader(header: string[]): { unit: UnitId | null; note: string | null } {
  const found = new Set<UnitId>();
  for (const h of header) {
    const m = /\[(.+?)\]/.exec(h ?? '');
    const u = m ? unitOfBracket(m[1]) : null;
    if (u) found.add(u);
  }
  if (found.size === 1) {
    const u = [...found][0];
    return { unit: u, note: `Discharge unit set to ${UNITS[u].label} from the column headers.` };
  }
  if (found.size > 1) {
    return { unit: null, note: `The column headers name different units (${[...found].map(u => UNITS[u].label).join(', ')}); one unit applies to every value column, so set the Discharge unit and convert the other columns before loading.` };
  }
  return { unit: null, note: null };
}

// ---------------------------------------------------------------- staging

export type ColumnRole = 'date' | 'observed' | 'run' | 'ignore';

export interface StageOptions {
  name: string;
  roles: ColumnRole[];        // one per column
  dateFormat: DateFormat;
  unit: UnitId;               // applied to every value column
  missingValue: number | null; // user-declared no-data value, e.g. -999
  /** How cells that read differently with a decimal point and a decimal
   *  comma ("1,234") are read; 'auto' (the default) decides per column and
   *  asks when the file cannot tell. */
  decimalMark?: DecimalMark;
}

export interface Staged {
  commit: CommitInput | null;
  validation: ValidationResult;
  dateInfo: { used: string; ambiguous: boolean; failures: number };
  /** Single next-step message while column roles are still unassigned
   *  (uploads start all-Ignore by design); null once all roles are mapped. */
  guidance: string | null;
}

/** Parsed columns memoised across successive stage() calls on the same table,
 *  so that a role change or a keystroke in the Data tab re-parses nothing.
 *  Create one per table with newStageCache(); the keys carry every option a
 *  parse depends on. */
export interface StageCache {
  dates: Map<string, ParsedDates>;
  cols: Map<string, ColumnParse>;
  scans: Map<number, ColumnScan>;
}
export const newStageCache = (): StageCache => ({ dates: new Map(), cols: new Map(), scans: new Map() });

function cached<K, V>(map: Map<K, V> | undefined, key: K, make: () => V): V {
  if (!map) return make();
  const hit = map.get(key);
  if (hit !== undefined) return hit;
  const v = make();
  map.set(key, v);
  return v;
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

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const fmtCount = (n: number) => n.toLocaleString('en-US');

/** Apply the mapping and produce a validated, committable dataset. */
export function stage(table: RawTable, opt: StageOptions, cacheIn?: StageCache): Staged {
  // Without a caller's cache, a local one still keeps each column to one
  // scan and one parse per call (the decimal-mark decision of a column may
  // look at every other value column).
  const cache = cacheIn ?? newStageCache();
  const marks = new Map<number, 'point' | 'comma' | null>();
  const dateCol = opt.roles.indexOf('date');
  const obsCol = opt.roles.indexOf('observed');
  const runCols = opt.roles.map((r, i) => (r === 'run' ? i : -1)).filter(i => i >= 0);
  const valueCols = (obsCol >= 0 ? [obsCol] : []).concat(runCols);

  const dates: Omit<ParsedDates, 'used'> & { used: string } = dateCol >= 0
    ? cached(cache.dates, `${dateCol}|${opt.dateFormat}`, () => parseDates(table.rows.map(r => String(r[dateCol] ?? '')), opt.dateFormat))
    : { ms: table.rows.map(() => NaN), used: 'none', ambiguous: false, failures: table.rows.length, shifted: 0, zoned: 0, shiftedExample: '' };

  // The comma's role (decimal mark or thousands group) is decided per column
  // from the cells that only one reading explains, then from the other value
  // columns, and otherwise asked of the user (ingest-01).
  const scan = (j: number) => cached(cache.scans, j, () => scanDecimalMarks(table.rows, j));
  const markOf = (j: number) => cached(marks, j, () => resolveDecimalMark(scan(j), () => valueCols.filter(k => k !== j).map(scan), opt.decimalMark ?? 'auto'));
  const col = (j: number) => {
    const mark = markOf(j);
    return cached(cache.cols, `${j}|${opt.missingValue}|${mark}`,
      () => parseColumn(table.rows.map(r => r[j]), { missingValue: opt.missingValue, commaDecimal: mark === 'comma' }));
  };
  const label = (j: number) => (table.header[j] || `col ${j + 1}`).replace(/\s*\[.+?\]\s*/, '').trim();

  const observed = obsCol >= 0 ? { name: label(obsCol), values: col(obsCol).values } : null;
  const runs = runCols.map(j => ({ name: label(j), values: col(j).values }));

  const validation = validateDataset(dates.ms, observed, runs, dateCol >= 0);
  if (dates.ambiguous && opt.dateFormat === 'auto') {
    validation.errors.push('Day/month order is ambiguous in this file; pick MDY or DMY explicitly in the date-format selector.');
  }
  const tooMany = runsMessage(runCols.length);
  if (tooMany) validation.errors.push(tooMany);

  // Dates written with a UTC offset are moved to UTC (ingest-07); say so.
  if (dateCol >= 0 && dates.shifted > 0) {
    const parsed = dates.ms.filter(isFinite).length;
    const naive = parsed - dates.zoned;
    validation.warnings.push(`${fmtCount(dates.shifted)} date-time${plural(dates.shifted, '', 's')} ${plural(dates.shifted, 'carries', 'carry')} a UTC offset (e.g. “${dates.shiftedExample}”) and ${plural(dates.shifted, 'is', 'are')} converted to UTC; all times are shown in UTC.${
      naive > 0 ? ` ${fmtCount(naive)} date-time${plural(naive, '', 's')} without an offset ${plural(naive, 'is', 'are')} read as UTC.` : ''}`);
  }

  // Every value that was not read as written is reported (ingest-01, -10).
  for (const j of valueCols) {
    const name = label(j);
    const mark = markOf(j);
    if (mark === null) {
      const ex = scan(j).ambiguousExample;
      const [p, c] = readBoth(ex);
      validation.errors.push(`Column “${name}” has values such as “${ex}” that read as ${p} with a decimal point or ${c} with a decimal comma, and nothing in the file shows which is meant. Choose the decimal mark in the Decimal mark selector.`);
    }
    const parsed = col(j);
    if (parsed.invalid > 0) {
      validation.warnings.push(`Column “${name}”: ${fmtCount(parsed.invalid)} cell${plural(parsed.invalid, '', 's')} could not be read as a number (e.g. “${parsed.invalidExample}”) and ${plural(parsed.invalid, 'is', 'are')} treated as missing.`);
    }
    if (parsed.tokens > 0) {
      validation.warnings.push(`Column “${name}”: ${fmtCount(parsed.tokens)} cell${plural(parsed.tokens, '', 's')} ${plural(parsed.tokens, 'holds', 'hold')} ${parsed.tokenTexts.map(t => `“${t}”`).join(', ')} and ${plural(parsed.tokens, 'is', 'are')} treated as missing.`);
    }
  }

  // Unassigned roles are a to-do, not a failure: one guidance message instead
  // of a wall of blocking errors right after an upload (roles start all-Ignore
  // by design). Genuine data problems stay in validation.errors.
  const needed: string[] = [];
  if (dateCol < 0) needed.push('one Date column');
  if (obsCol < 0) needed.push('one Observed column');
  if (runCols.length === 0) needed.push('at least one Simulated column');
  const guidance = needed.length
    ? `Data loaded. To continue, use the role selectors in the table header to assign ${
      needed.length === 1 ? needed[0] : `${needed.slice(0, -1).join(', ')} and ${needed[needed.length - 1]}`}.`
    : null;

  const ok = validation.errors.length === 0 && needed.length === 0 && observed;
  return {
    commit: ok ? {
      name: opt.name,
      dates: dates.ms,
      observed: { ...observed!, unit: opt.unit },
      runs: runs.map(r => ({ ...r, unit: opt.unit })),
    } : null,
    validation: { ...validation, ok: !!ok },
    dateInfo: { used: dates.used, ambiguous: dates.ambiguous, failures: dates.failures },
    guidance,
  };
}

export async function fetchSample(file: string): Promise<string> {
  const url = `${import.meta.env.BASE_URL}samples/${file}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Could not load sample ${file} (${r.status})`);
  return r.text();
}
