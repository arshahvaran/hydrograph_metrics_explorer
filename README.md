<p align="center">
  <img src="public/icon.svg" alt="Hydrograph Metrics Explorer" width="150">
</p>

<h1 align="center">Hydrograph Metrics Explorer (HME)</h1>

<p align="center">
  <a href="https://arshahvaran.github.io/hydrograph_metrics_explorer/"><img src="https://img.shields.io/badge/Live%20app-arshahvaran.github.io-0b6e99" alt="Live app"></a>
  <a href="https://github.com/arshahvaran/hydrograph_metrics_explorer/tags"><img src="https://img.shields.io/badge/version-1.13-informational" alt="Version"></a>
  <a href="https://creativecommons.org/licenses/by-nc/4.0/"><img src="https://img.shields.io/badge/License-CC%20BY--NC%204.0-lightgrey.svg" alt="CC BY-NC 4.0"></a>
</p>

**A browser-based evaluation tool that computes shift-tolerant hydrograph metrics
alongside conventional ones such as NSE and KGE, updating every metric live as users shift,
scale, or offset their flow series.**

**Live app:** https://arshahvaran.github.io/hydrograph_metrics_explorer/

HME accompanies a review of shift-tolerant metrics, which look beyond conventional
efficiency scores (NSE, KGE and relatives) to the *temporal structure* of model error:
peak-timing offsets, event-scale volume and lag errors, Series Distance, band-constrained
Dynamic Time Warping, cross-wavelet phase lag, and the Wasserstein distance between
hydrographs treated as distributions of flow mass over time. Diagnostic Efficiency is
computed too, although the review places it with the conventional metrics: its timing
term is a linear correlation, which responds to a lag without quantifying it.

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

**Metrics.** A 63-metric panel: the conventional families (error norms, correlation and
agreement, efficiencies including KGE variants, flow-duration-curve
signatures, transforms, benchmark skill scores), the shift-tolerant core (peak
timing after Gauch et al., 2021; event peak, volume, and lag errors; Series Distance;
banded DTW; Wasserstein W1/W2; cross-wavelet phase lag), and Diagnostic Efficiency. Optional
95% block-bootstrap confidence intervals. An "essentials" preset mirrors Table 2 of the
companion paper.

**Diagnostics and plots.** Eight linked plots (time series, 1:1 scatter, flow duration,
Q-Q, day-of-year climatology, annual heatmap, spaghetti, DTW alignment) with PNG/SVG/CSV
export; an analysis window, wrap-aware seasonal filter, and resampling; a Timing tab with
lag sweep, cross-wavelet curve, diagnostic-efficiency polar, and an event table.

**Perturbation sandbox.** Shift, offset, scale, dampen, and seeded-noise perturbations with
live metric readouts and presets, including a double-penalty demonstration.

**Comparison and reporting.** C2M-normalised multi-simulation ranking with user-weighted
priority metrics and a recommended simulation (the bounded C2M form E/(2 − E) of Mathevet
et al., 2006, is used only inside this ranking; the Metrics panel shows the efficiencies
themselves); a station map with catchment area; DOCX and PDF evaluation reports generated
entirely in the browser; portable `.hme.json` project files.

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
Everything runs inside one browser tab, so inputs are bounded: delimited files up to
200 MB, workbooks up to 25 MB, project files up to 100 MB, tables up to 1,000,000 rows,
100 columns and 30 million cells, and up to 60 simulated columns per dataset. Tables above
250,000 rows ask for confirmation before loading and are plotted at reduced resolution
(every point still counts in the metrics); bootstrap intervals need between 30 and
100,000 valid pairs.

## Technical validation

Metric implementations are written in TypeScript **from the published equations**; no code
is taken from existing libraries. The suite compares 34 of the 63 metrics with *executed*
reference outputs on nine fixture series, pinned in
[`tests/fixtures/reference_vectors.json`](tests/fixtures/reference_vectors.json)
(regenerable with [`scripts/generate_reference_vectors.py`](scripts/generate_reference_vectors.py)).
One series has gaps, which pins the pairwise NaN-drop semantics.

