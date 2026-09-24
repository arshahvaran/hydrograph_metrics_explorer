import Papa from 'papaparse'
import { parseDates, type DateFormat, type ParsedDates } from './dateParse'
import { parseColumn, readBoth, resolveDecimalMark, scanDecimalMarks, undecidedReason, type ColumnParse, type ColumnScan, type DecimalMark } from './missing'
import { validateDataset, type ValidationResult } from './validate'
import { inspectDelimited, runsMessage, tableShapeMessage, usedRange } from './limits'
import { UNITS } from '../units/registry'
import type { UnitId } from '../types'
import type { CommitInput } from '../store/store'

/** One table cell: text as written, or a number read from a typed workbook
 *  cell (xlsx, xls, ods: those numbers are exact and are never re-read from
 *  text). Text saved under a workbook name (HTML, CSV) stays text. */
export type Cell = string | number;
export interface RawTable {
  header: string[];
  rows: Cell[][];
  note?: string;
  /** Cell delimiter of delimited text (",", ";", TAB or "|"); a cue for
   *  the decimal mark. Not set for workbooks. */
  delimiter?: string;
}

/** 1-based line of a character offset (CRLF, LF or classic-Mac CR files). */
function lineOf(text: string, index: number): number {
  const nl = text.indexOf('\n') >= 0 ? '\n' : '\r';
  let line = 1;
  for (let p = text.indexOf(nl); p >= 0 && p < index; p = text.indexOf(nl, p + 1)) line++;
  return line;
}

/** Line breaks in a string, counted the way lineOf counts them. */
function breaksIn(s: string, nl: string): number {
  let n = 0;
  for (let p = s.indexOf(nl); p >= 0; p = s.indexOf(nl, p + 1)) n++;
  return n;
}

/**
 * A cell with line breaks whose later lines each look like a whole record
 * (at least columns - 1 delimiters) comes from two stray quotes: Papa read
 * every line between them into one cell, with no error (ingest-03). A real
 * multi-line remark does not hold lines like that. Returns the first such
 * cell as [record index, cell index], or null.
 */
function mergedRecord(data: string[][], delimiter: string, columns: number): [number, number] | null {
  if (columns < 2 || !delimiter) return null;
  for (let r = 0; r < data.length; r++) {
    const row = data[r];
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (typeof cell !== 'string' || (cell.indexOf('\n') < 0 && cell.indexOf('\r') < 0)) continue;
      const lines = cell.split(/\r\n|\n|\r/);
      for (let k = 1; k < lines.length; k++) {
        if (lines[k].split(delimiter).length - 1 >= columns - 1) return [r, c];
      }
    }
  }
  return null;
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
  // A stray quote that a second stray quote "closes" further down gives no
  // Papa error, but every line between them becomes one cell (ingest-03).
  // A cell with line breaks can only come from a quoted cell, so files
  // without a quote skip the check.
  const data = res.data as string[][];
  const delimiter = res.meta.delimiter;
  if (text.indexOf('"') >= 0) {
    const columns = data.length ? data[0].length : 0;
    const hit = mergedRecord(data, delimiter, columns);
    if (hit) {
      const [first, last] = mergedLines(text, data[hit[0]], hit[1]);
      const lost = last - first === 1
        ? `Line ${fmtLine(last)} would be read into that one cell and lost as a row.`
        : `Lines ${fmtLine(first + 1)} to ${fmtLine(last)} would be read into that one cell and lost as rows.`;
      throw new Error(`Line ${fmtLine(first)} of the file has a double quote (") that opens a quoted cell, and the quote that closes it is on line ${fmtLine(last)}. ${lost} Remove the stray quotes, then load the file again.`);
    }
  }
  const rows = data.filter(r => r.some(c => String(c ?? '').trim() !== ''));
  if (!rows.length) return { header: [], rows: [], delimiter };
  return { header: rows[0].map(h => String(h ?? '').trim()), rows: rows.slice(1).map(r => r.map(c => String(c ?? ''))), delimiter };
}

const fmtLine = (n: number) => n.toLocaleString('en-US');

/**
 * First and last line of cell `cell` of the merged record `target`. The
 * blank lines that the first parse skipped are not in its records, so the
 * text is parsed again with every line kept (only on this error path): a
 * record then starts on line 1 + the records before it + the line breaks
 * inside them.
 */
