export type DateFormat = 'auto' | 'ymd' | 'mdy' | 'dmy' | 'julian';

export interface ParsedDates {
  /** UTC epoch ms; NaN where unparseable. */
  ms: number[];
  /** Format actually applied. */
  used: Exclude<DateFormat, 'auto'> | 'iso' | 'mixed' | 'month-name';
  /** True when day/month order could not be inferred and MDY was NOT safe to assume. */
  ambiguous: boolean;
  failures: number;
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})([T ](\d{2}):(\d{2})(:(\d{2}))?)?/;
const JULIAN_RE = /^(\d{4})[-_ ]?(\d{3})$/;                  // 2023-045 / 2023045
const NUMERIC_RE = /^(\d{1,4})[\/\-.](\d{1,2})[\/\-.](\d{1,4})([T ](\d{1,2}):(\d{2})(:(\d{2}))?)?$/;
// Month-name forms are unambiguous about day/month order, so they parse in any
// non-Julian mode: 01-Jan-2020, 1 January 2020 (day first) and Jan 1, 2020,
// September 3 1999 (month first). Optional " HH:MM(:SS)" time part.
const DMY_NAME_RE = /^(\d{1,2})[-\/. ]([A-Za-z]{3,9})[-\/. ]+(\d{2,4})([T ](\d{1,2}):(\d{2})(:(\d{2}))?)?$/;
// day and year need a real separator (comma or [-/. ]) so a month-year label
// like "May-2020" is NOT silently read as day 20 of 2020
const MDY_NAME_RE = /^([A-Za-z]{3,9})[-\/. ]+(\d{1,2})(?:,\s*|[-\/. ]+)(\d{2,4})([T ](\d{1,2}):(\d{2})(:(\d{2}))?)?$/;
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

function utc(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number {
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  // Reject rollovers like month 13 or day 32.
  const dt = new Date(ms);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return NaN;
  return ms;
}

/** Parse a month-name date; NaN when the string is not one. */
function parseNamed(s: string): number {
  let day: number, mo: number, yRaw: string, h: number, mi: number, sec: number;
  const dmy = DMY_NAME_RE.exec(s);
  if (dmy) {
    day = +dmy[1]; mo = monthFromName(dmy[2]); yRaw = dmy[3];
    h = +(dmy[5] ?? 0); mi = +(dmy[6] ?? 0); sec = +(dmy[8] ?? 0);
  } else {
    const mdy = MDY_NAME_RE.exec(s);
    if (!mdy) return NaN;
    mo = monthFromName(mdy[1]); day = +mdy[2]; yRaw = mdy[3];
    h = +(mdy[5] ?? 0); mi = +(mdy[6] ?? 0); sec = +(mdy[8] ?? 0);
  }
  if (!isFinite(mo)) return NaN;
  return utc(pivotYear(+yRaw, yRaw), mo, day, h, mi, sec);
}

function julianToMs(y: number, doy: number): number {
  const jan1 = Date.UTC(y, 0, 1);
  const max = (Date.UTC(y + 1, 0, 1) - jan1) / 86400_000;
  if (doy < 1 || doy > max) return NaN;
  return jan1 + (doy - 1) * 86400_000;
}

function parseOne(raw: string, fmt: Exclude<DateFormat, 'auto'> | 'iso'): number {
  const s = raw.trim();
  if (fmt === 'julian') {
    const m = JULIAN_RE.exec(s);
    return m ? julianToMs(+m[1], +m[2]) : NaN;
  }
  const iso = ISO_RE.exec(s);
  if (iso) return utc(+iso[1], +iso[2], +iso[3], +(iso[5] ?? 0), +(iso[6] ?? 0), +(iso[8] ?? 0));
  const named = parseNamed(s);
  if (isFinite(named)) return named;
  const m = NUMERIC_RE.exec(s);
  if (!m) return NaN;
  const a = +m[1], b = +m[2], c = +m[3];
  const h = +(m[5] ?? 0), mi = +(m[6] ?? 0), sec = +(m[8] ?? 0);
  if (m[1].length === 4) return utc(a, b, c, h, mi, sec);            // YMD regardless
  if (fmt === 'ymd') return utc(pivotYear(a, m[1]), b, c, h, mi, sec);
  if (fmt === 'mdy') return utc(pivotYear(c, m[3]), a, b, h, mi, sec);
  return utc(pivotYear(c, m[3]), b, a, h, mi, sec);                   // dmy
}

/**
 * Parse a column of date strings (§6.0). In 'auto' mode:
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

  if (fmt !== 'auto') {
    const ms = trimmed.map(s => parseOne(s, fmt));
    return { ms, used: fmt, ambiguous: false, failures: ms.filter(Number.isNaN).length };
  }

  const nonEmpty = trimmed.filter(s => s.length > 0);
  const allJulian = nonEmpty.length > 0 && nonEmpty.every(s => JULIAN_RE.test(s));
  if (allJulian) {
    const ms = trimmed.map(s => parseOne(s, 'julian'));
    return { ms, used: 'julian', ambiguous: false, failures: ms.filter(Number.isNaN).length };
  }

  const isNamed = (s: string) => isFinite(parseNamed(s));
  const allIsoOrYmd = nonEmpty.every(s => ISO_RE.test(s) || (NUMERIC_RE.exec(s)?.[1].length === 4) || isNamed(s));
  if (allIsoOrYmd) {
    const ms = trimmed.map(s => parseOne(s, 'iso'));
    const named = nonEmpty.filter(isNamed).length;
    const used = named === nonEmpty.length ? 'month-name' : named > 0 ? 'mixed' : 'iso';
    return { ms, used, ambiguous: false, failures: ms.filter(Number.isNaN).length };
  }

  // d/m vs m/d inference over the whole column.
  let sawFirstGt12 = false, sawSecondGt12 = false;
  for (const s of nonEmpty) {
    const m = NUMERIC_RE.exec(s);
    if (!m || m[1].length === 4) continue;
    if (+m[1] > 12) sawFirstGt12 = true;
    if (+m[2] > 12) sawSecondGt12 = true;
  }
  let used: 'mdy' | 'dmy' = 'mdy';
  let ambiguous = false;
  if (sawFirstGt12 && !sawSecondGt12) used = 'dmy';
  else if (sawSecondGt12 && !sawFirstGt12) used = 'mdy';
  else ambiguous = true; // undecidable (or contradictory); UI must ask

  const ms = trimmed.map(s => parseOne(s, used));
  return { ms, used, ambiguous, failures: ms.filter(Number.isNaN).length };
}
