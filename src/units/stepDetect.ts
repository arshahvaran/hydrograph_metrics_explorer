const HOUR = 3600_000;
const DAY = 24 * HOUR;

export interface StepInfo {
  ms: number;            // modal step (representative; 30·DAY for monthly)
  label: string;         // e.g. '1h', '6h', '1d', '1mo'
  irregular: boolean;    // true if a meaningful share of diffs disagree with the mode
  monthly: boolean;
}

/**
 * Detect the sampling step as the mode of consecutive differences (§6.0).
 * Calendar-monthly data (diffs of 28–31 days) is recognised as '1mo'.
 * Gaps are tolerated: they simply don't win the mode.
 */
export function detectStep(datesMs: number[]): StepInfo {
  if (datesMs.length < 2) return { ms: DAY, label: '1d', irregular: false, monthly: false };

  const diffs: number[] = [];
  for (let i = 1; i < datesMs.length; i++) diffs.push(datesMs[i] - datesMs[i - 1]);

  // Monthly check first: nearly all diffs fall in [28, 31] days.
  const monthlyLike = diffs.filter(d => d >= 28 * DAY && d <= 31 * DAY).length;
  if (monthlyLike / diffs.length > 0.9) {
    return { ms: 30 * DAY, label: '1mo', irregular: false, monthly: true };
  }

  const counts = new Map<number, number>();
  for (const d of diffs) counts.set(d, (counts.get(d) ?? 0) + 1);
  let mode = diffs[0], best = 0;
  for (const [d, c] of counts) if (c > best || (c === best && d < mode)) { mode = d; best = c; }

  const offMode = diffs.filter(d => d !== mode).length;
  // Gaps that are exact multiples of the mode are missing rows, not irregularity.
  const trueIrregular = diffs.filter(d => d !== mode && d % mode !== 0).length;

  let label: string;
  if (mode % DAY === 0) label = `${mode / DAY}d`;
  else if (mode % HOUR === 0) label = `${mode / HOUR}h`;
  else if (mode % 60_000 === 0) label = `${mode / 60_000}min`;
  else label = `${mode}ms`;

  return {
    ms: mode,
    label,
    irregular: trueIrregular / diffs.length > 0.05 || offMode / diffs.length > 0.5,
    monthly: false,
  };
}