function mergedLines(text: string, target: string[], cell: number): [number, number] {
  const nl = text.indexOf('\n') >= 0 ? '\n' : '\r';
  const all = Papa.parse<string[]>(text, { skipEmptyLines: false }).data as string[][];
  let line = 1;
  for (const row of all) {
    if (row.length === target.length && row.every((c, i) => c === target[i])) {
      for (let c = 0; c < cell; c++) line += breaksIn(row[c], nl);
      return [line, line + breaksIn(row[cell], nl)];
    }
    for (const c of row) line += breaksIn(c, nl);
    line++;
  }
  return [line, line];
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
 * day later than the same formula gives.
 * Rounded to the whole second, as Excel shows it: a fill-down such as
 * =A2+1/24 stores serials a few microseconds early, and rounding to the
 * millisecond left one hourly stamp in five at hh:59:59.999, with midnights
 * on the previous day (ingest-04). With `keepMs` (the cell's number format
 * shows fractions of a second, "ss.000") it is rounded to the millisecond.
 */
export function excelSerialToMs(serial: number, date1904 = false, keepMs = false): number {
  if (!isFinite(serial)) return NaN;
  const unit = keepMs ? 1 : 1000;
  const round = (days: number) => Math.round(days * (DAY_MS / unit)) * unit;
  if (date1904) return round(serial) + Date.UTC(1904, 0, 1);
  if (serial >= 61) return round(serial - 25569);
  if (serial >= 60) return NaN;
  return round(serial) + Date.UTC(1899, 11, 31);
}

/** Does a spreadsheet number format show fractions of a second ("ss.0",
 *  "ss.000")? Quoted text and escaped characters are not format codes. */
export function showsFractionalSeconds(z: unknown): boolean {
  if (typeof z !== 'string') return false;
  return /s\.0/i.test(z.replace(/"[^"]*"/g, '').replace(/\\./g, ''));
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
 * The built-in objects that the reader must not change: the constructors
 * Object, Array, Function, String, Number, Boolean, Date and RegExp, their
 * prototypes, and every function-valued own property of these (such as
 * Object.prototype.toString). A name looked up on a plain object reaches
 * Object.prototype and its methods; "constructor" reaches Object itself.
 */
function guardedBuiltins(): object[] {
  const ctors: object[] = [Object, Array, Function, String, Number, Boolean, Date, RegExp];
  const out = new Set<object>();
  for (const c of ctors) {
    for (const o of [c, (c as { prototype: object }).prototype]) {
      out.add(o);
      for (const k of Reflect.ownKeys(o)) {
        const v = Object.getOwnPropertyDescriptor(o, k)!.value;
        if (typeof v === 'function') out.add(v);
      }
    }
  }
  return [...out];
}

/**
 * Run the spreadsheet reader and undo anything it adds to or changes on the
 * built-in objects (guardedBuiltins). SheetJS 0.20.3 still assigns into a
 * plain object keyed by a sheet name taken from the file (ODS database
 * ranges): a sheet called "__proto__" reaches Object.prototype (SEC-XLSX),
 * and "constructor", "toString" or "hasOwnProperty" reach Object and
 * Object.prototype's methods. The read is synchronous, so no other code can
 * observe the change before it is undone; the file is then refused.
 */
function readGuarded<T>(read: () => T): T {
  // The functions used to check and restore are taken before the read, so a
  // change the reader makes cannot reach them.
  const { ownKeys, deleteProperty } = Reflect, { getOwnPropertyDescriptor: desc, defineProperty, is } = Object;
  const objs = guardedBuiltins();
  const before: Map<PropertyKey, PropertyDescriptor>[] = [];
  for (const o of objs) {
    const m = new Map<PropertyKey, PropertyDescriptor>();
    for (const k of ownKeys(o)) m.set(k, desc(o, k)!);
    before.push(m);
  }
  let out: T | undefined, err: unknown = null;
  try { out = read(); } catch (e) { err = e; }
  let tampered = false;
  for (let i = 0; i < objs.length; i++) {
    const o = objs[i], was = before[i];
    for (const k of ownKeys(o)) {
      const d = desc(o, k)!, old = was.get(k);
      if (!old) { tampered = true; deleteProperty(o, k); continue; }
      // Object.is, not !==: Number.NaN is NaN and must not count as a change
      if (!is(d.value, old.value) || d.get !== old.get || d.set !== old.set) { tampered = true; defineProperty(o, k, old); }
    }
    for (const [k, old] of was) if (desc(o, k) === undefined) { tampered = true; defineProperty(o, k, old); }
  }
  if (tampered) throw new Error('This spreadsheet contains structures that would alter the page’s own program objects, so it was not read. Open it in a spreadsheet program, copy the data to a new workbook or save it as CSV, and upload that instead.');
  if (err) throw err;
  return out as T;
}

/** What a file with a workbook name (.xls, .xlsx) holds, from its bytes and
 *  not from its name: a binary or zipped workbook (xls, xlsx, xlsb, ods, and
 *  the older binary formats), markup that the spreadsheet reader parses
 *  (SpreadsheetML or flat ODS XML, an HTML or MHT table, SYLK, DIF), an RTF
 *  document, or plain delimited text (a CSV or TSV that was only renamed). */
export type WorkbookContent = 'workbook' | 'markup' | 'rtf' | 'text';

export function sniffWorkbook(buf: ArrayBuffer): { kind: WorkbookContent; text?: string } {
  const b = new Uint8Array(buf);
  if (b.length >= 2 && b[0] === 0x50 && b[1] === 0x4B) return { kind: 'workbook' };                     // ZIP: xlsx, xlsb, ods
  if (b.length >= 4 && b[0] === 0xD0 && b[1] === 0xCF && b[2] === 0x11 && b[3] === 0xE0) return { kind: 'workbook' };   // OLE: xls
  let text: string;
  if (b.length >= 2 && b[0] === 0xFF && b[1] === 0xFE) text = new TextDecoder('utf-16le').decode(b.subarray(2));
  else if (b.length >= 2 && b[0] === 0xFE && b[1] === 0xFF) text = new TextDecoder('utf-16be').decode(b.subarray(2));
  else {
    // A NUL byte near the start: another binary format (BIFF2-5, Lotus,
    // dBASE, Quattro Pro), which only the spreadsheet reader knows.
    if (b.subarray(0, 65536).indexOf(0) >= 0) return { kind: 'workbook' };
    // Decoded as the upload of a .csv file is (File.text(): UTF-8).
    text = new TextDecoder('utf-8').decode(b);
  }
  const head = text.replace(/^﻿/, '').trimStart().slice(0, 64);
  if (head.startsWith('{\\rtf')) return { kind: 'rtf' };
  if (head.startsWith('<') || /^MIME-Version:/i.test(head) || head.startsWith('ID;P') || /^TABLE\r?\n0,1/.test(head)) return { kind: 'markup' };
  return { kind: 'text', text };
}

/** Read the first sheet with data of an XLSX/XLS file. Text cells stay text,
 *  numbers stay numbers, and date-formatted numbers become UTC date-time
 *  text (see excelSerialToMs). Text-based content (HTML, CSV) stays text. */
export async function parseWorkbook(buf: ArrayBuffer): Promise<RawTable> {
  const content = sniffWorkbook(buf);
  // The spreadsheet reader's RTF reader rewrites numbers ("12,5" -> 125)
  // whatever the options, and RTF is a word-processor format.
  if (content.kind === 'rtf') {
    throw new Error('This file is an RTF document (word-processor text), not a spreadsheet, so its numbers cannot be read safely. Copy the table into a spreadsheet and save it as CSV or XLSX, then upload that file.');
  }
  // A CSV or TSV that only has a workbook name is read by the tool's own
  // text parser, as a .csv upload is, so every cue for the decimal mark (the
  // ";" between cells among them) applies. Text that does not split into
  // columns goes to the spreadsheet reader, as before.
  if (content.kind === 'text') {
    const text = content.text!;
    const bad = tableShapeMessage(inspectDelimited(text));
    if (bad) throw new Error(bad);
    const t = parseDelimited(text);
    if (t.header.length >= 2) return { ...t, note: 'The file has a workbook name (.xls or .xlsx) but holds plain text, so it was read as delimited text.' };
  }
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
  // raw:true keeps the cells of text saved under a workbook name (an HTML
  // table from a data portal's "Export to Excel", a CSV named .xls) as
  // text: SheetJS would otherwise delete the commas ("12,5" -> 125) before
  // the tool's own decimal-mark and date logic sees them. Typed cells of
  // xlsx, xlsb, xls, SpreadsheetML and ODS files are the same either way.
  const wb = readGuarded(() => XLSX.read(buf, { type: 'array', cellDates: false, cellNF: true, raw: true }));
  const date1904 = !!wb.Workbook?.WBProps?.date1904;
  const isDate = (z: unknown) => typeof z === 'string' && !!XLSX.SSF.is_date(z);
  const cellOf = (c: SheetCell | undefined): Cell => {
    if (!c || c.t === 'z' || c.v === undefined || c.v === null) return '';
    if (c.t === 'n' && typeof c.v === 'number') {
      if (!isDate(c.z)) return c.v;
      const ms = excelSerialToMs(c.v, date1904, showsFractionalSeconds(c.z));
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
 *  "s-1"/"d-1"/"h-1" as "/s"/"/d"/"/h", "sec" as "s", "day" as "d", "hr"
 *  and "hour" as "h", and a trailing "(...)" dropped ("ft³/s (cfs)"). */
const HEADER_UNITS: Record<string, UnitId> = {
  'm3/s': 'm3s', 'cms': 'm3s', 'cumecs': 'm3s',
  'ft3/s': 'cfs', 'cfs': 'cfs', 'cusecs': 'cfs', 'cusec': 'cfs',
  'l/s': 'ls', 'lps': 'ls',
  'm3/d': 'm3day',
  'ml/d': 'MLday',
  'mgd': 'MGD',
  'ac-ft/d': 'acftday', 'acft/d': 'acftday', 'acre-ft/d': 'acftday', 'acre-feet/d': 'acftday', 'af/d': 'acftday',
  'mm': 'mm_step', 'mm/interval': 'mm_step', 'mm/step': 'mm_step',
  'mm/d': 'mm_step', 'mm/h': 'mm_step',
  'in/d': 'in_day',
};
/** Depth spellings with their own period: the tool reads them as depth per
 *  time step, which is right only for that time step. */
const PER_PERIOD: Record<string, string> = { 'mm/d': '1 day', 'mm/h': '1 hour' };

function bracketKey(raw: string): string {
  return raw.normalize('NFKC').replace(/\u2212/g, '-').toLowerCase()
    .replace(/\s*\(.*\)$/, '')
    .replace(/[\s^\u00B7\u2022*]/g, '').replace(/\.(?=[a-z])/g, '')
    .replace(/(s|sec|d|day|h|hr|hour)-1$/, '/$1')
    .replace(/\/sec$/, '/s').replace(/\/day$/, '/d').replace(/\/(hr|hour)$/, '/h');
}

function unitOfBracket(raw: string): UnitId | null {
  const id = HEADER_UNITS[bracketKey(raw)] ?? null;
  // "ML/d" is megalitres; a lower-case "ml" (millilitres) is not a flow unit
  if (id === 'MLday' && !/^M[Ll]/.test(raw.trim())) return null;
  return id;
}

/** A header that names a date or time column: its bracket ("Date [UTC]")
 *  is not a discharge unit. */
const DATE_HEADER = /^\s*(date|time|datetime|timestamp|datum|zeit|fecha|heure)\b/i;

const quoted = (xs: string[]) => xs.map(x => `“[${x}]”`).join(', ');

/**
 * The discharge unit named in the column headers ("obs [ft³/s]"), for the
 * Data tab's unit selector (ingest-08). `cols` are the Observed and
 * Simulated columns; without them every column except date and time
 * columns is read (before the roles are mapped). One unit found sets it.
 * None found, or several different ones, returns null so the selector goes
 * back to its default rather than keeping the previous file's unit. A
 * bracket that names no unit the tool knows ("[kcfs]", "[m3/h]") is named
 * in the note, so a unit is never reset without a word.
 */
export function unitFromHeader(header: string[], cols?: number[]): { unit: UnitId | null; note: string | null } {
  const found = new Set<UnitId>();
  const unknown: string[] = [];
  let period: [string, string] | null = null;
  const idx = cols ?? header.map((_, j) => j).filter(j => !DATE_HEADER.test((header[j] ?? '').replace(/\[.*?\]/g, '')));
  for (const j of idx) {
    const m = /\[(.+?)\]/.exec(header[j] ?? '');
    if (!m) continue;
    const raw = m[1].trim();
    const u = unitOfBracket(raw);
    if (!u) { if (!unknown.includes(raw)) unknown.push(raw); continue; }
    found.add(u);
    const per = PER_PERIOD[bracketKey(raw)];
    if (per && !period) period = [raw, per];
  }
  const one = unknown.length === 1;
  if (found.size === 1) {
    const u = [...found][0], label = UNITS[u].label;
    let note = `Discharge unit set to ${label} from the column headers.`;
    if (period) note += ` The tool reads “[${period[0]}]” as mm per time step, which is correct only for a time step of ${period[1]}.`;
    if (unknown.length) note += ` The unit${one ? '' : 's'} ${quoted(unknown)} in the column headers ${one ? 'is not a unit' : 'are not units'} the tool knows; make sure ${one ? 'that column is' : 'those columns are'} also in ${label}.`;
    return { unit: u, note };
  }
  if (found.size > 1) {
    return { unit: null, note: `The column headers name different units (${[...found].map(u => UNITS[u].label).join(', ')}); one unit applies to every value column, so set the Discharge unit and convert the other columns before loading.` };
  }
  if (unknown.length) {
    return { unit: null, note: `The unit${one ? '' : 's'} ${quoted(unknown)} in the column headers ${one ? 'is not a unit' : 'are not units'} the tool knows, so the Discharge unit is set to ${UNITS.m3s.label}. Check it.` };
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

/** Missing-value texts named one by one in the warning; more are counted. */
const TOKEN_TEXTS_SHOWN = 8;

/** A dd.mm.yyyy date ("13.01.2020", also with a time) among the first 20
 *  non-empty cells of the date column, or null. Dotted day-first dates are a
 *  European cue for the decimal comma. */
function dottedDateExample(rows: Cell[][], col: number): string | null {
  let seen = 0;
  for (let i = 0; i < rows.length && seen < 20; i++) {
    const t = String(rows[i][col] ?? '').trim();
    if (!t) continue;
    seen++;
    if (/^\d{1,2}\.\d{1,2}\.\d{2,4}(?:$|[\sT])/.test(t)) return t;
  }
  return null;
}

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
  // columns, and otherwise asked of the user (ingest-01). A ";" delimiter
  // or dd.mm.yyyy dates make a dot before three digits a question too.
  const dmyExample = dateCol >= 0 ? dottedDateExample(table.rows, dateCol) : null;
  const europeanWhy = table.delimiter === ';'
    ? 'The file uses “;” between cells, which usually goes with a decimal comma.'
    : dmyExample ? `The file has dates such as “${dmyExample}”, which usually go with a decimal comma.` : null;
  const scan = (j: number) => cached(cache.scans, j, () => scanDecimalMarks(table.rows, j));
  const markOf = (j: number) => cached(marks, j, () => resolveDecimalMark(scan(j), () => valueCols.filter(k => k !== j).map(scan), opt.decimalMark ?? 'auto', europeanWhy !== null));
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
      const sc = scan(j), ex = sc.ambiguousExample;
      const [p, c] = readBoth(ex);
      const why = undecidedReason(sc, europeanWhy);
      validation.errors.push(`Column “${name}” has values such as “${ex}” that read as ${p} with a decimal point or ${c} with a decimal comma${
        why ? `. ${why}` : ', and nothing in the file shows which is meant.'} Choose the decimal mark in the Decimal mark selector.`);
    }
    const parsed = col(j);
    if (parsed.invalid > 0) {
      validation.warnings.push(`Column “${name}”: ${fmtCount(parsed.invalid)} cell${plural(parsed.invalid, '', 's')} could not be read as a number (e.g. “${parsed.invalidExample}”) and ${plural(parsed.invalid, 'is', 'are')} treated as missing.`);
    }
    if (parsed.tokens > 0) {
      // Every distinct text is named, up to TOKEN_TEXTS_SHOWN; the rest are
      // counted, so the message never hides what the cells hold (ingest-10).
      const texts = parsed.tokenTexts, shown = texts.slice(0, TOKEN_TEXTS_SHOWN).map(t => `“${t}”`).join(', ');
      const rest = texts.length - TOKEN_TEXTS_SHOWN;
      validation.warnings.push(`Column “${name}”: ${fmtCount(parsed.tokens)} cell${plural(parsed.tokens, '', 's')} ${plural(parsed.tokens, 'holds', 'hold')} ${shown}${
        rest > 0 ? ` and ${fmtCount(rest)} other missing-value text${plural(rest, '', 's')},` : ''} and ${plural(parsed.tokens, 'is', 'are')} treated as missing.`);
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
