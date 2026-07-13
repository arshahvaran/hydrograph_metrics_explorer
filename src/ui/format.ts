export const fmtNum = (v: number | undefined | null, digits = 3): string =>
  v === undefined || v === null || !isFinite(v) ? '—' : v.toFixed(digits);

export const fmtDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function download(filename: string, text: string, mime = 'text/plain'): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
