import { useState } from 'react'
import type { ColumnRole, RawTable } from '../ingest/ingest'

const BLANK = (r: number, c: number) => Array.from({ length: r }, () => Array.from({ length: c }, () => ''));

/** Editable paste sheet (spec Appendix C, AC1): fixed Date | Observed |
 *  Simulated 1… columns, "+ Add simulated column", header rename → run name. */
export function EditableGrid({ onUse, seedText }: { onUse: (t: RawTable, name: string, roles: ColumnRole[]) => void; seedText?: string }) {
  const [headers, setHeaders] = useState<string[]>(['Date', 'Observed', 'Simulated 1']);
  const [rows, setRows] = useState<string[][]>(BLANK(8, 3));

  const setCell = (r: number, c: number, v: string) =>
    setRows(rs => rs.map((row, i) => (i === r ? row.map((x, j) => (j === c ? v : x)) : row)));
  const addColumn = () => {
    setHeaders(h => [...h, `Simulated ${h.length - 1}`]);
    setRows(rs => rs.map(r => [...r, '']));
  };
  const addRows = (n: number) => setRows(rs => [...rs, ...BLANK(n, headers.length)]);
  const onPaste = (r0: number, c0: number, e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData('text/plain');
    if (!text.includes('\t') && !text.includes('\n')) return; // single-cell paste: default behaviour
    e.preventDefault();
    const block = text.replace(/\r/g, '').split('\n').filter(l => l.length).map(l => l.split('\t'));
    setRows(rs => {
      const need = r0 + block.length - rs.length;
      const grown = need > 0 ? [...rs, ...BLANK(need, headers.length)] : rs.slice();
      block.forEach((line, i) => {
        line.forEach((v, j) => { if (c0 + j < headers.length) grown[r0 + i] = grown[r0 + i].map((x, k) => (k === c0 + j ? v : x)); });
      });
      return grown.map(r => r.slice());
    });
  };
  const use = () => {
    const filled = rows.filter(r => r.some(c => c.trim() !== ''));
    const roles: ColumnRole[] = headers.map((_, j) => (j === 0 ? 'date' : j === 1 ? 'observed' : 'run'));
    onUse({ header: headers, rows: filled }, 'Sheet data', roles);
  };
  const nonEmpty = rows.some(r => r.some(c => c.trim() !== ''));

  return (
    <div className="gridwrap">
      <div className="mapscroll">
        <table className="grid editgrid" aria-label="editable data sheet">
          <thead>
            <tr>{headers.map((h, c) => (
              <th key={c}>
                {c < 2
                  ? h
                  : <input aria-label={`name of simulated column ${c - 1}`} value={h}
                      onChange={e => setHeaders(hs => hs.map((x, j) => (j === c ? e.target.value : x)))} />}
              </th>
            ))}</tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>{row.map((v, c) => (
                <td key={c}>
                  <input value={v} aria-label={`row ${r + 1} ${headers[c]}`}
                    onChange={e => setCell(r, c, e.target.value)}
                    onPaste={e => onPaste(r, c, e)} />
                </td>
              ))}</tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="controls">
        <button onClick={addColumn}>＋ Add simulated column</button>
        <button onClick={() => addRows(10)}>＋ Add 10 rows</button>
        <button className="primary" disabled={!nonEmpty} onClick={use}>Use sheet data</button>
        <span className="muted">Tab-separated blocks for pasting data from Excel or filling manually.</span>
      </div>
    </div>
  );
}
