/** Missing-value token handling (§6.0), numeric cell reading, and NaN policies (§10.4). */

/** Cell texts read as missing without being declared (compared case-blind).
 *  Empty cells are missing too. Stage reports every non-empty one it meets. */
export const MISSING_TOKENS = ['na', 'nan', 'null', 'n/a', '-', '--', '---', 'none', 'missing'] as const;
const BASE_TOKENS = new Set<string>(['', ...MISSING_TOKENS]);

/** The decimal-mark setting of the Data tab. 'auto' decides per column from
 *  the cells (see resolveDecimalMark); 'point' and 'comma' are the user's
 *  answer for the columns that auto cannot decide, and only for those. */
export type DecimalMark = 'auto' | 'point' | 'comma';

export interface MissingOptions {
  /** A user-declared no-data value (e.g. -999). null = nothing is treated as missing. */
  missingValue?: number | null;
  /** How to read a cell that is a valid number with either decimal mark but
   *  gives two different values ("1,234" is 1234 or 1.234; "1.234" is 1.234
   *  or 1234): true reads the comma as the decimal mark (and the dot as a
   *  thousands mark), false the reverse. Cells that only one mark can
   *  explain ("0,125", "1,5", "1,234,567", "1.5") are read that way
   *  whatever this says. */
  commaDecimal?: boolean;
}

/** Strict decimal grammar with a decimal point and no grouping. Rejects the
 *  forms Number() would accept silently (hex "0x10", binary, octal,
 *  "Infinity", whitespace-only). */
const DECIMAL_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
/** Dot-grouped integer ("1.234", "12.345.678"): a first group of 1-3 digits
 *  that does not start with 0, then groups of exactly 3 (CLDR "#,##0"). */
const DOT_GROUPED_RE = /^[+-]?[1-9]\d{0,2}(\.\d{3})+$/;
/** Full grammars, one per decimal mark. The integer part is either plain
 *  digits or CLDR grouping (first group 1-3 digits, not starting with 0,
 *  then groups of 3) with ONE grouping character used throughout: the other
 *  mark, a space, a no-break space (U+00A0), a narrow no-break space
 *  (U+202F, the French group separator) or an apostrophe (Swiss). */
