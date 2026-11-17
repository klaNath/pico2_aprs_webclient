// Great-circle distance and bearing, and small helpers for showing positions.

export interface LatLon {
  lat: number;
  lon: number;
}

const EARTH_RADIUS_M = 6371008.8;
const rad = (d: number): number => (d * Math.PI) / 180;
const deg = (r: number): number => (r * 180) / Math.PI;

/** Haversine distance in meters. */
export function distanceM(a: LatLon, b: LatLon): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b, in degrees [0, 360). */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const p1 = rad(a.lat);
  const p2 = rad(b.lat);
  const dLon = rad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dLon);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

const POINTS = [
  "N",
  "NNE",
  "NE",
  "ENE",
  "E",
  "ESE",
  "SE",
  "SSE",
  "S",
  "SSW",
  "SW",
  "WSW",
  "W",
  "WNW",
  "NW",
  "NNW",
] as const;

/** Shown by `cardinal` and `formatLatLon` for a value that is not a finite number. */
export const NO_VALUE = "—";

/** 16-point compass name, or "—" for a bearing that is not finite. */
export function cardinal(bearing: number): string {
  if (!Number.isFinite(bearing)) return NO_VALUE;
  const i = Math.round((((bearing % 360) + 360) % 360) / 22.5) % 16;
  return POINTS[i]!;
}

/** "35°40.800'N 139°45.600'E", or "—" if either value is not finite. */
export function formatLatLon(p: LatLon): string {
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return NO_VALUE;
  const part = (v: number, pos: string, neg: string, degWidth: number): string => {
    const a = Math.abs(v);
    let d = Math.floor(a);
    let m = Math.round((a - d) * 60 * 1000) / 1000;
    if (m >= 60) {
      d += 1;
      m = 0;
    }
    return `${String(d).padStart(degWidth, "0")}°${m.toFixed(3).padStart(6, "0")}'${v < 0 ? neg : pos}`;
  };
  return `${part(p.lat, "N", "S", 2)} ${part(p.lon, "E", "W", 3)}`;
}

/** Center of a Maidenhead locator (4 or 6 characters), or null if it is not valid. */
export function gridToLatLon(grid: string): LatLon | null {
  const m = /^([A-R]{2})(\d{2})(?:([A-X]{2}))?$/i.exec(grid);
  if (!m) return null;
  const f = m[1]!.toUpperCase();
  let lon = (f.charCodeAt(0) - 65) * 20 - 180 + Number(m[2]![0]) * 2;
  let lat = (f.charCodeAt(1) - 65) * 10 - 90 + Number(m[2]![1]);
  if (m[3]) {
    const s = m[3].toUpperCase();
    lon += (s.charCodeAt(0) - 65) * (5 / 60) + 2.5 / 60;
    lat += (s.charCodeAt(1) - 65) * (2.5 / 60) + 1.25 / 60;
  } else {
    lon += 1;
    lat += 0.5;
  }
  return { lat, lon };
}
