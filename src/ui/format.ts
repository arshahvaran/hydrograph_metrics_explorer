/** Display a metric value: `digits` fixed decimals from 0.1 upward (from 1
 *  upward when digits = 0) and for an exact zero. A smaller non-zero magnitude
 *  shows max(2, digits) significant figures, in exponent form below 1e-3
 *  ("3.82e-4"), so a non-zero value never reads as 0. Fixed decimals once
 *  printed a non-zero MSE of 3.8e-4 as "0.000", the optimum (audit norms-04,
 *  report-03). */
export const fmtNum = (v: number | undefined | null, digits = 3): string => {
  if (v === undefined || v === null || !isFinite(v)) return 'n/a';
  // toFixed switches to exponent notation at 1e21 ("-7.7e+27"); a magnitude
  // that large is summation garbage on degenerate data, not a metric value.
  if (Math.abs(v) >= 1e21) return 'n/a';
  const a = Math.abs(v);
  if (a !== 0 && a < Math.max(0.1, 10 ** -digits)) {
    const sig = Math.max(2, digits);
    return a < 1e-3 ? v.toExponential(sig - 1) : v.toPrecision(sig);
  }
  const s = v.toFixed(digits);
  // toFixed keeps the sign of a negative value that rounds to zero ("-0.00");
  // anything within half of the last displayed digit of zero shows unsigned.
  return /^-0(\.0*)?$/.test(s) ? s.slice(1) : s;
};

export const fmtDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Axis/table time stamp honouring the step size: daily and coarser steps keep
 *  the date-only form; sub-daily steps keep the time ("YYYY-MM-DD HH:mm",
 *  seconds added below one minute) so samples within a day stay distinct.
 *  All stamps are UTC. */
export const fmtStamp = (ms: number, stepMs: number): string => {
  const iso = new Date(ms).toISOString();
  if (stepMs >= 86_400_000) return iso.slice(0, 10);
  return (stepMs >= 60_000 ? iso.slice(0, 16) : iso.slice(0, 19)).replace('T', ' ');
};

export function download(filename: string, content: string | Blob, mime = 'text/plain'): void {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** QA-008: CSV cell hardening: Excel formula-injection guard (OWASP) plus
 *  real quoting. Numbers and numeric-looking strings are left untouched so
 *  negative values stay numeric; non-numeric strings starting with = + - @
 *  or tab/CR are prefixed with an apostrophe. */
export function csvCell(v: unknown, sep: ',' | '\t' = ','): string {
  if (typeof v === 'number') return String(v);
  let s = String(v ?? '');
  const numericLike = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s.trim());
  if (!numericLike && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (s.includes(sep) || s.includes('"') || /[\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}
export const csvLine = (cells: unknown[], sep: ',' | '\t' = ','): string =>
  cells.map(c => csvCell(c, sep)).join(sep);
