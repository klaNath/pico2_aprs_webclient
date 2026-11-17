// Entry point: parseAprs(tnc2) -> AprsPacket. Never throws; anything that cannot be understood
// becomes { type: "unknown" } with a reason.

import {
  COMPRESSED_LENGTH,
  FEET_TO_M,
  KNOTS_TO_KMH,
  MILES_TO_M,
  makeSymbol,
  parseCompressed,
} from "./compressed.ts";
import { applyDao, extractDao } from "./dao.ts";
import { gridToLatLon } from "./geo.ts";
import { parseMice } from "./mice.ts";
import { parseMdhm, parseTimestamp7 } from "./timestamp.ts";
import {
  parseCompressedTelemetry,
  parseTelemetryDefinition,
  parseTelemetryReport,
} from "./telemetry.ts";
import { decodeEscapes, isTnc2Error, parseTnc2Binary, readText } from "./tnc2.ts";
import type { AprsData, AprsPacket, Dfs, Phg, Position, Tnc2 } from "./types.ts";
import { parseWeatherFields } from "./weather.ts";

/** Parse a TNC2 line as it appears in `rx.tnc2` and `tx.tnc2`. */
export function parseAprs(line: string): AprsPacket {
  try {
    return parseBinaryPacket(decodeEscapes(line), 0);
  } catch (e) {
    const reason = `internal parser error: ${e instanceof Error ? e.message : String(e)}`;
    return { tnc2: null, data: { type: "unknown", reason }, error: reason };
  }
}

function parseBinaryPacket(binary: string, depth: number): AprsPacket {
  const t = parseTnc2Binary(binary);
  if (isTnc2Error(t)) {
    return { tnc2: null, data: { type: "unknown", reason: t.error }, error: t.error };
  }
  return { tnc2: t, data: parseInfo(t, depth) };
}

function unknown(dataType: string | undefined, reason: string): AprsData {
  return { type: "unknown", dataType, reason };
}

function parseInfo(t: Tnc2, depth: number): AprsData {
  const info = t.info;
  if (info === "") return unknown(undefined, "empty information field");
  const dt = info[0]!;

  switch (dt) {
    case "!":
    case "=": {
      const position = parsePositionAt(info, 1);
      if (typeof position === "string") return unknown(dt, position);
      return { type: "position", position, messaging: dt === "=" };
    }
    case "/":
    case "@": {
      const timestamp = parseTimestamp7(info.slice(1, 8));
      if (!timestamp) return unknown(dt, "invalid timestamp");
      const position = parsePositionAt(info, 8);
      if (typeof position === "string") return unknown(dt, position);
      return { type: "position", position, timestamp, messaging: dt === "@" };
    }
    case "`":
    case "'":
    case "\x1c":
    case "\x1d": {
      const r = parseMice(t.dst, info);
      if (!r) return unknown(dt, "invalid Mic-E");
      if ("reason" in r) return unknown(dt, r.reason);
      return { type: "mice", ...r };
    }
    case ";":
      return parseObject(info);
    case ")":
      return parseItem(info);
    case ":":
      return parseMessage(info);
    case ">":
      return parseStatus(info);
    case "_": {
      // `_MMDDHHMM` then fields. Eight digits that are not a valid date are an error; text that
      // does not start with eight digits is read as fields without a timestamp. A report
      // without a single field (`_hello`) is not weather.
      const stamp = /^\d{8}/.test(info.slice(1, 9)) ? parseMdhm(info.slice(1, 9)) : undefined;
      if (stamp === null) return unknown(dt, "invalid timestamp");
      const { weather, rest, fieldCount } = parseWeatherFields(info.slice(stamp ? 9 : 1), {
        windPrefix: false,
      });
      if (fieldCount === 0) return unknown(dt, "weather report without weather fields");
      if (rest !== "") weather.extra = readText(rest);
      return { type: "weather", timestamp: stamp, weather };
    }
    case "T": {
      const r = parseTelemetryReport(info);
      if (!r) return unknown(dt, "invalid telemetry report");
      return { type: "telemetry", ...r, comment: readText(r.comment) };
    }
    case "}":
      if (depth >= 1) return unknown(dt, "nested third-party packet");
      return { type: "thirdparty", inner: parseBinaryPacket(info.slice(1), depth + 1) };
    case "$":
      return { type: "nmea", sentence: info.slice(1).split(",")[0] ?? "", raw: readText(info) };
    case "<":
      return { type: "capabilities", text: readText(info.slice(1)) };
    case "?":
      return { type: "query", text: readText(info.slice(1)) };
    default:
      return unknown(dt, "unsupported data type");
  }
}

