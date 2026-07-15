import { useRef } from 'react'
import { useApp, serialiseProject } from './store/store'
import { parseProjectFile } from './store/projectLoad'
import { DataTab } from './ui/DataTab'
import { MetricsTab } from './ui/MetricsTab'
import { PlotsTab } from './ui/PlotsTab'
import { TimingTab } from './ui/TimingTab'
import { SandboxTab } from './ui/SandboxTab'
import { MapTab } from './ui/MapTab'
import { CompareTab } from './ui/CompareTab'
import { ReportTab } from './ui/ReportTab'
import { download } from './ui/format'
import { APP_VERSION } from './version'
import type { Project } from './types'

const I = (d: string) => (
  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
);
const ICONS: Record<string, JSX.Element> = {
  data: I('M4 5h16v14H4z M4 10h16 M10 5v14'),
  plots: I('M4 19V5 M4 19h16 M6.5 15l4-6 3.5 3.5 4-6.5'),
  metrics: I('M6 20V10 M12 20V4 M18 20v-7'),
  timing: I('M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7v5l3.5 2'),
  sandbox: I('M4 7h10 M18 7h2 M14 5v4 M4 12h3 M11 12h9 M7 10v4 M4 17h12 M20 17h0.5 M16 15v4'),
  compare: I('M9 4v16 M15 4v16 M4 8h5 M4 16h5 M15 8h5 M15 16h5'),
  map: I('M12 21s-6.5-5.4-6.5-10A6.5 6.5 0 0 1 12 4.5 6.5 6.5 0 0 1 18.5 11c0 4.6-6.5 10-6.5 10z M12 13a2 2 0 1 0 0-4 2 2 0 0 0 0 4z'),
  report: I('M7 3h7l4 4v14H7z M14 3v4h4 M10 12h5 M10 16h5'),
};
const TABS = [
  ['data', 'Data'], ['plots', 'Plots'], ['metrics', 'Metrics'],
  ['timing', 'Timing'], ['sandbox', 'Sandbox'], ['compare', 'Compare'],
  ['map', 'Map'], ['report', 'Report'],
] as const;

export default function App() {
  const project = useApp(s => s.project);
  const setActiveTab = useApp(s => s.setActiveTab);
  const setActiveDataset = useApp(s => s.setActiveDataset);
  const removeDataset = useApp(s => s.removeDataset);
  const loadProject = useApp(s => s.loadProject);
  const theme = useApp(s => s.theme);
  const toggleTheme = useApp(s => s.toggleTheme);
  const loadRef = useRef<HTMLInputElement>(null);

  const ds = project.datasets.find(d => d.id === project.activeDatasetId) ?? null;
  const tab = ds?.view.activeTab ?? 'data';

  async function onLoadProject(f: File) {
    try {
      const { project, warnings } = parseProjectFile(await f.text());
      loadProject(project);
      if (warnings.length) alert(`Project loaded with ${warnings.length} skipped item(s):\n- ${warnings.join('\n- ')}`);
    } catch (e) {
      alert(`Could not load project: ${e instanceof Error ? e.message : e}`);
    } finally {
      if (loadRef.current) loadRef.current.value = '';
    }
  }

  return (
    <div className="app">
      <a href="#main" className="skip">Skip to content</a>
      <header className="header">
        <div className="brand">
          <img className="logo" src={`${import.meta.env.BASE_URL}logo.svg`} alt="" aria-hidden="true" />
          <div>
            <h1>Hydrograph Metrics Explorer</h1>
            <p className="tagline">Evaluate hydrological model performance beyond conventional NSE or KGE with timing- and shape-aware measures.</p>
          </div>
        </div>
        <div className="headerright">
          {project.datasets.length > 0 && (
            <label className="dsselect">Active dataset:{' '}
              <select value={ds?.id ?? ''} onChange={e => setActiveDataset(e.target.value)} title="Active dataset" aria-label="Active dataset">
                {project.datasets.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </label>
          )}
          {ds && <button title="Remove active dataset" aria-label="Remove active dataset" onClick={() => removeDataset(ds.id)}>✕</button>}
          <button title="Duplicate the active dataset" disabled={!ds}
            onClick={() => useApp.getState().duplicateDataset()}>Duplicate</button>
          <button title="Save project (.hme.json)" disabled={!project.datasets.length}
            onClick={() => {
              const json = serialiseProject(project);
              if (json.length > 25_000_000) alert(`Heads-up: this project serialises to ${(json.length / 1e6).toFixed(0)} MB (spec suggests staying under 25 MB). It will still save, but loading may be slow.`);
              download('project.hme.json', json, 'application/json');
            }}>Save</button>
          <button title="Start a new empty project" disabled={!project.datasets.length}
            onClick={() => { if (confirm('Clear all datasets and start a new project? Unsaved work is lost.')) useApp.getState().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null }); }}>New</button>
          <label className="filebtn" title="Load a saved project">Load
            <input ref={loadRef} type="file" accept=".json" className="vh" aria-label="Load a saved .hme.json project" onChange={e => e.target.files?.[0] && onLoadProject(e.target.files[0])} />
          </label>
          <button className="theme-toggle" onClick={toggleTheme} title="Toggle light or dark interface" aria-label="Toggle colour theme">
            {theme === 'dark' ? '\u2600\uFE0E' : '\u263D'}
          </button>
        </div>
      </header>

      <nav className="tabs" aria-label="Main sections"
        onKeyDown={e => {
          if (!ds) return;
          const ids = TABS.map(([id]) => id);
          const cur = ids.indexOf(tab);
          let next = -1;
          if (e.key === 'ArrowRight') next = (cur + 1) % ids.length;
          else if (e.key === 'ArrowLeft') next = (cur - 1 + ids.length) % ids.length;
          else if (e.key === 'Home') next = 0;
          else if (e.key === 'End') next = ids.length - 1;
          if (next >= 0) {
            e.preventDefault();
            setActiveTab(ids[next]);
            (e.currentTarget.querySelectorAll('[role="tab"]')[next] as HTMLButtonElement)?.focus();
          }
        }}><div role="tablist" aria-label="Main sections" style={{ display: 'contents' }}>
        {TABS.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} tabIndex={tab === id ? 0 : -1}
            className={tab === id ? 'tab active' : 'tab'}
            disabled={!ds && id !== 'data'}
            title={!ds && id !== 'data' ? 'Load data first' : undefined}
            onClick={() => ds && setActiveTab(id)}>
            {ICONS[id]}<span>{label}</span>
          </button>
        ))}
      </div></nav>

      <main className="main" id="main">
        {tab === 'data' && <DataTab />}
        {tab === 'metrics' && ds && <MetricsTab />}
        {tab === 'plots' && ds && <PlotsTab />}
        {tab === 'timing' && ds && <TimingTab />}
        {tab === 'sandbox' && ds && <SandboxTab />}
        {tab === 'compare' && ds && <CompareTab />}
        {tab === 'map' && ds && <MapTab />}
        {tab === 'report' && ds && <ReportTab />}
      </main>

      <footer className="footer">
        <span>All computation runs in the browser; uploaded data never leaves this page.</span>
        <span>
          v{APP_VERSION} ·{' '}
          <a href="https://github.com/arshahvaran/hydrograph_metrics_explorer" target="_blank" rel="noreferrer">Source, License, &amp; Citation</a>
        </span>
        <span className="credit">Developed by Shahvaran et al., 2026</span>
      </footer>
    </div>
  );
}
