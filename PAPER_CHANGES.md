# Recommended manuscript edits (companion paper ↔ tool consistency)

Consolidated from the plan-phase contradiction review (C1–C10) and the CP-audit of the metric
implementations against HydroErr 1.24/2.0, Hydrostats 0.78, hydroeval 0.1.0 and hydroGOF sources.
Each item states the location, the issue, and drop-in replacement wording.

## Software-description corrections

**C1 — §6.2 "reuses tested implementations".** A client-only TypeScript SPA cannot call the Python
libraries. Replace with: "All metrics are *independently implemented* in TypeScript from the
published equations and *verified against* HydroErr, Hydrostats, hydroeval and hydroGOF reference
outputs in an automated test suite (101 tests at v1.1.0)." This also strengthens the
superset/correctness claim the section is making.

**C2 — §6.1 novelty sentence on Wasserstein.** hydroGOF ≥ 0.7-0 exposes a Wasserstein option inside
JDKGE, so "no existing GOF package offers optimal-transport distances" is falsifiable. Reword to:
"…not offered as a *standalone, interactively explorable* diagnostic in existing suites (hydroGOF
≥ 0.7-0 embeds a Wasserstein term inside JDKGE but does not expose W as a metric or couple it to a
lag sweep)." Cite hydroGOF 0.7-0 (Zambrano-Bigiarini).

**C3 — duplicate figure number.** "Fig. 8" is referenced for both the DE polar diagram and the tool
screenshot in §6; renumber the second occurrence (and cascade).

**C6 — §6 "two panels".** The shipped tool is eight tabs (Data, Metrics, Plots, Timing, Sandbox,
Compare, Map, Report). Suggest: "organised into two conceptual halves — data/diagnostics and
timing-aware exploration — across eight tabs."

**C9 — citation year.** §6.1 cites "Zambrano-Bigiarini, 2024" while the introduction cites 2020;
unify (hydroGOF package citation year) and attribute HydroErr to Roberts et al. (2018).

**C10 — KGE″.** The tool implements KGE″ (bias term β″ = (μ_S−μ_O)/σ_O) per Tang et al. (2021),
which the spec mandates but the manuscript never defines or cites. Add the definition to §4/App-A
and Tang et al. (2021) to the references; add the row to the master table.

## Metric-definition corrections (from the source audit)

**A1 — MLE/MALE/MSLE/RMSLE (App-A).** State the log-error family as ε_i = ln(S_i/O_i) (equivalently
ln S − ln O). Note for reproducibility: HydroErr's *code* uses log1p (ln(1+x)), diverging from its
own paper; the tool follows the paper form, which is scale-invariant (unit-tested).

**A2 — MARE → MAPD.** The quantity used, 100·Σ|S−O|/Σ|O|, is the *mean absolute percentage
deviation*; "MARE" collides with HydroErr's `mare` (a fraction) and hydroeval's `mare` (÷100).
Rename to MAPD [%] in the table and text.

**A3 — VE range.** Volumetric Efficiency's range is (−∞, 1], not [0, 1] (Criss & Winston 2008 is
frequently misquoted); one large error can drive VE arbitrarily negative.

**A4 — PBIAS sign convention.** State explicitly: PBIAS = 100·Σ(O−S)/ΣO, **positive = model
under-estimation** (Yapo/Gupta convention). hydroGOF uses the opposite sign; the tool documents the
difference in its reference and tests both conventions' magnitudes.

**A5 — sMAPE.** Specify the (|O|+|S|)/2 denominator and the resulting 0–200 % range, since a /1
variant (0–100 %) also circulates.

**A6 — DE polarity.** The tool displays DE with optimum 0 (radius on the polar plot), matching
Schwemmle et al. (2021) Fig. 8-style diagnostics; if the text mentions DE′ = 1 − DE anywhere, mark
it explicitly to avoid mixed polarity.

**A7 — FMS/FMM log form.** Keep the log-space mid-segment slope definition but add the caveat that
it is undefined for zero flows without the ε-shift (the tool applies ε = 0.01·mean(O), stated in §6).

## Headline-metric decisions (already reflected in the tool)

**C4 —** peak-timing headline = mean |lag| over matched peaks (Gauch et al., 2021 matching), with
signed mean lag reported alongside as timing *bias*.
**C5 —** headline transport metric = W₁ (L¹ distance of mass-normalised cumulative curves,
Magyar & Sambridge 2023); the Sandbox additionally exposes W₂² to reproduce the manuscript's
double-penalty figure.
**Optional (§6.1) —** half-sentence acknowledging Hydrostats' static `time_lag` sweep as the closest
prior art to the interactive lag sweep, sharpening the interactivity claim.
