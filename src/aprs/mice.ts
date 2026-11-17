// Mic-E (APRS101 chapter 10): position, course, speed and message are spread over the
// destination address and the information field.

import { MICE_MESSAGES } from "../protocol/settings.ts";
import { KNOTS_TO_KMH, base91, makeSymbol } from "./compressed.ts";
import { applyDao, extractDao } from "./dao.ts";
import { readText } from "./tnc2.ts";
import type { MiceMessage, Position } from "./types.ts";

interface DestChar {
  digit: number;
  /** The bit this character carries (message bit, N/S, longitude offset, W/E). */
  bit: 0 | 1;
  custom: boolean;
  /** K, L, Z: a blank digit (position ambiguity). */
  space: boolean;
}

function destChar(c: string, index: number): DestChar | null {
  const code = c.charCodeAt(0);
  if (c >= "0" && c <= "9") return { digit: code - 48, bit: 0, custom: false, space: false };
  if (c >= "P" && c <= "Y") return { digit: code - 80, bit: 1, custom: false, space: false };
  if (c === "L") return { digit: 0, bit: 0, custom: false, space: true };
  if (c === "Z") return { digit: 0, bit: 1, custom: false, space: true };
  // A-K (custom message bit) are only valid in the first three characters.
  if (index < 3 && c >= "A" && c <= "J") {
    return { digit: code - 65, bit: 1, custom: true, space: false };
  }
  if (index < 3 && c === "K") return { digit: 0, bit: 1, custom: true, space: true };
  return null;
}

function message(bits: [number, number, number], custom: boolean): MiceMessage {
  // 111 = message 0 ... 001 = message 6, 000 = Emergency
  const index = 7 - (bits[0] * 4 + bits[1] * 2 + bits[2]);
  if (index === 7) return { kind: "emergency", name: "Emergency" };
  if (custom) return { kind: "custom", index, name: `Custom ${index}` };
  return { kind: "standard", index, name: MICE_MESSAGES[index]! };
}

export interface MiceResult {
  position: Position;
  /** Null when the destination mixes custom and standard message bits (APRS101 forbids it). */
  message: MiceMessage | null;
  typeCode?: string;
}

const bad = (what: string): { reason: string } => ({ reason: `Mic-E: ${what}` });

/** Plausible altitude range of the `ccc}` field, in meters. The encoding itself reaches 743,570 m. */
const ALT_MIN_M = -10000;
const ALT_MAX_M = 100000;

/**
 * @param dst   destination address (SSID is ignored)
 * @param info  information field as a binary string, starting with the data type character
 * @returns the packet, `{ reason }` when it is Mic-E but damaged, or null when it cannot be Mic-E
 */
