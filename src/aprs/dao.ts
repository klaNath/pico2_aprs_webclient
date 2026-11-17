// The !DAO! extension (APRS 1.2 "precise position"): `!` datum, two digits `!`, at the end of the
// comment. It adds thousandths of a minute (human readable) or 1/91 of a hundredth of a minute
// (base 91) to the latitude and longitude. Shared by uncompressed positions and Mic-E.

import { base91 } from "./compressed.ts";

/**
 * Datum characters that are defined: W (WGS84) and R, uppercase for human-readable digits and
 * lowercase for base 91. Any other letter is ordinary comment text ("!Q12!").
 */
const DAO = /!([WRwr])([\x21-\x7b]{2})!\s*$/;

export interface DaoResult {
  /** Extra minutes of latitude and longitude, to be added to the magnitude. */
  latMin: number;
  lonMin: number;
  /** The comment without the DAO. */
  rest: string;
}

/** Find a DAO at the end of `text`; null if there is none or its digits are not valid. */
export function extractDao(text: string): DaoResult | null {
  const m = DAO.exec(text);
  if (!m) return null;
  const datum = m[1]!;
  const ao = m[2]!;
  let latMin: number;
  let lonMin: number;
  if (datum === "W" || datum === "R") {
    if (!/^\d\d$/.test(ao)) return null;
    latMin = Number(ao[0]) / 1000;
    lonMin = Number(ao[1]) / 1000;
  } else {
    const a = base91(ao[0]!);
    const o = base91(ao[1]!);
    if (!Number.isFinite(a) || !Number.isFinite(o)) return null;
    latMin = (a / 91) * 0.01;
    lonMin = (o / 91) * 0.01;
  }
  return { latMin, lonMin, rest: text.slice(0, m.index) + text.slice(m.index + 5) };
}

/**
 * Apply a DAO to a signed latitude and longitude: the extra minutes go away from the equator
 * and the prime meridian, i.e. in the direction of the hemisphere (`north`, `west` flags, not
 * the sign of the value, which is lost at exactly 0).
 * Returns null when the result would leave the globe (the DAO is then left in the comment).
 */
export function applyDao(
  lat: number,
  lon: number,
  north: boolean,
  west: boolean,
  dao: DaoResult,
): { lat: number; lon: number } | null {
  const newLat = lat + (north ? 1 : -1) * (dao.latMin / 60);
  const newLon = lon + (west ? -1 : 1) * (dao.lonMin / 60);
  if (Math.abs(newLat) > 90 || Math.abs(newLon) > 180) return null;
  return { lat: newLat, lon: newLon };
}