- **HydroErr 2.0.0** (29 metrics): ME, MAE, MdAE, MSE, RMSE, MdE, MdSE, MAPE, MAAPE, sMAPE,
  MAPD, MASE, NRMSE (mean, range, IQR), r, R², Spearman ρ, d, d₁, dᵣ, d_rel, E₁, NSE, NSE₁,
  NSE_rel, VE, KGE (2009) and KGE′ (2012). Hydrostats 1.0.0 re-exports these HydroErr
  functions, so it is not executed separately.
- **hydroeval 0.1.0** (2 more): PBIAS, with its sign convention (positive =
  underestimation), and KGEnp. MAPD (hydroeval's "mare") and the C2M forms of NSE, KGE, KGE′
  and KGEnp that the Compare ranking uses are checked against it too.
- **diag-eff 1.1** (3 more): DE and its constant and dynamic components, with the temporal
  correlation and the polar angle, on eight of the series.

A test passes when |HME − reference| ≤ 10⁻⁹ · max(1, |reference|) (10⁻¹⁰ in a second check
of NSE, KGE, RMSE and r; 10⁻⁸ for diag-eff; 10⁻⁶ for the DE polar angle). The largest
difference on the fixtures is below 2×10⁻¹⁴ relative, apart from ME and PBIAS, whose fixture
values are near zero after cancellation: they agree to 1.3×10⁻¹⁵ absolute. Exceptions:

- **KGEnp with tied flows.** HME ranks tied values by their average rank, the Spearman
  correlation of Pool et al. (2018); hydroeval ranks them by sort position. Without ties the
  two agree to 10⁻¹⁵. On the two series with a few tied simulated values they differ by up
  to 7×10⁻⁷ (the test allows 10⁻⁶). On `event_tri`, where 40 of the 60 observed flows sit at
  the baseflow, they differ by 4.5 % (KGEnp 0.7876 against 0.8251) and by 7.5 % in C2M form;
  the test pins that difference. HME's Spearman ρ matches HydroErr's (average ranks) to
  10⁻¹⁵ on the same series.
- **MLE, MALE, MSLE, RMSLE** follow the published ln(S/O) definition (Törnquist et al.,
  1985; Jackson et al., 2019). HydroErr's code computes log1p(S) − log1p(O), which changes
  with the flow unit, so its values differ from HME's by 5 % to 410 % on the fixtures. These
  four are checked against independent NumPy values instead.
- **MAAPE** counts a step with O = S = 0 as zero error; HydroErr returns NaN for a record
  with such a step. **sMAPE** divides by (|O| + |S|)/2; HydroErr's (O + S)/2 is the same for
  non-negative flows. No fixture contains either case.

The other 29 metrics have no executed reference: RSR, α, β-NSE, KGE″, wR², logNSE, the four
FDC signatures (FHV, FLV, FMS, FMM) and the 15 other timing and shape metrics (peak timing,
event errors, best-fit lag, Series Distance, DTW, Wasserstein, cross-wavelet lag). They are
checked against analytic identities (for example W₁ = k and W₂² = k² for a pure k-step
shift, and FLV = FMS = 0 for S = c·O), hand-worked formulas, and independent NumPy
implementations of the published equations (the log-error family and the FDC signatures).
%BiasFMM is reported as the unit-free log ratio 100·ln(S̃/Õ); the ratio to ln Õ of Yilmaz
et al. (2008) changes with the flow unit.
The suite also spans property-based, accessibility, privacy, and DOM integration tests; run
it with `npm test`.

## How to cite

*Reference paper will be added here once published.*

## License

This work is licensed under a
[Creative Commons Attribution-NonCommercial 4.0 International License][cc-by-nc].

[![CC BY-NC 4.0][cc-by-nc-image]][cc-by-nc]

[cc-by-nc]: https://creativecommons.org/licenses/by-nc/4.0/
[cc-by-nc-image]: https://licensebuttons.net/l/by-nc/4.0/88x31.png
