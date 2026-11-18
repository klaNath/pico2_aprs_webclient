// Pure geometry of the radar: distance and bearing -> position in the SVG, the scale (linear or
// logarithmic), which rings to draw, and what counts as out of range. No DOM here, so it is
// tested under Node.
//
// The radar is drawn in a square viewBox. North is up, bearings run clockwise (90° = east =
// right). The tracker is at the centre; the outer ring is `maxM` meters.

import type { RadarScale } from "../store/prefs.ts";

export const VIEW_SIZE = 240;
export const CENTER = VIEW_SIZE / 2;
/** Radius of the outer ring, in viewBox units. The rest is room for N/E/S/W and dots on the rim. */
export const OUTER_R = 96;

/** Choices offered for the outer ring, in km. */
export const RANGE_OPTIONS_KM = [5, 10, 20, 50, 100, 500] as const;

/**
 * A station is never drawn closer to the centre than this fraction of the outer radius, so it does
 * not hide under the marker of this tracker (and can be tapped). Only a display offset.
 */
export const MIN_DOT_FRACTION = 0.07;

/** Rings closer together than this (as a fraction of the outer radius) are thinned out. */
const RING_MIN_GAP = 0.12;

/**
 * Where a distance falls between the centre (0) and the outer ring (1), clamped to [0, 1].
 * linear: d / max. log: log(1 + d) / log(1 + max) with meters, so 100 m of a 50 km range is
 * already at 43 % of the radius while the scale still reaches the edge at exactly `maxM`.
 * Non-decreasing in `distM`. An invalid `maxM` gives 0.
 */
export function radiusFraction(distM: number, maxM: number, scale: RadarScale): number {
  if (!Number.isFinite(distM) || !Number.isFinite(maxM) || maxM <= 0) return 0;
  const d = Math.max(0, distM);
  const f = scale === "linear" ? d / maxM : Math.log1p(d) / Math.log1p(maxM);
  return Math.min(1, Math.max(0, f));
}

export function isOutOfRange(distM: number, maxM: number): boolean {
  return distM > maxM;
}

/** Position of a point `frac` of the way out along `bearing` (degrees, clockwise from north). */
export function polarToXY(frac: number, bearing: number, cx = CENTER, cy = CENTER, r = OUTER_R) {
  const a = (bearing * Math.PI) / 180;
  return { x: cx + r * frac * Math.sin(a), y: cy - r * frac * Math.cos(a) };
}

export interface Placed {
  x: number;
  y: number;
  /** Fraction of the outer radius actually used (after the minimum offset and the edge clamp). */
  frac: number;
  /** True when the station is beyond the outer ring: it is drawn on the rim. */
  outOfRange: boolean;
}

/** Screen position of a station at `distM` meters and `bearing` degrees from the centre. */
export function placeStation(
  distM: number,
  bearing: number,
  maxM: number,
  scale: RadarScale,
  minFraction = MIN_DOT_FRACTION,
): Placed {
  const frac = Math.max(minFraction, radiusFraction(distM, maxM, scale));
  const b = Number.isFinite(bearing) ? bearing : 0;
  const { x, y } = polarToXY(frac, b);
  return { x, y, frac, outOfRange: isOutOfRange(distM, maxM) };
}

const NICE = [1, 2, 5] as const;

/** 1, 2, 5, 10, 20, 50, ... that is >= `v` (v > 0). */
function niceCeil(v: number): number {
  const e = Math.floor(Math.log10(v));
  for (const exp of [e, e + 1]) {
    for (const m of NICE) {
      const c = m * 10 ** exp;
      if (c >= v * (1 - 1e-9)) return c;
    }
  }
  return 10 ** (e + 1);
}

/**
 * Distances (meters, ascending) of the rings to draw. The last one is always `maxM` itself (the
 * outer ring). Linear: evenly spaced, 2 to 5 rings at 1-2-5 steps. Log: decades first (100 m, 1 km,
 * 10 km ...), then 5s and 2s where there is room, never closer together than `RING_MIN_GAP`.
 */
export function ringValues(maxM: number, scale: RadarScale): number[] {
  if (!Number.isFinite(maxM) || maxM <= 0) return [];
  const rings: number[] = [];
  if (scale === "linear") {
    const step = niceCeil(maxM / 5);
    for (let k = 1; k * step < maxM; k++) {
      const v = Math.round(k * step * 1e6) / 1e6;
      if (v / maxM < 1 - 0.08) rings.push(v);
    }
  } else {
    const floorExp = Math.ceil(Math.log10(maxM / 500));
    const candidates: number[] = [];
    for (const mant of [1, 5, 2]) {
      for (let e = floorExp; 10 ** e * mant < maxM; e++) candidates.push(mant * 10 ** e);
    }
    const kept: number[] = [];
    const fracs: number[] = [1];
    for (const c of candidates) {
      const f = radiusFraction(c, maxM, "log");
      if (f < 0.1 || f > 1 - RING_MIN_GAP) continue;
      if (fracs.some((o) => Math.abs(o - f) < RING_MIN_GAP)) continue;
      kept.push(c);
      fracs.push(f);
    }
    rings.push(...kept.sort((a, b) => a - b));
  }
  rings.push(maxM);
  return rings;
}

/** 100 -> "100 m", 1000 -> "1 km", 1500 -> "1.5 km", 50000 -> "50 km". */
export function formatRingLabel(m: number): string {
  if (!Number.isFinite(m)) return "";
  if (m < 1000) return `${Math.round(m)} m`;
  return `${Number((m / 1000).toFixed(1))} km`;
}

export interface Compass {
  label: "N" | "E" | "S" | "W";
  bearing: number;
}

export const COMPASS: readonly Compass[] = [
  { label: "N", bearing: 0 },
  { label: "E", bearing: 90 },
  { label: "S", bearing: 180 },
  { label: "W", bearing: 270 },
];
