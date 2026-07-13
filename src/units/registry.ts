import type { UnitId, UnitKind, AreaUnitId } from '../types'

// Conversion factors pinned exactly to webtool_v3.md Appendix B.
// Volumetric units carry a fixed factor to the base unit m³/s.
// Depth units convert through catchment area and the time step (see convert.ts).

export interface UnitDef {
  id: UnitId;
  label: string;
  kind: UnitKind;
  /** For volumetric units: multiply by this to get m³/s. */
  toM3s?: number;
  /** For depth units: multiply by this to get mm per interval. */
  toMmPerInterval?: number;
  /** For depth units: the interval the depth is expressed over. */
  interval?: 'step' | 'day';
}

export const UNITS: Record<UnitId, UnitDef> = {
  m3s:    { id: 'm3s',    label: 'm³/s',        kind: 'volumetric', toM3s: 1 },
  cfs:    { id: 'cfs',    label: 'ft³/s (cfs)', kind: 'volumetric', toM3s: 0.0283168 },
  ls:     { id: 'ls',     label: 'L/s',         kind: 'volumetric', toM3s: 0.001 },
  m3day:  { id: 'm3day',  label: 'm³/day',      kind: 'volumetric', toM3s: 1.15741e-5 },
  MLday:  { id: 'MLday',  label: 'ML/day',      kind: 'volumetric', toM3s: 0.0115741 },
  MGD:    { id: 'MGD',    label: 'MGD (US)',    kind: 'volumetric', toM3s: 0.0438126 },
  acftday:{ id: 'acftday',label: 'acre-ft/day', kind: 'volumetric', toM3s: 0.0142764 },
  mm_step:{ id: 'mm_step',label: 'mm / interval', kind: 'depth', toMmPerInterval: 1, interval: 'step' },
  in_day: { id: 'in_day', label: 'in / day',    kind: 'depth', toMmPerInterval: 25.4, interval: 'day' },
  dimensionless: { id: 'dimensionless', label: 'dimensionless', kind: 'dimensionless' },
};

/** Area factors to km² (Appendix B). */
export const AREA_TO_KM2: Record<AreaUnitId, number> = {
  km2: 1,
  mi2: 2.589988,
  ha: 0.01,
  acre: 0.00404686,
};

export function unitKind(u: UnitId): UnitKind {
  return UNITS[u].kind;
}

/**
 * Compatibility rule (§8): volumetric↔volumetric always; depth↔volumetric (either
 * direction) and depth↔depth require catchment area; dimensionless only with itself.
 */
export function unitsCompatible(a: UnitId, b: UnitId, hasArea: boolean): boolean {
  const ka = unitKind(a); const kb = unitKind(b);
  if (ka === 'dimensionless' || kb === 'dimensionless') return ka === kb;
  if (ka === 'volumetric' && kb === 'volumetric') return true;
  return hasArea; // any conversion touching depth needs an area
}
