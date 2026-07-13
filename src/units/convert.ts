import { UNITS, AREA_TO_KM2, unitsCompatible } from './registry'
import type { UnitId, AreaUnitId } from '../types'

export interface ConvertContext {
  from: UnitId;
  to: UnitId;
  /** Catchment area, required for any conversion involving a depth unit. */
  area?: { value: number; unit: AreaUnitId } | null;
  /** Series step in ms (used when a depth unit is per-interval). */
  stepMs?: number;
  /** True when the series step is calendar-monthly (Δt varies by month). */
  monthly?: boolean;
  /** UTC epoch-ms dates; required for monthly depth conversion. */
  dates?: number[];
}

export function areaToKm2(value: number, unit: AreaUnitId): number {
  return value * AREA_TO_KM2[unit];
}

function daysInMonthUTC(ms: number): number {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

/** Seconds spanned by one interval at element i. */
function intervalSeconds(ctx: ConvertContext, i: number, interval: 'step' | 'day'): number {
  if (interval === 'day') return 86400;
  if (ctx.monthly) {
    if (!ctx.dates) throw new Error('Monthly depth conversion requires the date index.');
    return daysInMonthUTC(ctx.dates[i]) * 86400;
  }
  if (!ctx.stepMs) throw new Error('Depth conversion requires the series time step.');
  return ctx.stepMs / 1000;
}

function toM3sAt(v: number, ctx: ConvertContext, i: number): number {
  const def = UNITS[ctx.from];
  if (def.kind === 'volumetric') return v * (def.toM3s as number);
  if (def.kind === 'depth') {
    const areaKm2 = ctx.area ? areaToKm2(ctx.area.value, ctx.area.unit) : NaN;
    const mm = v * (def.toMmPerInterval as number);
    const dt = intervalSeconds(ctx, i, def.interval as 'step' | 'day');
    // Q [m³/s] = D [mm/Δt] × A [km²] × 1000 / Δt [s]   (Appendix B)
    return (mm * areaKm2 * 1000) / dt;
  }
  return v; // dimensionless
}

function fromM3sAt(q: number, ctx: ConvertContext, i: number): number {
  const def = UNITS[ctx.to];
  if (def.kind === 'volumetric') return q / (def.toM3s as number);
  if (def.kind === 'depth') {
    const areaKm2 = ctx.area ? areaToKm2(ctx.area.value, ctx.area.unit) : NaN;
    const dt = intervalSeconds(ctx, i, def.interval as 'step' | 'day');
    const mm = (q * dt) / (areaKm2 * 1000);
    return mm / (def.toMmPerInterval as number);
  }
  return q;
}

/**
 * Convert a series between units. NaN passes through. Throws on incompatible
 * unit pairs (dimensionless↔flow) or a depth conversion without area.
 * Full float precision throughout; rounding happens only at display time (§8).
 */
export function convertSeries(values: ArrayLike<number>, ctx: ConvertContext): Float64Array {
  const hasArea = !!ctx.area && isFinite(ctx.area.value) && ctx.area.value > 0;
  if (!unitsCompatible(ctx.from, ctx.to, hasArea)) {
    throw new Error(`Cannot convert ${UNITS[ctx.from].label} to ${UNITS[ctx.to].label}` +
      (hasArea ? '.' : ' without a catchment area.'));
  }
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!isFinite(v)) { out[i] = NaN; continue; }
    out[i] = ctx.from === ctx.to ? v : fromM3sAt(toM3sAt(v, ctx, i), ctx, i);
  }
  return out;
}
