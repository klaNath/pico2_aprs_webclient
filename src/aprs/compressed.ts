// Compressed position format (APRS101 chapter 9) and the base-91 helper used by several formats.

import type { AprsSymbol } from "./types.ts";

export const KNOTS_TO_KMH = 1.852;
export const FEET_TO_M = 0.3048;
export const MILES_TO_M = 1609.344;

/** Base-91 number from characters '!'..'{'. NaN if any character is out of range. */
export function base91(s: string): number {
  let v = 0;
  for (let i = 0; i < s.length; i++) {
    const d = s.charCodeAt(i) - 33;
    if (d < 0 || d > 90) return NaN;
    v = v * 91 + d;
  }
  return v;
}

/**
 * Symbol from a table character and a code. The table character is "/" or "\" or, for the
 * alternate table with an overlay, 0-9 / A-Z. In the compressed format only (`compressed`),
 * a-j also mean the overlays 0-9: there the table character cannot hold a digit, because
 * digits mean "uncompressed position". Everywhere else (uncompressed, Mic-E, status) a-j are
 * not valid table characters and give the plain alternate table.
 */
export function makeSymbol(
  tableChar: string,
  code: string,
  opts: { compressed?: boolean } = {},
): AprsSymbol {
  if (tableChar === "/") return { table: "/", code };
  if (tableChar === "\\") return { table: "\\", code };
  if (opts.compressed && tableChar >= "a" && tableChar <= "j") {
    return { table: "\\", code, overlay: String(tableChar.charCodeAt(0) - 97) };
  }
  if (/^[0-9A-Z]$/.test(tableChar)) return { table: "\\", code, overlay: tableChar };
  return { table: "\\", code };
}

export interface CompressedPosition {
  lat: number;
  lon: number;
  symbol: AprsSymbol;
  courseDeg?: number;
  speedKmh?: number;
  altitudeM?: number;
  rangeM?: number;
}

/** Length of the compressed position block: table + lat(4) + lon(4) + code + cs(2) + T. */
export const COMPRESSED_LENGTH = 13;

/**
 * Largest base-91 value of the position: 380926 * 180 = 190463 * 360. A value above it is
 * past the pole or past the antimeridian. Those packets are reported as unknown rather than
 * clamped, because a clamped value would put a believable marker on the pole and hide that the
 * packet is damaged.
 */
const MAX_POSITION_VALUE = 68566680;

/**
 * Parse `/YYYYXXXX$csT` at the start of `s`. Returns null if it is not a compressed position
 * and `{ reason }` if it is one but the position is out of range.
 */
export function parseCompressed(s: string): CompressedPosition | { reason: string } | null {
  if (s.length < COMPRESSED_LENGTH) return null;
  const table = s[0]!;
  if (!/^[/\\A-Za-j]$/.test(table)) return null;
  const y = base91(s.slice(1, 5));
  const x = base91(s.slice(5, 9));
  if (!Number.isFinite(y) || !Number.isFinite(x)) return null;
  if (y > MAX_POSITION_VALUE || x > MAX_POSITION_VALUE) {
    return { reason: "compressed position out of range" };
  }

  const out: CompressedPosition = {
    lat: 90 - y / 380926,
    lon: -180 + x / 190463,
    symbol: makeSymbol(table, s[9]!, { compressed: true }),
  };

  const c = s.charCodeAt(10) - 33;
  const sv = s.charCodeAt(11) - 33;
  const t = s.charCodeAt(12) - 33;
  if (s[10] !== " " && c >= 0 && c <= 90 && sv >= 0 && sv <= 90) {
    const nmeaSource = t >= 0 && t <= 90 ? (t >> 3) & 3 : 0;
    if (nmeaSource === 2) {
      // GGA: cs is the altitude
      out.altitudeM = 1.002 ** (c * 91 + sv) * FEET_TO_M;
    } else if (c <= 89) {
      if (c > 0) out.courseDeg = c * 4;
      out.speedKmh = (1.08 ** sv - 1) * KNOTS_TO_KMH;
    } else {
      out.rangeM = 2 * 1.08 ** sv * MILES_TO_M;
    }
  }
  return out;
}
