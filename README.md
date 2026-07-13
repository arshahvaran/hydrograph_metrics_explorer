# Hydrograph Metrics Explorer (HME)

**Live app:** https://arshahvaran.github.io/hydrograph_metrics_explorer/

HME is a client-side web tool for **timing- and shape-aware evaluation of hydrologic model
simulations**. It accompanies a review paper on performance-assessment frameworks that look
beyond conventional efficiency scores (NSE, KGE and relatives) to the *temporal structure* of
model error: peak-timing offsets, event-scale volume and lag errors, Series Distance,
band-constrained Dynamic Time Warping, cross-wavelet phase lag, Diagnostic Efficiency, and the
Wasserstein distance between hydrographs treated as distributions of flow mass over time.

Everything — parsing, unit conversion, every metric, every plot, report generation — runs in
your browser. **No data ever leaves the page**; there is no server, no database, no account.

## Status

This repository is being built in verified checkpoints. Each checkpoint lands with its tests.

| Checkpoint | Contents | Status |
|---|---|---|
| CP1 | Scaffold, data model, date parsing (incl. Julian), time-step detection, unit engine (volumetric + area/step-aware depth↔volume), missing-value & NaN policies, validation, bundled samples | ✅ live |
| CP2 | Full classical catalogue: error norms, correlation & agreement, efficiencies (incl. KGE′, KGE″, KGEnp, bounded C2M forms), FDC signatures (FHV/FLV/FMS/FMM), transforms, benchmarks & skill scores | ✅ live |
| CP3 | Timing-aware core: peak-timing (Gauch et al., 2021), event errors, Series Distance (core form), band-constrained DTW, Wasserstein W₁/W₂², cross-wavelet phase lag (Morlet, red-noise gated), Diagnostic Efficiency, lag sweep | ✅ live |
| CP4 | File upload (CSV/TXT/XLSX) + paste with column mapping, full metrics table with presets/exports, in-app metric reference | ✅ live (spreadsheet-style editing grid still to come) |
| CP5 | Eight plots: time series, 1:1 scatter, FDC, Q–Q, DOY climatology, annual heatmap, spaghetti, DTW alignment; PNG export via the plot toolbar | ✅ live |
| CP6 | Perturbation Sandbox (shift/offset/scale/dampen/seeded noise, presets incl. the double-penalty demo) and Timing tab UI (config, lag sweep, XWT curve, DE polar, events table) | ✅ live |
| CP7 | Station map + catchment area, project save/load (.hme.json) | ✅ live (DOCX/PDF report and multi-run ranking view still to come) |
| CP8 | Web Workers for very long records, bootstrap CIs, editing grid, report generator, acceptance & accessibility audit, release | ⏳ |

## Correctness

Metric implementations are written in TypeScript **from the published equations** — no code is
taken from existing libraries. They are verified value-for-value against *executed* reference
outputs of HydroErr 2.0.0, Hydrostats 1.0.0, hydroeval 0.1.0 and diag-eff 1.1, pinned in
[`tests/fixtures/reference_vectors.json`](tests/fixtures/reference_vectors.json) (regenerable
with [`scripts/generate_reference_vectors.py`](scripts/generate_reference_vectors.py)) —
including exact NaN-handling semantics and the PBIAS sign convention
(positive = underestimation). Run the suite with `npm test`.

## Development

```bash
npm install
npm run dev      # local dev server
npm test         # vitest suite
npm run build    # typecheck + production build to dist/
```

Deployed to GitHub Pages from the `gh-pages` branch (`dist/` contents).

## Licence & citation

MIT — see [LICENSE](LICENSE). If you use this software, please cite it via
[CITATION.cff](CITATION.cff); a paper reference will be added on publication.
