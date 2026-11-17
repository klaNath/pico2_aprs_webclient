// Result types of the APRS parser. Units are metric (km/h, m, °C, mm, hPa, m/s, degrees).

export interface PathEntry {
  call: string;
  /** True up to and including the last entry that carried `*`. */
  used: boolean;
  /**
   * True for an APRS-IS q construct (`qAR`, `qAC`, `qAo`, ...). It is not a digipeater: it
   * marks how the packet entered APRS-IS, and the entry after it is the IGate. Omitted when false.
   */
  qConstruct?: boolean;
}

export interface Tnc2 {
  /** Callsigns are kept in the case they were received; compare with `toUpperCase()`. */
  src: string;
  dst: string;
  path: PathEntry[];
  /** Information field as a binary string: one char per byte (0-255). */
  info: string;
}

/** A map symbol (named `AprsSymbol` so that it does not hide the global `Symbol`). */
export interface AprsSymbol {
  /** "/" (primary) or "\\" (alternate). */
  table: "/" | "\\";
  code: string;
  /** Overlay character (0-9, A-Z) for the alternate table. */
  overlay?: string;
}

export interface Timestamp {
  format: "dhm-z" | "dhm-local" | "hms" | "mdhm";
  month?: number;
  day?: number;
  hour: number;
  minute: number;
  second?: number;
}

export interface WeatherData {
  windDirDeg?: number;
  windSpeedMs?: number;
  gustMs?: number;
  tempC?: number;
  rain1hMm?: number;
  rain24hMm?: number;
  rainMidnightMm?: number;
  /** 1-100 */
  humidity?: number;
  pressureHpa?: number;
  luminosityWm2?: number;
  snowMm?: number;
  /** Text that follows the fields (software and device codes). */
  extra?: string;
}

export interface CompressedTelemetry {
  seq: number;
  analog: number[];
  digital?: number;
}

export interface Phg {
  powerW: number;
  heightM: number;
  gainDb: number;
  /** Degrees, or null for omnidirectional. */
  directivityDeg: number | null;
}

export interface Dfs {
  strength: number;
  heightM: number;
  gainDb: number;
  directivityDeg: number | null;
}

export interface Eqn {
  a: number;
  b: number;
  c: number;
}

export interface Position {
  lat: number;
  lon: number;
  /** 0-4: number of digits blanked out in the position. */
  ambiguity: number;
  symbol: AprsSymbol;
  compressed: boolean;
  courseDeg?: number;
  speedKmh?: number;
  altitudeM?: number;
  /** Radio range (RNG or compressed cs), in meters. */
  rangeM?: number;
  phg?: Phg;
  dfs?: Dfs;
  /** True when a DAO extension added precision. */
  dao?: boolean;
  /**
   * Weather of a weather-station position. Weather also comes as `type: "weather"` (a report
   * without a position): use `packetWeather()` to get it from either place.
   */
  weather?: WeatherData;
  telemetry?: CompressedTelemetry;
  comment: string;
}

export type MiceMessage =
  | { kind: "standard"; index: number; name: string }
  | { kind: "custom"; index: number; name: string }
  | { kind: "emergency"; name: string };

