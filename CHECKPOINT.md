# CHECKPOINT — CP1–CP3 + full UI (v0.3.0) · 2026-07-13

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


---

# Update · v0.3.0 (same session)

## Added since CP1
- Classical engine complete (`src/metrics/classical/catalogue.ts`): 30 metrics verified vs
  executed HydroErr 2.0.0 across all 8 fixture series at ≤1e-9 rel; hydroeval pins for
  PBIAS/MARE/C2M family/KGEnp (tie-order tolerance 1e-5 documented in test); log-error family
  is log1p (HydroErr/sklearn convention); MARE is hydroeval's Σ|e|/Σo.
- Timing engine (`src/metrics/timing/`): events + per-event errors, Gauch peak-timing,
  lag sweep, W₁/W₂² (mass-normalised, inverse-CDF W₂²), Sakoe–Chiba DTW with backtrack,
  Diagnostic Efficiency mirroring diag-eff exactly (incl. artefact zeroing; `phi` full form +
  `phiFdc` fixture-pinned form — generator passed b_area as b_slope), core Series Distance,
  Morlet XWT with AR1 red-noise 95 % gating + COI (radix-2 FFT in-house). All pinned by
  analytic pure-shift identities (W₁=k, W₂²=k², DTW dist 0 & warp≈k, peak lag=k, sweep argmax k,
  XWT lag≈k — sign convention locked by test).
- Registry (`src/metrics/registry.ts`): metadata for ~45 metrics, presets, computeAll orchestrator
  (DTW decimation guard >6000 pts; XWT decimation >16384).
- UI: all six tabs live. Metrics (grouped table, best-per-row, C2M toggle, benchmark skill,
  provenance-stamped CSV/TSV export), Plots (8 plots incl. DTW alignment; lazy Plotly),
  Timing (config + sweep + XWT-by-scale + DE polar + events), Sandbox (perturbation model
  S′ = m + (B(t−Δt)−m)·γ·(1−δ) + β + ε, presets, contrast readout), Map (Leaflet, area),
  Data (upload CSV/TXT/XLSX, paste, column mapping, date-format, units, sentinel toggle),
  header save/load `.hme.json`, dataset switcher, unit conversion on the fly.
- 69 tests green. Bundle: entry ~404 kB min (+ lazy plotly 1.4 MB gz, lazy xlsx 143 kB gz).

## Known deferrals (state honestly)
- No Web Workers yet: heavy metrics run on the main thread with decimation guards; fine to
  ~10k steps, sluggish beyond.
- No DOCX/PDF report, no bootstrap CIs, no editable grid, no multi-run ranking view,
  no windows/season subsetting UI (engine supports arbitrary arrays).
- Series Distance is the documented core form (auto event matching), not full interactive
  segment supervision.
- Paper edits C1/C2/C3 still owed (exact sentences at CP8).


---

# Update · v0.3.1 — metric correctness audit (Jackson et al. 2019 / Roberts et al. 2018 as ground truth)

Findings & corrections (details in tests/classical.test.ts):
1. **MLE/MALE/MSLE/RMSLE corrected to the paper form ln(S/O)** (Törnquist 1985; Jackson Table 1).
   HydroErr's *code* computes log1p(S)−log1p(O), contradicting its own paper and losing unit
   invariance. Tests now pin these against independent NumPy references; a scale-invariance test
   documents why the paper form wins. (HydroErr is still the oracle for 27 other metrics.)
2. **MARE renamed to MAPD %** (paper Table 2 name) = 100·Σ|S−O|/Σ|O|; oracled against HydroErr
   `mapd` (×100) and hydroeval `mare` (÷100). Avoids the MARE/MAPE naming collision.
3. sqrt transform: negative flows now propagate NaN instead of silent clamping to 0.
4. benchmarkSeries NaN-safe (mean/climatology over finite values only); skill() guarded when the
   benchmark sits at the optimum.
5. KgeResult fields renamed {variability, bias} — kge2012 no longer stores γ in a field called
   'alpha'; kge2021's β″=(μs−μo)/σo semantics verified against hydroGOF's method="2021" docs
   (Tang et al., 2021).
