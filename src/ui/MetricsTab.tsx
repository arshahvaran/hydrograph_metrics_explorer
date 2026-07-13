import { useMemo, useState } from 'react'
import { useApp } from '../store/store'
import { REGISTRY, PRESETS, C2M_APPLICABLE, toC2M } from '../metrics/registry'
import { benchmarkSeries, nse as nseFn, kge2009 as kgeFn, skill } from '../metrics/classical/catalogue'
import { applyNanPolicy } from '../ingest/missing'
import { computeForRun, bestIndex } from './compute'
import { fmtNum, download } from './format'
import { APP_VERSION } from '../version'
import type { Dataset } from '../types'

const GROUPS = ['Error norms', 'Correlation & agreement', 'Efficiencies', 'FDC signatures', 'Timing & shape'] as const;

export function MetricsTab() {
  const ds = useApp(s => s.project.datasets.find(d => d.id === s.project.activeDatasetId) ?? null);
  const updateView = useApp(s => s.updateView);
  const [preset, setPreset] = useState<string>('Timing-aware');
  const [c2mOn, setC2mOn] = useState(false);
  if (!ds) return null;

  const runs = ds.runs.filter(r => r.visible);
  const outputs = runs.map(r => computeForRun(ds, r));

  const selected = PRESETS[preset] === 'all' ? REGISTRY.map(m => m.id) : (PRESETS[preset] as string[]);
  const metricRows = REGISTRY.filter(m => selected.includes(m.id));

  // benchmark skill (NSE & KGE vs the selected benchmark forecast)
  const bench = useMemo(() => {
    const b = benchmarkSeries(ds.observed.values as number[], ds.view.benchmark, ds.dates);
    return runs.map((_r, i) => {
      const pb = applyNanPolicy(ds.observed.values, b, ds.view.nanPolicy);
      const nseB = nseFn(pb.obs, pb.sim), kgeB = kgeFn(pb.obs, pb.sim).value;
      return {
        nseSkill: skill(outputs[i].values.nse, nseB),
        kgeSkill: skill(outputs[i].values.kge2009, kgeB),
      };
    });
  }, [ds, runs.map(r => r.id).join(), ds.view.benchmark, ds.view.nanPolicy, ds.view.transform, JSON.stringify(ds.view.timingConfig)]);

  const display = (id: string, v: number) =>
    c2mOn && C2M_APPLICABLE.has(id) ? toC2M(v) : v;

  function exportCsv(sep: ',' | '\t') {
    const lines: string[] = [
      `# Hydrograph Metrics Explorer v${APP_VERSION} — https://arshahvaran.github.io/hydrograph_metrics_explorer/`,
      `# exported ${new Date().toISOString()}`,
      `# dataset: ${ds!.name} (${ds!.dates.length} rows, step ${ds!.step.label}, unit ${ds!.targetUnit})`,
      `# settings: nan=${ds!.view.nanPolicy}; transform=${ds!.view.transform}; benchmark=${ds!.view.benchmark}; c2m_display=${c2mOn}`,
      `# timing config: ${JSON.stringify(ds!.view.timingConfig)}`,
      ['metric', 'group', 'optimum', ...runs.map(r => r.name)].join(sep),
    ];
    for (const m of metricRows) {
      lines.push([m.label.replace(new RegExp(sep === ',' ? ',' : '\\t', 'g'), ';'), m.group, m.optimum,
        ...outputs.map(o => String(display(m.id, o.values[m.id])))].join(sep));
    }
    download(`hme_metrics_${ds!.name.replace(/\W+/g, '_')}.${sep === ',' ? 'csv' : 'tsv'}`,
      lines.join('\n'), sep === ',' ? 'text/csv' : 'text/tab-separated-values');
  }

  return (
    <div>
      <section className="card">
        <div className="controls">
          <label>Preset{' '}
            <select value={preset} onChange={e => setPreset(e.target.value)}>
              {Object.keys(PRESETS).map(p => <option key={p}>{p}</option>)}
            </select>
          </label>
          <label>NaN policy{' '}
            <select value={ds.view.nanPolicy} onChange={e => updateView({ nanPolicy: e.target.value as any })}>
              <option value="pairwise">pairwise drop</option>
              <option value="zero">substitute 0</option>
              <option value="mean">substitute mean</option>
            </select>
          </label>
          <label>Transform{' '}
            <select value={ds.view.transform} onChange={e => updateView({ transform: e.target.value as any })}>
              <option value="none">none</option>
              <option value="log">log (ε = 0.01·mean O)</option>
              <option value="sqrt">sqrt</option>
              <option value="inverse">inverse</option>
            </select>
          </label>
          <label>Benchmark{' '}
            <select value={ds.view.benchmark} onChange={e => updateView({ benchmark: e.target.value as any })}>
              <option value="mean">mean flow</option>
              <option value="climatology">monthly climatology</option>
              <option value="persistence">persistence</option>
            </select>
          </label>
          <label title="Display unbounded efficiencies on the bounded (−1,1] C2M scale">
            <input type="checkbox" checked={c2mOn} onChange={e => setC2mOn(e.target.checked)} /> C2M display
          </label>
          <button className="primary" onClick={() => exportCsv(',')}>Export CSV</button>
          <button onClick={() => exportCsv('\t')}>TSV</button>
        </div>
        <p className="muted">
          n per run (valid pairs): {runs.map((r, i) => `${r.name}: ${outputs[i].n}`).join(' · ')}.
          {ds.view.transform !== 'none' && ' Metrics are computed on the transformed series.'}
          {' '}Rows tinted <span className="timingchip">⏱</span> are the timing- &amp; shape-aware measures — the ones conventional suites omit.
        </p>
        {outputs.flatMap(o => o.notes).filter((v, i, a) => a.indexOf(v) === i).map(nn => <div key={nn} className="warning">{nn}</div>)}
        <table className="grid metricstable">
          <thead>
            <tr><th>Metric</th><th>optimum</th>{runs.map(r => <th key={r.id} style={{ color: r.color }}>{r.name}</th>)}</tr>
          </thead>
          <tbody>
            {GROUPS.map(g => {
              const rows = metricRows.filter(m => m.group === g);
              if (!rows.length) return null;
              return (
                <FragmentGroup key={g} title={g}>
                  {rows.map(m => {
                    const vals = outputs.map(o => display(m.id, o.values[m.id]));
                    const best = runs.length > 1 ? bestIndex(vals, m.direction) : -1;
                    return (
                      <tr key={m.id} className={m.timing ? 'timingrow' : ''} title={m.blurb + ` Range ${m.range}.`}>
                        <td>{m.timing ? '⏱ ' : ''}{m.label}</td>
                        <td className="muted">{m.optimum}</td>
                        {vals.map((v, i) => (
                          <td key={runs[i].id} className={i === best ? 'best' : ''}>{fmtNum(v, m.digits)}</td>
                        ))}
                      </tr>
                    );
                  })}
                  {g === 'Efficiencies' && (
                    <>
                      <tr title="Skill of NSE relative to the selected benchmark: (NSE − NSE_bench)/(1 − NSE_bench)">
                        <td>NSE skill vs {ds.view.benchmark}</td><td className="muted">1</td>
                        {bench.map((b, i) => <td key={runs[i].id}>{fmtNum(b.nseSkill, 3)}</td>)}
                      </tr>
                      <tr title="Skill of KGE relative to the selected benchmark">
                        <td>KGE skill vs {ds.view.benchmark}</td><td className="muted">1</td>
                        {bench.map((b, i) => <td key={runs[i].id}>{fmtNum(b.kgeSkill, 3)}</td>)}
                      </tr>
                    </>
                  )}
                </FragmentGroup>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="card">
        <details>
          <summary><strong>Metric reference</strong> — what each measures, and its blind spot</summary>
          {GROUPS.map(g => (
            <div key={g}>
              <h3>{g}</h3>
              <ul>
                {REGISTRY.filter(m => m.group === g).map(m => (
                  <li key={m.id}><strong>{m.label}</strong> (optimum {m.optimum}, range {m.range}): {m.blurb}</li>
                ))}
              </ul>
            </div>
          ))}
        </details>
      </section>
    </div>
  );
}

function FragmentGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <>
      <tr className="grouprow"><td colSpan={99}>{title}</td></tr>
      {children}
    </>
  );
}