// ---- positions ----------------------------------------------------------------------------

const UNCOMPRESSED =
  /^(\d{2})([\d ]{2})\.([\d ]{2})([NS])(.)(\d{3})([\d ]{2})\.([\d ]{2})([EW])(.)/s;

/**
 * Position (compressed or not) starting at `s[i]`, followed by extensions and the comment.
 * Returns the reason (a string) when it cannot be read.
 */
function parsePositionAt(s: string, i: number): Position | string {
  const first = s[i];
  if (first === undefined) return "invalid position";
  if (/^[0-9 ]$/.test(first)) return parseUncompressed(s.slice(i));
  if (s.length - i < COMPRESSED_LENGTH) return "invalid position";
  const c = parseCompressed(s.slice(i));
  if (!c) return "invalid position";
  if ("reason" in c) return c.reason;
  const position: Position = {
    lat: c.lat,
    lon: c.lon,
    ambiguity: 0,
    symbol: c.symbol,
    compressed: true,
    comment: "",
  };
  if (c.courseDeg !== undefined) position.courseDeg = c.courseDeg;
  if (c.speedKmh !== undefined) position.speedKmh = c.speedKmh;
  if (c.altitudeM !== undefined) position.altitudeM = c.altitudeM;
  if (c.rangeM !== undefined) position.rangeM = c.rangeM;
  let rest = s.slice(i + COMPRESSED_LENGTH);
  if (c.symbol.code === "_") {
    // Weather: the wind is in cs, so the text after the block has no `ccc/sss` and its `s` is
    // snowfall. cs holds the direction (course) and the speed. The direction is taken. The
    // speed is not: cs speed is defined in knots for tracks and APRS101 does not say whether
    // weather uses mph like the other wind fields, so no number is guessed.
    const dir = position.courseDeg;
    delete position.courseDeg;
    delete position.speedKmh;
    const w = parseWeatherFields(rest, { windPrefix: false, windGiven: true });
    position.weather = w.weather;
    if (dir !== undefined) position.weather.windDirDeg = dir;
    rest = w.rest;
  }
  return finishComment(position, rest);
}

function parseUncompressed(s: string): Position | string {
  const m = UNCOMPRESSED.exec(s);
  if (!m) return "invalid position";
  const latMin = Number(`${m[2]!.replaceAll(" ", "0")}.${m[3]!.replaceAll(" ", "0")}`);
  const lonMin = Number(`${m[7]!.replaceAll(" ", "0")}.${m[8]!.replaceAll(" ", "0")}`);
  const latDeg = Number(m[1]);
  const lonDeg = Number(m[6]);
  // Minutes below 60, latitude up to 90 and longitude up to 180 degrees, where the limit
  // itself only holds with zero minutes.
  if (latMin >= 60 || lonMin >= 60) return "minutes out of range";
  if (latDeg > 90 || (latDeg === 90 && latMin > 0)) return "latitude out of range";
  if (lonDeg > 180 || (lonDeg === 180 && lonMin > 0)) return "longitude out of range";
  const north = m[4] === "N";
  const west = m[9] === "W";
  const ambiguity = [...(m[2]! + m[3]!)].filter((c) => c === " ").length;
  const position: Position = {
    // + 0 turns -0 (0 degrees, S or W) into 0
    lat: (latDeg + latMin / 60) * (north ? 1 : -1) + 0,
    lon: (lonDeg + lonMin / 60) * (west ? -1 : 1) + 0,
    ambiguity,
    symbol: makeSymbol(m[5]!, m[10]!),
    compressed: false,
    comment: "",
  };
  let rest = s.slice(19);

  if (position.symbol.code === "_") {
    const w = parseWeatherFields(rest, { windPrefix: true });
    position.weather = w.weather;
    rest = w.rest;
  } else {
    rest = dataExtension(position, rest);
  }
  return finishComment(position, rest, { north, west });
}

