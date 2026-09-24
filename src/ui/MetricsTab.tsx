import { useState } from 'react'
import { useApp } from '../store/store'
import { REGISTRY, PRESETS, GROUPS } from '../metrics/registry'
import { useRunOutputs, bestIndices, frameFor, useBootstrapCIsAll, useComputeError } from './compute'
import { csvLine, fmtNum, download } from './format'
import { Eq } from './Eq'
import { APP_VERSION } from '../version'
import type { Dataset } from '../types'
import { RunName } from './RunName'

/** Tooltip text shared by the two skill rows: how every benchmark is built. */
const BENCHMARK_CONVENTION = 'The model and the benchmark are scored on the same pairs (where the observation, the simulation and the benchmark are all valid) and under the same transform. Each benchmark is a flow series built from the observations of those pairs: their mean flow, their monthly mean flow (climatology), or the observation at the previous step (persistence; none at the first step or after a missing observation, where the pair is dropped from both scores). The benchmark is then transformed like the simulation.';

export function MetricsTab() {
  const ds = useApp(s => s.project.datasets.find(d => d.id === s.project.activeDatasetId) ?? null);
  if (!ds) return null;
  return <MetricsTabInner ds={ds} />;
}

function MetricsTabInner({ ds }: { ds: Dataset }) {
  const updateView = useApp(s => s.updateView);
  // The preset lives in the dataset's view so it is saved with the project.
  const preset = PRESETS[ds.view.metricPreset] ? ds.view.metricPreset : 'essentials';
  const setPreset = (p: string) => updateView({ metricPreset: p });
  const [refQuery, setRefQuery] = useState('');

  const runs = ds.runs.filter(r => r.visible);
  const outputs = useRunOutputs(ds, runs);
  const frame = frameFor(ds);
  const busy = outputs.some(o => o === null);
  const ciOn = ds.view.showBootstrapCIs;
  const boots = useBootstrapCIsAll(ds, runs, ciOn);
  const computeError = useComputeError(ds);

  const selected = PRESETS[preset] === 'all' ? REGISTRY.map(m => m.id) : (PRESETS[preset] as string[]);
  const metricRows = REGISTRY.filter(m => selected.includes(m.id));

  // benchmark skill (NSE & KGE vs the selected benchmark forecast), scored on
  // the model's own pairs under the model's transform (design rule D4). The
  // worker computes it with the panel for all three benchmarks, so rendering
  // only reads it and a benchmark switch recomputes nothing (tb-rev-05).
  const bench = outputs.map(o => {
    const b = o?.benchmark?.[ds.view.benchmark];
    return { nseSkill: b?.nseSkill ?? NaN, kgeSkill: b?.kgeSkill ?? NaN };
  });

  const display = (id: string, v: number) =>
    v;

  function exportCsv(sep: ',' | '\t') {
    // Each comment line is written as ONE quoted cell: the dataset name, run
    // names and settings come from user files, and a separator inside them
    // would otherwise open a new cell that a spreadsheet may run as a formula.
    const comment = (text: string) => csvLine([text], sep);
    const lines: string[] = [
      comment(`# Hydrograph Metrics Explorer v${APP_VERSION} · https://arshahvaran.github.io/hydrograph_metrics_explorer/`),
      comment(`# exported ${new Date().toISOString()}`),
      comment(`# dataset: ${ds!.name} (${ds!.dates.length} rows, step ${ds!.step.label}, unit ${ds!.targetUnit})`),
      comment(`# settings: nan=${ds!.view.nanPolicy}; transform=${ds!.view.transform}; benchmark=${ds!.view.benchmark}`),
      comment(`# timing config: ${JSON.stringify(ds!.view.timingConfig)}`),
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
    // A UTF-8 byte-order mark makes Excel read the labels (R², KGE′, d₁) as UTF-8.
    download(`${ds!.name.replace(/[^\w-]+/g, '_')}_metrics.csv`,
      '﻿' + lines.join('\n'), sep === ',' ? 'text/csv' : 'text/tab-separated-values');
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
          <label title="Circular block bootstrap of the conventional (time-synchronous) metrics on the same pairs and transform as the values shown (B = 500, seeded). The block length follows the persistence of the errors (Politis and White, 2004), so records with long-lasting errors get longer blocks and wider intervals. Timing and shape rows are excluded: resampling blocks destroys the time axis they measure.">
            <input type="checkbox" checked={ciOn} onChange={e => updateView({ showBootstrapCIs: e.target.checked })} /> Calculate 95% CIs (block bootstrap)
          </label>
          {ciOn && boots.progress < 1 && <span className="muted" role="status" aria-live="polite">bootstrapping… {Math.round(boots.progress * 100)}%</span>}
          <button className="primary" disabled={busy || (ciOn && boots.progress < 1)} title={busy || (ciOn && boots.progress < 1) ? 'Available when the metrics (and CIs) have finished computing' : undefined} onClick={() => exportCsv(',')}>Export CSV</button>
        </div>
        <p className="muted" aria-live="polite">
          Valid pairs per simulation (n): {runs.map((r, i) => `${r.name}: ${outputs[i]?.n ?? '…'}`).join(' · ')}.{busy && !computeError ? ' Computing in a background worker…' : ''}{frame.caption ? ` Subset: ${frame.caption}.` : ''}
          {ds.view.transform !== 'none' && ' The error, correlation and efficiency metrics, the benchmark skill, DTW and XWT are computed on the transformed series; the notes below name the metrics that use untransformed flows.'}
          {' '}Rows tinted <span className="timingchip">⏱</span> are the timing and shape metrics: the shift-tolerant metrics, which are recommended as complements to the conventional ones, plus the lag at best fit and Diagnostic Efficiency. For datasets with multiple simulations, the better value in each row is underlined.
        </p>
        {computeError && <div className="error" role="alert">{computeError}</div>}
        {outputs.flatMap(o => o?.notes ?? []).filter((v, i, a) => a.indexOf(v) === i).map(nn => <div key={nn} className="warning">{nn}</div>)}
        {ciOn && boots.results.map((b, i) => (b?.reason ? <div key={runs[i].id} className="warning">CIs for {runs[i].name}: {b.reason}</div> : null))}
        <div className="mapscroll"><table className="grid metricstable" aria-label="Metric values per simulation">
          <thead>
            <tr><th>Metric</th><th>Optimum</th>{runs.map(r => <th key={r.id}><RunName name={r.name} color={r.color} /></th>)}</tr>
          </thead>
          <tbody>
            {GROUPS.map(g => {
              const rows = metricRows.filter(m => m.group === g);
              if (!rows.length) return null;
              return (
                <FragmentGroup key={g} title={g}>
                  {rows.map(m => {
                    const vals = outputs.map(o => (o ? display(m.id, o.values[m.id]) : NaN));
                    const best = runs.length > 1 ? bestIndices(vals, m.direction) : new Set<number>();
                    return (
                      <tr key={m.id} className={m.timing ? 'timingrow' : ''} title={m.blurb + ` Range ${m.range}.`}>
                        <td>{m.timing ? '⏱ ' : ''}{m.label}</td>
                        <td className="muted">{m.optimum}</td>
                        {vals.map((v, i) => {
                          const res = ciOn ? boots.results[i] : null;
                          const ci = res?.cis[m.id];
                          return (
                            <td key={runs[i].id} className={best.has(i) ? 'best' : ''}>
                              {fmtNum(v, m.digits)}
                              {ciOn && (m.timing
                                ? <span className="ci" title={m.id.startsWith('de')
                                    ? 'Not bootstrapped: only the conventional block is resampled. DE depends on the flow-duration curve and r, not on time order, so a CI would be possible but is not computed in this version.'
                                    : 'Block resampling destroys the time axis that timing metrics measure, so a bootstrap CI would be meaningless here.'}>CI n/a</span>
                                : ci && isFinite(ci[0])
                                  ? <span className="ci">[{fmtNum(ci[0], m.digits)}, {fmtNum(ci[1], m.digits)}]</span>
                                  : res
                                    ? <span className="ci" title={res.reason ?? 'The bootstrap distribution of this metric was not stable enough for an interval.'}>CI n/a</span>
                                    : <span className="ci">…</span>)}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                  {g === 'Efficiencies' && (
                    <>
                      <tr title={`Skill of NSE relative to the selected benchmark: (NSE − NSE_bench)/(1 − NSE_bench). ${BENCHMARK_CONVENTION} With no transform the mean-flow benchmark scores NSE_bench = 0, so the skill equals NSE; under a transform the transformed mean flow is not the mean of the transformed flows, and NSE_bench is below 0.`}>
                        <td>NSE skill vs {ds.view.benchmark}</td><td className="muted">1</td>
                        {bench.map((b, i) => <td key={runs[i].id}>{fmtNum(b.nseSkill, 3)}</td>)}
                      </tr>
                      <tr title={`Skill of KGE (2009) relative to the selected benchmark: (KGE − KGE_bench)/(1 − KGE_bench) (Knoben et al., 2019). ${BENCHMARK_CONVENTION} With no transform the mean-flow benchmark scores KGE_bench = 1 − √2 ≈ −0.41 (r taken as 0 for a constant series); under a transform its bias ratio moves away from 1 and KGE_bench is lower. n/a under the log transform, where KGE is n/a.`}>
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
                <tr><th>Metric</th><th>Equation</th><th>Range</th><th>Optimum</th><th>Better</th><th>What it measures / blind spot</th></tr>
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
