export type DateFormat = 'auto' | 'ymd' | 'mdy' | 'dmy' | 'julian';

export interface ParsedDates {
  /** UTC epoch ms; NaN where unparseable. */
  ms: number[];
  /** Format actually applied. */
  used: Exclude<DateFormat, 'auto'> | 'iso' | 'mixed' | 'month-name';
  /** True when day/month order could not be inferred and MDY was NOT safe to assume. */
  ambiguous: boolean;
  failures: number;
  /** Parsed values that carried a UTC offset other than zero ("-05:00");
   *  they are converted to UTC. */
  shifted: number;
  /** Parsed values with a date-time zone designator of any kind (Z, UTC,
   *  +hh:mm); the rest are read as UTC wall-clock time. */
  zoned: number;
  /** A value with a non-zero offset, as written (for messages). */
  shiftedExample: string;
}

// Time of day after the date. The WHOLE string must match (audit ingest-02):
// a separator ("T" or spaces), hour of 1 or 2 digits, optional :mm, :ss and
// fraction of a second, optional AM/PM, optional zone designator (Z, UTC,
// GMT, +hh, +hhmm or +hh:mm). Anything else left over makes the cell
// unparseable, so it is counted as a failure instead of being cut off.
const TIME = String.raw`(?:(?:T|\s+)(\d{1,2})(?::(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?\s*([AaPp]\.?[Mm]\.?)?\s*(Z|UTC|GMT|[+-]\d{2}(?::?\d{2})?)?)?`;
const ISO_RE = new RegExp(String.raw`^(\d{4})-(\d{2})-(\d{2})${TIME}$`);
const JULIAN_RE = /^(\d{4})[-_ ]?(\d{3})$/;                  // 2023-045 / 2023045
const NUMERIC_RE = new RegExp(String.raw`^(\d{1,4})[\/\-.](\d{1,2})[\/\-.](\d{1,4})${TIME}$`);
// Month-name forms are unambiguous about day/month order, so they parse in any
// non-Julian mode: 01-Jan-2020, 1 January 2020 (day first) and Jan 1, 2020,
// September 3 1999 (month first), with the same optional time part.
const DMY_NAME_RE = new RegExp(String.raw`^(\d{1,2})[-\/. ]([A-Za-z]{3,9})[-\/. ]+(\d{2,4})${TIME}$`);
// day and year need a real separator (comma or [-/. ]) so a month-year label
// like "May-2020" is NOT silently read as day 20 of 2020
const MDY_NAME_RE = new RegExp(String.raw`^([A-Za-z]{3,9})[-\/. ]+(\d{1,2})(?:,\s*|[-\/. ]+)(\d{2,4})${TIME}$`);
/** Index of the hour group in every date regex above (groups 1-3 are the date). */
const H = 4;
const MONTH_PREFIX: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];

function monthFromName(token: string): number {
  const lo = token.toLowerCase();
  const m = MONTH_PREFIX[lo.slice(0, 3)];
  if (!m) return NaN;
  // Accept the 3-letter abbreviation, "sept", or any prefix of the full name
  // ("janu", "january"); reject arbitrary words that merely start like one.
  if (lo.length === 3 || lo === 'sept' || MONTH_NAMES[m - 1].startsWith(lo)) return m;
  return NaN;
}

/** Two-digit years use the POSIX/strptime pivot: 00-68 read as 2000-2068,
 *  69-99 as 1969-1999. Documented in the QA ingest tests. */
function pivotYear(y: number, rawDigits: string): number {
  if (rawDigits.length > 2) return y;
  return y <= 68 ? 2000 + y : 1900 + y;
}

/** Counters filled while a column is parsed. */
interface ZoneTally { shifted: number; zoned: number; shiftedExample: string }

/** Time of day from the TIME groups of a match, or null when a field is out
 *  of range: hour 0-23 (1-12 with AM/PM; 24:00 exactly is the end of the
 *  day, ISO 8601:2004), minute 0-59, second 0-59 (audit ingest-11). The
 *  offset is in minutes east of UTC. */
