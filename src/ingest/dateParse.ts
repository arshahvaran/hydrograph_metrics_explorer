export type DateFormat = 'auto' | 'ymd' | 'mdy' | 'dmy' | 'julian';

export interface ParsedDates {
  /** UTC epoch ms; NaN where unparseable. */
  ms: number[];
  /** Format actually applied. */
  used: Exclude<DateFormat, 'auto'> | 'iso' | 'mixed';
  /** True when day/month order could not be inferred and MDY was NOT safe to assume. */
  ambiguous: boolean;
  failures: number;
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})([T ](\d{2}):(\d{2})(:(\d{2}))?)?/;
const JULIAN_RE = /^(\d{4})[-_ ]?(\d{3})$/;                  // 2023-045 / 2023045
const NUMERIC_RE = /^(\d{1,4})[\/\-.](\d{1,2})[\/\-.](\d{1,4})([T ](\d{1,2}):(\d{2})(:(\d{2}))?)?$/;

function utc(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number {
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  // Reject rollovers like month 13 or day 32.
  const dt = new Date(ms);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return NaN;
  return ms;
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
  const m = NUMERIC_RE.exec(s);
  if (!m) return NaN;
  const a = +m[1], b = +m[2], c = +m[3];
  const h = +(m[5] ?? 0), mi = +(m[6] ?? 0), sec = +(m[8] ?? 0);
  if (m[1].length === 4) return utc(a, b, c, h, mi, sec);            // YMD regardless
  if (fmt === 'ymd') return utc(a, b, c, h, mi, sec);
  if (fmt === 'mdy') return utc(c, a, b, h, mi, sec);
  return utc(c, b, a, h, mi, sec);                                    // dmy
}

/**
 * Parse a column of date strings (§6.0). In 'auto' mode:
 *  - ISO and 4-digit-leading forms parse directly;
 *  - Julian ordinal is recognised when the whole column matches YYYY-DDD;
 *  - for d/m/y-style strings the day/month order is inferred by scanning the
 *    column for a value > 12; if none exists the result is flagged `ambiguous`
 *    and the UI must force an explicit MDY/DMY choice (spec §6.0).
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

  const allIsoOrYmd = nonEmpty.every(s => ISO_RE.test(s) || (NUMERIC_RE.exec(s)?.[1].length === 4));
  if (allIsoOrYmd) {
    const ms = trimmed.map(s => parseOne(s, 'iso'));
    return { ms, used: 'iso', ambiguous: false, failures: ms.filter(Number.isNaN).length };
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
  else ambiguous = true; // undecidable (or contradictory) — UI must ask

  const ms = trimmed.map(s => parseOne(s, used));
  return { ms, used, ambiguous, failures: ms.filter(Number.isNaN).length };
}
