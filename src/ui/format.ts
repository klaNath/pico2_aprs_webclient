// Display formatting shared by the views. "—" (NO_VALUE) stands for "no value".

import { NO_VALUE } from "../aprs/geo.ts";

export { NO_VALUE };

/** 45 -> "45 s", 125 -> "2 min", 7300 -> "2 h". */
export function fmtAge(sec: number | undefined): string {
  if (sec === undefined || !Number.isFinite(sec) || sec < 0) return NO_VALUE;
  if (sec < 90) return `${Math.round(sec)} s`;
  if (sec < 5400) return `${Math.round(sec / 60)} min`;
  if (sec < 172800) return `${Math.round(sec / 3600)} h`;
  return `${Math.round(sec / 86400)} d`;
}

/**
 * Meters -> "850 m" / "12.3 km" / "245 km". The unit changes where the rounded number would
 * reach the next one: 999.6 m is "1.0 km" (not "1000 m") and 99 999.96 m is "100 km" (not
 * "100.0 km").
 */
export function fmtDistance(m: number | undefined): string {
  if (m === undefined || !Number.isFinite(m)) return NO_VALUE;
  const meters = Math.round(m);
  if (meters < 1000) return `${meters} m`;
  const km1 = Math.round(m / 100) / 10;
  if (km1 < 100) return `${km1.toFixed(1)} km`;
  return `${Math.round(m / 1000)} km`;
}

/** "-31.3 dB". A value that rounds to zero is "0.0 dB", never "-0.0 dB". */
export function fmtDb(db: number | undefined): string {
  if (db === undefined || !Number.isFinite(db)) return NO_VALUE;
  const s = db.toFixed(1);
  return `${s === "-0.0" ? "0.0" : s} dB`;
}

/** "12:34:56" local time for a Date.now() value. */
export function fmtClock(at: number): string {
  const d = new Date(at);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
