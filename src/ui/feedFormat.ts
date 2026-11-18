// Feed tab logic that does not touch the DOM (so that it can be tested in node): names, one-line
// summaries, detail rows, filtering, file names and the export formats.

import { cardinal, formatLatLon, NO_VALUE } from "../aprs/geo.ts";
import { symbolName } from "../aprs/symbols.ts";
import {
  packetProblem,
  type AprsData,
  type AprsPacket,
  type AprsSymbol,
  type PathEntry,
  type Position,
  type Timestamp,
  type WeatherData,
} from "../aprs/types.ts";
import type { RxMsg } from "../protocol/types.ts";
import type { FeedItem } from "../store/state.ts";
import { fmtClock, fmtDb } from "./format.ts";

// ---- categories and names ------------------------------------------------------------------

export type FeedCategory =
  | "position"
  | "mice"
  | "object"
  | "weather"
  | "message"
  | "status"
  | "telemetry"
  | "other"
  | "unknown";

/** Filter choices in the order they are shown. */
export const CATEGORY_OPTIONS: readonly { value: FeedCategory; label: string }[] = [
  { value: "position", label: "Position" },
  { value: "mice", label: "Mic-E" },
  { value: "object", label: "Object / item" },
  { value: "weather", label: "Weather" },
  { value: "message", label: "Message" },
  { value: "status", label: "Status" },
  { value: "telemetry", label: "Telemetry" },
  { value: "other", label: "Other" },
  { value: "unknown", label: "Unreadable" },
];

/** The group a packet belongs to, for the type filter. */
export function feedCategory(p: AprsPacket): FeedCategory {
  if (p.error !== undefined) return "unknown";
  const d: AprsData = p.data;
  switch (d.type) {
    case "position":
      return d.position.weather ? "weather" : "position";
    case "mice":
      return "mice";
    case "object":
    case "item":
      return "object";
    case "weather":
      return "weather";
    case "message":
      return "message";
    case "status":
      return "status";
    case "telemetry":
    case "telemetry-def":
      return "telemetry";
    case "thirdparty":
    case "nmea":
    case "capabilities":
    case "query":
      return "other";
    case "unknown":
      return "unknown";
    default: {
      const never: never = d;
      void never;
      return "other";
    }
  }
}

/** A short human-readable name of the packet type ("position", "mic-e", "ack", ...). */
export function kindLabel(p: AprsPacket): string {
  if (p.error !== undefined) return "invalid";
  const d: AprsData = p.data;
  switch (d.type) {
    case "position":
      return d.position.weather ? "weather" : "position";
    case "mice":
      return "mic-e";
    case "object":
      return "object";
    case "item":
      return "item";
    case "weather":
      return "weather";
    case "message":
      if (d.reply) return d.reply;
      return d.bulletin ? "bulletin" : "message";
    case "status":
      return "status";
    case "telemetry":
      return "telemetry";
    case "telemetry-def":
      return `telemetry ${d.kind.toLowerCase()}`;
    case "thirdparty":
      return "3rd party";
    case "nmea":
      return "NMEA";
    case "capabilities":
      return "capabilities";
    case "query":
      return "query";
    case "unknown":
      return "unknown";
    default: {
      const never: never = d;
      void never;
      return "unknown";
    }
  }
}

/** "rx", "tx" or "tx dry" (a dry run was not sent over the air). */
export function directionLabel(item: FeedItem): string {
  if (item.kind === "rx") return "rx";
  return item.msg.t === "tx" && item.msg.dry ? "tx dry" : "tx";
}

function rxMsg(item: FeedItem): RxMsg | undefined {
  return item.msg.t === "rx" ? item.msg : undefined;
}

/** The sending station: what the device reported, else what the line says. */
export function feedSource(item: FeedItem): string {
  return rxMsg(item)?.src || item.parsed.tnc2?.src || NO_VALUE;
}

// ---- small formatters ------------------------------------------------------------------------

/** A number with at most `digits` decimals and no trailing zeros ("3.20" -> "3.2", "-0.0" -> "0"). */
export function num(v: number, digits = 1): string {
  if (!Number.isFinite(v)) return NO_VALUE;
  return String(Number(v.toFixed(digits)));
}

