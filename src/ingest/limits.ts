/**
 * Ingest limits: hard caps that are checked before any expensive work, and
 * the soft "large dataset" thresholds above which the user is asked first.
 *
 * The numbers come from a measured campaign (Chromium, 4 GB renderer heap):
 * a 1,000,000 x 25 delimited file (160 MB) still loads at about 1.3 GB of
 * heap; 3,000,000 rows parse but are unusable (minutes per metric panel);
 * 3,000,000 x 25 is a certain out-of-memory. SheetJS needs roughly 300 bytes
 * of transient heap per cell, so workbooks are capped on bytes well below the
 * delimited cap. Every message states the size found, the limit, and what to
 * do about it.
 */

const MB = 1024 * 1024;

export const LIMITS = {
  /** Delimited text (CSV, TXT, TSV); checked on the File size before reading. */
  delimitedBytes: 200 * MB,
  /** Excel workbooks; checked on the File size before reading. */
  workbookBytes: 25 * MB,
  /** Saved projects (.hme.json); JSON.parse needs several times the file size. */
  projectBytes: 100 * MB,
  /** Paste box, in characters (one character is one byte of a text file). */
  pasteChars: 25 * MB,
  /** Data rows (Excel's own sheet limit is 1,048,576). */
  rows: 1_000_000,
  /** Columns in the table. */
  columns: 100,
  /** rows x columns. */
  cells: 30_000_000,
  /** Columns that may be mapped as Simulated in one dataset. */
  runs: 60,
  /** Editable sheet. */
  sheetRows: 2_000,
  sheetColumns: 32,
  /** Soft thresholds: above these the user is asked before the table loads. */
  warnRows: 250_000,
  warnCells: 5_000_000,
  warnWorkbookBytes: 8 * MB,
  warnProjectBytes: 25 * MB,
  /** Time-series traces are drawn at reduced resolution above this many points. */
  plotPoints: 50_000,
} as const;

export const fmtMB = (bytes: number): string => {
  const mb = bytes / MB;
  return `${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)} MB`;
};
const num = (n: number): string => n.toLocaleString('en-US');

export interface TableShape { rows: number; columns: number }

/**
 * Cheap pass over delimited text before the real parser runs: the number of
 * non-empty lines after the header and the column count of the header line
 * (delimiter sniffed among comma, tab, semicolon and pipe). Quoted newlines
 * or quoted delimiters in the header can over-count slightly, which only
 * matters at the caps themselves.
 */
export function inspectDelimited(text: string): TableShape {
  // Classic Mac line endings (CR only): the parser reads them, so the scan must too.
  if (text.indexOf('\n') < 0 && text.indexOf('\r') >= 0) text = text.replace(/\r/g, '\n');
  const n = text.length;
  let start = 0;
  while (start < n && (text.charCodeAt(start) === 10 || text.charCodeAt(start) === 13 || text.charCodeAt(start) === 32 || text.charCodeAt(start) === 65279)) start++;
  let end = text.indexOf('\n', start);
  if (end < 0) end = n;
  const header = text.slice(start, end).replace(/\r$/, '');
  let best = 0;
  for (const d of [',', '\t', ';', '|']) {
    let c = 0, p = -1;
    while ((p = header.indexOf(d, p + 1)) >= 0) c++;
    if (c > best) best = c;
  }
  const columns = header.length ? best + 1 : 0;
  let rows = 0, pos = end + 1;
  while (pos < n) {
    let nl = text.indexOf('\n', pos);
    if (nl < 0) nl = n;
    let e = nl;
    if (e > pos && text.charCodeAt(e - 1) === 13) e--;
    if (e > pos) rows++;
    pos = nl + 1;
  }
  return { rows, columns };
}

/** Hard size rejection for an upload, or null when the file may be read. */
export function fileSizeMessage(bytes: number, kind: 'delimited' | 'workbook' | 'project'): string | null {
  if (kind === 'delimited') {
    if (bytes <= LIMITS.delimitedBytes) return null;
    return `This file is ${fmtMB(bytes)}; delimited text files above ${fmtMB(LIMITS.delimitedBytes)} cannot be loaded in the browser. Split the record into shorter periods, remove columns you do not need, or resample to daily or monthly means before uploading.`;
  }
  if (kind === 'workbook') {
    if (bytes <= LIMITS.workbookBytes) return null;
    return `This workbook is ${fmtMB(bytes)}; workbooks above ${fmtMB(LIMITS.workbookBytes)} cannot be read in the browser. Save the sheet as CSV (File, Save As) and upload that instead, or remove columns you do not need.`;
  }
  if (bytes <= LIMITS.projectBytes) return null;
  return `This project file is ${fmtMB(bytes)}; project files above ${fmtMB(LIMITS.projectBytes)} cannot be loaded in the browser. Save projects with fewer datasets per file.`;
}

