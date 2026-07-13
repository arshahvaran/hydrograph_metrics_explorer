import { useRef } from 'react'
import { useApp, serialiseProject } from './store/store'
import { DataTab } from './ui/DataTab'
import { MetricsTab } from './ui/MetricsTab'
import { PlotsTab } from './ui/PlotsTab'
import { TimingTab } from './ui/TimingTab'
import { SandboxTab } from './ui/SandboxTab'
import { MapTab } from './ui/MapTab'
import { download } from './ui/format'
import { APP_VERSION, CHECKPOINT } from './version'
import type { Project } from './types'

const TABS = [
  ['data', 'Data'], ['metrics', 'Metrics'], ['plots', 'Plots'],
  ['timing', 'Timing'], ['sandbox', 'Sandbox'], ['map', 'Map'],
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
      const p = JSON.parse(await f.text()) as Project;
      if (p?.schemaVersion !== 1 || !Array.isArray(p.datasets)) throw new Error('Not an HME project file');
      loadProject(p);
    } catch (e) {
      alert(`Could not load project: ${e instanceof Error ? e.message : e}`);
    } finally {
      if (loadRef.current) loadRef.current.value = '';
    }
  }

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>Hydrograph Metrics Explorer</h1>
          <p className="tagline">Timing- and shape-aware evaluation of hydrologic model simulations — beyond NSE and KGE.</p>
        </div>
        <div className="headerright">
          {project.datasets.length > 0 && (
            <select value={ds?.id ?? ''} onChange={e => setActiveDataset(e.target.value)} title="Active dataset">
              {project.datasets.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          )}
          {ds && <button title="Remove active dataset" onClick={() => removeDataset(ds.id)}>✕</button>}
          <button title="Save project (.hme.json)" disabled={!project.datasets.length}
            onClick={() => download('project.hme.json', serialiseProject(project), 'application/json')}>Save</button>
          <label className="filebtn" title="Load a saved project">Load
            <input ref={loadRef} type="file" accept=".json" hidden onChange={e => e.target.files?.[0] && onLoadProject(e.target.files[0])} />
          </label>
          <span className="badge">{CHECKPOINT}</span>
          <button className="theme-toggle" onClick={toggleTheme} title="Toggle light or dark interface" aria-label="Toggle colour theme">
            {theme === 'dark' ? '\u2600\uFE0E' : '\u263D'}
          </button>
        </div>
      </header>

      <nav className="tabs" role="tablist" aria-label="Main sections">
        {TABS.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id}
            className={tab === id ? 'tab active' : 'tab'}
            disabled={!ds && id !== 'data'}
            title={!ds && id !== 'data' ? 'Load data first' : undefined}
            onClick={() => ds && setActiveTab(id)}>
            {label}
          </button>
        ))}
      </nav>

      <main className="main">
        {tab === 'data' && <DataTab />}
        {tab === 'metrics' && ds && <MetricsTab />}
        {tab === 'plots' && ds && <PlotsTab />}
        {tab === 'timing' && ds && <TimingTab />}
        {tab === 'sandbox' && ds && <SandboxTab />}
        {tab === 'map' && ds && <MapTab />}
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
