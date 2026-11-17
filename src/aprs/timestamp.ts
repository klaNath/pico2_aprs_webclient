// APRS timestamps. They are kept as parsed; `resolveTimestamp` turns one into a Date given the
// time of reception, because the formats leave out the month or the year.

import type { Timestamp } from "./types.ts";

/**
 * Calendar ranges of APRS101 ch.6: day 01-31, hour 00-23, minute 00-59, second 00-59,
 * month 01-12. A second of 60 (leap second) is not accepted.
 */
export function isValidTimestamp(ts: Timestamp): boolean {
  const within = (v: number | undefined, lo: number, hi: number): boolean =>
    v === undefined || (Number.isInteger(v) && v >= lo && v <= hi);
  const need = (v: number | undefined): boolean => v !== undefined;
  if (ts.format === "hms") {
    if (!need(ts.second)) return false;
  } else if (!need(ts.day)) return false;
  if (ts.format === "mdhm" && !need(ts.month)) return false;
  return (
    within(ts.month, 1, 12) &&
    within(ts.day, 1, 31) &&
    within(ts.hour, 0, 23) &&
    within(ts.minute, 0, 59) &&
    within(ts.second, 0, 59)
  );
}

/** The 7-character timestamp of `/`, `@` and object reports: DDHHMMz, DDHHMM/, HHMMSSh. */
export function parseTimestamp7(s: string): Timestamp | null {
  let ts: Timestamp | null = null;
  let m = /^(\d{2})(\d{2})(\d{2})([zZ/])/.exec(s);
  if (m) {
    ts = {
      format: m[4] === "/" ? "dhm-local" : "dhm-z",
      day: Number(m[1]),
      hour: Number(m[2]),
      minute: Number(m[3]),
    };
  } else {
    m = /^(\d{2})(\d{2})(\d{2})h/.exec(s);
    if (m) ts = { format: "hms", hour: Number(m[1]), minute: Number(m[2]), second: Number(m[3]) };
  }
  return ts && isValidTimestamp(ts) ? ts : null;
}

/** The 8-digit MMDDHHMM timestamp of a position-less weather report. */
export function parseMdhm(s: string): Timestamp | null {
  const m = /^(\d{2})(\d{2})(\d{2})(\d{2})/.exec(s);
  if (!m) return null;
  const ts: Timestamp = {
    format: "mdhm",
    month: Number(m[1]),
    day: Number(m[2]),
    hour: Number(m[3]),
    minute: Number(m[4]),
  };
  return isValidTimestamp(ts) ? ts : null;
}

/**
 * Absolute time (UTC) closest to `ref`. Returns undefined for local-time stamps, because the
 * sender's time zone is unknown, and for a timestamp that is out of range (`Date.UTC` would
 * roll it over into another day).
 */
export function resolveTimestamp(ts: Timestamp, ref: Date): Date | undefined {
  if (!isValidTimestamp(ts)) return undefined;
  const y = ref.getUTCFullYear();
  const mo = ref.getUTCMonth();
  const d = ref.getUTCDate();
  const candidates: Date[] = [];
  const add = (year: number, month: number, day: number, h: number, mi: number, s = 0): void => {
    const date = new Date(Date.UTC(year, month, day, h, mi, s));
    // Skip impossible dates such as Feb 30 (Date would roll them over).
    if (ts.day !== undefined && date.getUTCDate() !== ts.day && ts.format !== "hms") return;
    if (ts.format === "mdhm" && date.getUTCMonth() !== month) return;
    candidates.push(date);
  };

  switch (ts.format) {
    case "dhm-local":
      return undefined;
    case "dhm-z":
      for (const dm of [-1, 0, 1]) add(y, mo + dm, ts.day!, ts.hour, ts.minute);
      break;
    case "hms":
      for (const dd of [-1, 0, 1]) add(y, mo, d + dd, ts.hour, ts.minute, ts.second ?? 0);
      break;
    case "mdhm":
      for (const dy of [-1, 0, 1]) add(y + dy, ts.month! - 1, ts.day!, ts.hour, ts.minute);
      break;
  }
  let best: Date | undefined;
  for (const c of candidates) {
    if (!best || Math.abs(c.getTime() - ref.getTime()) < Math.abs(best.getTime() - ref.getTime())) {
      best = c;
    }
  }
  return best;
}
