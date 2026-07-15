import { useState } from 'react'
import { useApp } from '../store/store'
import { frameFor, computeForRunAsync } from './compute'
import { buildDocx, buildReportImages, openPrintReport, reportFilename, type ReportSections } from '../report/report'
import { download } from './format'

/** Report tab (spec §16): section toggles, notes, DOCX + matching PDF. */
export function ReportTab() {
  const ds = useApp(s => s.project.datasets.find(d => d.id === s.project.activeDatasetId) ?? null);
  const [sections, setSections] = useState<ReportSections>({ summary: true, metrics: true, plots: true, events: true, ranking: true });
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  if (!ds) return null;
  const runs = ds.runs.filter(r => r.visible);
  const toggle = (k: keyof ReportSections) => setSections(s => ({ ...s, [k]: !s[k] }));

  async function generate(kind: 'docx' | 'pdf') {
    if (!ds || !runs.length) return;
    try {
      setBusy('computing metric panels…');
      const outputs = await Promise.all(runs.map(r => computeForRunAsync(ds, r)));
      const frame = frameFor(ds);
      setBusy('rendering figures…');
      const images = sections.plots ? await buildReportImages(ds, frame, runs, outputs) : [];
      const payload = { ds, frame, runs, outputs, images, sections, notes };
      if (kind === 'docx') {
        setBusy('assembling DOCX…');
        const blob = await buildDocx(payload);
        download(reportFilename(ds, 'docx'), blob,
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      } else {
        openPrintReport(payload);
      }
    } catch (err) {
      console.error(err);
      alert(`Report generation failed: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <section className="card">
        <h2>Report <span className="muted">Word or PDF, generated entirely in your browser</span></h2>
        {!runs.length && <p className="warning">Add at least one visible model simulation first.</p>}
        <div className="controls">
          {(
            [['summary', 'Data & settings'], ['metrics', 'Metrics table (timing rows flagged)'],
             ['plots', 'Figures'], ['events', 'Event summary'], ['ranking', 'Ranking & recommendation']] as const
          ).map(([k, label]) => (
            <label key={k}><input type="checkbox" checked={sections[k]} onChange={() => toggle(k)} /> {label}</label>
          ))}
        </div>
        <label style={{ display: 'block' }}>Notes (appended verbatim)
          <textarea rows={3} value={notes} onChange={e => setNotes(e.target.value)}
            placeholder="e.g. Calibration period 2001–2004; validation 2005–2006. Model B uses the revised routing." />
        </label>
        <div className="controls">
          <button className="primary" disabled={!!busy || !runs.length} onClick={() => generate('docx')}>Download DOCX</button>
          <button disabled={!!busy || !runs.length} onClick={() => generate('pdf')}>Print / save PDF</button>
          {busy && <span className="muted" role="status">{busy}</span>}
        </div>
        <p className="muted">
          The report embeds the current analysis subset, all settings (a provenance appendix lets anyone regenerate it),
          the full metrics table with the timing-aware rows shaded, the hydrograph/scatter/lag-sweep figures, per-event
          errors, and, with two or more runs, the composite ranking with a recommended run. Filename:
          {' '}<code>{reportFilename(ds, 'docx')}</code>. The PDF route opens your browser's print dialog; choose “Save as PDF”.
        </p>
      </section>
    </div>
  );
}
