// App state: the device client, the feed (rx/tx ring buffer) and the station table.
// Views read this and re-render when `onChange` fires. Nothing here touches the DOM.

import { packetLatLon, type AprsPacket } from "../aprs/types.ts";
import { parseAprs } from "../aprs/parse.ts";
import type { LatLon } from "../aprs/geo.ts";
import { DeviceClient, STATUS_STALE_MS, type ClientState } from "../client/deviceClient.ts";
import type { RxMsg, StationMsg, StatusMsg, TxMsg } from "../protocol/types.ts";
import { MockTransport } from "../transport/mock/mockTransport.ts";
import { Prefs } from "./prefs.ts";

export interface FeedItem {
  /** Increases by one per item; use it as a stable key. */
  seq: number;
  kind: "rx" | "tx";
  /** Date.now() when the app received it. */
  at: number;
  msg: RxMsg | TxMsg;
  /** The parsed TNC2 line (parseAprs never throws). */
  parsed: AprsPacket;
}

export interface StationRow {
  src: string;
  lat?: number;
  lon?: number;
  /** Date.now() of the last time it was heard (derived from `last_s` for the device's list). */
  lastAt: number;
  count: number;
  lvlDb?: number;
  /** Symbol as two characters ("/>"), when known. */
  sym?: string;
  own: boolean;
}

/** Most stations kept (the device keeps 64; see plan.md). */
export const MAX_STATIONS = 256;

export class App {
  readonly prefs = new Prefs();
  client: DeviceClient | undefined;
  mock = false;
  /** Oldest first. Trimmed to prefs.logLimit. */
  feed: FeedItem[] = [];
  stations = new Map<string, StationRow>();
  /** Why the last connection attempt failed, or a note for the user. Cleared on connect. */
  notice: string | undefined;

  private seq = 0;
  private readonly listeners = new Set<() => void>();
  private offs: (() => void)[] = [];

  get state(): ClientState {
    return this.client?.state ?? "disconnected";
  }

  get status(): StatusMsg | undefined {
    return this.client?.lastStatus;
  }

  /** True when there is no recent status: `tx_ready` and the rest cannot be trusted. */
  get statusStale(): boolean {
    return this.client === undefined || this.client.statusStale;
  }

  /** Own position from `status` (only with a fix). */
  ownPosition(): LatLon | undefined {
    const s = this.status;
    return s && s.lat !== undefined && s.lon !== undefined ? { lat: s.lat, lon: s.lon } : undefined;
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  notify(): void {
    for (const l of this.listeners) l();
  }

  /** Connect to the simulated device (Demo). */
  async connectMock(): Promise<void> {
    await this.connectWith(new MockTransport({ autoRx: true, connectDelayMs: 400 }), true);
  }

  /** Real Bluetooth arrives with work 5 (webBluetooth.ts). */
  connectBluetooth(): Promise<void> {
    this.notice = "Bluetooth connection is not available in this build yet. Use Demo.";
    this.notify();
    return Promise.resolve();
  }

  async disconnect(): Promise<void> {
    await this.client?.stop();
    this.notify();
  }

  clearFeed(): void {
    this.feed = [];
    this.notify();
  }

  private async connectWith(transport: MockTransport, mock: boolean): Promise<void> {
    await this.teardown();
    this.mock = mock;
    this.notice = undefined;
    this.feed = [];
    this.stations = new Map();
    const client = new DeviceClient(transport);
    this.client = client;
    this.offs = [
      client.on("state", () => this.notify()),
      client.on("status", () => this.notify()),
      client.on("statusStale", () => this.notify()),
      client.on("schema", () => this.notify()),
      client.on("settings", () => this.notify()),
      client.on("rx", (m) => this.onRx(m)),
      client.on("tx", (m) => this.onTx(m)),
      client.on("stations", (list) => this.onStations(list)),
      client.on("deviceError", (e) => {
        this.notice = `Device error: ${e.code}${e.msg ? ` (${e.msg})` : ""}`;
        this.notify();
      }),
    ];
    this.notify();
    try {
      await client.start();
    } catch (e) {
      this.notice = e instanceof Error ? e.message : String(e);
    }
    this.notify();
  }

  private async teardown(): Promise<void> {
    for (const off of this.offs.splice(0)) off();
    const old = this.client;
    this.client = undefined;
    if (old) await old.dispose();
  }

  // ---- feed and stations ------------------------------------------------------------------

  private pushFeed(kind: "rx" | "tx", msg: RxMsg | TxMsg): FeedItem {
    const item: FeedItem = {
      seq: ++this.seq,
      kind,
      at: Date.now(),
      msg,
      parsed: parseAprs(msg.tnc2),
    };
    this.feed.push(item);
    const limit = this.prefs.get("logLimit");
    if (this.feed.length > limit) this.feed.splice(0, this.feed.length - limit);
    return item;
  }

  private onTx(msg: TxMsg): void {
    this.pushFeed("tx", msg);
    this.notify();
  }

  private onRx(msg: RxMsg): void {
    const item = this.pushFeed("rx", msg);
    const src = msg.src ?? item.parsed.tnc2?.src;
    if (src) {
      const ll = msg.lat !== undefined && msg.lon !== undefined ? msg : packetLatLon(item.parsed);
      const prev = this.stations.get(src);
      const row: StationRow = {
        src,
        lastAt: item.at,
        count: (prev?.count ?? 0) + 1,
        own: prev?.own ?? false,
      };
      const lat = ll?.lat ?? prev?.lat;
      const lon = ll?.lon ?? prev?.lon;
      if (lat !== undefined && lon !== undefined) {
        row.lat = lat;
        row.lon = lon;
      }
      const lvl = msg.lvl_db ?? prev?.lvlDb;
      if (lvl !== undefined) row.lvlDb = lvl;
      const sym = msg.sym ?? prev?.sym;
      if (sym !== undefined) row.sym = sym;
      this.stations.set(src, row);
      this.trimStations();
    }
    this.notify();
  }

  private onStations(list: StationMsg[]): void {
    const now = Date.now();
    for (const s of list) {
      const prev = this.stations.get(s.src);
      const row: StationRow = {
        src: s.src,
        lastAt: s.last_s !== undefined ? now - s.last_s * 1000 : (prev?.lastAt ?? now),
        count: s.count ?? prev?.count ?? 0,
        own: s.own ?? prev?.own ?? false,
      };
      const lat = s.lat ?? prev?.lat;
      const lon = s.lon ?? prev?.lon;
      if (lat !== undefined && lon !== undefined) {
        row.lat = lat;
        row.lon = lon;
      }
      const lvl = s.lvl_db ?? prev?.lvlDb;
      if (lvl !== undefined) row.lvlDb = lvl;
      if (prev?.sym !== undefined) row.sym = prev.sym;
      this.stations.set(s.src, row);
    }
    this.trimStations();
    this.notify();
  }

  private trimStations(): void {
    if (this.stations.size <= MAX_STATIONS) return;
    const oldest = [...this.stations.values()]
      .filter((r) => !r.own)
      .sort((a, b) => a.lastAt - b.lastAt)
      .slice(0, this.stations.size - MAX_STATIONS);
    for (const r of oldest) this.stations.delete(r.src);
  }
}

export { STATUS_STALE_MS };
