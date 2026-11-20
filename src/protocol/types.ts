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
  "beacon.send",
  "msg.send",
  "msg.list",
  "msg.cancel",
] as const;
export type Op = (typeof OPS)[number];

export type SettingValue = string | number | boolean | null | string[];
export type SettingsValues = Record<string, SettingValue>;

export interface Request {
  op: Op;
  id?: number;
  values?: SettingsValues;
  /** `msg.send`: the addressee (§7.6). */
  to?: string;
  /** `msg.send`: the message text (§7.6). */
  text?: string;
  /** `msg.cancel`: the message number (§7.8). */
  no?: string;
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
  /** The `beacon_mode` setting: "auto" or "manual" (§8.1). */
  beacon_mode?: string;
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
  /** Messages received for this device since the last `msg.list` (§8.1). */
  msg_unread?: number;
  /** Messages sent by the app that are still `pending` (§8.1). */
  msg_pending?: number;
  /** Whether the channel is judged busy now (§7.9). A change does not trigger an event. */
  ch_busy?: boolean;
}

export interface RxMsg {
  t: "rx";
  tnc2: string;
  /** The sending station (the inner sender for third-party traffic), §8.2. */
  src?: string;
  /** Object or item name; only when `kind` is "object" or "item" (§8.2). */
  obj?: string;
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

/** The answer to `beacon.send` (§7.5). The packet itself follows as a `tx` event. */
export interface BeaconMsg {
  t: "beacon";
  id?: number;
  /** Always present (§8.7). True when the transmit gate refused: recorded, not sent on the air. */
  dry: boolean;
}

/** States of a sent message (§8.8). More may be added: treat an unknown one as ended. */
export const MSG_STATES = [
  "pending",
  "acked",
  "rejected",
  "failed",
  "cancelled",
  "stopped",
] as const;
export type MsgState = (typeof MSG_STATES)[number] | (string & {});

/**
 * One APRS message (§8.8): the answer to `msg.send` and `msg.cancel`, each row of `msg.list`
 * (all with `id`), or an event (no `id`). Provisional in the spec.
 */
export interface MsgMsg {
  t: "msg";
  id?: number;
  /** "in": received, addressed to this device. "out": sent from the app. */
  dir: "in" | "out" | (string & {});
  /** Message number, an opaque string. Always present for "out". */
  no?: string;
  /** "in" only: the sender. */
  src?: string;
  /** "out" only: the addressee. */
  to?: string;
  text?: string;
  /** "out" only. */
  state?: MsgState;
  /** "out" only: transmissions so far. */
  tries?: number;
  utc?: string;
}

export interface MsgEndMsg {
  t: "msg.end";
  id?: number;
  n?: number;
}

export interface StationMsg {
  t: "station";
  id?: number;
  /** Station callsign-SSID, or the object/item name when `obj` is true (§8.4). */
  src: string;
  /** True for an object or item row. */
  obj?: boolean;
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
  /** For "str": the only accepted values (§9.2). Checked where it is used. */
  choices?: unknown;
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
  "switch_off",
  "no_fix",
  "too_soon",
  "frame_too_long",
  "tx_not_ready",
  "queue_full",
  "unknown_msg",
] as const;
export type ErrCode = (typeof KNOWN_ERR_CODES)[number] | (string & {});

export interface ErrMsg {
  t: "err";
  id?: number;
  code: ErrCode;
  key?: string;
  msg?: string;
  /** `too_soon`: seconds left before `beacon.send` is accepted again. */
  wait_s?: number;
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
  | BeaconMsg
  | StationMsg
  | StationsEndMsg
  | MsgMsg
  | MsgEndMsg
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
      "msg_unread",
      "msg_pending",
    ],
    bool: ["sw", "tx_enabled", "tx_ready", "ch_busy"],
    str: ["utc", "tx_refuse", "call", "sd", "beacon_mode"],
  },
  rx: {
    required: ["tnc2"],
    str: ["tnc2", "src", "kind", "sym", "utc"],
    num: ["lat", "lon", "lvl_db"],
    bool: ["clip"],
  },
  tx: { required: ["tnc2"], str: ["tnc2", "utc"], bool: ["dry"] },
  beacon: { required: ["dry"], bool: ["dry"] },
  station: {
    required: ["src"],
    str: ["src"],
    num: ["last_s", "count", "lat", "lon", "lvl_db"],
    bool: ["own"],
  },
  "stations.end": { num: ["n"] },
  msg: {
    required: ["dir"],
    str: ["dir", "no", "src", "to", "text", "state", "utc"],
    num: ["tries"],
  },
  "msg.end": { num: ["n"] },
  err: { required: ["code"], str: ["code", "key", "msg"], num: ["wait_s"] },
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
