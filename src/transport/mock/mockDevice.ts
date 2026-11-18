// Pure simulation of the device's message handling (ble-protocol.md §5-§9).
// No timers and no BLE: `handleLine` takes one request line and returns the response lines.

import { MAX_LINE_BYTES } from "../../protocol/framing.ts";
import { KNOWN_SETTINGS, validateSetting } from "../../protocol/settings.ts";
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
  /** `hello.name`; a different value makes the app treat this as another device. */
  helloName = "pico2_aprs";
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
            name: this.helloName,
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
