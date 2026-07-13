# CHECKPOINT — CP1 (data core) · 2026-07-12

State manifest so any future working session can resume by cloning this repository.
Requirement IDs refer to `AGENT1_requirements_checklist.md` (kept with the project plan;
ask the author for `HME_PLAN.md` / `AGENT1` / `AGENT2` documents if not present).

## Done at CP1
- Repo, Vite + React 18 + TS + Zustand scaffold, MIT, CITATION.cff (A1, A2 partial, A10, A12)
- Data model & defaults per spec §4, incl. TimingConfig with peakProminence + step-aware
  peak window (B1, B4 with C4 extension)
- Date parsing: ISO / YMD / MDY / DMY inference with ambiguity flag / Julian ordinal (C3)
- Step detection: mode-of-diffs, hourly/daily/monthly labels, gap-tolerant irregularity (C4)
- Missing tokens + sentinels; NaN policies pairwise/zero/mean pinned to HydroErr semantics (C5, E4)
- Unit engine: all App-B volumetric factors, area conversions, depth↔volume with per-month Δt,
  compatibility guard (D1–D3 core)
- Validation summary + blocking errors + warnings incl. overlap guard (C6, C7, J2, J3 core)
- Seed metrics: NSE, KGE-2009(+components), RMSE, PBIAS (paper sign), Pearson r, C2M (F1 seed)
- Bundled samples: HYMOD-vs-observed (from Raven Hydrographs.csv) + deterministic synthetic
  with `run_shifted` (+3 d) and `run_biased` (+1.5) (C11 partial)
- App shell: 6 tabs, Data tab live (sample load → validation → seed metric table → preview),
  privacy footer, colourblind-safe palette, reduced-motion CSS (G shell, A8 start, A12)
- Tests: 32 passing — oracle comparisons ≤1e-10 rel vs HydroErr/hydroeval, exact lag-sweep
  truth reproduction (argmax = +3, NSE = 1), NaN pair pinning, unit identities

## Deliberate CP1 simplifications (to revisit)
- `parseSampleCsv` assumes column order date|obs|runs… — replaced by full mapping UI at CP4
- Metrics table on Data tab is a temporary seed display — real Metrics tab at CP4
- No workers yet (nothing heavy computed); no window/season subsetting wired to UI

## Next: CP2 — full classical engine
1. `src/metrics/classical/`: errors (MSE/MAE/MdAE/RSR/NRMSE/MAPE/sMAPE/MAAPE/MSLE/MARE),
   correlation & agreement (R², wR², d, d1, dr), efficiencies (logNSE, KGE′-2012, KGE″-2021
   [Tang], KGEnp, VE, β-NSE, α), FDC signatures (FHV top 2 %, FLV bottom 30 % log, FMS 20–70 %,
   FMM), transforms (log/sqrt/inverse, ε = 0.01·mean(O)), benchmarks + skill (§11.8)
2. Metric registry with metadata per F3 (id/label/group/formula/range/optimum/direction/…)
3. Extend `tests/metricsSeed.test.ts` → `tests/classical.test.ts` covering *all* fixture keys
   in `HydroErr_2.0.0` + hydroeval C2M/KGEnp; add hydroGOF documented-example cross-checks
4. Keep vectorised-across-runs façade (`src/metrics/index.ts`)

## Open questions for the author (defaults in use, flagged in HME_PLAN.md)
- C5 headline Wasserstein (W₁ in time units proposed) · C4 |lag| headline (in use)
- C1/C2/C3 are **paper edits**, exact sentences due at CP8

## Environment notes
- Node 22, npm 10; `npm install && npm test && npm run build`
- Pages serves `gh-pages` branch = `dist/` (base path `/hydrograph_metrics_explorer/`)
- Oracle regeneration: Python venv with numpy/scipy + inspected library sources
  (see header of `scripts/generate_reference_vectors.py`)
