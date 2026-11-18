// Known settings items (ble-protocol.md §9.1). Shared by the mock device, and later the settings UI.

import type { SchemaItem, SettingValue, SettingsValues } from "./types.ts";

export const MICE_MESSAGES = [
  "Off Duty",
  "En Route",
  "In Service",
  "Returning",
  "Committed",
  "Special",
  "Priority",
] as const; // 7 (Emergency) cannot be set from the app

export const KNOWN_SETTINGS: readonly SchemaItem[] = [
  {
    key: "callsign",
    desc: "Own callsign without SSID (null = not set, never transmit)",
    type: "str",
    nullable: true,
    pattern: "^[A-Z0-9]{3,6}$",
  },
  { key: "ssid", desc: "SSID", type: "int", min: 0, max: 15 },
  { key: "symbol", desc: "Symbol table and code (2 chars)", type: "str", len: 2 },
  { key: "path", desc: "Digipeater path", type: "list", max_items: 2 },
  { key: "comment", desc: "Beacon comment", type: "str", max_len: 40 },
  { key: "mice_message", desc: "Mic-E message (0-6)", type: "int", min: 0, max: 6 },
  {
    key: "beacon_moving_s",
    desc: "Beacon interval while moving (s)",
    type: "int",
    min: 30,
    max: 3600,
  },
  {
    key: "beacon_still_s",
    desc: "Beacon interval while still (s)",
    type: "int",
    min: 60,
    max: 7200,
  },
  {
    key: "beacon_move_m",
    desc: "Distance counted as moving (m)",
    type: "float",
    min: 1,
    max: 1000,
  },
  {
    key: "tx_enabled",
    desc: "Transmit permission (the beacon switch must also be on)",
    type: "bool",
  },
  { key: "fx25_tx", desc: "Transmit with FX.25", type: "bool" },
];

// ---- Validation (§9.1) ----------------------------------------------------------------------
// The client checks values before sending; the device still makes the final decision (§9.2).
// Ranges come from KNOWN_SETTINGS, so there is one definition. Extra rules that the schema cannot
// express (a digit in the callsign, the symbol table, the path entry format) are written below.

export type SettingCheck = { value: SettingValue } | { error: string };

const KNOWN_BY_KEY: ReadonlyMap<string, SchemaItem> = new Map(
  KNOWN_SETTINGS.map((i) => [i.key, i]),
);

function range(item: SchemaItem): string {
  return item.min !== undefined && item.max !== undefined ? ` ${item.min}-${item.max}` : "";
}

/** Check a value against one schema item (type, finite number, range, length, nullable). */
function checkItem(item: SchemaItem, v: unknown): SettingCheck {
  if (v === null) {
    return item.nullable ? { value: null } : { error: `${item.type} required, not null` };
  }
  switch (item.type) {
    case "int":
    case "float": {
      const isInt = item.type === "int";
      const ok = typeof v === "number" && (isInt ? Number.isInteger(v) : Number.isFinite(v));
      if (
        !ok ||
        (item.min !== undefined && v < item.min) ||
        (item.max !== undefined && v > item.max)
      ) {
        return { error: `${isInt ? "integer" : "number"}${range(item)}` };
      }
      return { value: v };
    }
    case "bool":
      return typeof v === "boolean" ? { value: v } : { error: "boolean" };
    case "str": {
      if (typeof v !== "string") return { error: "string" };
      if (item.len !== undefined && v.length !== item.len) {
        return { error: `${item.len} characters` };
      }
      if (item.max_len !== undefined && v.length > item.max_len) {
        return { error: `at most ${item.max_len} characters` };
      }
      if (item.pattern !== undefined) {
        let re: RegExp | undefined;
        try {
          re = new RegExp(item.pattern);
        } catch {
          re = undefined; // a pattern is only a guide (§9.2)
        }
        if (re && !re.test(v)) return { error: `must match ${item.pattern}` };
      }
      return { value: v };
    }
    case "list": {
      if (!Array.isArray(v) || !v.every((e) => typeof e === "string")) {
        return { error: "list of strings" };
      }
      if (item.max_items !== undefined && v.length > item.max_items) {
        return { error: `at most ${item.max_items} entries` };
      }
      return { value: [...(v as string[])] };
    }
    default:
      return { error: `unsupported type ${String(item.type)}` };
  }
}

