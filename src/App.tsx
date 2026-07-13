import { useApp } from './store/store'
import { DataTab } from './ui/DataTab'
import { EmptyTab } from './ui/EmptyTab'
import { APP_VERSION, CHECKPOINT } from './version'

const TABS = [
  { id: 'data', label: 'Data' },
  { id: 'metrics', label: 'Metrics' },
  { id: 'plots', label: 'Plots' },
  { id: 'timing', label: 'Timing' },
  { id: 'sandbox', label: 'Sandbox' },
  { id: 'map', label: 'Map' },
] as const;

const COMING: Record<string, string> = {
  metrics: 'The full classical catalogue (error norms, correlation & agreement, efficiencies incl. bounded C2M forms, FDC signatures) with per-run columns, transforms and benchmarks arrives at CP2. A seed of it already runs on the Data tab.',
  plots: 'Seven linked plots (time series with brush, 1:1 scatter, flow-duration curve, annual heatmap, spaghetti, day-of-year climatology, quantile–quantile) plus the DTW/Series-Distance alignment view arrive at CP5.',
  timing: 'Timing- & shape-aware panel — peak-timing (Gauch et al., 2021), event errors, Series Distance, band-constrained DTW, cross-wavelet phase lag, Diagnostic Efficiency with its polar plot, Wasserstein distance, and the interactive lag sweep — arrives at CP3 (engine) and CP6 (UI).',
  sandbox: 'The perturbation sandbox — shift, offset, scale, dampen, seeded noise with live metric response and the double-penalty preset — arrives at CP6.',
  map: 'Station map (Leaflet + OpenStreetMap) arrives at CP7.',
};

export default function App() {
  const project = useApp(s => s.project);
  const setActiveTab = useApp(s => s.setActiveTab);
  const ds = project.datasets.find(d => d.id === project.activeDatasetId) ?? null;
  const tab = ds?.view.activeTab ?? 'data';

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>Hydrograph Metrics Explorer</h1>
          <p className="tagline">Timing- and shape-aware evaluation of hydrologic model simulations — beyond NSE and KGE.</p>
        </div>
        <span className="badge" title="Development checkpoint">{CHECKPOINT}</span>
      </header>

      <nav className="tabs" role="tablist" aria-label="Main sections">
        {TABS.map(t => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? 'tab active' : 'tab'}
            disabled={!ds && t.id !== 'data'}
            title={!ds && t.id !== 'data' ? 'Load data first' : undefined}
            onClick={() => ds && setActiveTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main className="main">
        {tab === 'data' && <DataTab />}
        {tab !== 'data' && <EmptyTab title={TABS.find(t => t.id === tab)!.label} text={COMING[tab]} />}
      </main>

      <footer className="footer">
        <span>All computation runs in your browser; your data never leaves this page.</span>
        <span>
          HME v{APP_VERSION} · MIT ·{' '}
          <a href="https://github.com/arshahvaran/hydrograph_metrics_explorer" target="_blank" rel="noreferrer">source &amp; citation</a>
        </span>
      </footer>
    </div>
  );
}
