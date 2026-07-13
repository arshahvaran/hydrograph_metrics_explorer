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
import { AnalysisBar } from './ui/AnalysisBar'
import { download } from './ui/format'
import { APP_VERSION, CHECKPOINT } from './version'
import type { Project } from './types'

const TABS = [
  ['data', 'Data'], ['metrics', 'Metrics'], ['plots', 'Plots'],
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
        <div>
          <h1>Hydrograph Metrics Explorer</h1>
          <p className="tagline">Timing- and shape-aware evaluation of hydrologic model simulations — beyond NSE and KGE.</p>
        </div>
        <div className="headerright">
          {project.datasets.length > 0 && (
            <select value={ds?.id ?? ''} onChange={e => setActiveDataset(e.target.value)} title="Active dataset" aria-label="Active dataset">
              {project.datasets.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          )}
          {ds && <button title="Remove active dataset" aria-label="Remove active dataset" onClick={() => removeDataset(ds.id)}>✕</button>}
          <button title="Save project (.hme.json)" disabled={!project.datasets.length}
            onClick={() => {
              const json = serialiseProject(project);
              if (json.length > 25_000_000) alert(`Heads-up: this project serialises to ${(json.length / 1e6).toFixed(0)} MB (spec suggests staying under 25 MB). It will still save, but loading may be slow.`);
              download('project.hme.json', json, 'application/json');
            }}>Save</button>
          <button title="Duplicate the active dataset" disabled={!ds}
            onClick={() => useApp.getState().duplicateDataset()}>Duplicate</button>
          <button title="Start a new empty project" disabled={!project.datasets.length}
            onClick={() => { if (confirm('Clear all datasets and start a new project? Unsaved work is lost.')) useApp.getState().loadProject({ schemaVersion: 1, datasets: [], activeDatasetId: null }); }}>New</button>
          <label className="filebtn" title="Load a saved project">Load
            <input ref={loadRef} type="file" accept=".json" className="vh" aria-label="Load a saved .hme.json project" onChange={e => e.target.files?.[0] && onLoadProject(e.target.files[0])} />
          </label>
          <span className="badge">{CHECKPOINT}</span>
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
            {label}
          </button>
        ))}
      </div></nav>

      <main className="main" id="main">
        {tab !== 'data' && ds && <AnalysisBar />}
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
        <span>All computation runs in your browser; your data never leaves this page.</span>
        <span>
          HME v{APP_VERSION} · MIT ·{' '}
          <a href="https://github.com/arshahvaran/hydrograph_metrics_explorer" target="_blank" rel="noreferrer">source &amp; citation</a>
        </span>
        <span className="credit">
          Developed by Ali Reza Shahvaran ·{' '}
          <a href="https://github.com/arshahvaran/" target="_blank" rel="noopener noreferrer">github.com/arshahvaran</a>
        </span>
      </footer>
    </div>
  );
}
