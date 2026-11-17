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
}

export function isParseError(v: Incoming | ParseError): v is ParseError {
  return "error" in v && typeof (v as ParseError).error === "string" && "line" in v && !("t" in v);
}

/** Parse one line. Only checks that it is a JSON object with a string `t`. */
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
  if (typeof o.t !== "string") return { error: "missing t", line };
  // A non-integer id is treated as absent (§6.1).
  if ("id" in o && !Number.isInteger(o.id)) delete o.id;
  return o as Incoming;
}
