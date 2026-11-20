// Pure simulation of the device's message handling (ble-protocol.md §5-§9).
// No timers and no BLE: `handleLine` takes one request line and returns the response lines.

import { MAX_LINE_BYTES } from "../../protocol/framing.ts";
import { checkMsgText, checkMsgTo, MSG_MAX_TRIES, MSG_QUEUE_MAX } from "../../protocol/messages.ts";
import { KNOWN_SETTINGS, validateSetting } from "../../protocol/settings.ts";
import { PROTO_VERSION } from "../../protocol/types.ts";
import type {
  MsgMsg,
  SettingValue,
  SettingsValues,
  StationMsg,
  StatusMsg,
} from "../../protocol/types.ts";

/** Seconds between the tries of a message (§7.6), and after the last one until `failed`. */
export const MSG_RETRY_S = [30, 60, 120, 240, 240] as const;
/** Messages the device keeps (§7.7). */
const MSG_KEEP = 16;

interface MockMessage {
  row: MsgMsg;
  /** When the next try (or, after the last one, `failed`) is due, in `now()` ms. */
  dueAt: number;
}

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
  beacon_mode: "auto",
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

  /** Seconds between two beacons that `beacon.send` refuses (§7.5). */
  static readonly BEACON_MIN_S = 10;

  /** The clock (ms). A test replaces it to move time without waiting. */
  now: () => number = () => Date.now();
  /** When the last beacon was built (`beacon.send`), in `now()` ms. */
  lastBeaconAt: number | undefined;

  /** Test knobs. */
  /** `hello.name`; a different value makes the app treat this as another device. */
  helloName = "pico2_aprs";
  failNextSave = false;
  /** Make the next `beacon.send` fail after the checks: `frame_too_long` or `internal`. */
  failNextBeacon: "frame_too_long" | "internal" | undefined;
  protoOverride: number | undefined;
  /** Demo: the addressee acknowledges each message this long after a try (undefined = never). */
  autoAckMs: number | undefined;
  /** Whether the channel is judged busy (§7.9). Due messages wait while it is. */
  chBusy = false;

  /** Messages kept, newest first (§7.7). */
  messages: MockMessage[] = [];
  msgUnread = 0;
  private nextMsgNo = 12;
  private lastAckAt = new Map<string, number>();

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
      beacon_mode: this.settings.beacon_mode as string,
      tx_enabled: this.settings.tx_enabled as boolean,
      tx_ready: this.sw && refuse === undefined,
      call: callsign === null ? "NOCALL" : ssid ? `${callsign}-${ssid}` : callsign,
      rx_count: this.rxCount,
      tx_count: this.txCount,
      lvl_db: this.lvlDb,
      sd: "no card",
      dropped: this.dropped,
      msg_unread: this.msgUnread,
      msg_pending: this.messages.filter((m) => m.row.state === "pending").length,
      ch_busy: this.chBusy,
    };
    if (this.fix >= 2) {
      s.lat = this.lat;
      s.lon = this.lon;
      s.utc = new Date(this.now()).toISOString().replace(/\.\d{3}Z$/, "Z");
    }
    if (this.lastBeaconAt !== undefined) {
      s.last_tx_s = Math.max(0, Math.floor((this.now() - this.lastBeaconAt) / 1000));
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
      case "beacon.send":
        return this.beaconSend(id);
      case "msg.send":
        return this.msgSend(id, r.to, r.text);
      case "msg.list": {
        this.msgUnread = 0;
        const out = this.messages.map((m) => withId(m.row));
        out.push(withId({ t: "msg.end", n: this.messages.length }));
        return out;
      }
      case "msg.cancel": {
        if (typeof r.no !== "string") return [err(id, "invalid", { key: "no", msg: "string" })];
        const m = this.messages.find((x) => x.row.dir === "out" && x.row.no === r.no);
        if (!m) return [err(id, "unknown_msg")];
        if (m.row.state === "pending") m.row.state = "cancelled";
        return [withId(m.row)];
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

  private ownCall(): string {
    const callsign = this.settings.callsign as string | null;
    const ssid = this.settings.ssid as number;
    return callsign === null ? "NOCALL" : ssid ? `${callsign}-${ssid}` : callsign;
  }

  private utc(ms: number): string {
    return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  /** `msg.send` (§7.6): check in the spec's order, then queue. The first try is made by `tick`. */
  private msgSend(id: number | undefined, to: unknown, text: unknown): string[] {
    const withId = (o: object): string => JSON.stringify(id === undefined ? o : { ...o, id });
    if (typeof to !== "string" || checkMsgTo(to, this.ownCall()) !== undefined) {
      return [err(id, "invalid", { key: "to", msg: "callsign-SSID, 1-9 characters" })];
    }
    if (typeof text !== "string" || checkMsgText(text) !== undefined) {
      return [err(id, "invalid", { key: "text", msg: "1-67 printable ASCII, no | ~ {" })];
    }
    if (!this.sw) return [err(id, "switch_off")];
    const refuse = this.status().tx_refuse;
    if (refuse !== undefined) return [err(id, "tx_not_ready", { msg: refuse })];
    if (this.messages.filter((m) => m.row.state === "pending").length >= MSG_QUEUE_MAX) {
      return [err(id, "queue_full")];
    }
    const now = this.now();
    const row: MsgMsg = {
      t: "msg",
      dir: "out",
      no: String(this.nextMsgNo++),
      to: to.toUpperCase(),
      text,
      state: "pending",
      tries: 0,
      utc: this.utc(now),
    };
    this.keep({ row, dueAt: now });
    return [withId(row)];
  }

  private keep(m: MockMessage): void {
    this.messages.unshift(m);
    // The 16 newest are kept; a pending message is never dropped (§7.7).
    while (this.messages.length > MSG_KEEP) {
      const i = this.messages.findLastIndex((x) => x.row.state !== "pending");
      if (i < 0) break;
      this.messages.splice(i, 1);
    }
  }

  private path(): string {
    const path = (this.settings.path as string[]).join(",");
    return path ? `,${path}` : "";
  }

  /**
   * Advance the message queue to `now()`: make due tries (when the switch is on, the gate allows it
   * and the channel is clear), end messages as `failed`, and deliver demo acknowledgements.
   * Returns the event lines (`tx`, `msg`).
   */
  tick(): string[] {
    const out: string[] = [];
    const now = this.now();
    const canSend = this.sw && this.status().tx_ready === true && !this.chBusy;
    for (const m of this.messages) {
      const r = m.row;
      if (r.state !== "pending") continue;
      const tries = r.tries ?? 0;
      if (
        this.autoAckMs !== undefined &&
        tries > 0 &&
        now >= (this.lastAckAt.get(r.no!) ?? Infinity)
      ) {
        r.state = "acked";
        out.push(JSON.stringify(r));
        continue;
      }
      if (now < m.dueAt) continue;
      if (tries >= MSG_MAX_TRIES) {
        r.state = "failed";
        out.push(JSON.stringify(r));
        continue;
      }
      if (!canSend) continue; // a due try waits, and is not counted
      r.tries = tries + 1;
      this.txCount++;
      m.dueAt = now + MSG_RETRY_S[tries]! * 1000;
      if (this.autoAckMs !== undefined) this.lastAckAt.set(r.no!, now + this.autoAckMs);
      const addressee = (r.to ?? "").padEnd(9, " ");
      out.push(
        JSON.stringify({
          t: "tx",
          tnc2: `${this.ownCall()}>APRS${this.path()}::${addressee}:${r.text}{${r.no}`,
          dry: false,
          utc: this.utc(now),
        }),
        JSON.stringify(r),
      );
    }
    return out;
  }

  /**
   * A message addressed to this device arrives (demo and tests). Returns the `msg` event and, for
   * a numbered message when the device can transmit, the `tx` event of its acknowledgement.
   */
  receiveMessage(src: string, text: string, no?: string): string[] {
    const now = this.now();
    const row: MsgMsg = { t: "msg", dir: "in", src, text, utc: this.utc(now) };
    if (no !== undefined) row.no = no;
    this.keep({ row, dueAt: now });
    this.msgUnread++;
    this.rxCount++;
    const out = [JSON.stringify(row)];
    if (no !== undefined && this.sw && this.status().tx_ready === true) {
      this.txCount++;
      out.push(
        JSON.stringify({
          t: "tx",
          tnc2: `${this.ownCall()}>APRS${this.path()}::${src.padEnd(9, " ")}:ack${no}`,
          dry: false,
          utc: this.utc(now),
        }),
      );
    }
    return out;
  }

  /** `beacon.send` (§7.5): check in the spec's order, then answer and add the `tx` event. */
  private beaconSend(id: number | undefined): string[] {
    const withId = (o: object): string => JSON.stringify(id === undefined ? o : { ...o, id });
    if (!this.sw) return [err(id, "switch_off")];
    const hasTime = this.fix >= 2;
    if (!hasTime) return [err(id, "no_fix")];
    const now = this.now();
    if (this.lastBeaconAt !== undefined) {
      const wait = Math.ceil(MockDevice.BEACON_MIN_S - (now - this.lastBeaconAt) / 1000);
      if (wait > 0)
        return [
          JSON.stringify({
            t: "err",
            ...(id === undefined ? {} : { id }),
            code: "too_soon",
            wait_s: wait,
          }),
        ];
    }
    if (this.failNextBeacon !== undefined) {
      const code = this.failNextBeacon;
      this.failNextBeacon = undefined;
      return [err(id, code)];
    }
    const dry = this.status().tx_ready !== true;
    this.lastBeaconAt = now;
    this.txCount++;
    const callsign = this.settings.callsign as string | null;
    const ssid = this.settings.ssid as number;
    const call = callsign === null ? "NOCALL" : ssid ? `${callsign}-${ssid}` : callsign;
    const path = (this.settings.path as string[]).join(",");
    const tx = {
      t: "tx",
      tnc2: `${call}>SU4PX0${path ? `,${path}` : ""}:\`CIXl >/${String(this.settings.comment)}`,
      dry,
      utc: new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z"),
    };
    return [withId({ t: "beacon", dry }), JSON.stringify(tx)];
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
