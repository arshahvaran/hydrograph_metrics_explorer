# Hydrograph Metrics Explorer (HME)

[![Live app](https://img.shields.io/badge/Live%20app-arshahvaran.github.io-0b6e99)](https://arshahvaran.github.io/hydrograph_metrics_explorer/)
[![Version](https://img.shields.io/badge/version-1.7-informational)](https://github.com/arshahvaran/hydrograph_metrics_explorer/tags)
[![CC BY-NC 4.0][cc-by-nc-shield]][cc-by-nc]

**A client-side web tool for timing- and shape-aware evaluation of hydrologic model simulations.**

**Live app:** https://arshahvaran.github.io/hydrograph_metrics_explorer/

HME accompanies a review of performance-assessment frameworks that look beyond conventional
efficiency scores (NSE, KGE and relatives) to the *temporal structure* of model error:
peak-timing offsets, event-scale volume and lag errors, Series Distance, band-constrained
Dynamic Time Warping, cross-wavelet phase lag, Diagnostic Efficiency, and the Wasserstein
distance between hydrographs treated as distributions of flow mass over time.

Everything (parsing, unit conversion, every metric, every plot, report generation) runs in
your browser. **No data ever leaves the page**; there is no server, no database, no account.

## Contents

- [Key features](#key-features)
- [Getting started](#getting-started)
- [Input data](#input-data)
- [Technical validation](#technical-validation)
- [How to cite](#how-to-cite)
- [License](#license)

## Key features

**Data ingestion.** CSV/TXT/XLSX upload and paste with explicit column mapping, a
spreadsheet-style editing grid, Julian and calendar date parsing, automatic time-step
detection, user-declared missing values, and a unit engine covering volumetric flows and
area/step-aware depth-to-volume conversion (with automatic rescaling of absolute event
thresholds).

**Metrics.** A 62-metric panel: the classical families (error norms, correlation and
agreement, efficiencies including KGE variants and bounded C2M forms, flow-duration-curve
signatures, transforms, benchmark skill scores) plus the timing- and shape-aware core (peak
timing after Gauch et al., 2021; event peak, volume, and lag errors; Series Distance;
banded DTW; Wasserstein W1/W2; cross-wavelet phase lag; Diagnostic Efficiency). Optional
95% block-bootstrap confidence intervals. An "essentials" preset mirrors Table 2 of the
companion paper.

**Diagnostics and plots.** Eight linked plots (time series, 1:1 scatter, flow duration,
Q-Q, day-of-year climatology, annual heatmap, spaghetti, DTW alignment) with PNG/SVG/CSV
export; an analysis window, wrap-aware seasonal filter, and resampling; a Timing tab with
lag sweep, cross-wavelet curve, diagnostic-efficiency polar, and an event table.

**Perturbation sandbox.** Shift, offset, scale, dampen, and seeded-noise perturbations with
live metric readouts and presets, including a double-penalty demonstration.

**Comparison and reporting.** C2M-normalised multi-simulation ranking with user-weighted
priority metrics and a recommended simulation; a station map with catchment area; DOCX and
PDF evaluation reports generated fully client-side; portable `.hme.json` project files.

## Getting started

Use the live app directly (nothing to install): https://arshahvaran.github.io/hydrograph_metrics_explorer/

Two bundled sample datasets (a deterministic synthetic pair and a HYMOD calibration) load
with one click and demonstrate every panel.

To run locally:

```bash
npm install
npm run dev      # local dev server
npm test         # vitest suite
npm run build    # typecheck + production build to dist/
```

Deployed to GitHub Pages from the `gh-pages` branch (`dist/` contents).

## Input data

One date column plus one observed and any number of simulated discharge columns, in CSV,
TXT, or XLSX (or pasted directly). Column roles are assigned explicitly at import; missing
values are declared in the "Missing value" box rather than assumed. Supported units include
m³/s, ft³/s, L/s, m³/day, ac-ft/day, and depth per step (mm, in) with a catchment area.

## Technical validation

Metric implementations are written in TypeScript **from the published equations**; no code
is taken from existing libraries. They are verified value-for-value against *executed*
reference outputs of HydroErr 2.0.0, Hydrostats 1.0.0, hydroeval 0.1.0 and diag-eff 1.1,
pinned in [`tests/fixtures/reference_vectors.json`](tests/fixtures/reference_vectors.json)
(regenerable with [`scripts/generate_reference_vectors.py`](scripts/generate_reference_vectors.py)),
including exact NaN-handling semantics and the PBIAS sign convention (positive =
underestimation). The suite spans unit, property-based, accessibility, privacy, and DOM
integration tests; run it with `npm test`.

## How to cite

*Reference paper will be added here once published.*

## License

This work is licensed under a
[Creative Commons Attribution-NonCommercial 4.0 International License][cc-by-nc].

[![CC BY-NC 4.0][cc-by-nc-image]][cc-by-nc]

[cc-by-nc]: https://creativecommons.org/licenses/by-nc/4.0/
[cc-by-nc-image]: https://licensebuttons.net/l/by-nc/4.0/88x31.png
[cc-by-nc-shield]: https://img.shields.io/badge/License-CC%20BY--NC%204.0-lightgrey.svg
