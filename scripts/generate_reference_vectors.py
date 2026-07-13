#!/usr/bin/env python3
"""
Generate reference test vectors for the Hydrograph Metrics Explorer (HME).

Runs the *inspected* sources of:
  - HydroErr 2.0.0   (MIT)   -- all 75 synchronous metrics
  - Hydrostats 1.0.0 (MIT)   -- wraps HydroErr (verified re-export)
  - hydroeval v0.1.0 (GPL-3) -- executed for numeric cross-check ONLY (no code reuse):
                                 nse/kge/kgeprime/kgenp/rmse/mare/pbias + C2M variants
  - diag-eff 1.1     (GPL-3) -- executed for numeric cross-check ONLY:
                                 Diagnostic Efficiency components (Schwemmle et al. 2021)

Outputs reference_vectors.json with full float64 precision (repr, 17 sig. digits).
These values are the ground truth for HME's TypeScript metric unit tests.
"""
import json, warnings, math, sys
import numpy as np

# Defensive shims for older libs on numpy>=2
for _alias, _t in (("float", float), ("int", int), ("bool", bool)):
    if not hasattr(np, _alias):
        setattr(np, _alias, _t)

import HydroErr as he
from HydroErr.HydroErr import function_list as HE_FUNCTIONS
import hydroeval as hev
import scipy.integrate as _si
if not hasattr(_si, "simps"):
    _si.simps = _si.simpson   # numeric-compat shim for diag-eff on scipy>=1.14
import de.de as dde

RNG = np.random.default_rng(42)

def f(x):
    """repr-precision float or None."""
    try:
        x = float(x)
        return None if (math.isnan(x) or math.isinf(x)) else float(repr(x) and x)
    except Exception:
        return None

def fr(x):
    try:
        xf = float(x)
        if math.isnan(xf): return "NaN"
        if math.isinf(xf): return "Infinity" if xf > 0 else "-Infinity"
        return repr(xf)
    except Exception:
        return None

# ----------------------------------------------------------------------------- series
def synth_obs(n=730, seed=7):
    rng = np.random.default_rng(seed)
    t = np.arange(n)
    base = 8.0 + 6.0 * np.sin(2 * np.pi * (t - 90) / 365.0) ** 2
    q = base.copy()
    for c, a, w in [(60, 55, 4.0), (95, 30, 6.0), (170, 18, 9.0), (300, 40, 5.0),
                    (425, 65, 4.5), (462, 28, 7.0), (540, 22, 10.0), (665, 48, 5.0)]:
        q += a * np.exp(-0.5 * ((t - c) / w) ** 2)
    q += rng.normal(0, 0.35, n)
    return np.maximum(q, 0.05)

def shift(x, k):
    """Positive k = late simulation. Pads by edge value; unmatched ends kept (paired metrics
    below always use full overlap of the two arrays after slicing)."""
    if k == 0: return x.copy()
    if k > 0:  return np.concatenate([np.full(k, x[0]), x[:-k]])
    k = -k;    return np.concatenate([x[k:], np.full(k, x[-1])])

OBS730 = synth_obs()
MEAN_O = float(OBS730.mean())

SERIES = {
    "tiny6": {
        "obs": [4.7, 6.0, 10.0, 2.5, 4.0, 7.0],
        "sim": [5.0, 7.0,  9.0, 2.0, 4.5, 6.7],
        "note": "Six-point hand-checkable pair.",
    },
    "nan8": {
        "obs": [4.7, 6.0, np.nan, 2.5, 4.0, 7.0, 5.5, np.nan],
        "sim": [5.0, np.nan, 9.0, 2.0, 4.5, 6.7, np.nan, 3.0],
        "note": "NaN pattern; HydroErr default (replace_nan=None) pairwise-drops rows -> "
                "defines HME 'pairwise-drop' semantics. Effective pairs: idx 0,3,4,5.",
    },
    "synth730_shift3":  {"obs": OBS730, "sim": shift(OBS730, 3),
                         "note": "Pure +3-step (late) shift of observed."},
    "synth730_offset":  {"obs": OBS730, "sim": OBS730 + 2.0,
                         "note": "Constant +2.0 offset."},
    "synth730_scale":   {"obs": OBS730, "sim": OBS730 * 1.25,
                         "note": "Multiplicative 1.25 scale."},
    "synth730_dampen":  {"obs": OBS730, "sim": MEAN_O + (OBS730 - MEAN_O) * (1 - 0.4),
                         "note": "Dampen delta=0.4 about mean(obs)."},
    "synth730_noise":   {"obs": OBS730,
                         "sim": OBS730 + RNG.normal(0, 0.15 * MEAN_O, OBS730.size),
                         "note": "Gaussian noise sd=0.15*mean(obs), rng seed 42 (default_rng)."},
    "synth730_combo":   {"obs": OBS730, "sim": shift(OBS730, 2) * 0.8,
                         "note": "+2 shift then 0.8 scale."},
    "event_tri": {
        "obs": (lambda: (lambda t: 1.0 + 9.0*np.maximum(0,1-np.abs(t-15)/6.0)
                                       + 6.0*np.maximum(0,1-np.abs(t-42)/5.0))(np.arange(60)))(),
        "sim": None,  # filled below: obs shifted +2
        "note": "Two triangular events on baseflow 1.0; sim = obs shifted +2 steps (late). "
                "For DTW / peak-timing / Wasserstein hand checks.",
    },
}
SERIES["event_tri"]["sim"] = shift(np.asarray(SERIES["event_tri"]["obs"]), 2)

