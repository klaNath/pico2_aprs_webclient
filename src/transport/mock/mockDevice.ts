// Pure simulation of the device's message handling (ble-protocol.md §5-§9).
// No timers and no BLE: `handleLine` takes one request line and returns the response lines.

import { MAX_LINE_BYTES } from "../../protocol/framing.ts";
import { KNOWN_SETTINGS } from "../../protocol/settings.ts";
import { PROTO_VERSION } from "../../protocol/types.ts";
import type { SettingValue, SettingsValues, StationMsg, StatusMsg } from "../../protocol/types.ts";

export const DEFAULT_SETTINGS: SettingsValues = {
  callsign: "Q1TEST",
  ssid: 7,
  symbol: "/>",
  path: ["WIDE1-1"],
  comment: "Pico2 APRS",
  mice_message: 0,
  beacon_moving_s: 60,
  beacon_still_s: 900,
  beacon_move_m: 20,
  tx_enabled: false,
  fx25_tx: false,
};

const encoder = new TextEncoder();

function isInt(v: unknown, min: number, max: number): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

/** Validate one value (§9.1). Returns the normalized value (e.g. upper-cased `path`), or an error message. */
export function validateSetting(
  key: string,
  v: unknown,
): { error: string } | { value: SettingValue } {
  switch (key) {
    case "callsign":
      if (v === null) return { value: null };
      if (typeof v === "string" && /^[A-Z0-9]{3,6}$/.test(v) && /\d/.test(v)) return { value: v };
      return { error: "3-6 chars A-Z 0-9 with a digit, or null" };
    case "ssid":
      return isInt(v, 0, 15) ? { value: v as number } : { error: "integer 0-15" };
    case "symbol":
      if (
        typeof v === "string" &&
        v.length === 2 &&
        /^[/\\0-9A-Z]$/.test(v[0]!) &&
        v.charCodeAt(1) >= 0x21 &&
        v.charCodeAt(1) <= 0x7e
      )
        return { value: v };
      return { error: "2 chars: table (/ \\ 0-9 A-Z) + code (! to ~)" };
    case "path": {
      if (!Array.isArray(v) || v.length > 2 || !v.every((e) => typeof e === "string"))
        return { error: "list of 0-2 strings" };
      const up = (v as string[]).map((e) => e.toUpperCase());
      if (!up.every((e) => /^[A-Z0-9]{1,6}(-([0-9]|1[0-5]))?$/.test(e)))
        return { error: "entries like WIDE1-1" };
      return { value: up };
    }
    case "comment":
      if (typeof v === "string" && /^[\x20-\x7e]{0,40}$/.test(v)) return { value: v };
      return { error: "printable ASCII, 0-40 chars" };
    case "mice_message":
      return isInt(v, 0, 6) ? { value: v as number } : { error: "integer 0-6" };
    case "beacon_moving_s":
      return isInt(v, 30, 3600) ? { value: v as number } : { error: "integer 30-3600" };
    case "beacon_still_s":
      return isInt(v, 60, 7200) ? { value: v as number } : { error: "integer 60-7200" };
    case "beacon_move_m":
      return typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= 1000
        ? { value: v }
        : { error: "number 1-1000" };
    case "tx_enabled":
    case "fx25_tx":
      return typeof v === "boolean" ? { value: v } : { error: "boolean" };
    default:
      return { error: "unknown item" };
  }
}