/** Collapse whitespace and control characters, and cut long text. */
export function oneLine(s: string, max = 200): string {
  // eslint-disable-next-line no-control-regex
  const t = s.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function decimalPos(lat: number, lon: number, digits: number): string {
  return `${lat.toFixed(digits)}, ${lon.toFixed(digits)}`;
}

function fmtSymbol(s: AprsSymbol): string {
  return `${symbolName(s)} (${s.table}${s.code}${s.overlay ?? ""})`;
}

const p2 = (n: number): string => String(n).padStart(2, "0");

export function fmtTimestamp(t: Timestamp): string {
  const date =
    t.month !== undefined && t.day !== undefined
      ? `${p2(t.month)}-${p2(t.day)} `
      : t.day !== undefined
        ? `day ${p2(t.day)} `
        : "";
  const time = `${p2(t.hour)}:${p2(t.minute)}${t.second !== undefined ? `:${p2(t.second)}` : ""}`;
  const zone = t.format === "dhm-local" ? " (local)" : t.format === "mdhm" ? "" : " UTC";
  return `${date}${time}${zone}`;
}

/** Digipeater path as TNC2 shows it: the last used entry carries `*`. */
export function fmtPath(path: readonly PathEntry[]): string {
  if (path.length === 0) return "direct";
  let star = -1;
  path.forEach((e, i) => {
    if (e.used && !e.qConstruct) star = i;
  });
  return path.map((e, i) => (i === star ? `${e.call}*` : e.call)).join(",");
}

function fmtDirectivity(deg: number | null): string {
  return deg === null ? "omni" : `${num(deg, 0)}°`;
}

// ---- weather ---------------------------------------------------------------------------------

/**
 * Key values of a weather report on one line ("12.3 °C, 65 %, 1013 hPa, wind 180° 3.2 m/s").
 * Rain is the amount of the last hour (a depth, not a rate). With no wind (speed 0) the direction
 * is left out: APRS sends 000 for it, which would read as a north wind.
 */
export function weatherSummary(w: WeatherData): string {
  const parts: string[] = [];
  if (w.tempC !== undefined) parts.push(`${num(w.tempC)} °C`);
  if (w.humidity !== undefined) parts.push(`${num(w.humidity, 0)} %`);
  if (w.pressureHpa !== undefined) parts.push(`${num(w.pressureHpa)} hPa`);
  if (w.windSpeedMs !== undefined || w.windDirDeg !== undefined) {
    const calm = w.windSpeedMs === 0;
    const dir = !calm && w.windDirDeg !== undefined ? `${num(w.windDirDeg, 0)}° ` : "";
    const speed = w.windSpeedMs === undefined ? "" : calm ? "calm" : `${num(w.windSpeedMs)} m/s`;
    const gust = w.gustMs !== undefined ? ` (gust ${num(w.gustMs)} m/s)` : "";
    parts.push(`wind ${dir}${speed}${gust}`.trim());
  } else if (w.gustMs !== undefined) {
    parts.push(`gust ${num(w.gustMs)} m/s`);
  }
  if (w.rain1hMm !== undefined) parts.push(`rain ${num(w.rain1hMm)} mm (1 h)`);
  return parts.length > 0 ? parts.join(", ") : "no values";
}

export interface DetailRow {
  label: string;
  value: string;
}

function weatherRows(w: WeatherData): DetailRow[] {
  const rows: DetailRow[] = [];
  const add = (label: string, v: number | undefined, unit: string, digits = 1): void => {
    if (v !== undefined) rows.push({ label, value: `${num(v, digits)} ${unit}` });
  };
  // No wind: the direction field is 000 and means nothing.
  if (w.windDirDeg !== undefined && w.windSpeedMs !== 0) {
    rows.push({ label: "Wind direction", value: `${num(w.windDirDeg, 0)}°` });
  }
  add("Wind speed", w.windSpeedMs, "m/s");
  add("Gust", w.gustMs, "m/s");
  add("Temperature", w.tempC, "°C");
  add("Rain, last hour", w.rain1hMm, "mm");
  add("Rain, 24 hours", w.rain24hMm, "mm");
  add("Rain, since midnight", w.rainMidnightMm, "mm");
  add("Humidity", w.humidity, "%", 0);
  add("Pressure", w.pressureHpa, "hPa");
  add("Luminosity", w.luminosityWm2, "W/m²", 0);
  add("Snow, 24 hours", w.snowMm, "mm");
  if (w.extra) rows.push({ label: "Weather unit", value: oneLine(w.extra) });
  return rows;
}

// ---- summaries -------------------------------------------------------------------------------

function positionBrief(pos: Position): string {
  const parts = [decimalPos(pos.lat, pos.lon, 4)];
  if (pos.speedKmh !== undefined && pos.speedKmh > 0) parts.push(`${num(pos.speedKmh, 0)} km/h`);
  return parts.join(" · ");
}

/** One line that says what the packet is about (position, message text, weather values, ...). */
export function summarize(p: AprsPacket): string {
  if (p.error !== undefined) return oneLine(p.error);
  const d: AprsData = p.data;
  switch (d.type) {
    case "position": {
      const w = d.position.weather;
      const base = w ? weatherSummary(w) : positionBrief(d.position);
      return d.position.comment && !w ? `${base} · ${oneLine(d.position.comment)}` : base;
    }
    case "mice": {
      const parts = [positionBrief(d.position)];
      if (d.message) parts.push(d.message.name);
      if (d.position.comment) parts.push(oneLine(d.position.comment));
      return parts.join(" · ");
    }
    case "object":
    case "item": {
      const state = d.live ? "" : " (killed)";
      const base = `${oneLine(d.name, 20)}${state} · ${positionBrief(d.position)}`;
      return d.position.comment ? `${base} · ${oneLine(d.position.comment)}` : base;
    }
    case "weather":
      return weatherSummary(d.weather);
    case "message": {
      const to = `to ${oneLine(d.addressee, 20)}`;
      if (d.reply) return `${to}: ${d.reply} ${d.msgNo ?? ""}`.trim();
      return `${to}: ${oneLine(d.text)}`;
    }
    case "status": {
      const parts = [oneLine(d.text)];
      if (d.grid) parts.push(d.grid);
      return parts.filter((s) => s !== "").join(" · ") || "(empty)";
    }
    case "telemetry": {
      const a = d.analog.map((v) => (v === undefined ? NO_VALUE : num(v, 2))).join(", ");
      return `#${d.seq}: ${a}`;
    }
    case "telemetry-def": {
      const what = `${oneLine(d.addressee, 20)} ${d.kind}`;
      if (d.names && d.names.length > 0) return `${what}: ${oneLine(d.names.join(", "))}`;
      if (d.title) return `${what}: ${oneLine(d.title)}`;
      if (d.bits) return `${what}: ${d.bits}`;
      return what;
    }
    case "thirdparty":
      return d.inner ? `via ${summarize(d.inner)}` : "third-party packet (unreadable)";
    case "nmea":
      return oneLine(d.sentence);
    case "capabilities":
    case "query":
      return oneLine(d.text);
    case "unknown":
      return packetProblem(p) ?? "unknown packet";
    default: {
      const never: never = d;
      void never;
      return "";
    }
  }
}

// ---- detail rows -----------------------------------------------------------------------------

function positionRows(pos: Position): DetailRow[] {
  const rows: DetailRow[] = [
    {
      label: "Position",
      value: `${decimalPos(pos.lat, pos.lon, 5)} (${formatLatLon({ lat: pos.lat, lon: pos.lon })})`,
    },
  ];
  if (pos.ambiguity > 0) {
    rows.push({
      label: "Ambiguity",
      value: `${pos.ambiguity} digit${pos.ambiguity > 1 ? "s" : ""}`,
    });
  }
  rows.push({ label: "Symbol", value: fmtSymbol(pos.symbol) });
  if (pos.compressed) rows.push({ label: "Encoding", value: "compressed" });
  if (pos.speedKmh !== undefined) rows.push({ label: "Speed", value: `${num(pos.speedKmh)} km/h` });
  if (pos.courseDeg !== undefined) {
    rows.push({ label: "Course", value: `${num(pos.courseDeg, 0)}° ${cardinal(pos.courseDeg)}` });
  }
  if (pos.altitudeM !== undefined) {
    rows.push({ label: "Altitude", value: `${num(pos.altitudeM, 0)} m` });
  }
  if (pos.rangeM !== undefined) {
    rows.push({ label: "Range", value: `${num(pos.rangeM / 1000)} km` });
  }
  if (pos.phg) {
    const g = pos.phg;
    rows.push({
      label: "PHG",
      value: `${num(g.powerW, 0)} W, ${num(g.heightM, 0)} m, ${num(g.gainDb, 0)} dB, ${fmtDirectivity(g.directivityDeg)}`,
    });
  }
  if (pos.dfs) {
    const g = pos.dfs;
    rows.push({
      label: "DFS",
      value: `strength ${g.strength}, ${num(g.heightM, 0)} m, ${num(g.gainDb, 0)} dB, ${fmtDirectivity(g.directivityDeg)}`,
    });
  }
  if (pos.dao) rows.push({ label: "DAO", value: "yes (extra position precision)" });
  if (pos.telemetry) {
    const t = pos.telemetry;
    const digital = t.digital !== undefined ? `, digital ${t.digital}` : "";
    rows.push({
      label: "Telemetry",
      value: `#${t.seq}: ${t.analog.map((v) => num(v, 2)).join(", ")}${digital}`,
    });
  }
  if (pos.weather) rows.push(...weatherRows(pos.weather));
  if (pos.comment) rows.push({ label: "Comment", value: pos.comment });
  return rows;
}

function dataRows(p: AprsPacket, prefix: string): DetailRow[] {
  const d: AprsData = p.data;
  const rows: DetailRow[] = [];
  const add = (label: string, value: string): void => {
    rows.push({ label: `${prefix}${label}`, value });
  };
  const addAll = (more: DetailRow[]): void => {
    for (const r of more) add(r.label, r.value);
  };
  switch (d.type) {
    case "position":
      if (d.timestamp) add("Time", fmtTimestamp(d.timestamp));
      if (d.messaging) add("Messaging", "yes");
      addAll(positionRows(d.position));
      break;
    case "mice":
      add("Mic-E message", d.message ? d.message.name : "not valid");
      if (d.typeCode) add("Type code", d.typeCode);
      addAll(positionRows(d.position));
      break;
    case "object":
    case "item":
      add("Name", d.name);
      add("State", d.live ? "live" : "killed");
      if (d.type === "object" && d.timestamp) add("Time", fmtTimestamp(d.timestamp));
      addAll(positionRows(d.position));
      break;
    case "weather":
      if (d.timestamp) add("Time", fmtTimestamp(d.timestamp));
      addAll(weatherRows(d.weather));
      break;
    case "message":
      add("To", d.addressee);
      if (d.reply) add("Reply", d.reply);
      else add("Text", d.text);
      if (d.msgNo !== undefined) add("Message no.", d.msgNo);
      if (d.replyAck !== undefined) add("Also acknowledges", d.replyAck);
      if (d.bulletin) add("Bulletin", "yes");
      break;
    case "status":
      add("Text", d.text || "(empty)");
      if (d.timestamp) add("Time", fmtTimestamp(d.timestamp));
      if (d.grid) add("Grid", d.grid);
      if (d.gridLat !== undefined && d.gridLon !== undefined) {
        add("Grid centre", `${decimalPos(d.gridLat, d.gridLon, 3)} (approximate)`);
      }
      if (d.symbol) add("Symbol", fmtSymbol(d.symbol));
      break;
    case "telemetry":
      add("Sequence", String(d.seq));
      add("Analog", d.analog.map((v) => (v === undefined ? NO_VALUE : num(v, 3))).join(", "));
      if (d.digital) add("Digital", d.digital.map((b) => (b ? "1" : "0")).join(""));
      if (d.comment) add("Comment", d.comment);
      break;
    case "telemetry-def":
      add("To", d.addressee);
      add("Definition", d.kind);
      if (d.names) add("Values", d.names.join(", "));
      if (d.eqns) {
        d.eqns.forEach((e, i) => {
          add(
            `Channel ${i + 1}`,
            e ? `a=${num(e.a, 6)} b=${num(e.b, 6)} c=${num(e.c, 6)}` : NO_VALUE,
          );
        });
      }
      if (d.bits !== undefined) add("Bits", d.bits);
      if (d.title) add("Title", d.title);
      break;
    case "thirdparty":
      if (d.inner) rows.push(...packetRows(d.inner, `${prefix}Inner `));
      else add("Inner packet", "unreadable");
      break;
    case "nmea":
      add("Sentence", d.sentence);
      break;
    case "capabilities":
    case "query":
      add("Text", d.text);
      break;
    case "unknown":
      if (d.dataType) add("Data type", d.dataType);
      break;
    default: {
      const never: never = d;
      void never;
    }
  }
  return rows;
}

/** From / to / path, then the type-specific fields. `prefix` marks an inner (third-party) packet. */
export function packetRows(p: AprsPacket, prefix = ""): DetailRow[] {
  const rows: DetailRow[] = [];
  if (p.tnc2) {
    rows.push({ label: `${prefix}From`, value: p.tnc2.src });
    rows.push({ label: `${prefix}Destination`, value: p.tnc2.dst });
    rows.push({ label: `${prefix}Path`, value: fmtPath(p.tnc2.path) });
  }
  rows.push(...dataRows(p, prefix));
  if (prefix !== "") {
    const problem = packetProblem(p);
    if (problem) rows.push({ label: `${prefix}Problem`, value: problem });
  }
  return rows;
}

/** Local "YYYY-MM-DD HH:MM:SS". */
export function fmtDateTime(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${fmtClock(at)}`;
}

/** Everything shown when a row is opened, except the raw line and the problem text. */
export function detailRows(item: FeedItem): DetailRow[] {
  const rows: DetailRow[] = [
    { label: "Received", value: fmtDateTime(item.at) },
    { label: "Direction", value: directionLabel(item) },
  ];
  const rx = rxMsg(item);
  if (rx) {
    if (rx.lvl_db !== undefined) rows.push({ label: "Level", value: fmtDb(rx.lvl_db) });
    if (rx.clip) rows.push({ label: "Clipping", value: "yes (input was too loud)" });
    if (rx.kind) rows.push({ label: "Device type", value: rx.kind });
  }
  if (item.msg.utc) rows.push({ label: "Device time", value: item.msg.utc });
  rows.push(...packetRows(item.parsed));
  return rows;
}

// ---- filtering -------------------------------------------------------------------------------

export interface FeedFilter {
  dir: "all" | "rx" | "tx";
  category: "all" | FeedCategory;
  /** Substring of the source callsign, case-insensitive. */
  source: string;
}

export const NO_FILTER: FeedFilter = { dir: "all", category: "all", source: "" };

export function isFiltering(f: FeedFilter): boolean {
  return f.dir !== "all" || f.category !== "all" || f.source.trim() !== "";
}

export function matchesFilter(item: FeedItem, f: FeedFilter): boolean {
  if (f.dir !== "all" && item.kind !== f.dir) return false;
  if (f.category !== "all" && feedCategory(item.parsed) !== f.category) return false;
  const q = f.source.trim().toUpperCase();
  if (q !== "" && !feedSource(item).toUpperCase().includes(q)) return false;
  return true;
}

/**
 * The newest `max` items that match, oldest first, and how many match in all. Walks the feed
 * from the end once; with no filter it does not look at the items at all.
 */
export function selectItems(
  items: readonly FeedItem[],
  f: FeedFilter,
  max: number,
): { shown: FeedItem[]; matched: number } {
  if (!isFiltering(f)) return { shown: items.slice(-max), matched: items.length };
  const shown: FeedItem[] = [];
  let matched = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (!matchesFilter(it, f)) continue;
    matched++;
    if (shown.length < max) shown.push(it);
  }
  return { shown: shown.reverse(), matched };
}

// ---- export ----------------------------------------------------------------------------------

/** `pico2aprs-feed-YYYYMMDD-HHMMSS.<ext>` in local time. */
export function exportFileName(now: Date, ext: "json" | "txt"): string {
  const date = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}`;
  const time = `${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
  return `pico2aprs-feed-${date}-${time}.${ext}`;
}

export interface Tnc2Options {
  /**
   * Also write this tracker's own transmissions (`tx`, dry runs included), each after a comment
   * line. Off by default: a TNC2 log has no direction and no time, so a beacon that was only
   * sent (or only tried as a dry run) would look like a received packet in another tool.
   */
  includeTx?: boolean;
}

/** The items a TNC2 log written with `opts` contains. */
export function tnc2Items(items: readonly FeedItem[], opts: Tnc2Options = {}): FeedItem[] {
  return items.filter((i) => i.kind === "rx" || opts.includeTx === true);
}

/**
 * One packet per line, as the device sent it (`<0xHH>` kept as is). Only packets that were
 * received (rx) unless `includeTx`; a tx line is then preceded by `# tx` or `# tx (dry run)`.
 */
export function buildTnc2Log(items: readonly FeedItem[], opts: Tnc2Options = {}): string {
  const lines: string[] = [];
  for (const i of tnc2Items(items, opts)) {
    if (i.kind === "tx") lines.push(i.msg.t === "tx" && i.msg.dry ? "# tx (dry run)" : "# tx");
    lines.push(i.msg.tnc2.replace(/[\r\n]+/g, " "));
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/**
 * The feed as JSON. Each item has the app's `seq`, `dir`, `at` (UTC) and parsed `type`, and the
 * device's message, untouched except for `t`, under `msg` (so a key the firmware adds later can
 * never overwrite one of the app's).
 */
export function buildFeedJson(items: readonly FeedItem[], now: Date): string {
  const out = items.map((i) => {
    const { t, ...msg } = i.msg;
    void t;
    return {
      seq: i.seq,
      dir: i.kind,
      at: new Date(i.at).toISOString(),
      type: i.parsed.data.type,
      msg,
    };
  });
  return JSON.stringify(
    {
      format: "pico2aprs-feed",
      version: 1,
      exportedAt: now.toISOString(),
      count: out.length,
      items: out,
    },
    null,
    2,
  );
}