interface TimeOfDay { ms: number; offsetMin: number; zoned: boolean }
function timeOf(m: RegExpExecArray): TimeOfDay | null {
  if (m[H] === undefined) return { ms: 0, offsetMin: 0, zoned: false };
  let h = +m[H];
  const mi = +(m[H + 1] ?? 0), s = +(m[H + 2] ?? 0);
  const frac = m[H + 3] ? +(m[H + 3] + '00').slice(0, 3) : 0;
  const ampm = m[H + 4];
  if (ampm) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (/^[Pp]/.test(ampm) ? 12 : 0);
  }
  if (mi > 59 || s > 59) return null;
  if (h > 24 || (h === 24 && (mi || s || frac))) return null;
  const z = m[H + 5];
  let offsetMin = 0;
  if (z && z !== 'Z' && z !== 'UTC' && z !== 'GMT') {
    const d = z.replace(':', '');
    const oh = +d.slice(1, 3), om = d.length > 3 ? +d.slice(3, 5) : 0;
    if (oh > 14 || om > 59) return null;
    offsetMin = (z[0] === '-' ? -1 : 1) * (oh * 60 + om);
  }
  return { ms: ((h * 60 + mi) * 60 + s) * 1000 + frac, offsetMin, zoned: !!z };
}

/** UTC epoch ms of a calendar date plus a time of day; NaN for a date that
 *  rolls over (month 13, day 32, 30 February) or an invalid time. */
function utc(y: number, mo: number, d: number, t: TimeOfDay | null, raw: string, tally?: ZoneTally): number {
  if (!t) return NaN;
  const day = Date.UTC(y, mo - 1, d);
  // Reject rollovers like month 13 or day 32.
  const dt = new Date(day);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return NaN;
  if (tally && t.zoned) {
    tally.zoned++;
    if (t.offsetMin !== 0 && !tally.shifted++) tally.shiftedExample = raw;
  }
  return day + t.ms - t.offsetMin * 60_000;
}

/** Parse a month-name date; NaN when the string is not one. */
function parseNamed(s: string, tally?: ZoneTally): number {
  let day: number, mo: number, yRaw: string;
  const dmy = DMY_NAME_RE.exec(s);
  const m = dmy ?? MDY_NAME_RE.exec(s);
  if (!m) return NaN;
  if (dmy) { day = +m[1]; mo = monthFromName(m[2]); yRaw = m[3]; }
  else { mo = monthFromName(m[1]); day = +m[2]; yRaw = m[3]; }
  if (!isFinite(mo)) return NaN;
  return utc(pivotYear(+yRaw, yRaw), mo, day, timeOf(m), s, tally);
}

function julianToMs(y: number, doy: number): number {
  const jan1 = Date.UTC(y, 0, 1);
  const max = (Date.UTC(y + 1, 0, 1) - jan1) / 86400_000;
  if (doy < 1 || doy > max) return NaN;
  return jan1 + (doy - 1) * 86400_000;
}

function parseOne(raw: string, fmt: Exclude<DateFormat, 'auto'> | 'iso', tally?: ZoneTally): number {
  const s = raw.trim();
  if (fmt === 'julian') {
    const m = JULIAN_RE.exec(s);
    return m ? julianToMs(+m[1], +m[2]) : NaN;
  }
  const iso = ISO_RE.exec(s);
  if (iso) return utc(+iso[1], +iso[2], +iso[3], timeOf(iso), s, tally);
  const named = parseNamed(s, tally);
  if (isFinite(named)) return named;
  const m = NUMERIC_RE.exec(s);
  if (!m) return NaN;
  const a = +m[1], b = +m[2], c = +m[3];
  const t = timeOf(m);
  // A day or month has 1-2 digits and a year 2 or 4, so "2020-01-015" and
  // "1/2/202" fail instead of being read as some date.
  const yearLen = (k: number) => m[k].length === 2 || m[k].length === 4;
  if (m[1].length === 4) return m[3].length <= 2 ? utc(a, b, c, t, s, tally) : NaN;   // YMD regardless
  if (fmt === 'ymd') return yearLen(1) && m[3].length <= 2 ? utc(pivotYear(a, m[1]), b, c, t, s, tally) : NaN;
  if (!yearLen(3) || m[1].length > 2) return NaN;
  if (fmt === 'mdy') return utc(pivotYear(c, m[3]), a, b, t, s, tally);
  return utc(pivotYear(c, m[3]), b, a, t, s, tally);                   // dmy
}

