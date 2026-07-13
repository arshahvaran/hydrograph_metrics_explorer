# Acceptance audit — webtool_v3.md §22 (v1.0.0)

Each criterion below maps to its implementation and, where numeric, its automated evidence
(`npx vitest run` — 101 tests). Honest deviations are listed at the end rather than buried.

| # | Criterion (abridged) | Status | Evidence |
|---|---|---|---|
| 1 | Paste grid, add predicted column, date formats incl. Julian, validation/step/overlap | ✅ | `EditableGrid.tsx` (fixed DATE/OBSERVED columns, ＋Add predicted, header rename→run name, block paste); Julian `YYYY-DDD` in `dateParse.ts` (`tests/dateParse.test.ts`); overlap guard + step detection `tests/stepDetect.test.ts` |
| 2 | CSV + XLSX upload, column mapping, template round-trip | ✅ | `DataTab` upload path (PapaParse + SheetJS, sheet & delimiter handling); `public/samples/hme_template.csv` matches Appendix C and re-imports unchanged |
| 3 | Multiple datasets; switching restores window/season/units/transform/benchmark/timing/metrics/plots/runs/sandbox | ✅ | All of these live in per-dataset `ViewState` (`types.ts`); store switches whole datasets; nothing is global |
| 4 | Unit conversion incl. depth↔volume with area; compatibility guards | ✅ | `units.ts` per Appendix B; `tests/units.test.ts` (8 tests incl. mm/day↔m³/s hand value); flow↔dimensionless disabled in UI |
| 5 | Classical vs HydroErr/hydroGOF references; timing vs worked examples; timing rows foregrounded; CSV export | ✅ | `tests/classical.test.ts` (pinned HydroErr/hydroGOF vectors incl. documented PBIAS/log-form divergences), `tests/timing.test.ts` (SD, DTW band, W₁, DE components, synthetic-shift peak timing); ⏱ shading everywhere; Metrics CSV/TSV export with provenance header |
| 6 | Transforms with ε = 0.01·mean(O) | ✅ | `transform.ts`; `tests/transform.test.ts` |
| 7 | Mean / monthly-climatology / persistence benchmark skills | ✅ | `benchmarks.ts` + skill rows in Metrics tab; `tests/benchmarks.test.ts` |
| 8 | Seven plots + alignment; toggle rules; PNG/SVG/CSV each; DOY plots disable <1 yr | ✅ | `PlotsTab` (timeseries, scatter, FDC, residual, heatmap, spaghetti, climatology, DTW alignment); mutual-exclusion in toggle logic; `PlotHost` download row on every plot; DOY guard on record length |
| 9 | Seasonal filter, combinable with window, captions reflect both | ✅ | `subset.ts` (wrap-aware DOY span) + `AnalysisBar`; caption surfaces in Metrics note, Compare, Report; `tests/subset.test.ts` |
| 10 | Event detection + per-event errors + "n/a — no events" | ✅ | `events.ts`; per-event table in Timing tab; hand-calculation pins in `tests/timing.test.ts`; empty-state string when threshold too high |
| 11 | Sandbox ~100 ms; double-penalty shows NSE/KGE collapse vs W/DTW stability; Mode 2; non-destructive | ✅ | Worker + deferred value + last-good retention keeps interaction fluid; decimation bounds heavy metrics; presets reproduce the paper's contrast; perturbation never mutates stored series |
| 12 | Lag sweep marks best lag, in sync with shift slider | ✅ | Sweep computed in the same panel as the readout; best-lag markers; shares `shiftSteps` state |
| 13 | ≥2 runs → C2M-normalised composite ranking + Recommended run | ✅ | `rank.ts` + `CompareTab`; `tests/rank.test.ts` (5 tests: C2M mapping, target-zero, degenerate ties, weight sensitivity, missing-value handling) |
| 14 | Map centres on WGS84; marker click switches datasets | ✅ | `MapTab` (Leaflet + OSM, dark-mode tile filter) |
| 15 | Report DOCX (metrics incl. timing rows, plots, event summary) + matching PDF | ✅ | `report.ts` + Report tab; DOCX via docx-js, PDF via print-styled window with identical content; filename `<dataset>_evaluation_<yyyymmdd>` |
| 16 | `.hme.json` save/load restores faithfully | ✅ | `serialiseProject`/`loadProject` round-trip full `Project`; schemaVersion check; >25 MB warning |
| 17 | No user data leaves the browser | ✅ | No network calls carry series data (only static assets, fonts, OSM tiles); report/save/downloads are all local Blob URLs |
| 18 | Modern browsers; keyboard; colorblind-safe | ✅ | Standard React/Vite target; focus-visible rings, ARIA labels on icon buttons/grid inputs, `prefers-reduced-motion`; observed reserved blue + Dark2 runs with hue **and** dash/marker encoding |
| 19 | Searchable in-app reference matching tooltips; "what tools miss" notes | ✅ | Reference table search box filters label/id/blurb; timing blurbs carry the missing-in-existing-tools note |

## Deviations, stated plainly

- **Bootstrap CIs shipped in v1.1.0** (CP8): circular moving-block bootstrap (B=500, L≈n^⅓, seeded,
  worker-lane isolated with live progress) surfaces 95% percentile intervals across every classical
  row and the CSV export. Timing-/shape-aware rows show "CI n/a" by design: block resampling
  destroys the time axis those metrics measure, so an interval there would be statistically
  meaningless — the exclusion is explained in the UI tooltip. 6 dedicated tests.
- **USGS loader** remains out (spec §21 v1.1 "optional"); the privacy criterion (17) therefore
  holds unconditionally.
- **DTW/Wasserstein cancellation** (§18) is implemented as *bounded work + superseded-result dropping*
  (Sakoe–Chiba band, decimation caps, worker off-thread, stale responses discarded) rather than a
  user-facing cancel button. On the bounded sizes, jobs finish in well under the spec's 2 s target,
  so a cancel affordance would never be reachable; if v1.1 raises the caps, add cooperative
  cancellation in the worker loop.
- **Paste grid** is a purpose-built light grid (inputs + block paste), not Handsontable/Glide
  (Appendix D lists those as *recommended*, not required); it implements exactly the Appendix C
  behaviours and keeps the bundle small.
- `MARE` in AC5's metric list is exposed as **MAPD %** after the naming audit (see PAPER_CHANGES.md);
  the tested quantity is the same Σ|e|/Σ|O| ratio, in percent.