export function parseMice(dst: string, info: string): MiceResult | { reason: string } | null {
  const d = dst.split("-")[0]!;
  if (d.length !== 6 || info.length < 9) return null;

  const chars: DestChar[] = [];
  for (let i = 0; i < 6; i++) {
    const c = destChar(d[i]!, i);
    if (!c) return null;
    chars.push(c);
  }

  // Custom and standard message bits cannot be mixed. The position is still good, so only the
  // message is dropped.
  const customCount = chars.slice(0, 3).filter((c) => c.custom).length;
  const standardCount = chars.slice(0, 3).filter((c) => !c.custom && c.bit === 1).length;
  const msg =
    customCount > 0 && standardCount > 0
      ? null
      : message([chars[0]!.bit, chars[1]!.bit, chars[2]!.bit], customCount > 0);

  // Latitude: ddmm.hh from six digits. Degrees up to 90, minutes below 60, and 90 only exactly.
  const ambiguity = chars.filter((c) => c.space).length;
  const latDeg = chars[0]!.digit * 10 + chars[1]!.digit;
  const latMin = chars[2]!.digit * 10 + chars[3]!.digit;
  const latHund = chars[4]!.digit * 10 + chars[5]!.digit;
  if (latMin >= 60) return bad("latitude minutes out of range");
  if (latDeg > 90 || (latDeg === 90 && (latMin > 0 || latHund > 0))) {
    return bad("latitude out of range");
  }
  const lat = latDeg + (latMin + latHund / 100) / 60;
  const north = chars[3]!.bit === 1;
  const lonOffset = chars[4]!.bit === 1;
  const west = chars[5]!.bit === 1;

  // The six bytes after the data type are value + 28 with the value 0-99 (0x1C-0x7F). Anything
  // else is damage: it used to be decoded into a believable but wrong position.
  const b = (i: number): number => info.charCodeAt(i) - 28;
  for (let i = 1; i <= 6; i++) if (b(i) < 0 || b(i) > 99) return bad("byte out of range");

  let lonDeg = b(1);
  if (lonOffset) lonDeg += 100;
  if (lonDeg >= 190) lonDeg -= 190;
  else if (lonDeg >= 180) lonDeg -= 80;
  // Minutes 0-9 are sent as 60-69, so the value is at most 69.
  if (b(2) > 69) return bad("longitude minutes out of range");
  const lonMin = b(2) >= 60 ? b(2) - 60 : b(2);
  const lon = lonDeg + (lonMin + b(3) / 100) / 60;
  if (lon > 180) return bad("longitude out of range");

  let speedKnots = b(4) * 10 + Math.floor(b(5) / 10);
  if (speedKnots >= 800) speedKnots -= 800;
  let course = (b(5) % 10) * 100 + b(6);
  if (course >= 400) course -= 400;
  if (course > 360) return bad("course out of range");

  const code = info[7]!;
  const table = info[8]!;
  if (!/^[\x21-\x7e]$/.test(code) || !/^[\x21-\x7e]$/.test(table)) return bad("invalid symbol");

  let rest = info.slice(9);
  // The optional type code (`>` `]` backtick `'`), then the altitude `ccc}` directly after it
  // (APRS101 ch.10). A `}` further into the comment is ordinary text. The altitude's first
  // character can itself be `'` (39,686 m and up); the type code reading wins only if the
  // altitude is still found behind it.
  const altAt = (t: string): RegExpExecArray | null => /^([\x21-\x7b]{3})\}/.exec(t);
  let typeCode: string | undefined;
  if (rest.length > 0 && ">]`'".includes(rest[0]!) && !(altAt(rest) && !altAt(rest.slice(1)))) {
    typeCode = rest[0];
    rest = rest.slice(1);
  }
  let altitudeM: number | undefined;
  const alt = altAt(rest);
  if (alt) {
    const m = base91(alt[1]!) - 10000; // already meters
    // Outside the plausible range the three characters are not taken for an altitude.
    if (m >= ALT_MIN_M && m <= ALT_MAX_M) {
      altitudeM = m;
      rest = rest.slice(4);
    }
  }

  // Mic-E has hundredths of a minute; a DAO at the end of the comment can add the thousandths.
  let latV = north ? lat : -lat;
  let lonV = west ? -lon : lon;
  let dao = false;
  if (ambiguity === 0) {
    const x = extractDao(rest);
    const moved = x && applyDao(latV, lonV, north, west, x);
    if (x && moved) {
      latV = moved.lat;
      lonV = moved.lon;
      rest = x.rest;
      dao = true;
    }
  }

  const position: Position = {
    lat: latV + 0, // + 0 turns -0 into 0
    lon: lonV + 0,
    ambiguity,
    symbol: makeSymbol(table, code),
    compressed: false,
    speedKmh: speedKnots * KNOTS_TO_KMH,
    comment: readText(rest),
  };
  if (dao) position.dao = true;
  if (course >= 1 && course <= 360) position.courseDeg = course;
  if (altitudeM !== undefined) position.altitudeM = altitudeM;
  const result: MiceResult = { position, message: msg };
  if (typeCode !== undefined) result.typeCode = typeCode;
  return result;
}