function run(trimmed: string[], fmt: Exclude<DateFormat, 'auto'> | 'iso'): { ms: number[]; failures: number } & ZoneTally {
  const tally: ZoneTally = { shifted: 0, zoned: 0, shiftedExample: '' };
  const ms = trimmed.map(s => parseOne(s, fmt, tally));
  return { ms, failures: ms.filter(Number.isNaN).length, ...tally };
}

/**
 * Parse a column of date strings (§6.0). The whole cell must be a date, with
 * an optional time of day (1- or 2-digit hour, optional minutes, seconds,
 * fraction, AM/PM) and an optional UTC offset, which is applied: the result
 * is always the UTC instant. Cells with anything else in them fail and are
 * counted. In 'auto' mode:
 *  - ISO, 4-digit-leading, and month-name forms (01-Jan-2020, Jan 1, 2020)
 *    parse directly;
 *  - Julian ordinal is recognised when the whole column matches YYYY-DDD;
 *  - for d/m/y-style strings the day/month order is inferred by scanning the
 *    column for a value > 12; if none exists the result is flagged `ambiguous`
 *    and the UI must force an explicit MDY/DMY choice (spec §6.0).
 * Two-digit years follow the POSIX pivot (00-68 -> 2000s, 69-99 -> 1900s).
 */
export function parseDates(raws: string[], fmt: DateFormat = 'auto'): ParsedDates {
  const trimmed = raws.map(r => (r ?? '').trim());

  if (fmt !== 'auto') return { ...run(trimmed, fmt), used: fmt, ambiguous: false };

  const nonEmpty = trimmed.filter(s => s.length > 0);
  const allJulian = nonEmpty.length > 0 && nonEmpty.every(s => JULIAN_RE.test(s));
  if (allJulian) return { ...run(trimmed, 'julian'), used: 'julian', ambiguous: false };

  const isNamed = (s: string) => isFinite(parseNamed(s));
  const allIsoOrYmd = nonEmpty.every(s => ISO_RE.test(s) || (NUMERIC_RE.exec(s)?.[1].length === 4) || isNamed(s));
  if (allIsoOrYmd) {
    const named = nonEmpty.filter(isNamed).length;
    const used = named === nonEmpty.length ? 'month-name' : named > 0 ? 'mixed' : 'iso';
    return { ...run(trimmed, 'iso'), used, ambiguous: false };
  }

  // d/m vs m/d inference over the whole column.
  let sawFirstGt12 = false, sawSecondGt12 = false, sawDayMonth = false;
  for (const s of nonEmpty) {
    const m = NUMERIC_RE.exec(s);
    if (!m || m[1].length === 4) continue;
    sawDayMonth = true;
    if (+m[1] > 12) sawFirstGt12 = true;
    if (+m[2] > 12) sawSecondGt12 = true;
  }
  // No d/m/y cell at all: the column is ISO-style with some unparseable
  // cells, which are failures, not a day/month question.
  if (!sawDayMonth) return { ...run(trimmed, 'iso'), used: 'iso', ambiguous: false };
  let used: 'mdy' | 'dmy' = 'mdy';
  let ambiguous = false;
  if (sawFirstGt12 && !sawSecondGt12) used = 'dmy';
  else if (sawSecondGt12 && !sawFirstGt12) used = 'mdy';
  else ambiguous = true; // undecidable (or contradictory); UI must ask

  return { ...run(trimmed, used), used, ambiguous };
}
