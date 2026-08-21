export const fmtNum = (v: number | undefined | null, digits = 3): string => {
  if (v === undefined || v === null || !isFinite(v)) return 'n/a';
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
