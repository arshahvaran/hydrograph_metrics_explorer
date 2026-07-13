import { useState } from 'react'
import { useApp } from '../store/store'
import { fetchSample, parseSampleCsv, type LoadedCsv } from '../ingest/csvLoad'
import { applyNanPolicy } from '../ingest/missing'
import { nse, kge2009, rmse, pbias, pearsonR } from '../metrics/classical/basics'

const fmtDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const fmt = (v: number, d = 3) => (isFinite(v) ? v.toFixed(d) : 'n/a');

const SAMPLES = [
  {
    file: 'sample_hymod_raven.csv',
    name: 'HYMOD vs observed (Raven output, daily 1954–1959)',
    note: 'Real model output exported by the Raven hydrologic framework.',
  },
  {
    file: 'sample_synthetic.csv',
    name: 'Synthetic catchment, two runs (daily, 2 years)',
    note: 'run_shifted lags the truth by 3 days; run_biased adds a constant offset — the two canonical error types the timing-aware metrics separate.',
  },
];

export function DataTab() {
  const commitDataset = useApp(s => s.commitDataset);
  const ds = useApp(s => s.project.datasets.find(d => d.id === s.project.activeDatasetId) ?? null);
  const [loaded, setLoaded] = useState<LoadedCsv | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load(file: string, name: string) {
    setBusy(file); setError(null);
    try {
      const text = await fetchSample(file);
      const parsed = parseSampleCsv(text, name);
      setLoaded(parsed);
      if (parsed.validation.ok) commitDataset(parsed.commit);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="datatab">
      <section className="card">
        <h2>Load data</h2>
        <p>
          Paste-grid and file upload (CSV/TXT/XLSX with column mapping, unit and date-format
          selectors) arrive at CP4. For this checkpoint, load a bundled sample — everything you
          see is parsed, validated and computed <em>in this browser tab</em>.
        </p>
        <div className="samplerow">
          {SAMPLES.map(s => (
            <button key={s.file} className="primary" disabled={busy !== null} onClick={() => load(s.file, s.name)}>
              {busy === s.file ? 'Loading…' : s.name}
            </button>
          ))}
        </div>
        <p className="muted">{SAMPLES[1].note}</p>
        {error && <div className="error">{error}</div>}
      </section>

      {loaded && (
        <section className="card">
          <h2>Validation summary</h2>
          {loaded.validation.errors.map((e, i) => <div key={i} className="error">{e}</div>)}
          {loaded.validation.warnings.map((w, i) => <div key={i} className="warning">{w}</div>)}
          <table className="kv">
            <tbody>
              <tr><th>Rows</th><td>{loaded.validation.rows.toLocaleString()}</td></tr>
              <tr><th>Date range</th><td>{loaded.validation.dateRange ? `${fmtDate(loaded.validation.dateRange[0])} → ${fmtDate(loaded.validation.dateRange[1])}` : '—'}</td></tr>
              <tr><th>Detected step</th><td>{loaded.validation.step?.label ?? '—'}{loaded.validation.step?.irregular ? ' (irregular)' : ''}</td></tr>
              <tr><th>Duplicate dates</th><td>{loaded.validation.duplicates}</td></tr>
            </tbody>
          </table>
          <table className="grid">
            <thead>
              <tr><th>Series</th><th>missing</th><th>negatives</th><th>min</th><th>mean</th><th>max</th><th>valid pairs vs obs</th></tr>
            </thead>
            <tbody>
              {loaded.validation.series.map(s => (
                <tr key={s.name}>
                  <td>{s.name}</td><td>{s.missing}</td><td>{s.negatives}</td>
                  <td>{fmt(s.min)}</td><td>{fmt(s.mean)}</td><td>{fmt(s.max)}</td>
                  <td>{s.overlapWithObserved.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {ds && (
        <section className="card">
          <h2>Metrics — seed of the engine <span className="muted">(pairwise NaN policy · full catalogue at CP2, timing-aware core at CP3)</span></h2>
          <table className="grid">
            <thead>
              <tr><th>Metric</th><th>optimum</th>{ds.runs.map(r => <th key={r.id} style={{ color: r.color }}>{r.name}</th>)}</tr>
            </thead>
            <tbody>
              {(() => {
                const paired = ds.runs.map(r => applyNanPolicy(ds.observed.values, r.values, 'pairwise'));
                const rows: [string, string, (i: number) => number][] = [
                  ['NSE', '1', i => nse(paired[i].obs, paired[i].sim)],
                  ['KGE (2009)', '1', i => kge2009(paired[i].obs, paired[i].sim).kge],
                  ['RMSE', '0', i => rmse(paired[i].obs, paired[i].sim)],
                  ['PBIAS % (+ = under-est.)', '0', i => pbias(paired[i].obs, paired[i].sim)],
                  ['r (Pearson)', '1', i => pearsonR(paired[i].obs, paired[i].sim)],
                ];
                return rows.map(([label, opt, f]) => (
                  <tr key={label}>
                    <td>{label}</td><td className="muted">{opt}</td>
                    {ds.runs.map((r, i) => <td key={r.id}>{fmt(f(i))}</td>)}
                  </tr>
                ));
              })()}
            </tbody>
          </table>
          <p className="muted">
            Every value above is computed from the published equations and verified in the test
            suite against executed reference outputs of HydroErr, Hydrostats, hydroeval and
            diag-eff — see <code>tests/</code> in the repository.
          </p>
        </section>
      )}

      {loaded && (
        <section className="card">
          <h2>Preview (first 8 rows)</h2>
          <table className="grid">
            <thead><tr>{loaded.preview.header.map(h => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>
              {loaded.preview.rows.map((r, i) => (
                <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
