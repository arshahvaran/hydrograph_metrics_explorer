import { useRef, useState } from 'react'
import { useApp } from '../store/store'
import { parseDelimited, parseWorkbook, guessRoles, stage, fetchSample, type RawTable, type ColumnRole } from '../ingest/ingest'
import { EditableGrid } from './EditableGrid'
import { UNITS } from '../units/registry'
import { fmtDate, fmtNum } from './format'
import type { DateFormat } from '../ingest/dateParse'
import type { UnitId } from '../types'

const SAMPLES = [
  { file: 'sample_hymod_raven.csv', name: 'HYMOD vs observed (Raven, daily 1954–59)' },
  { file: 'sample_synthetic.csv', name: 'Synthetic: shifted + biased runs (daily, 2 yr)' },
];

const ROLE_OPTIONS: ColumnRole[] = ['date', 'observed', 'run', 'ignore'];

export function DataTab() {
  const commitDataset = useApp(s => s.commitDataset);
  const setActiveTab = useApp(s => s.setActiveTab);
  const convertUnits = useApp(s => s.convertUnits);
  const ds = useApp(s => s.project.datasets.find(d => d.id === s.project.activeDatasetId) ?? null);

  const [table, setTable] = useState<RawTable | null>(null);
  const [roles, setRoles] = useState<ColumnRole[]>([]);
  const [dateFormat, setDateFormat] = useState<DateFormat>('auto');
  const [unit, setUnit] = useState<UnitId>('m3s');
  const [sentinels, setSentinels] = useState(true);
  const [name, setName] = useState('My dataset');
  const [pasteText, setPasteText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [convertMsg, setConvertMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const staged = table && roles.length
    ? stage(table, { name, roles, dateFormat, unit, sentinels })
    : null;

  function loadTable(t: RawTable, suggestedName: string) {
    setTable(t);
    setRoles(guessRoles(t.header));
    setName(suggestedName);
    setError(null);
    const m = t.header.map(h => /\[(.+?)\]/.exec(h)?.[1]?.replace(/\s/g, '').toLowerCase()).find(Boolean);
    if (m === 'm3/s' || m === 'm³/s') setUnit('m3s');
    else if (m === 'cfs' || m === 'ft3/s') setUnit('cfs');
    else if (m === 'l/s') setUnit('ls');
  }

  async function onSample(file: string, label: string) {
    setBusy(true);
    try { loadTable(parseDelimited(await fetchSample(file)), label); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function onFile(f: File) {
    setBusy(true); setError(null);
    try {
      if (/\.xlsx?$/i.test(f.name)) loadTable(await parseWorkbook(await f.arrayBuffer()), f.name.replace(/\.\w+$/, ''));
      else loadTable(parseDelimited(await f.text()), f.name.replace(/\.\w+$/, ''));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  }

  function commit() {
    if (!staged?.commit) return;
    commitDataset(staged.commit);
    setActiveTab('metrics');
  }

  return (
    <div>
      <section className="card">
        <h2>Load data <span className="muted">— parsed, validated and computed entirely in this browser tab</span></h2>
        <div className="controls">
          {SAMPLES.map(s => (
            <button key={s.file} disabled={busy} onClick={() => onSample(s.file, s.name)}>{s.name}</button>
          ))}
          <label className="primary filebtn">
            Upload CSV / TXT / XLSX
            <input ref={fileRef} type="file" accept=".csv,.txt,.tsv,.xlsx,.xls" className="vh" aria-label="Upload CSV, TXT, TSV or XLSX data files"
              onChange={e => e.target.files?.[0] && onFile(e.target.files[0])} />
          </label>
        </div>
        <details>
          <summary>…or paste / type into an editable grid</summary>
          <EditableGrid onUse={(t2, name) => loadTable(t2, name)} seedText={pasteText} />
          <p className="muted">Or paste raw delimited text below (tab, comma or semicolon; first row = headers) — <a href="samples/hme_template.csv" download>download the CSV template</a>.</p>
          <textarea rows={6} value={pasteText} placeholder={'date\tobserved\tmodelA\n2001-01-01\t5.2\t4.9\n…'}
            onChange={e => setPasteText(e.target.value)} />
          <button className="primary" disabled={!pasteText.trim()}
            onClick={() => loadTable(parseDelimited(pasteText), 'Pasted data')}>Parse pasted data</button>
        </details>
        {error && <div className="error">{error}</div>}
      </section>

      {table && (
        <section className="card">
          <h2>Map columns</h2>
          {table.note && <p className="warn" role="status">{table.note}</p>}
          <div className="controls">
            <label>Name <input value={name} onChange={e => setName(e.target.value)} /></label>
            <label>Date format{' '}
              <select aria-label="Date format" value={dateFormat} onChange={e => setDateFormat(e.target.value as DateFormat)}>
                <option value="auto">auto-detect</option>
                <option value="ymd">Y-M-D</option>
                <option value="mdy">M/D/Y</option>
                <option value="dmy">D/M/Y</option>
                <option value="julian">Julian (YYYY-DDD)</option>
              </select>
            </label>
            <label>Unit (all value columns){' '}
              <select aria-label="Input unit" value={unit} onChange={e => setUnit(e.target.value as UnitId)}>
                {Object.values(UNITS).map(u => <option key={u.id} value={u.id}>{u.label}</option>)}
              </select>
            </label>
            <label title="-9999 and -999 are treated as missing">
              <input type="checkbox" checked={sentinels} onChange={e => setSentinels(e.target.checked)} /> sentinel −9999/−999 = missing
            </label>
          </div>
          <div className="mapscroll">
            <table className="grid">
              <thead>
                <tr>{table.header.map((h, j) => (
                  <th key={j}>
                    <div>{h || `col ${j + 1}`}</div>
                    <select aria-label={`Role for column ${table.header[j] || j + 1}`} value={roles[j]} onChange={e => setRoles(roles.map((r, k) => (k === j ? e.target.value as ColumnRole : r)))}>
                      {ROLE_OPTIONS.map(r => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </th>
                ))}</tr>
              </thead>
              <tbody>
                {table.rows.slice(0, 6).map((r, i) => (
                  <tr key={i}>{table.header.map((_, j) => <td key={j}>{r[j]}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted">{table.rows.length.toLocaleString()} data rows · date parser: {staged?.dateInfo.used}
            {staged?.dateInfo.failures ? ` · ${staged.dateInfo.failures} unparseable dates` : ''}</p>

          {staged && (
            <>
              {staged.validation.errors.map((e, i) => <div key={i} className="error">{e}</div>)}
              {staged.validation.warnings.map((w, i) => <div key={i} className="warning">{w}</div>)}
              <table className="grid">
                <thead><tr><th>Series</th><th>missing</th><th>negatives</th><th>min</th><th>mean</th><th>max</th><th>valid pairs vs obs</th></tr></thead>
                <tbody>
                  {staged.validation.series.map(s => (
                    <tr key={s.name}>
                      <td>{s.name}</td><td>{s.missing}</td><td>{s.negatives}</td>
                      <td>{fmtNum(s.min)}</td><td>{fmtNum(s.mean)}</td><td>{fmtNum(s.max)}</td>
                      <td>{s.overlapWithObserved.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button className="primary" disabled={!staged.commit} onClick={commit}>Use this data →</button>
            </>
          )}
        </section>
      )}

      {ds && (
        <section className="card">
          <h2>Active dataset: {ds.name}</h2>
          <table className="kv"><tbody>
            <tr><th>Rows</th><td>{ds.dates.length.toLocaleString()}</td></tr>
            <tr><th>Range</th><td>{fmtDate(ds.dates[0])} → {fmtDate(ds.dates[ds.dates.length - 1])}</td></tr>
            <tr><th>Step</th><td>{ds.step.label}{ds.step.irregular ? ' (irregular)' : ''}</td></tr>
            <tr><th>Series</th><td>{ds.observed.name || 'Observed'} + {ds.runs.length} run{ds.runs.length === 1 ? '' : 's'}</td></tr>
            <tr><th>Unit</th><td>
              <select aria-label="Convert units to" value={ds.targetUnit} onChange={e => setConvertMsg(convertUnits(e.target.value as UnitId))}>
                {Object.values(UNITS).filter(u => u.kind !== 'dimensionless' || ds.targetUnit === 'dimensionless').map(u => <option key={u.id} value={u.id}>{u.label}</option>)}
              </select>
              {' '}<span className="muted">converting a depth unit needs the catchment area (Map tab)</span>
            </td></tr>
          </tbody></table>
          {convertMsg && <div className="error">{convertMsg}</div>}
          <p className="muted">Head to <strong>Metrics</strong> for the full catalogue, <strong>Timing</strong> for the shape-aware panel, or <strong>Sandbox</strong> to stress-test the metrics.</p>
        </section>
      )}
    </div>
  );
}