/** Course/speed, PHG, RNG or DFS right after the symbol. Returns the text that follows. */
function dataExtension(p: Position, rest: string): string {
  let m = /^(\d{3})\/(\d{3})/.exec(rest);
  if (m) {
    const course = Number(m[1]);
    if (course >= 1 && course <= 360) p.courseDeg = course;
    p.speedKmh = Number(m[2]) * KNOTS_TO_KMH;
    return rest.slice(7);
  }
  m = /^PHG(\d)(\d)(\d)(\d)/.exec(rest);
  if (m) {
    const phg: Phg = {
      powerW: Number(m[1]) ** 2,
      heightM: 10 * 2 ** Number(m[2]) * FEET_TO_M,
      gainDb: Number(m[3]),
      directivityDeg: Number(m[4]) === 0 ? null : Number(m[4]) * 45,
    };
    p.phg = phg;
    return rest.slice(7);
  }
  m = /^RNG(\d{4})/.exec(rest);
  if (m) {
    p.rangeM = Number(m[1]) * MILES_TO_M;
    return rest.slice(7);
  }
  m = /^DFS(\d)(\d)(\d)(\d)/.exec(rest);
  if (m) {
    const dfs: Dfs = {
      strength: Number(m[1]),
      heightM: 10 * 2 ** Number(m[2]) * FEET_TO_M,
      gainDb: Number(m[3]),
      directivityDeg: Number(m[4]) === 0 ? null : Number(m[4]) * 45,
    };
    p.dfs = dfs;
    return rest.slice(7);
  }
  return rest;
}

/**
 * Compressed telemetry, altitude, DAO; what remains is the comment. `hemisphere` is given for
 * uncompressed positions only, which are the ones that can carry a DAO (a compressed position
 * has no use for one).
 */
function finishComment(
  p: Position,
  text: string,
  hemisphere?: { north: boolean; west: boolean },
): Position {
  let rest = text;

  const tel = /\|((?:[\x21-\x7b]{2}){2,7})\|$/.exec(rest);
  if (tel) {
    const t = parseCompressedTelemetry(tel[1]!);
    if (t) {
      p.telemetry = t;
      rest = rest.slice(0, tel.index);
    }
  }

  // Altitude `/A=aaaaaa` (feet). Only the first one is taken; a second `/A=` stays in the
  // comment as text (APRS101 has one altitude field per packet).
  const alt = /\/A=(-\d{5}|\d{6})/.exec(rest);
  if (alt) {
    p.altitudeM = Number(alt[1]) * FEET_TO_M;
    rest = rest.slice(0, alt.index) + rest.slice(alt.index + 9);
  }

  if (hemisphere && p.ambiguity === 0) {
    const dao = extractDao(rest);
    const moved = dao && applyDao(p.lat, p.lon, hemisphere.north, hemisphere.west, dao);
    if (dao && moved) {
      p.lat = moved.lat;
      p.lon = moved.lon;
      p.dao = true;
      rest = dao.rest;
    }
  }

  p.comment = readText(rest);
  return p;
}

// ---- objects, items -----------------------------------------------------------------------

function parseObject(info: string): AprsData {
  // ;NAME_____*DDHHMMzPOSITION  (name is 9 characters)
  if (info.length < 19) return unknown(";", "object report is too short");
  const state = info[10];
  if (state !== "*" && state !== "_") return unknown(";", "invalid object state");
  const timestamp = parseTimestamp7(info.slice(11, 18));
  if (!timestamp) return unknown(";", "invalid object timestamp");
  const position = parsePositionAt(info, 18);
  if (typeof position === "string") return unknown(";", `object: ${position}`);
  return {
    type: "object",
    name: readText(info.slice(1, 10)).trimEnd(),
    live: state === "*",
    timestamp,
    position,
  };
}