function sameValue(a: SettingValue | undefined, b: SettingValue | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class MockDevice {
  settings: SettingsValues = structuredClone(DEFAULT_SETTINGS);
  /** The unit's physical beacon switch. */
  sw = true;
  fix = 3;
  sats = 9;
  lat = 35.68124;
  lon = 139.76712;
  lvlDb = -35.2;
  rxCount = 0;
  txCount = 0;
  dropped = 0;
  stations: StationMsg[] = [
    {
      t: "station",
      src: "Q1AAA-9",
      last_s: 120,
      count: 3,
      lat: 35.66867,
      lon: 139.76117,
      lvl_db: -20.1,
    },
    { t: "station", src: "Q1BBB", last_s: 240, count: 1, lat: 35.7, lon: 139.8, lvl_db: -27.5 },
    { t: "station", src: "Q1TEST-7", last_s: 300, count: 1, own: true },
  ];

  /** Test knobs. */
  failNextSave = false;
  protoOverride: number | undefined;

  status(): StatusMsg {
    const callsign = this.settings.callsign as string | null;
    const ssid = this.settings.ssid as number;
    let refuse: string | undefined;
    if (callsign === null) refuse = "callsign not set";
    else if (this.settings.tx_enabled !== true) refuse = "TX not enabled";
    const s: StatusMsg = {
      t: "status",
      fix: this.fix,
      sats: this.sats,
      sw: this.sw,
      tx_enabled: this.settings.tx_enabled as boolean,
      tx_ready: this.sw && refuse === undefined,
      call: callsign === null ? "NOCALL" : ssid ? `${callsign}-${ssid}` : callsign,
      rx_count: this.rxCount,
      tx_count: this.txCount,
      lvl_db: this.lvlDb,
      sd: "no card",
      dropped: this.dropped,
    };
    if (this.fix >= 2) {
      s.lat = this.lat;
      s.lon = this.lon;
    }
    if (refuse !== undefined) s.tx_refuse = refuse;
    return s;
  }

  /** Handle one request line (no newline). Returns the response lines. */
  handleLine(line: string): string[] {
    if (encoder.encode(line).length > MAX_LINE_BYTES) return [err(undefined, "too_long")];
    let req: unknown;
    try {
      req = JSON.parse(line);
    } catch {
      return [err(undefined, "bad_json")];
    }
    if (typeof req !== "object" || req === null || Array.isArray(req)) {
      return [err(undefined, "bad_json")];
    }
    const r = req as Record<string, unknown>;
    // A non-integer id is treated as absent (§6.1).
    const id = Number.isInteger(r.id) ? (r.id as number) : undefined;
    const withId = (o: object): string => JSON.stringify(id === undefined ? o : { ...o, id });

    switch (r.op) {
      case "hello":
        return [
          withId({
            t: "hello",
            proto: this.protoOverride ?? PROTO_VERSION,
            name: "pico2_aprs",
            mode: "tnc",
          }),
        ];
      case "status":
        return [withId(this.status())];
      case "settings.schema":
        return [withId({ t: "schema", items: KNOWN_SETTINGS })];
      case "settings.get":
        return [withId({ t: "settings", values: this.settings })];
      case "settings.set":
        return [this.set(r.values, id)];
      case "settings.reset": {
        if (this.failNextSave) {
          this.failNextSave = false;
          return [err(id, "io")];
        }
        const changed = Object.keys(DEFAULT_SETTINGS).filter(
          (k) => !sameValue(this.settings[k], DEFAULT_SETTINGS[k]),
        );
        this.settings = structuredClone(DEFAULT_SETTINGS);
        return [withId({ t: "settings", values: this.settings, changed })];
      }
      case "stations.list": {
        const out = this.stations.map((s) => withId(s));
        out.push(withId({ t: "stations.end", n: this.stations.length }));
        return out;
      }
      default:
        return [err(id, "unknown_op", { msg: String(r.op ?? "").slice(0, 32) })];
    }
  }

  private set(values: unknown, id: number | undefined): string {
    const invalid = (key: string, msg: string): string => err(id, "invalid", { key, msg });
    if (typeof values !== "object" || values === null || Array.isArray(values)) {
      return invalid("values", "object required");
    }
    const entries = Object.entries(values as Record<string, unknown>);
    if (entries.length === 0) return invalid("values", "at least one item required");

    const next: SettingsValues = { ...this.settings };
    for (const [key, v] of entries) {
      const res = validateSetting(key, v);
      if ("error" in res) return invalid(key, res.error);
      next[key] = res.value;
    }
    if (this.failNextSave) {
      this.failNextSave = false;
      return err(id, "io");
    }
    const changed = entries.map(([k]) => k).filter((k) => !sameValue(this.settings[k], next[k]));
    this.settings = next;
    return JSON.stringify({
      t: "settings",
      ...(id === undefined ? {} : { id }),
      values: next,
      changed,
    });
  }
}

function err(
  id: number | undefined,
  code: string,
  extra: { key?: string; msg?: string } = {},
): string {
  return JSON.stringify({ t: "err", ...(id === undefined ? {} : { id }), code, ...extra });
}