6. Added missing registry rows + computeAll outputs: MLE, MALE, RMSLE, MdE, MdSE, MAPD.
7. Conventions documented as deliberate: PBIAS = 100·Σ(O−S)/ΣO, positive = under-estimation
   (paper/Moriasi; hydroGOF uses the opposite sign — pinned by test); VE range (−∞,1] with
   optimum 1 (the review paper's "0 ≤ VE < 1, smaller is better" is a misprint vs Criss &
   Winston 2008); sMAPE denominator (|O|+|S|)/2 preserving the stated 0–200 bound (HydroErr uses
   (S+O)/2 — identical for positive flows); %BiasFMM log form per the Yilmaz-family signature
   literature (scale-sensitive when median(O)≈1 in the chosen unit — documented).
8. Single source of truth: deleted classical/basics.ts; all callers use catalogue.ts.
9. UI: metric reference is now a grouped table with KaTeX-rendered equations, range, optimum,
   polarity, and blind-spot columns (per-row equation = exactly what the engine computes).
Tests: 86 passing (was 69).


---

# Update · v0.4.0 — visual release (studio-family consistency + paper-figure style)

- Layout bug fixed: sandbox sliders were a 3-column grid inside minmax(300px) cells → label/value
  overlap (user screenshot). Now stacked rows (label+value line, full-width slider) — collision-free
  at any width. Wide tables (metrics, timing summary, events) wrapped in horizontal-scroll guards.
- Design language aligned with the author's studio tools (inspected color_model_studio & cartolab):
  html[data-theme] light/dark with ☽/☀ header toggle (localStorage 'hme_theme', prefers-color-scheme
  fallback, flash-free bootstrap in index.html); Fraunces headings, Hanken Grotesk body, DM Mono
  numerals/badges; 12px radius cards + soft shadow; accent-soft pill badge; footer credit
  "Developed by Ali Reza Shahvaran" + github link; data-URI SVG favicon (hydrograph mark:
  blue solid + orange dashed in the rounded-card frame) + public/icon.svg; og meta.
- Paper-figure consistency: OBSERVED_COLOR #1f77b4 (solid, 2.2px); runs dashed, palette led by the
  figures' simulated orange #d95f02 then ColorBrewer Dark2; Plotly template now theme-aware with
  STIX Two Text serif type (figures' look); XWT panel reoriented to the paper's timing-error-by-scale
  layout (period on log-y, reversed; lag on x; dotted zero line); DE polar restyled per the
  diagnostic polar figure (markers coloured by timing r, Plasma-reversed yellow→purple, colorbar,
  0° at top); lag sweeps carry the dotted 'perfect alignment' zero line; dark-mode Leaflet via
  invert/hue-rotate filter.
- 86 tests unchanged and passing; no engine changes.


---

# CP8 · v1.0.0 — MVP complete (spec §21) 

New this checkpoint:
- **Subsetting engine** (`src/metrics/subset.ts`): contiguous window → wrap-aware seasonal DOY filter →
  daily/monthly resample with effective step; cached "frames" feed every tab, caption strings surface in
  Metrics/Compare/Report (AC3, AC9). Global AnalysisBar above all analysis tabs.
- **Web Worker** metric engine (`src/metrics/worker.ts` + async `compute.ts`): full panel off-thread,
  pending states in every tab, last-good retention in the Sandbox so sliders never blank (§18–19).
- **Compare tab** (`rank.ts` + `CompareTab.tsx`): priority metrics with weights, C2M-normalised scores,
  composite ranking, Recommended-run callout with timing nudge (AC13). Unit-tested (5 tests) — the tests
  caught and fixed a degenerate all-equal scoring bug.
- **Report** (`src/report/report.ts` + tab): client-side DOCX (docx-js; dual-DXA tables, CLEAR shading,
  typed ImageRun, per-line Paragraphs) with data summary, grouped metrics (timing rows shaded ⏱),
  three embedded figures (hydrograph / scatter / lag sweep, serif figure style), per-run event tables,
  ranking + recommendation, notes, provenance JSON appendix, citation; matching print-window PDF;
  filename `<dataset>_evaluation_<yyyymmdd>` (AC15, §16).
- **Per-plot PNG/SVG/CSV downloads** on every PlotHost (AC8); **editable paste grid** with
  ＋Add-predicted-column, header-rename→run-name, block paste (Appendix C, AC1) + template CSV;
  reference **search** (AC19); Duplicate dataset / New project / >25 MB save warning (§17).
- Tests 86 → **95** (subset ×4, rank ×5); tsc clean; worker chunk emitted by Vite build.
Deviations recorded in ACCEPTANCE.md (USGS + bootstrap CIs are spec-designated v1.1; long-job
cancellation implemented as bounded decimation + superseded-result drop rather than a cancel button).