# ------------------------------------------------------------------- HydroErr sweep
def hydroerr_all(sim, obs):
    out = {}
    for func in HE_FUNCTIONS:
        fn = func.__name__
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            try:
                out[fn] = fr(func(np.asarray(sim, float), np.asarray(obs, float)))
            except Exception as e:
                out[fn] = f"ERROR: {type(e).__name__}: {e}"
    # component forms
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        try:
            k, r, a, b = he.kge_2009(np.asarray(sim,float), np.asarray(obs,float), return_all=True)
            out["kge_2009_components"] = {"kge": fr(k), "r": fr(r), "alpha": fr(a), "beta": fr(b)}
            k, r, g, b = he.kge_2012(np.asarray(sim,float), np.asarray(obs,float), return_all=True)
            out["kge_2012_components"] = {"kge": fr(k), "r": fr(r), "gamma": fr(g), "beta": fr(b)}
        except Exception as e:
            out["kge_components_error"] = str(e)
    return out

# ------------------------------------------------------------------- hydroeval sweep
def hydroeval_all(sim, obs):
    out = {}
    s = np.asarray(sim, float); o = np.asarray(obs, float)
    m = ~(np.isnan(s) | np.isnan(o)); s, o = s[m], o[m]   # hydroeval has no NaN handling
    def ev(fun, **kw):
        v = hev.evaluator(fun, s, o, **kw)
        return v
    singles = ["nse", "rmse", "mare", "pbias", "nse_c2m", "kge_c2m",
               "kgeprime_c2m", "kgenp_c2m"]
    for name in singles:
        try:
            out[name] = fr(np.asarray(ev(getattr(hev, name))).ravel()[0])
        except Exception as e:
            out[name] = f"ERROR: {e}"
    for name, labels in [("kge",      ["kge", "r", "alpha", "beta"]),
                         ("kgeprime", ["kgeprime", "r", "gamma", "beta"]),
                         ("kgenp",    ["kgenp", "rs", "alpha_np", "beta"])]:
        try:
            arr = np.asarray(ev(getattr(hev, name))).ravel()
            out[name] = {lab: fr(v) for lab, v in zip(labels, arr)}
        except Exception as e:
            out[name] = f"ERROR: {e}"
    return out

# ------------------------------------------------------------------- diag-eff sweep
def diageff_all(sim, obs):
    s = np.asarray(sim, float); o = np.asarray(obs, float)
    m = ~(np.isnan(s) | np.isnan(o)); s, o = s[m], o[m]
    out = {}
    try:
        brel_mean = dde.calc_brel_mean(o, s)
        brel_res  = dde.calc_brel_res(o, s)
        b_area    = dde.calc_bias_area(brel_res)
        out["brel_mean(constant)"] = fr(brel_mean)
        out["bias_area(dynamic)"]  = fr(b_area)
        out["temp_cor(timing)"]    = fr(dde.calc_temp_cor(o, s))
        out["de"]                  = fr(dde.calc_de(o, s))
        out["phi"]                 = fr(dde.calc_phi(brel_mean, b_area))
    except Exception as e:
        out["error"] = f"{type(e).__name__}: {e}"
    return out

