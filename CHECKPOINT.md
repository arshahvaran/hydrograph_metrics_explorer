# CHECKPOINT: CP1–CP3 + full UI (v0.3.0) · 2026-07-13

State manifest so any future working session can resume by cloning this repository.
Requirement IDs refer to the project requirements checklist (kept with the project
plan; ask the author for the HME plan documents if not present).

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
- Tests: 32 passing; oracle comparisons ≤1e-10 rel vs HydroErr/hydroeval, exact lag-sweep
  truth reproduction (argmax = +3, NSE = 1), NaN pair pinning, unit identities

## Deliberate CP1 simplifications (to revisit)
- `parseSampleCsv` assumes column order date|obs|runs…; replaced by full mapping UI at CP4
- Metrics table on Data tab is a temporary seed display; real Metrics tab at CP4
- No workers yet (nothing heavy computed); no window/season subsetting wired to UI

## Next: CP2: full classical engine
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
  `phiFdc` fixture-pinned form; generator passed b_area as b_slope), core Series Distance,
  Morlet XWT with AR1 red-noise 95 % gating + COI (radix-2 FFT in-house). All pinned by
  analytic pure-shift identities (W₁=k, W₂²=k², DTW dist 0 & warp≈k, peak lag=k, sweep argmax k,
  XWT lag≈k; sign convention locked by test).
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

# Update · v0.3.1: metric correctness audit (Jackson et al. 2019 / Roberts et al. 2018 as ground truth)

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
5. KgeResult fields renamed {variability, bias}; kge2012 no longer stores γ in a field called
   'alpha'; kge2021's β″=(μs−μo)/σo semantics verified against hydroGOF's method="2021" docs
   (Tang et al., 2021).
6. Added missing registry rows + computeAll outputs: MLE, MALE, RMSLE, MdE, MdSE, MAPD.
7. Conventions documented as deliberate: PBIAS = 100·Σ(O−S)/ΣO, positive = under-estimation
   (paper/Moriasi; hydroGOF uses the opposite sign; pinned by test); VE range (−∞,1] with
   optimum 1 (the review paper's "0 ≤ VE < 1, smaller is better" is a misprint vs Criss &
   Winston 2008); sMAPE denominator (|O|+|S|)/2 preserving the stated 0–200 bound (HydroErr uses
   (S+O)/2; identical for positive flows); %BiasFMM log form per the Yilmaz-family signature
   literature (scale-sensitive when median(O)≈1 in the chosen unit; documented).
8. Single source of truth: deleted classical/basics.ts; all callers use catalogue.ts.
9. UI: metric reference is now a grouped table with KaTeX-rendered equations, range, optimum,
   polarity, and blind-spot columns (per-row equation = exactly what the engine computes).
Tests: 86 passing (was 69).


---

# Update · v0.4.0: visual release (studio-family consistency + paper-figure style)

- Layout bug fixed: sandbox sliders were a 3-column grid inside minmax(300px) cells → label/value
  overlap (user screenshot). Now stacked rows (label+value line, full-width slider); collision-free
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

# CP8 · v1.0.0: MVP complete (spec §21) 

New this checkpoint:
- **Subsetting engine** (`src/metrics/subset.ts`): contiguous window → wrap-aware seasonal DOY filter →
  daily/monthly resample with effective step; cached "frames" feed every tab, caption strings surface in
  Metrics/Compare/Report (AC3, AC9). Global AnalysisBar above all analysis tabs.
- **Web Worker** metric engine (`src/metrics/worker.ts` + async `compute.ts`): full panel off-thread,
  pending states in every tab, last-good retention in the Sandbox so sliders never blank (§18–19).
- **Compare tab** (`rank.ts` + `CompareTab.tsx`): priority metrics with weights, C2M-normalised scores,
  composite ranking, Recommended-run callout with timing nudge (AC13). Unit-tested (5 tests); the tests
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


---

# CP8 ✅ (final) · v1.1.0: the checkpoint's own six items, all delivered

