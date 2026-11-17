// Message types for ble-protocol.md §6-§9 (proto 1).
// Unknown keys and unknown kinds are tolerated; omitted values are undefined.

export const PROTO_VERSION = 1;

export const OPS = [
  "hello",
  "status",
  "settings.schema",
  "settings.get",
  "settings.set",
  "settings.reset",
  "stations.list",
] as const;
export type Op = (typeof OPS)[number];

export type SettingValue = string | number | boolean | null | string[];
export type SettingsValues = Record<string, SettingValue>;

export interface Request {
  op: Op;
  id?: number;
  values?: SettingsValues;
}

export interface HelloMsg {
  t: "hello";
  id?: number;
  proto: number;
  name?: string;
  mode?: string;
}

export interface StatusMsg {
  t: "status";
  id?: number;
  utc?: string;
  fix?: number;
  sats?: number;
  lat?: number;
  lon?: number;
  sw?: boolean;
  tx_enabled?: boolean;
  tx_ready?: boolean;
  tx_refuse?: string;
  call?: string;
  last_tx_s?: number;
  next_beacon_s?: number;
  rx_count?: number;
  tx_count?: number;
  lvl_db?: number;
  sd?: string;
  dropped?: number;
}

export interface RxMsg {
  t: "rx";
  tnc2: string;
  src?: string;
  kind?: string;
  lat?: number;
  lon?: number;
  sym?: string;
  lvl_db?: number;
  clip?: boolean;
  utc?: string;
}

export interface TxMsg {
  t: "tx";
  tnc2: string;
  dry?: boolean;
  utc?: string;
}

export interface StationMsg {
  t: "station";
  id?: number;
  src: string;
  last_s?: number;
  count?: number;
  lat?: number;
  lon?: number;
  lvl_db?: number;
  own?: boolean;
}

export interface StationsEndMsg {
  t: "stations.end";
  id?: number;
  n?: number;
}

export type SchemaType = "str" | "int" | "float" | "bool" | "list";

export interface SchemaItem {
  key: string;
  desc?: string;
  type: SchemaType | string;
  nullable?: boolean;
  min?: number;
  max?: number;
  len?: number;
  max_len?: number;
  max_items?: number;
  pattern?: string;
}

export interface SchemaMsg {
  t: "schema";
  id?: number;
  items: SchemaItem[];
}

export interface SettingsMsg {
  t: "settings";
  id?: number;
  values: SettingsValues;
  changed?: string[];
}

export const KNOWN_ERR_CODES = [
  "bad_json",
  "too_long",
  "busy",
  "unknown_op",
  "invalid",
  "io",
  "internal",
] as const;
export type ErrCode = (typeof KNOWN_ERR_CODES)[number] | (string & {});

export interface ErrMsg {
  t: "err";
  id?: number;
  code: ErrCode;
  key?: string;
  msg?: string;
}

export interface UnknownMsg {
  t: string;
  id?: number;
  [key: string]: unknown;
}

export type Incoming =
  | HelloMsg
  | StatusMsg
  | RxMsg
  | TxMsg
  | StationMsg
  | StationsEndMsg
  | SchemaMsg
  | SettingsMsg
  | ErrMsg
  | UnknownMsg;

export const RX_KINDS = [
  "position",
  "mice",
  "object",
  "item",
  "message",
  "status",
  "other",
] as const;
export type RxKind = (typeof RX_KINDS)[number];

/** Map an unknown or missing kind to "other" (§8.2). */
export function rxKind(msg: { kind?: unknown }): RxKind {
  const k = msg.kind;
  return typeof k === "string" && (RX_KINDS as readonly string[]).includes(k)
    ? (k as RxKind)
    : "other";
}

export interface ParseError {
  error: string;
  line: string;
  /** The `id` of the line when it was readable enough to have one (a malformed reply). */
  id?: number;
}

export function isParseError(v: Incoming | ParseError): v is ParseError {
  return "error" in v && typeof (v as ParseError).error === "string" && "line" in v && !("t" in v);
}

// Minimal per-type checks (§8). A key that is present must have the documented type; `null` is
// not allowed (a missing value is omitted, §6.1). Unknown keys and unknown `t` pass.
interface Shape {
  required?: string[];
  str?: string[];
  num?: string[];
  bool?: string[];
}

const SHAPES: Record<string, Shape> = {
  hello: { required: ["proto"], num: ["proto"], str: ["name", "mode"] },
  status: {
    num: [
      "fix",
      "sats",
      "lat",
      "lon",
      "last_tx_s",
      "next_beacon_s",
      "rx_count",
      "tx_count",
      "lvl_db",
      "dropped",
    ],
    bool: ["sw", "tx_enabled", "tx_ready"],
    str: ["utc", "tx_refuse", "call", "sd"],
  },
  rx: {
    required: ["tnc2"],
    str: ["tnc2", "src", "kind", "sym", "utc"],
    num: ["lat", "lon", "lvl_db"],
    bool: ["clip"],
  },
  tx: { required: ["tnc2"], str: ["tnc2", "utc"], bool: ["dry"] },
  station: {
    required: ["src"],
    str: ["src"],
    num: ["last_s", "count", "lat", "lon", "lvl_db"],
    bool: ["own"],
  },
  "stations.end": { num: ["n"] },
  err: { required: ["code"], str: ["code", "key", "msg"] },
};

function checkShape(o: Record<string, unknown>): string | undefined {
  const shape = SHAPES[o.t as string];
  if (shape) {
    for (const k of shape.required ?? []) if (!(k in o)) return `missing ${k}`;
    const kinds: [string[] | undefined, (v: unknown) => boolean, string][] = [
      [shape.str, (v) => typeof v === "string", "a string"],
      [shape.num, (v) => typeof v === "number" && Number.isFinite(v), "a finite number"],
      [shape.bool, (v) => typeof v === "boolean", "a boolean"],
    ];
    for (const [keys, ok, what] of kinds) {
      for (const k of keys ?? []) {
        if (k in o && !ok(o[k])) return `${o.t as string}.${k} must be ${what}`;
      }
    }
  }
  if (o.t === "schema") {
    const items = o.items;
    if (
      !Array.isArray(items) ||
      !items.every(
        (i: unknown) =>
          typeof i === "object" &&
          i !== null &&
          typeof (i as SchemaItem).key === "string" &&
          typeof (i as SchemaItem).type === "string",
      )
    ) {
      return "schema.items must be a list of items with key and type";
    }
  } else if (o.t === "settings") {
    const v = o.values;
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      return "settings.values must be an object";
    }
    if (
      "changed" in o &&
      !(Array.isArray(o.changed) && o.changed.every((c) => typeof c === "string"))
    ) {
      return "settings.changed must be a list of strings";
    }
  }
  return undefined;
}

/**
 * Parse one line. Checks that it is a JSON object with a string `t`, and that the keys of the
 * known message types have the documented types.
 */
export function parseMessage(line: string): Incoming | ParseError {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return { error: "invalid JSON", line };
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return { error: "not an object", line };
  }
  const o = v as Record<string, unknown>;
  // A non-integer id is treated as absent (§6.1).
  if ("id" in o && !Number.isInteger(o.id)) delete o.id;
  if (typeof o.t !== "string") return { error: "missing t", line };
  const bad = checkShape(o);
  if (bad !== undefined) {
    return typeof o.id === "number" ? { error: bad, line, id: o.id } : { error: bad, line };
  }
  return o as Incoming;
}
