import { detectStep, type StepInfo } from '../units/stepDetect'

export interface SeriesSummary {
  name: string;
  missing: number;
  negatives: number;
  min: number; mean: number; max: number;
  /** Valid (obs, run) pairs; for the observed series this equals its valid count. */
  overlapWithObserved: number;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];    // blocking (§18): missing roles, unparseable dates, < 2 valid pairs
  warnings: string[];  // non-blocking (§18)
  rows: number;
  dateRange: [number, number] | null;
  duplicates: number;
  step: StepInfo | null;
  series: SeriesSummary[];
}

function summarise(name: string, v: ArrayLike<number>, obs?: ArrayLike<number>): SeriesSummary {
  let missing = 0, negatives = 0, min = Infinity, max = -Infinity, sum = 0, c = 0, overlap = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    if (!isFinite(x)) { missing++; continue; }
    if (x < 0) negatives++;
    if (x < min) min = x;
    if (x > max) max = x;
    sum += x; c++;
    if (!obs || isFinite(obs[i])) overlap++;
  }
  return {
    name, missing, negatives,
    min: c ? min : NaN, mean: c ? sum / c : NaN, max: c ? max : NaN,
    overlapWithObserved: overlap,
  };
}

/**
 * Validate an aligned dataset before it is committed ("Use this data", §6.0).
 * `dates` must already be parsed to UTC ms (NaN = unparseable row).
 */
export function validateDataset(
  dates: number[],
  observed: { name: string; values: ArrayLike<number> } | null,
  runs: { name: string; values: ArrayLike<number> }[],
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!observed) errors.push('No column is mapped as Observed; map one to continue.');
  if (runs.length === 0) errors.push('No column is mapped as Predicted; map at least one simulation.');

  const badDates = dates.filter(d => !isFinite(d)).length;
  if (badDates > 0) {
    errors.push(`${badDates} date value${badDates === 1 ? '' : 's'} could not be parsed; check the date format selector.`);
  }

  const good = dates.filter(isFinite).sort((a, b) => a - b);
  let duplicates = 0;
  for (let i = 1; i < good.length; i++) if (good[i] === good[i - 1]) duplicates++;
  if (duplicates > 0) warnings.push(`${duplicates} duplicate date${duplicates === 1 ? '' : 's'} found; duplicated rows are flagged, first occurrence is used.`);

  const step = good.length >= 2 ? detectStep(good) : null;
  if (step?.irregular) warnings.push('The time step is irregular; day-of-year plots and step-dependent defaults may be unreliable.');

  const series: SeriesSummary[] = [];
  if (observed) {
    const so = summarise(observed.name, observed.values);
    series.push(so);
    const missShare = so.missing / Math.max(1, dates.length);
    if (missShare > 0.5) warnings.push(`Observed is ${(missShare * 100).toFixed(0)}% missing; results may not be meaningful.`);
    if (so.negatives > 0) warnings.push(`Observed contains ${so.negatives} negative value${so.negatives === 1 ? '' : 's'}; allowed, but check the data if streamflow is expected.`);
  }

  for (const r of runs) {
    const sr = summarise(r.name, r.values, observed?.values);
    series.push(sr);
    if (sr.negatives > 0) warnings.push(`${r.name} contains ${sr.negatives} negative value${sr.negatives === 1 ? '' : 's'}.`);
    if (observed) {
      const share = sr.overlapWithObserved / Math.max(1, r.values.length);
      if (sr.overlapWithObserved < 2) {
        errors.push(`${r.name} has fewer than 2 valid overlapping pairs with Observed; metrics cannot be computed.`);
      } else if (sr.overlapWithObserved < 30 || share < 0.1) {
        warnings.push(`${r.name} overlaps Observed on only ${sr.overlapWithObserved} valid pairs (${(share * 100).toFixed(0)}% of the record); metrics will be computed but interpret with care.`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors, warnings,
    rows: dates.length,
    dateRange: good.length ? [good[0], good[good.length - 1]] : null,
    duplicates,
    step,
    series,
  };
}