Per the project checkpoint plan ("Web Workers for very long records, bootstrap CIs, editing grid,
report generator, acceptance & accessibility audit, release"):
1. **Web Workers**; full metric panel + bootstrap on dedicated lanes ('panel' / 'boot') so 500-replicate
   jobs never queue behind live interaction; pending states everywhere; DTW decimation guards ≥50k rows.
2. **Bootstrap CIs**; `src/metrics/bootstrap.ts`: circular moving-block bootstrap on the paired index,
   L = max(3, n^⅓), B = 500, seeded, per-replicate transform re-application, percentile 95% CIs;
   `classicalValues()` extracted from `computeAll` (no behaviour change, suite-verified) as the replicate
   unit; worker progress → "bootstrapping… N%"; CI sub-lines in every classical cell + CSV lo/hi columns;
   timing rows honestly excluded with in-UI rationale. Tests +6 (reproducibility, bracketing, width-vs-n,
   classical-only coverage, block-length rate, progress) → **101 total**.
3. **Editing grid**; shipped earlier in CP8 (EditableGrid, Appendix C).
4. **Report generator**; shipped earlier in CP8 (DOCX + matching PDF).
5. **Acceptance & accessibility audit**; ACCEPTANCE.md updated (CI deviation resolved);
   **ACCESSIBILITY.md** added with measured WCAG contrast (10 pairs, all ≥4.5:1, worst 4.63:1),
   plus fixes landed this checkpoint: skip-to-content link, ARIA tabs pattern with roving tabindex +
   Arrow/Home/End activation, file inputs made keyboard-reachable (hidden → .vh), aria-labels on all
   icon-only controls and key tables, polite live regions for async status. Partials stated
   (canvas plots ↔ CSV-equivalent alternative; light grid has no arrow-key nav).
6. **Release**; v1.1.0 tagged + deployed.


## v1.1.1: pre-release QA campaign (adversarial, charter-based)
Full REPRODUCE→ROOT-CAUSE→FIX→REGRESSION-TEST loop on every defect. 13 defects
logged (7×S1, 4×S2, 2×S3), all fixed; 1 suspicion refuted by test (QA-006).
Highlights: rules-of-hooks crashes on Timing/Sandbox first visit under real
workers (QA-001/002); the v1.1 CI toggle was never rendered (QA-004); European
decimal commas parsed ×10 wrong (QA-005); 15 metrics leaked ±Infinity on
degenerate denominators (QA-010); hardcoded peak minDistance=100 suppressed
real daily peaks (QA-011); window-clamped peak lags reported as truth
(QA-011b); numerically-constant series produced plausible wrong r/KGE
(QA-012, incl. a sqrt(dx·dy) underflow instability); Math.min(...arr) stack
overflow ≥130k rows (QA-013); CSV formula injection (QA-008); unvalidated
project files (QA-007); XLSX sheet-0 only (QA-009); DOCX >6-run overflow;
reversed windows. Suite grew 101 → 300 tests incl. DOM (jsdom+RTL), fast-check
fuzz, axe-core a11y, perf numbers, worker-race, privacy manifest, and a
rules-of-hooks lint gate.

## v1.2.0: interface revision from manual inspection
Header rebuilt: animated 1:1 logo (same art as the favicon; simulated curve
shifts in a loop, reduced-motion aware), new tagline, no em dashes anywhere in
the UI, "Active dataset:" label, Duplicate/Save swapped, badge removed. Tabs
reordered (Data, Plots, Metrics, …) with monochrome inline icons and distinct
boundaries in both themes. Footer: neutral privacy wording, "Source, License,
& Citation", version without prefix, credit "Shahvaran et al., 2026" far right.
Data tab: Sample 1/2, professional date-format labels, "Discharge unit"
limited to 5 common units, sentinel checkbox replaced by a user-declared
"Missing value" box (engine now takes missingValue: number|null), role
dropdowns read Date/Observed/Simulated/Ignore and uploads start unmapped,
capitalised summary headers, sheet terminology, full-width sheet cells,
Simulated N columns, template header simulated_1, paste placeholder equals the
template. Subsetting restructured: window/season/resample moved into the Plots
tab only, with "Use this data →" materialising the selection as a new dataset
(commitSubsetDataset); all analysis tabs now always see full records. Suite
300 → 306.

## v1.2.1: plots polish round
Solid simulated lines everywhere (logo/favicon, hydrographs, DTW overlay,
sandbox, report figures). Logo enlarged to 55 px. Data commit jumps to Plots;
"simulations" wording; live-editable column names in the mapping header that
flow into the staged summary and every plot label. Plots tab: "Plot type:" and
"Download plot:" labels, JPG export on a forced-white light template, 1:1
aspect (width only) for scatter/FDC/Q-Q, axis lines + outside ticks + tick
standoff unified through the Plotly template across Plots/Timing/Sandbox and
the report renderer, real unit labels (m³/s not m3s) in every axis/caption,
capitalised and corrected plot captions, Log(y) checkbox label, heatmap
colorbar sized to the plot. Header right no longer wraps internally.

## v1.3.0: Metrics governance + plots round 3
Presets reduced to two: Essentials (exactly the paper's Table 2, both blocks,
25 metrics) and Extended (beta) = full catalogue; default Essentials. Audit of
all 37 Extended-only metrics: 35 already pinned against reference libraries or
hand-worked sources; wr2 (Krause 2005) and logNSE (Pushpalatha 2012 epsilon)
received new authority pins; zero removals. C2M display checkbox and TSV
export removed; "Valid pairs per run (n)"; complements wording + underline
note; Optimum header; "Calculate 95% CIs"; best-cell styling underline-only in
the run's own colour weight. Plots: Time axis titles on time series & DTW
(rangeslider intact), bottom frame line removed on six plots (y=0 zeroline
carries the axis), left frame removed on scatter/Q-Q (x=0 zeroline), Q-Q label,
Rainbow heatmap with pixel-exact colorbar, 300-dpi raster exports, dataset-
prefixed professional filenames everywhere, hard-locked 1:1 for scatter/FDC/
Q-Q (fixed layout dims). Logo stretches to exactly the title-to-tagline block
height (1:1 kept). Switching the active dataset now stays on the current tab
(and plot type persists). Custom window label; wider DOY inputs.

## v1.3.1: Table 2 cross-check + round-4 polish
Essentials verified line-by-line against the attached Table 2: added the
missing per-event PEAK-HEIGHT metric (event_peak, mean signed %, from the
existing per-event peakMagErrPct), corrected the PBIAS range metadata to
(−∞, 100] %; all other ranges/optima/semantics already agreed. Preset names
lowercased (essentials / extended (beta)). Fixed the square-plot leak: Plotly
.react retains layout keys that stop being passed, so a visited square plot
locked width for later plot types; non-square layouts now explicitly unset
width with autosize on. Logo frame tile removed (transparent curves only);
heatmap colorbar 376 px; footer shows major.minor (v1.3).

## v1.3.2: round 5: theme default, timing & sandbox overhaul
Light theme on first open (stored choice still respected). Logo tile frame
restored (the doubled CSS frame stays gone). Colorbar 370 px. Timing summary
now shows exactly the 13 essentials timing metrics; extra rows dropped;
Optimum header. DE polar: observed dot at the centre, Magma scale with yellow
at r = 0; description rewritten (no paper mention, no em dash); XWT
description likewise; "in-cone" replaced by "edge effects excluded". Default
toggle on the timing configuration (fieldset-disabled controls; switching on
resets to the dataset's defaults). Events table gains Export CSV
(dataset_events_run.csv). Naming audit: metrics CSV → Dataset_metrics.csv,
project → hme_project_YYYYMMDD.hme.json, DE polar figure named; all exports
now Dataset-first at 300 dpi. Sandbox: bold "Hydrograph of the perturbed
series" title with subtitle, Time x-axis, new header copy, "perturb a model
simulation", Simulation label, four preset buttons removed (Reset kept),
"Metrics comparison" card with Perturbed/Original series headers, unbolded
values.

## v1.3.3: round 6: logo frame, timing switch, readable DE polar, sandbox wording
Logo tile frame thinned (rect stroke-width 3 to 2) in public/logo.svg; the
unreferenced public/icon.svg brought back in line with the same art (thin frame,
simulated curve made SOLID per the house rule; it still had the pre-v1.2.1
dash). New tests/branding.test.ts pins frame width, solidity, and art parity.
Timing tab: the "Default settings (switch off to customise)" checkbox is now
dressed as a toggle switch (CSS track + knob on the same native checkbox, so
label association, keyboard use, and the fieldset enable/disable semantics are
unchanged; focus-visible ring on the track; reduced-motion covered by the
global rule). DE polar readability fix: with the reference-style fixed [0, 1]
colour axis, Sample 2's runs (timing r = 0.974 vs 1.000) both rendered
near-black and looked identical; the colour axis lower bound now floats one
0.05 step below the worst finite r in view via exported deColorFloor()
(clamped to [-1, 0.9], span never under 0.1, no marker at the extreme yellow),
cmax stays 1, and the caption explains the adaptive range. Metric VALUES are
untouched and still reference-pinned. Sandbox: target picker label "Simulation
to perturb"; both Metrics-comparison "Original series" header cells lost the
muted class so all six headers are uniform bold (original VALUE cells stay
muted). Suite 309 to 319 (branding x3, round6 DOM x7: deColorFloor pins,
polar trace floor + distinguishability, switch semantics, sandbox label,
header boldness).

## v1.4.0: round 7, Compare overhaul, Simulation wording, map placeholders, report fix, style scrub
Compare tab. Priority panel split in two: a checklist of candidates on the
left and a Metric/Weight table on the right; ticking a metric adds a row with
weight 1, the weight is edited in place, and a remove button clears the row.
Subtitle now reads "select the metrics that matter for your application, then
enter the relative weights". Candidates reduced to the essentials-only subset
of the previous list (nse, kge2009, r2, ve, rmse, pbias, peak_lag_abs, w1,
dtw_warp, de, xwt_lag); kge2012, dr, lognse, event_threat and lag_best
dropped. DEFAULT_PRIORITIES and the defaultView seed both read nse, kge2009,
w1, peak_lag_abs (they previously disagreed; the seed had only kge2009 and
nse, so the declared default was dead code). Composite direction audit: for
every candidate, a value nearer the stated optimum must outrank one further
away, whatever the polarity (higher-better, lower-better, zero-target); 13 new
pins in tests/rank.test.ts confirm the existing math was already correct, no
engine change. Score explanation rewritten for lay readers (1 = closest to the
ideal among the simulations compared, 0 = furthest, composite = weighted
average, higher always better). Ranking table: "Simulation" column, per-cell
sub-header "value . score (weight w)", and no bold anywhere outside header
rows (run-name weight and the strong wrapper removed). Recommendation sentence
now reads "at a more proper time, not just a more proper average".
Global wording: every user-visible "run" is now "simulation" (Timing summary,
Event report picker, Sandbox target, Metrics captions and table names, Report
warning, ingest validation, project-load errors, DOCX and PDF ranking
sections); sample column names such as run_shifted are data, not chrome, and
stay. Tests that pinned the old accessible names were updated to the new ones.
Header: Load now precedes New. Map tab: two inactive placeholder buttons with
beta badges for gauge-station and catchment uploads (SHP or KML/KMZ); the
caption paragraph under the map removed (the on-map Leaflet attribution
remains, which keeps the OpenStreetMap licence satisfied).
Report bug fixed: "Report generation failed: Invalid time value". Both
renderers read fields that never existed on EventError (e.start, e.obsPeak,
e.simPeak, e.volBiasPct) behind an any cast, so the date lookup indexed with
undefined and Date.toISOString threw the moment a single event existed. Both
paths now share typed eventTableRows() reading the real shape (obs.start,
obs.peakQ, peakMagErrPct, volumeErrPct) with an n/a guard for non-finite
stamps; pinned by tests/report-events.test.ts including an end-to-end DOCX
build with events present.
Repository style scrub: QA suite headers reworded, plan-document references
neutralised, and every em dash in tracked md/ts/tsx/html/css files replaced
with commas, semicolons, colons, or parentheses as context requires. Suite
319 to 342 (rank direction audit x13, report-events x4, round7 DOM x6).

## v1.4.1: final QA campaign (adversarial pass across the whole tool)
Systematic cross-feature hunt with the reviewer in mind; five defects found
and fixed, each with regression tests that fail on the pre-fix code.
1. CRITICAL, stale frame cache after unit conversion. convertUnits rewrites
   value arrays in place under the same dataset id, but frames were cached on
   id + length only, so every tab kept comparing old-unit observed values
   against new-unit simulations (NSE about -6.5 million on a healthy fit,
   shown as a real result until reload). Both frame caches now key on
   targetUnit; tests/units-frame.test.ts crosses the features (scale-free
   metrics invariant, unitful metrics scale exactly, subset frame included)
   and a DOM journey asserts the Metrics tab digits.
2. Absolute event thresholds now convert with the units: a threshold of
   8 m3/s silently meant "8 L/s" after conversion, redefining every event.
   The store scales the value exactly when the conversion factor is uniform
   across the record (all flow-to-flow conversions); non-uniform monthly
   depth factors have no single correct answer and are left for the user.
   Round-trip pinned.
3. Compare tab NaN states: zeroing every weight (reachable through the new
   weights table) produced a literal "composite NaN" recommendation chosen
   alphabetically; both report renderers had the same unguarded toFixed plus
   a leftover "Recommended run" wording. The tab now explains and recovers,
   both reports print a fallback sentence, wording unified; junk weight
   keystrokes coerce to 0 instead of storing NaN, and hostile project files
   can no longer smuggle NaN, negative, or duplicate priority weights in
   (loader hardened).
4. Sandbox slider ranges went stale after a unit conversion (memo keyed on
   ids while conversion replaces arrays); now keyed on the series identity,
   with a DOM test asserting the offset range rescales by the factor.
5. Report figures are now isolated per figure: one misbehaving canvas skips
   that figure instead of aborting the whole report.
Also verified this pass: the em-dash scrub touched no string literals or
KaTeX equations in src; print-report escaping covers names and notes; the
popup-blocked path alerts cleanly; fmtNum renders every non-finite value as
n/a; conversion errors surface in the Data tab; README and ACCEPTANCE
feature wording aligned with Simulation. Suite 342 to 352 (units-frame x5,
stress-final DOM x5, plus the round-7 additions revalidated).

## v1.5: report content round + repository presentation
Report (both DOCX and print-PDF renderers). Fig. R2 now renders on a square
460x460 canvas and embeds square (DOCX 320x320; print HTML at 58% width,
centred), so the 1:1 scatter is truly 1:1 instead of stretched wide. The
Provenance section (settings JSON dump) removed from both formats. The
generated-by meta line no longer carries the privacy sentence. The long
citation paragraph replaced by "Developed by Shahvaran et al., 2026" plus a
real hyperlink "Source, License, & Citation" to the repository (docx
ExternalHyperlink; anchor tag in print HTML). Exported REPORT_CREDIT /
REPORT_CREDIT_LINK_TEXT / REPO_URL consts keep the strings pinned;
tests/dom/report-round9.test.tsx covers the square figure in both formats and
the print HTML content (credit present, provenance and privacy sentence
absent, no three-digit version anywhere).
Versioning switched to a two-digit user-visible scheme: APP_VERSION is now
"1.5" (footer, CSV headers, report metas all print v1.5). package.json keeps
semver "1.5.0" because npm requires three parts; the git tag is v1.5.
Repository presentation for review. README rewritten in the structure common
to journal-published web tools (badges, contents, grouped feature sections,
getting started, input-data format, correctness and testing, documentation
pointers, citation, license); the checkpoint status table removed from the
README (this file remains the internal change log). License switched from MIT
to Creative Commons BY-NC 4.0 using the same note template and LICENSE text
as the author's cartolab repository; package.json and CITATION.cff aligned
(version "1.5", release date updated). "How to cite" carries the placeholder
"Reference paper will be added here once published" plus the software
citation. Suite 352 to 354 (report-round9 x2).

## v1.6: DE polar restyle to the paper's figure + sandbox label
Timing tab, Diagnostic-efficiency polar: the Observed label moved above its
dot (it collided with the radial tick labels); radial grid now every 0.2
instead of 0.1; the colour scale is plasma matching the manuscript figure,
written as explicit reversed stops (yellow #f0f921 at the low end for timing
mismatch, dark blue-purple #0d0887 at r = 1 for timing match) so there is no
renderer ambiguity around reversescale (the live magma-reversed variant was
in fact rendering light-at-1, opposite to the caption); the colourbar is
thickness 14, len 0.88, vertically centred (yanchor middle at y 0.5), sized
to sit flush with the circle given the 330px plot and its margins; caption
wording updated from magma to plasma. Sandbox: "Noise kind / seed" is now
"Noise type / seed" (visible label and the select's accessible name).
Version 1.6 across footer, reports, README badge, and CITATION.cff
(package.json 1.6.0 for npm semver). Suite 354 to 356 (round10 x2).

## v1.7: DE polar colourbar sized in pixels to the circle
The colourbar length moved from a plot-area fraction (0.88, which rendered
visibly shorter than the circle in the author's screenshot) to explicit pixel
sizing: lenmode pixels, len 226, computed as the 258px plot area (330 height
minus 36+36 margins) minus about 16px per side for the angular tick labels,
still vertically centred with yanchor middle at y 0.5. Pixel mode removes the
ambiguity in what Plotly's length fraction references on polar subplots.
Round10 pin updated. Suite stays at 356.

## README round (no app change, no version bump)
License section: shield line removed (the top badge and the CC image with
link remain; the shield link definition stays because the header badge uses
it). How to cite: reduced to the placeholder sentence only. Documentation
section removed and ACCEPTANCE.md, ACCESSIBILITY.md, PAPER_CHANGES.md deleted
from the repository (nothing in code or tests read them; one stale comment in
tests/dom/a11y.test.tsx reworded). "Correctness and testing" retitled to
"Technical validation"; contents list updated to match. App untouched, so no
APP_VERSION bump, no gh-pages deploy, and no tag for this round.