function parseItem(info: string): AprsData {
  // )NAME!POSITION  (name is 3-9 characters, ended by '!' live or '_' killed)
  let end = -1;
  for (let i = 4; i <= 10 && i < info.length; i++) {
    if (info[i] === "!" || info[i] === "_") {
      end = i;
      break;
    }
  }
  if (end < 0) return unknown(")", "no end of item name");
  const position = parsePositionAt(info, end + 1);
  if (typeof position === "string") return unknown(")", `item: ${position}`);
  return { type: "item", name: readText(info.slice(1, end)), live: info[end] === "!", position };
}

// ---- messages, status ---------------------------------------------------------------------

/**
 * Bulletin and announcement names: `BLN` + digit or letter (APRS101 ch.14: BLNn, BLNx), or
 * `NWS-` / `NWS_` + a name that has a letter. A bare "NWS-1" is a callsign with an SSID, and
 * "NWS1AB" is not a bulletin either.
 */
const BULLETIN = /^(?:BLN[0-9A-Z]|NWS[-_]\w*[A-Za-z])/;

function parseMessage(info: string): AprsData {
  // :ADDRESSEE:text{msgNo  (addressee is 9 characters, padded with spaces)
  if (info.length < 11 || info[10] !== ":") return unknown(":", "invalid message");
  const addressee = info.slice(1, 10).trim();
  let body = info.slice(11);

  const def = parseTelemetryDefinition(body);
  if (def) {
    return {
      type: "telemetry-def",
      addressee,
      kind: def.kind,
      names: def.names?.map(readText),
      eqns: def.eqns,
      bits: def.bits,
      title: def.title === undefined ? undefined : readText(def.title),
    };
  }

  // A reply is `ack` or `rej` followed by a message number and nothing else: 1-5 letters or
  // digits (APRS101 ch.14), and at least one digit. Without the digit rule, ordinary words that
  // begin with "ack" or "rej" ("reject", "acked") would be read as replies to message "ect"
  // and "ed". The cost: a reply whose number has only letters is read as a plain message.
  const reply = /^(ack|rej)([A-Za-z0-9]{1,5})$/.exec(body);
  if (reply && /\d/.test(reply[2]!)) {
    return {
      type: "message",
      addressee,
      text: "",
      msgNo: reply[2],
      reply: reply[1] as "ack" | "rej",
      bulletin: false,
    };
  }

  // `{mm` or, with reply-ack (APRS 1.2), `{mm}aa`; both numbers are 1-5 letters or digits.
  let msgNo: string | undefined;
  let replyAck: string | undefined;
  const no = /\{([A-Za-z0-9]{1,5})(?:\}([A-Za-z0-9]{0,5}))?$/.exec(body);
  if (no) {
    msgNo = no[1];
    if (no[2]) replyAck = no[2];
    body = body.slice(0, no.index);
  }
  const out: AprsData = {
    type: "message",
    addressee,
    text: readText(body),
    bulletin: BULLETIN.test(addressee),
  };
  if (msgNo !== undefined) out.msgNo = msgNo;
  if (replyAck !== undefined) out.replyAck = replyAck;
  return out;
}

const STATUS_GRID = /^([A-Ra-r]{2}\d{2}(?:[A-Xa-x]{2})?)([\x21-\x7e])([\x21-\x7e])(?: (.*))?$/s;

function parseStatus(info: string): AprsData {
  let text = info.slice(1);
  const timestamp = /^\d{6}z/.test(text)
    ? (parseTimestamp7(text.slice(0, 7)) ?? undefined)
    : undefined;
  if (timestamp) text = text.slice(7);

  const out: AprsData = { type: "status", text: "", timestamp };
  const g = STATUS_GRID.exec(text);
  if (g) {
    const center = gridToLatLon(g[1]!);
    if (center) {
      out.grid = g[1]!.toUpperCase();
      out.gridLat = center.lat;
      out.gridLon = center.lon;
      out.symbol = makeSymbol(g[2]!, g[3]!);
      text = g[4] ?? "";
    }
  }
  out.text = readText(text);
  return out;
}