# ------------------------------------------------------------------- lag-sweep truth
def lag_table(obs, sim, lags=range(-5, 6)):
    """Ground truth for the lag sweep. Lag L advances the SIMULATED series by L steps
    (pairs sim[t+L] with obs[t]); a simulation that is k steps LATE scores best at L=+k.
    Evaluated on the overlapping core only (no padded values enter)."""
    rows = []
    o = np.asarray(obs, float); s = np.asarray(sim, float); n = o.size
    for L in lags:
        if L > 0:   ss, oo = s[L:], o[:n - L]
        elif L < 0: ss, oo = s[:n + L], o[-L:]
        else:       ss, oo = s, o
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            rows.append({"lag": L,
                         "nse":  fr(he.nse(ss, oo)),
                         "kge_2009": fr(he.kge_2009(ss, oo)),
                         "rmse": fr(he.rmse(ss, oo)),
                         "pearson_r": fr(he.pearson_r(ss, oo))})
    return rows

# ------------------------------------------------------------------- convention pins
def convention_pins():
    o = np.array([10.0, 10.0, 10.0]); s = np.array([12.0, 12.0, 12.0])  # over-simulation
    pins = {}
    pins["hydroeval_pbias_oversim20pct"] = fr(np.asarray(hev.evaluator(hev.pbias, s, o)).ravel()[0])
    pins["paper_pbias_oversim20pct = 100*sum(O-S)/sum(O)"] = fr(100.0 * (o - s).sum() / o.sum())
    pins["note"] = ("Paper/Table-2 convention: PBIAS = 100*sum(Qobs-Qsim)/sum(Qobs); "
                    "positive = UNDERestimation. Record hydroeval/hydroGOF sign for mapping.")
    return pins

# ------------------------------------------------------------------- main
def main():
    results = {}
    for name, d in SERIES.items():
        obs = np.asarray(d["obs"], float); sim = np.asarray(d["sim"], float)
        results[name] = {
            "note": d["note"],
            "n": int(obs.size),
            "HydroErr_2.0.0": hydroerr_all(sim, obs),
            "hydroeval_0.1.0": hydroeval_all(sim, obs),
            "diag_eff_1.1": diageff_all(sim, obs),
        }
    doc = {
        "meta": {
            "generated_by": "gen_reference_vectors.py",
            "purpose": "Ground-truth values for HME classical-metric unit tests and "
                       "C2M/KGEnp/DE cross-checks.",
            "libraries": {
                "HydroErr": {"version": "2.0.0 (master, inspected source)", "license": "MIT"},
                "Hydrostats": {"version": "1.0.0 (master; metrics are a re-export of HydroErr)",
                               "license": "MIT"},
                "hydroeval": {"version": "0.1.0 (tag)", "license": "GPL-3",
                              "use": "numeric cross-check only; no code reuse"},
                "diag-eff": {"version": "1.1 (PyPI)", "license": "GPL-3",
                             "use": "numeric cross-check only; no code reuse"},
            },
            "nan_semantics": "HydroErr default replace_nan=None pairwise-drops NaN rows "
                             "(verified in util.treat_values) == HME 'pairwise-drop'.",
            "shift_convention": "positive shift = simulation LATE by k steps",
            "float_format": "repr() of float64 (round-trip exact)",
        },
        "series": {k: {"note": v["note"],
                       "obs": [fr(x) for x in np.asarray(v["obs"], float)],
                       "sim": [fr(x) for x in np.asarray(v["sim"], float)]}
                   for k, v in SERIES.items()},
        "results": results,
        "lag_sweep_truth_synth730_shift3": lag_table(OBS730, shift(OBS730, 3)),
        "convention_pins": convention_pins(),
    }
    with open("/home/claude/out/reference_vectors.json", "w") as fh:
        json.dump(doc, fh, indent=1)
    print("wrote reference_vectors.json")
    # quick sanity echoes
    r = results["tiny6"]["HydroErr_2.0.0"]
    print("tiny6  nse =", r["nse"], "| kge_2009 =", r["kge_2009"], "| rmse =", r["rmse"])
    r = results["synth730_shift3"]["HydroErr_2.0.0"]
    print("shift3 nse =", r["nse"], "| kge_2009 =", r["kge_2009"])
    r = results["synth730_offset"]["HydroErr_2.0.0"]
    print("offset pearson_r =", r["pearson_r"], "(should be ~1.0)")
    d = results["synth730_shift3"]["diag_eff_1.1"]
    print("shift3 DE =", d.get("de"), "| temp_cor =", d.get("temp_cor(timing)"))
    print("lag L=+3 NSE (should be near-perfect):",
          [row for row in doc["lag_sweep_truth_synth730_shift3"] if row["lag"] == 3][0]["nse"])

if __name__ == "__main__":
    sys.exit(main())
