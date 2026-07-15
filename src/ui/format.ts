export const fmtNum = (v: number | undefined | null, digits = 3): string =>
  v === undefined || v === null || !isFinite(v) ? 'n/a' : v.toFixed(digits);

export const fmtDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

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