const POINT_RE = /^([+-]?)(?:(\d+)|([1-9]\d{0,2})([, \u00A0\u202F'\u2019])(\d{3}(?:\4\d{3})*))?(?:\.(\d*))?([eE][+-]?\d+)?$/;
const COMMA_RE = /^([+-]?)(?:(\d+)|([1-9]\d{0,2})([. \u00A0\u202F'\u2019])(\d{3}(?:\4\d{3})*))?(?:,(\d*))?([eE][+-]?\d+)?$/;

function readWith(t: string, re: RegExp): number {
  const m = re.exec(t);
  if (!m) return NaN;
  const int = m[2] ?? (m[3] !== undefined ? m[3] + m[5].split(m[4]).join('') : '');
  const frac = m[6] ?? '';
  if (!int && !frac) return NaN;                       // ".", "+", ","
  return Number(`${m[1]}${int || '0'}.${frac || '0'}${m[7] ?? ''}`);
}

/**
 * The value of a trimmed, non-empty cell under each decimal mark:
 * [value with a decimal point, value with a decimal comma]. NaN where that
 * mark cannot explain the cell. Equal values mean the cell is unambiguous;
 * two different finite values mean the reader must decide ("1,234").
 */
export function readBoth(t: string): [number, number] {
  if (t.charCodeAt(0) === 0x2212) t = '-' + t.slice(1);   // U+2212 minus sign
  let grouped = false;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 44 || c === 32 || c === 0xA0 || c === 0x202F || c === 39 || c === 0x2019) { grouped = true; break; }
  }
  if (!grouped) {
    // Digits, sign, exponent and dots only: the point reading is plain JS
    // decimal syntax; the comma reading exists only for dot grouping.
    const p = DECIMAL_RE.test(t) ? Number(t) : NaN;
    if (t.indexOf('.') < 0) return [p, p];
    return [p, DOT_GROUPED_RE.test(t) ? Number(t.split('.').join('')) : NaN];
  }
  return [readWith(t, POINT_RE), readWith(t, COMMA_RE)];
}

/**
 * Locale-aware numeric cell parsing (QA-005, audit ingest-01/ingest-10).
 * Every cell is read under both decimal marks (readBoth):
 *  - a cell only one mark can explain is read that way: "3,5", "0,125",
 *    "-0,500" and "1.234,5" have a decimal comma (a thousands group never
 *    starts with 0 and always has 3 digits); "1,234,567", "1,234.5" and
 *    "1.5" have a decimal point;
 *  - space, no-break space, U+202F and apostrophe grouping is accepted with
 *    either mark ("1 234,5" is 1234.5);
 *  - a cell both marks explain with different values ("1,234", "1.234") is
 *    read with the comma as decimal mark when `commaDecimal` is true and
 *    with the point otherwise. stage() decides this per column and asks
 *    the user when the file cannot tell (resolveDecimalMark);
 *  - scientific notation passes through; hex, "Infinity" and other
 *    non-decimal forms are invalid (NaN).
 */
export function parseNumericCell(raw: string, commaDecimal = false): number {
  const t = raw.trim();
  if (!t) return NaN;
  const [p, c] = readBoth(t);
  if (Number.isNaN(p)) return c;
  if (Number.isNaN(c) || p === c) return p;
  return commaDecimal ? c : p;
}

/** What one column's cells say about the decimal mark. */
export interface ColumnScan {
  /** Cells only a decimal point explains ("1.5", "1,234,567"). */
  point: number;
  /** Cells only a decimal comma explains ("0,125", "1,5", "1.234,5"). */
  comma: number;
  /** Cells both marks explain with different values ("1,234", "1.234"). */
  ambiguous: number;
  /** Those of them that contain a comma ("1,234", "-999,000"). */
  ambiguousComma: number;
  /** An ambiguous cell, one with a comma when there is one. */
  ambiguousExample: string;
  /** Whole numbers written without any mark ("850", "-12"), and one of them. */
  integers: number;
  integerExample: string;
  /** Sum and count of log10 |value| over the non-zero whole numbers and
   *  over the ambiguous dot cells read with a decimal point ("1.250" is
   *  1.25). Their means compare the sizes of the two groups. */
  intLogSum: number;
  intLogCount: number;
  dotLogSum: number;
  dotLogCount: number;
}

const INTEGER_RE = /^[+\-\u2212]?\d+$/;

/** Scan column `col` of `rows` for decimal-mark evidence (text cells only;
 *  workbook numbers carry no mark). */
export function scanDecimalMarks(rows: ArrayLike<ArrayLike<unknown>>, col: number): ColumnScan {
  const out: ColumnScan = { point: 0, comma: 0, ambiguous: 0, ambiguousComma: 0, ambiguousExample: '', integers: 0, integerExample: '',
    intLogSum: 0, intLogCount: 0, dotLogSum: 0, dotLogCount: 0 };
  for (let i = 0; i < rows.length; i++) {
    const cell = rows[i][col];
    if (typeof cell !== 'string') continue;
    const t = cell.trim();
    if (BASE_TOKENS.has(t.toLowerCase())) continue;
    if (INTEGER_RE.test(t)) {
      if (!out.integers++) out.integerExample = t;
      const v = Math.abs(readBoth(t)[0]);
      if (v > 0) { out.intLogSum += Math.log10(v); out.intLogCount++; }
      continue;
    }
    const [p, c] = readBoth(t);
    const pn = Number.isNaN(p), cn = Number.isNaN(c);
    if (pn && cn) continue;
    if (pn) out.comma++;
    else if (cn) out.point++;
    else if (p !== c) {
      if (!out.ambiguous++) out.ambiguousExample = t;
      if (t.indexOf(',') >= 0) { if (!out.ambiguousComma++) out.ambiguousExample = t; }
      else if (p !== 0) { out.dotLogSum += Math.log10(Math.abs(p)); out.dotLogCount++; }
    }
  }
  return out;
}

/**
 * Do the whole numbers of a column match its dot cells read with the dot
 * as a thousands separator ("850" next to "1.000", "1.250": 1000, 1250)
 * rather than as a decimal point (1, 1.25)? A time series does not jump
 * by a factor of 1000 between neighbouring kinds of cells, so the reading
 * that puts the two groups closer in size is the likely one. The grouped
 * reading is the point reading times 1000 (three orders of magnitude), so
 * the grouped reading is closer when the whole numbers are on average more
 * than 10^1.5 (about 32) times the point reading. A stray small whole
 * number among fixed three-decimal values ("-2" next to "4.873") does not
 * match.
 */
export function integersSuggestGrouping(own: ColumnScan): boolean {
  if (!own.intLogCount || !own.dotLogCount) return false;
  return own.intLogSum / own.intLogCount > own.dotLogSum / own.dotLogCount + 1.5;
}

/**
 * Does the column use the comma as its decimal mark? True when at least one
 * cell can only be read with a decimal comma ("1,23", "0,5", "0,125",
 * "1234,5", "1.234,5"), so "1,234" in the same column reads 1.234, not 1234
 * (which would be a silent thousand-fold error on the rows that happen to
 * have three decimals).
 */
export function detectCommaDecimal(rows: ArrayLike<ArrayLike<unknown>>, col: number): boolean {
  return scanDecimalMarks(rows, col).comma > 0;
}

/**
 * Decide how a column's ambiguous cells are read, or null when nothing
 * decides it and the user must choose.
 *  - The column's own unambiguous cells decide when they all point one way
 *    (null when they contradict each other).
 *  - Otherwise the other value columns of the file decide when theirs all
 *    point one way.
 *  - Otherwise a column with an ambiguous comma ("12,345") gets null: a
 *    comma is never guessed to be a thousands mark, which would make the
 *    value 1000 times too large.
 *  - Otherwise only dot cells such as "1.000" or "5.123" are ambiguous. They
 *    get null when the column also has whole numbers of the size that the
 *    grouped reading gives ("850" next to "1.000": integersSuggestGrouping)
 *    or when the file has European cues (`european`: ";" between cells or
 *    dd.mm.yyyy dates), because the point reading would then be 1000 times
 *    too small (ingest-01). Else they keep the decimal point, the
 *    anglophone default.
 *  - `mark` ('point' / 'comma', the user's choice) answers only the columns
 *    that the steps above leave at null. A column that is already decided
 *    keeps its own reading.
 * A column with no ambiguous cell needs no decision and gets 'point' (a
 * no-op: every cell has one reading).
 */
export function resolveDecimalMark(own: ColumnScan, others: ColumnScan[] | (() => ColumnScan[]), mark: DecimalMark = 'auto', european = false): 'point' | 'comma' | null {
  const auto = autoDecimalMark(own, others, european);
  return auto === null && mark !== 'auto' ? mark : auto;
}

function autoDecimalMark(own: ColumnScan, others: ColumnScan[] | (() => ColumnScan[]), european: boolean): 'point' | 'comma' | null {
  if (own.ambiguous === 0) return 'point';
  if (own.comma > 0 && own.point === 0) return 'comma';
  if (own.point > 0 && own.comma === 0) return 'point';
  if (own.point > 0 && own.comma > 0) return null;      // the column contradicts itself
  let p = 0, c = 0;
  for (const s of typeof others === 'function' ? others() : others) { p += s.point; c += s.comma; }
  if (c > 0 && p === 0) return 'comma';
  if (p > 0 && c === 0) return 'point';
  if (own.ambiguousComma > 0) return null;
  if (integersSuggestGrouping(own) || european) return null;
  return 'point';
}

/** Why resolveDecimalMark left a column undecided, as a sentence for the
 *  Data tab's question, or null for the general case ("nothing in the file
 *  shows which is meant"). `europeanWhy` names the European cue. */
export function undecidedReason(own: ColumnScan, europeanWhy: string | null): string | null {
  if (own.ambiguousComma > 0 || own.point > 0 || own.comma > 0) return null;
  if (integersSuggestGrouping(own)) return `The column also has whole numbers such as “${own.integerExample}”, which are near in size to the values with the dot as a thousands separator.`;
  return europeanWhy;
}

export function parseValue(raw: string | number | null | undefined, opts: MissingOptions = {}): number {
  const missingValue = opts.missingValue ?? null;
  if (raw === null || raw === undefined) return NaN;
  if (typeof raw === 'number') {
    if (missingValue !== null && raw === missingValue) return NaN;
    return raw;
  }
  const s = raw.trim();
  if (BASE_TOKENS.has(s.toLowerCase())) return NaN;
  const v = parseNumericCell(s, opts.commaDecimal === true);
  if (!isFinite(v)) return NaN;
  if (missingValue !== null && v === missingValue) return NaN;
  return v;
}

/** One value column read in full, with what had to be treated as missing. */
export interface ColumnParse {
  values: number[];
  /** Non-empty cells that are neither numbers nor missing tokens. */
  invalid: number;
  invalidExample: string;
  /** Cells holding a missing-value token (MISSING_TOKENS), and every
   *  distinct text among them, in order of first appearance (ingest-10). */
  tokens: number;
  tokenTexts: string[];
}

/** Read a column: parseValue per cell, counting what became missing and why. */
export function parseColumn(cells: ArrayLike<unknown>, opts: MissingOptions = {}): ColumnParse {
  const values = new Array<number>(cells.length);
  const out: ColumnParse = { values, invalid: 0, invalidExample: '', tokens: 0, tokenTexts: [] };
  const seen = new Set<string>();
  for (let i = 0; i < cells.length; i++) {
    const raw = cells[i];
    if (typeof raw === 'number') { values[i] = parseValue(raw, opts); continue; }
    const s = raw === null || raw === undefined ? '' : String(raw).trim();
    if (s === '') { values[i] = NaN; continue; }
    if (BASE_TOKENS.has(s.toLowerCase())) {
      values[i] = NaN;
      out.tokens++;
      if (!seen.has(s)) { seen.add(s); out.tokenTexts.push(s); }
      continue;
    }
    const v = parseNumericCell(s, opts.commaDecimal === true);
    if (!isFinite(v)) {
      values[i] = NaN;
      if (!out.invalid++) out.invalidExample = s;
    } else values[i] = opts.missingValue != null && v === opts.missingValue ? NaN : v;
  }
  return out;
}

export type NanPolicy = 'pairwise' | 'zero' | 'mean';

export interface Paired {
  obs: Float64Array;
  sim: Float64Array;
  /** Indices (into the original series) that survived pairing. */
  index: number[];
  /** Number of valid pairs actually used. */
  n: number;
}

/**
 * Apply a NaN policy to one (observed, simulated) pair (§10.4).
 * 'pairwise' (default): drop time steps where either value is missing: the
 * same semantics as HydroErr's default treatment, which our reference vectors pin.
 * 'zero' / 'mean': substitute per-series before computing.
 */
export function applyNanPolicy(obs: ArrayLike<number>, sim: ArrayLike<number>, policy: NanPolicy = 'pairwise'): Paired {
  const n = Math.min(obs.length, sim.length);

  if (policy === 'pairwise') {
    const index: number[] = [];
    for (let i = 0; i < n; i++) if (isFinite(obs[i]) && isFinite(sim[i])) index.push(i);
    const o = new Float64Array(index.length), s = new Float64Array(index.length);
    index.forEach((idx, k) => { o[k] = obs[idx]; s[k] = sim[idx]; });
    return { obs: o, sim: s, index, n: index.length };
  }

  const fill = (arr: ArrayLike<number>): Float64Array => {
    const out = new Float64Array(n);
    if (policy === 'zero') {
      for (let i = 0; i < n; i++) out[i] = isFinite(arr[i]) ? arr[i] : 0;
    } else {
      let sum = 0, c = 0;
      for (let i = 0; i < n; i++) if (isFinite(arr[i])) { sum += arr[i]; c++; }
      const m = c > 0 ? sum / c : 0;
      for (let i = 0; i < n; i++) out[i] = isFinite(arr[i]) ? arr[i] : m;
    }
    return out;
  };
  const index = Array.from({ length: n }, (_, i) => i);
  return { obs: fill(obs), sim: fill(sim), index, n };
}
