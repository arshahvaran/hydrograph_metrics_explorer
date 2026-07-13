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
| CP1 | Scaffold, data model, date parsing (incl. Julian), time-step detection, unit engine (volumetric + area/step-aware depth↔volume), missing-value & NaN policies, validation, bundled samples, seed metrics (NSE, KGE-2009, RMSE, PBIAS, r, C2M) | ✅ live |
| CP2 | Full classical catalogue: error norms, correlation & agreement, efficiencies (incl. KGE′, KGE″, KGEnp, bounded C2M forms), FDC signatures (FHV/FLV/FMS/FMM), transforms, benchmarks & skill scores | ⏳ |
| CP3 | Timing-aware core: peak-timing (Gauch et al., 2021), event errors, Series Distance, DTW (Sakoe–Chiba), Wasserstein W₁/W₂², cross-wavelet phase lag, Diagnostic Efficiency, lag sweep — in Web Workers | ⏳ |
| CP4 | Paste grid, file upload with column mapping, editing, full metrics table, in-app metric reference | ⏳ |
| CP5 | Seven linked plots + DTW/SD alignment view, shared toggles, PNG/SVG/CSV export | ⏳ |
| CP6 | Perturbation Sandbox (shift/offset/scale/dampen/seeded noise, presets incl. the double-penalty demo), Timing tab UI | ⏳ |
| CP7 | Multi-run comparison & recommendation, station map, DOCX/PDF report, project save/load | ⏳ |
| CP8 | Full acceptance audit, accessibility & privacy checks, release | ⏳ |

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