/**
 * Validate one value and return it normalized (`path` entries are upper-cased, §9.1; a `callsign`
 * is never altered: it must already be upper case and without spaces, so that what the user
 * confirmed is exactly what is sent). Items that are not known to the app are checked against
 * `schema` (the device's `settings.schema`) when given, and are otherwise rejected.
 */
export function validateSetting(
  key: string,
  v: unknown,
  schema: readonly SchemaItem[] = [],
): SettingCheck {
  const known = KNOWN_BY_KEY.get(key);
  if (!known) {
    const item = schema.find((i) => i.key === key);
    return item ? checkItem(item, v) : { error: "unknown item" };
  }
  switch (key) {
    case "callsign": {
      const r = checkItem(known, v);
      if ("error" in r) return { error: "3-6 chars A-Z 0-9 with a digit, or null" };
      if (typeof r.value === "string" && !/\d/.test(r.value)) {
        return { error: "3-6 chars A-Z 0-9 with a digit, or null" };
      }
      return r;
    }
    case "symbol": {
      const r = checkItem(known, v);
      const s = "value" in r ? r.value : undefined;
      if (
        typeof s === "string" &&
        /^[/\\0-9A-Z]$/.test(s[0]!) &&
        s.charCodeAt(1) >= 0x21 &&
        s.charCodeAt(1) <= 0x7e
      ) {
        return r;
      }
      return { error: "2 chars: table (/ \\ 0-9 A-Z) + code (! to ~)" };
    }
    case "path": {
      const r = checkItem(known, v);
      if ("error" in r) return { error: "list of 0-2 strings" };
      const up = (r.value as string[]).map((e) => e.toUpperCase());
      if (!up.every((e) => /^[A-Z0-9]{1,6}(-([0-9]|1[0-5]))?$/.test(e))) {
        return { error: "entries like WIDE1-1" };
      }
      return { value: up };
    }
    case "comment": {
      const r = checkItem(known, v);
      if ("error" in r || !/^[\x20-\x7e]*$/.test(r.value as string)) {
        return { error: "printable ASCII, 0-40 chars" };
      }
      return r;
    }
    default:
      return checkItem(known, v);
  }
}

/** Equality for setting values (null, scalars, and lists of strings). */
export function settingEquals(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((e, i) => e === b[i]);
  }
  return a === b;
}

/**
 * Validate and normalize a set of changes. `undefined` values are ignored. Returns the first
 * error with its key, or the normalized values.
 */
export function normalizeSettings(
  values: unknown,
  schema: readonly SchemaItem[] = [],
): { values: SettingsValues } | { key: string; error: string } {
  if (typeof values !== "object" || values === null || Array.isArray(values)) {
    return { key: "values", error: "object required" };
  }
  const out: SettingsValues = {};
  for (const [key, v] of Object.entries(values)) {
    if (v === undefined) continue;
    const r = validateSetting(key, v, schema);
    if ("error" in r) return { key, error: r.error };
    out[key] = r.value;
  }
  return { values: out };
}

/** Changes that the UI must have the user confirm before they are sent (CLAUDE.md, transmit safety). */
export type SettingsRisk = "tx_enable" | "callsign" | "ssid";

/**
 * Which confirmations does this change need, given the values the device has now?
 * - `tx_enable`: `tx_enabled` goes to true
 * - `callsign`: the callsign changes (including to null)
 * - `ssid`: the SSID changes. Always, whether or not transmitting is allowed: the SSID is part of the
 *   identity on the air (CALL-SSID), so the user confirms every change (decided with the owner)
 */
export function settingsRisks(
  current: Readonly<SettingsValues>,
  changes: Readonly<SettingsValues>,
): SettingsRisk[] {
  const risks: SettingsRisk[] = [];
  if ("callsign" in changes && !settingEquals(changes.callsign, current.callsign)) {
    risks.push("callsign");
  }
  if ("ssid" in changes && !settingEquals(changes.ssid, current.ssid)) risks.push("ssid");
  if (changes.tx_enabled === true && current.tx_enabled !== true) risks.push("tx_enable");
  return risks;
}