export type AprsData =
  | {
      type: "position";
      position: Position;
      timestamp?: Timestamp;
      /** True for `=` and `@` (the station can receive messages). */
      messaging: boolean;
    }
  | {
      type: "mice";
      position: Position;
      /** Null when the message bits of the destination are not valid (custom and standard mixed). */
      message: MiceMessage | null;
      /** Leading type character of the comment (`>`, `]`, `` ` `` or `'`), removed from the comment. */
      typeCode?: string;
    }
  | {
      type: "object";
      name: string;
      live: boolean;
      timestamp?: Timestamp;
      position: Position;
    }
  | { type: "item"; name: string; live: boolean; position: Position }
  | {
      type: "message";
      addressee: string;
      text: string;
      msgNo?: string;
      /** Set when the text is an ack or rej of message `msgNo`. */
      reply?: "ack" | "rej";
      /** APRS 1.2 reply-ack: this message also acknowledges message `replyAck` (`Hi{12}34`). */
      replyAck?: string;
      /** True for bulletins and announcements (`BLNn`, `BLNx`) and weather bulletins (`NWS-xxx`). */
      bulletin: boolean;
    }
  | {
      type: "telemetry-def";
      addressee: string;
      kind: "PARM" | "UNIT" | "EQNS" | "BITS";
      names?: string[];
      /** One entry per analog channel; undefined where the equation could not be read. */
      eqns?: (Eqn | undefined)[];
      bits?: string;
      title?: string;
    }
  | {
      type: "status";
      text: string;
      timestamp?: Timestamp;
      grid?: string;
      /** Centre of the locator `grid`, accurate to the size of the square only. */
      gridLat?: number;
      gridLon?: number;
      symbol?: AprsSymbol;
    }
  | { type: "weather"; timestamp?: Timestamp; weather: WeatherData }
  | {
      type: "telemetry";
      seq: number | "MIC";
      analog: (number | undefined)[];
      digital?: boolean[];
      comment: string;
    }
  | { type: "thirdparty"; inner: AprsPacket | null }
  | { type: "nmea"; sentence: string; raw: string }
  | { type: "capabilities"; text: string }
  | { type: "query"; text: string }
  | { type: "unknown"; dataType?: string; reason?: string };

export interface AprsPacket {
  tnc2: Tnc2 | null;
  data: AprsData;
  /**
   * Set when the line is not TNC2 at all (`tnc2` is null). A packet whose header is fine but
   * whose information field cannot be read has `data.type === "unknown"` and the reason in
   * `data.reason`. Use `packetProblem()` to get either.
   */
  error?: string;
}

/**
 * The exact position carried by a packet, if any: position reports, Mic-E, objects, items,
 * and the same inside a third-party packet (the position belongs to the inner station).
 *
 * Not returned: the centre of a status locator (`status.gridLat`/`gridLon`). It is only
 * accurate to a few km and a `Position` would claim more; use `packetLatLon()` for it.
 */
export function packetPosition(p: AprsPacket): Position | undefined {
  const d = p.data;
  if (d.type === "thirdparty") return d.inner ? packetPosition(d.inner) : undefined;
  return d.type === "position" || d.type === "mice" || d.type === "object" || d.type === "item"
    ? d.position
    : undefined;
}

/** A latitude and longitude from a packet, `approximate` when it is a locator centre. */
export function packetLatLon(
  p: AprsPacket,
): { lat: number; lon: number; approximate: boolean } | undefined {
  const pos = packetPosition(p);
  if (pos) return { lat: pos.lat, lon: pos.lon, approximate: false };
  const d = p.data;
  if (d.type === "status" && d.gridLat !== undefined && d.gridLon !== undefined) {
    return { lat: d.gridLat, lon: d.gridLon, approximate: true };
  }
  if (d.type === "thirdparty" && d.inner) return packetLatLon(d.inner);
  return undefined;
}

/** Weather from a weather report or from a weather-station position (also inside a third-party packet). */
export function packetWeather(p: AprsPacket): WeatherData | undefined {
  const d = p.data;
  if (d.type === "weather") return d.weather;
  if (d.type === "thirdparty") return d.inner ? packetWeather(d.inner) : undefined;
  if (d.type === "position" || d.type === "mice" || d.type === "object" || d.type === "item") {
    return d.position.weather;
  }
  return undefined;
}

/** Why a packet could not be read: `error` (not TNC2) or `data.reason` (unknown data), if either. */
export function packetProblem(p: AprsPacket): string | undefined {
  if (p.error !== undefined) return p.error;
  if (p.data.type === "unknown") return p.data.reason ?? "unknown packet";
  return undefined;
}