/** Hard row, column and cell rejection for a table, or null when it fits. */
export function tableShapeMessage(shape: TableShape, what = 'This file'): string | null {
  const { rows, columns } = shape;
  if (rows > LIMITS.rows) {
    return `${what} has ${num(rows)} data rows; the tool accepts up to ${num(LIMITS.rows)}. Split the record into shorter periods or resample to daily or monthly means before uploading.`;
  }
  if (columns > LIMITS.columns) {
    return `${what} has ${num(columns)} columns; the tool accepts up to ${num(LIMITS.columns)}. Remove the columns you do not need before uploading.`;
  }
  if (rows * columns > LIMITS.cells) {
    return `${what} has ${num(rows)} rows x ${num(columns)} columns (${num(rows * columns)} cells); the tool accepts up to ${num(LIMITS.cells)} cells. Remove columns you do not need or resample the record before uploading.`;
  }
  return null;
}

/** Populated extent of a worksheet: the table shape it implies plus the
 *  SheetJS bounds (0-based, inclusive) of the cells, or null for no cell. */
export interface UsedRange extends TableShape { s: { r: number; c: number }; e: { r: number; c: number } }

/**
 * Extent of a worksheet's populated cells, ignoring its declared range.
 * Excel inflates the sheet dimension with formatted-but-empty rows and
 * columns (a whole-column fill or a stray format near row 1,048,576 is
 * common in real files), so a declared range above the caps is not a
 * refusal by itself: the cells decide. Keys starting with "!" are sheet
 * metadata and stub cells (type "z") are blank; both are skipped.
 */
export function usedRange(sheet: Record<string, unknown>): UsedRange | null {
  let r0 = Infinity, r1 = -1, c0 = Infinity, c1 = -1;
  for (const key of Object.keys(sheet)) {
    if (key.charCodeAt(0) === 33) continue; // "!"
    const cell = sheet[key] as { t?: string } | null | undefined;
    if (!cell || typeof cell !== 'object' || cell.t === 'z') continue;
    // A1-style address: the letters are the column (base 26), the digits the row
    let i = 0, c = 0;
    while (i < key.length) {
      const code = key.charCodeAt(i);
      if (code < 65 || code > 90) break;
      c = c * 26 + (code - 64);
      i++;
    }
    if (i === 0 || i === key.length) continue;
    const r = Number(key.slice(i));
    if (!Number.isInteger(r) || r < 1) continue;
    if (r < r0) r0 = r;
    if (r > r1) r1 = r;
    if (c < c0) c0 = c;
    if (c > c1) c1 = c;
  }
  if (r1 < 0) return null;
  return { rows: r1 - r0, columns: c1 - c0 + 1, s: { r: r0 - 1, c: c0 - 1 }, e: { r: r1 - 1, c: c1 - 1 } };
}

/** Simulated-column cap message, or null. */
export function runsMessage(mapped: number): string | null {
  if (mapped <= LIMITS.runs) return null;
  return `${num(mapped)} columns are mapped as Simulated; the tool computes up to ${LIMITS.runs} simulations per dataset. Set the extra columns to Ignore.`;
}

export function pasteMessage(chars: number): string | null {
  if (chars <= LIMITS.pasteChars) return null;
  return `The pasted text is ${fmtMB(chars)}; the paste box accepts up to ${fmtMB(LIMITS.pasteChars)}. Save it as a file and use Upload instead.`;
}

export function sheetRowsMessage(pastedRows: number): string {
  return `The editable sheet holds up to ${num(LIMITS.sheetRows)} rows; this paste has ${num(pastedRows)} rows. Paste larger tables into the text box below or upload a file.`;
}

/** Rough wall-clock expectations from the measured campaign (desktop-class CPU). */
export const estimateLoadSeconds = (shape: TableShape): number =>
  Math.max(2, Math.round((shape.rows * shape.columns) / 250_000));
export const estimatePanelSeconds = (rows: number): number =>
  Math.max(1, Math.round(rows / 90_000));

/** Soft confirmation body for a large delimited table, or null when it is not large. */
export function largeTableNotice(shape: TableShape, bytes?: number): string | null {
  const { rows, columns } = shape;
  if (rows <= LIMITS.warnRows && rows * columns <= LIMITS.warnCells) return null;
  const size = bytes ? ` (${fmtMB(bytes)})` : '';
  return `This table has ${num(rows)} rows and ${num(columns)} columns${size}. Loading and mapping it will take roughly ${num(estimateLoadSeconds(shape))} seconds, each metric panel about ${num(estimatePanelSeconds(rows))} seconds per simulation, and time-series plots will be drawn at reduced resolution (every point still counts in the metrics).`;
}

/** Soft confirmation body for a large workbook, or null. */
export function largeWorkbookNotice(bytes: number): string | null {
  if (bytes <= LIMITS.warnWorkbookBytes) return null;
  return `This workbook is ${fmtMB(bytes)}. Reading it may take up to a minute and a large amount of memory; a CSV export of the same sheet loads several times faster.`;
}

/** Soft confirmation body for a large project file, or null. */
export function largeProjectNotice(bytes: number): string | null {
  if (bytes <= LIMITS.warnProjectBytes) return null;
  return `This project file is ${fmtMB(bytes)}; loading it may take about ${num(Math.max(5, Math.round(bytes / (4 * MB))))} seconds.`;
}
