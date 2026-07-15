import { useMemo, useState } from 'react'
import { useApp } from '../store/store'
import { REGISTRY, PRESETS, GROUPS } from '../metrics/registry'
import { benchmarkSeries, nse as nseFn, kge2009 as kgeFn, skill } from '../metrics/classical/catalogue'
import { applyNanPolicy } from '../ingest/missing'
import { useRunOutputs, bestIndex, frameFor, useBootstrapCIsAll } from './compute'
import { csvLine, fmtNum, download } from './format'
import { Eq } from './Eq'
import { APP_VERSION } from '../version'
import type { Dataset } from '../types'


export function MetricsTab() {
  const ds = useApp(s => s.project.datasets.find(d => d.id === s.project.activeDatasetId) ?? null);
  if (!ds) return null;
  return <MetricsTabInner ds={ds} />;
}

function MetricsTabInner({ ds }: { ds: Dataset }) {
  const updateView = useApp(s => s.updateView);
  const [preset, setPreset] = useState<string>('Essentials');
  const [refQuery, setRefQuery] = useState('');

  const runs = ds.runs.filter(r => r.visible);
  const outputs = useRunOutputs(ds, runs);
  const frame = frameFor(ds);
  const busy = outputs.some(o => o === null);
  const ciOn = ds.view.showBootstrapCIs;
  const boots = useBootstrapCIsAll(ds, runs, ciOn);

  const selected = PRESETS[preset] === 'all' ? REGISTRY.map(m => m.id) : (PRESETS[preset] as string[]);
  const metricRows = REGISTRY.filter(m => selected.includes(m.id));

  // benchmark skill (NSE & KGE vs the selected benchmark forecast)
  const bench = useMemo(() => {
    const b = benchmarkSeries(frame.obs as unknown as number[], ds.view.benchmark, frame.dates);
    const pb = applyNanPolicy(frame.obs, b, ds.view.nanPolicy);
    const nseB = nseFn(pb.obs, pb.sim), kgeB = kgeFn(pb.obs, pb.sim).value;
    return runs.map((_r, i) => {
      const o = outputs[i];
      return o ? { nseSkill: skill(o.values.nse, nseB), kgeSkill: skill(o.values.kge2009, kgeB) }
               : { nseSkill: NaN, kgeSkill: NaN };
    });
  }, [frame.key, runs.map(r => r.id).join(), ds.view.benchmark, ds.view.nanPolicy, ds.view.transform, JSON.stringify(ds.view.timingConfig), outputs]);

  const display = (id: string, v: number) =>
    v;

  function exportCsv(sep: ',' | '\t') {
    const lines: string[] = [
      `# Hydrograph Metrics Explorer v${APP_VERSION} · https://arshahvaran.github.io/hydrograph_metrics_explorer/`,
      `# exported ${new Date().toISOString()}`,
      `# dataset: ${ds!.name} (${ds!.dates.length} rows, step ${ds!.step.label}, unit ${ds!.targetUnit})`,
      `# settings: nan=${ds!.view.nanPolicy}; transform=${ds!.view.transform}; benchmark=${ds!.view.benchmark}`,
      `# timing config: ${JSON.stringify(ds!.view.timingConfig)}`,
      csvLine(['metric', 'group', 'optimum', ...runs.flatMap(r => ciOn ? [r.name, `${r.name} ci95_lo`, `${r.name} ci95_hi`] : [r.name])], sep),
    ];
    for (const m of metricRows) {
      lines.push(csvLine([m.label, m.group, m.optimum,
        ...outputs.flatMap((o, i) => {
          const v = o ? display(m.id, o.values[m.id]) : '';
          if (!ciOn) return [v];
          const ci = m.timing ? undefined : boots.results[i]?.cis[m.id];
          return [v, ci ? ci[0] : '', ci ? ci[1] : ''];
        })], sep));
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
          <label title="Circular moving-block bootstrap on the paired series (B=500, L≈n^⅓, seeded). Timing rows are excluded; resampling blocks destroys the time axis they measure.">
            <input type="checkbox" checked={ciOn} onChange={e => updateView({ showBootstrapCIs: e.target.checked })} /> Calculate 95% CIs (block bootstrap)
          </label>
          {ciOn && boots.progress < 1 && <span className="muted" role="status" aria-live="polite">bootstrapping… {Math.round(boots.progress * 100)}%</span>}
          <button className="primary" onClick={() => exportCsv(',')}>Export CSV</button>
        </div>
        <p className="muted" aria-live="polite">
          Valid pairs per run (n): {runs.map((r, i) => `${r.name}: ${outputs[i]?.n ?? '…'}`).join(' · ')}.{busy ? ' Computing in a background worker…' : ''}{frame.caption ? ` Subset: ${frame.caption}.` : ''}
          {ds.view.transform !== 'none' && ' Metrics are computed on the transformed series.'}
          {' '}Rows tinted <span className="timingchip">⏱</span> are the timing- &amp; shape-aware measures, recommended as complements to conventional metrics. For datasets with multiple simulations, the better value in each row is underlined.
        </p>
        {outputs.flatMap(o => o?.notes ?? []).filter((v, i, a) => a.indexOf(v) === i).map(nn => <div key={nn} className="warning">{nn}</div>)}
        <div className="mapscroll"><table className="grid metricstable" aria-label="Metric values per run">
          <thead>
            <tr><th>Metric</th><th>Optimum</th>{runs.map(r => <th key={r.id} style={{ color: r.color }}>{r.name}</th>)}</tr>
          </thead>
          <tbody>
            {GROUPS.map(g => {
              const rows = metricRows.filter(m => m.group === g);
              if (!rows.length) return null;
              return (
                <FragmentGroup key={g} title={g}>
                  {rows.map(m => {
                    const vals = outputs.map(o => (o ? display(m.id, o.values[m.id]) : NaN));
                    const best = runs.length > 1 ? bestIndex(vals, m.direction) : -1;
                    return (
                      <tr key={m.id} className={m.timing ? 'timingrow' : ''} title={m.blurb + ` Range ${m.range}.`}>
                        <td>{m.timing ? '⏱ ' : ''}{m.label}</td>
                        <td className="muted">{m.optimum}</td>
                        {vals.map((v, i) => {
                          const ci = ciOn ? boots.results[i]?.cis[m.id] : undefined;
                          return (
                            <td key={runs[i].id} className={i === best ? 'best' : ''}>
                              {fmtNum(v, m.digits)}
                              {ciOn && (m.timing
                                ? <span className="ci" title="Block resampling destroys the time axis that timing metrics measure, so a bootstrap CI would be meaningless here.">CI n/a</span>
                                : ci && isFinite(ci[0])
                                  ? <span className="ci">[{fmtNum(ci[0], m.digits)}, {fmtNum(ci[1], m.digits)}]</span>
                                  : <span className="ci">…</span>)}
                            </td>
                          );
                        })}
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
        </table></div>
      </section>

      <section className="card">
        <details>
          <summary><strong>Metric reference</strong>: equations, ranges, and blind spots</summary>
          <div className="controls"><label>Search{' '}
            <input type="search" placeholder="e.g. wasserstein, bias, timing…" value={refQuery}
              onChange={e => setRefQuery(e.target.value)} aria-label="search metric reference" />
          </label></div>
          <p className="muted">
            Notation: <Eq tex={'O_i'} /> observed, <Eq tex={'S_i'} /> simulated, <Eq tex={'n'} /> valid pairs after the NaN policy,{' '}
            <Eq tex={'\\bar{O},\\ \\sigma'} /> mean and population standard deviation, <Eq tex={'\\tilde{O}'} /> median,{' '}
            <Eq tex={'F'} /> cumulative mass over time (Wasserstein) or FDC quantile. Lags are in steps of the record ({''}
            positive = simulation late).
          </p>
          <div className="mapscroll">
            <table className="grid reftable" aria-label="Metric reference: equations, ranges and blind spots">
              <thead>
                <tr><th>Metric</th><th>Equation</th><th>Range</th><th>Optimum</th><th>Better</th><th>Measures / blind spot</th></tr>
              </thead>
              <tbody>
                {GROUPS.map(g => (
                  <FragmentGroup key={g} title={g}>
                    {REGISTRY.filter(m => m.group === g)
                      .filter(m => {
                        const q = refQuery.trim().toLowerCase();
                        if (!q) return true;
                        return (m.label + ' ' + m.id + ' ' + (m.blurb ?? '')).toLowerCase().includes(q);
                      }).map(m => (
                      <tr key={m.id} className={m.timing ? 'timingrow' : ''}>
                        <td>{m.timing ? '⏱ ' : ''}{m.label}</td>
                        <td className="eqcell"><Eq tex={m.equation} /></td>
                        <td>{m.range}</td>
                        <td>{m.optimum}</td>
                        <td>{m.direction === 'max' ? 'higher' : m.direction === 'min' ? 'lower' : m.direction === 'zero' ? 'closer to 0' : 'closer to 1'}</td>
                        <td className="blurbcell">{m.blurb}</td>
                      </tr>
                    ))}
                  </FragmentGroup>
                ))}
              </tbody>
            </table>
          </div>
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
