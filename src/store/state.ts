// App state: the device client, the feed (rx/tx ring buffer) and the station table.
// Views read this and re-render when `onChange` fires. Nothing here touches the DOM.

import type { AprsPacket } from "../aprs/types.ts";
import { parseAprs } from "../aprs/parse.ts";
import type { LatLon } from "../aprs/geo.ts";
import { DeviceClient, STATUS_STALE_MS, type ClientState } from "../client/deviceClient.ts";
import { describeConnectError } from "./connectError.ts";
import type { ErrMsg, HelloMsg, RxMsg, StationMsg, StatusMsg, TxMsg } from "../protocol/types.ts";
import { MockTransport, type MockTransportOptions } from "../transport/mock/mockTransport.ts";
import type { Transport } from "../transport/transport.ts";
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

/** Most device errors kept in `recentErrors`. */
export const MAX_RECENT_ERRORS = 20;

export interface AppOptions {
  /** Makes the simulated device's transport (Demo). Tests replace it to keep hold of it. */
  createMockTransport?: (opts: MockTransportOptions) => MockTransport;
}

/** An `err` event from the device that did not answer a request of ours. */
export interface DeviceErrorRecord {
  /** Date.now() */
  at: number;
  text: string;
}

const noop = (): void => undefined;

export class App {
  readonly prefs = new Prefs();
  /**
   * The current client. It stays after a disconnect, so that the last `settings` and `schema`
   * can still be shown (read-only); a new connection replaces it.
   */
  client: DeviceClient | undefined;
  mock = false;
  /** Oldest first. Trimmed to prefs.logLimit. Kept across disconnects and reconnects. */
  feed: FeedItem[] = [];
  stations = new Map<string, StationRow>();
  /**
   * A sentence for the user: why the last connection attempt failed, or a note. Cleared when a
   * connection starts and when it disconnects. Never holds a device error (see `recentErrors`)
   * and is empty for `proto_mismatch` (the state says it).
   */
  notice: string | undefined;
  /** Device `err` events that were not a reply to a request. Oldest first, at most 20. */
  recentErrors: DeviceErrorRecord[] = [];

  private seq = 0;
  private readonly listeners = new Set<() => void>();
  private offs: (() => void)[] = [];
  private readonly createMockTransport: (opts: MockTransportOptions) => MockTransport;
  /** Bumped by every connectWith() and disconnect(): an attempt with an older number is void. */
  private token = 0;
  /** The attempts run one at a time: this is the end of the last one. */
  private tail: Promise<void> = Promise.resolve();
  private kind: "user" | "link" | undefined;
  /** Which device the feed and stations belong to (see `deviceKeyOf`). */
  private deviceKey: string | undefined;

  constructor(options: AppOptions = {}) {
    this.createMockTransport = options.createMockTransport ?? ((o) => new MockTransport(o));
    // A smaller limit applies at once, also while disconnected.
    this.prefs.onChange(() => {
      if (this.trimFeed()) this.notify();
    });
  }

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

  /**
   * Why the last connection ended: "user" (disconnect() was called, also a cancel while
   * connecting) or "link" (the link dropped by itself). undefined: not disconnected, or never
   * connected. A reconnect should only be attempted after "link".
   */
  get disconnectKind(): "user" | "link" | undefined {
    return this.kind;
  }

  /** The newest of `recentErrors`. */
  get lastDeviceError(): DeviceErrorRecord | undefined {
    return this.recentErrors[this.recentErrors.length - 1];
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
  async connectMock(opts: { fast?: boolean } = {}): Promise<void> {
    const rx = opts.fast ? { rxMinMs: 300, rxMaxMs: 900 } : {};
    await this.connectWith(
      this.createMockTransport({ autoRx: true, connectDelayMs: 400, ...rx }),
      true,
    );
  }

  /** Real Bluetooth arrives with work 5 (webBluetooth.ts), through `connectWith`. */
  connectBluetooth(): Promise<void> {
    this.notice = "Bluetooth connection is not available in this build yet. Use Demo.";
    this.notify();
    return Promise.resolve();
  }

  /** The user ends the connection (also cancels one that is still connecting). */
  async disconnect(): Promise<void> {
    this.token++; // voids an attempt that is still waiting for its turn
    this.kind = "user";
    this.notice = undefined;
    await this.client?.stop();
    await this.tail;
    this.notify();
  }

  /** Empties the feed (the user's Clear). The station table is kept. */
  clearFeed(): void {
    this.feed = [];
    this.notify();
  }

  /**
   * Connect with `transport` (the Demo's, or Web Bluetooth's in work 5). Attempts are serialized:
   * a call while another is running or waiting cancels that one and replaces it, and the previous
   * client is gone (stopped, disposed) before the new one starts. Resolves when this attempt has
   * ended, whatever way: failures are in `notice` / `state`, not thrown.
   *
   * Where auto-reconnect belongs (work 5): the "state" handler below sees the link drop
   * (`disconnectKind === "link"`). The same `DeviceClient` can then be started again with
   * `client.start()`, which runs the §6.2 flow from the beginning on the same transport. This
   * class keeps its listeners on that client, so the feed and the views go on as they are, and
   * `hello` tells whether it is still the same device. connectWith() is only for a *new* link.
   */
  async connectWith(transport: Transport, mock: boolean): Promise<void> {
    const token = ++this.token;
    // Everything that follows the old client must stop at once, not after the awaits below.
    this.detach();
    const old = this.client;
    const stopping = old ? old.dispose().catch(noop) : Promise.resolve();
    const prev = this.tail;
    const attempt = (async () => {
      await prev;
      await stopping;
      if (token !== this.token) return; // cancelled while it waited
      this.mock = mock;
      this.notice = undefined;
      this.kind = undefined;
      const client = new DeviceClient(transport);
      this.client = client;
      const live = (): boolean => this.client === client && token === this.token;
      const on = <T extends Parameters<typeof client.on>[0]>(
        ev: T,
        cb: Parameters<typeof client.on<T>>[1],
      ): (() => void) => client.on(ev, (v) => (live() ? cb(v) : undefined));
      this.offs = [
        on("state", (s) => this.onClientState(s)),
        on("hello", (h) => this.onHello(h, transport, mock)),
        on("status", () => this.notify()),
        on("statusStale", () => this.notify()),
        on("schema", () => this.notify()),
        on("settings", () => this.notify()),
        on("rx", (m) => this.onRx(m)),
        on("tx", (m) => this.onTx(m)),
        on("stations", (list) => this.onStations(list)),
        on("deviceError", (e) => this.onDeviceError(e)),
      ];
      this.notify();
      try {
        await client.start();
      } catch (e) {
        // A cancel (disconnect(), or a newer connectWith()) is not an error.
        if (!live() || this.kind === "user") return;
        this.notice = describeConnectError(e) || undefined;
      }
      if (live()) this.notify();
    })();
    this.tail = attempt.catch(noop);
    await attempt;
  }

  private detach(): void {
    for (const off of this.offs.splice(0)) off();
  }

  private onClientState(s: ClientState): void {
    if (s === "connecting") {
      this.kind = undefined;
      this.notice = undefined;
    } else if (s === "disconnected") {
      this.notice = undefined;
      // The user's disconnect() sets "user" before it stops the client.
      this.kind ??= "link";
    }
    this.notify();
  }

  /** The feed belongs to one device: another one (or Demo vs real) starts with an empty one. */
  private onHello(hello: HelloMsg, transport: Transport, mock: boolean): void {
    const key = `${mock ? "demo" : "ble"}|${transport.deviceId ?? ""}|${hello.name ?? ""}`;
    if (this.deviceKey !== undefined && key !== this.deviceKey) {
      this.feed = [];
      this.stations = new Map();
      this.recentErrors = [];
    }
    this.deviceKey = key;
    this.notify();
  }

  private onDeviceError(e: ErrMsg): void {
    const text = `${e.code}${e.key ? ` ${e.key}` : ""}${e.msg ? `: ${e.msg}` : ""}`;
    this.recentErrors.push({ at: Date.now(), text });
    if (this.recentErrors.length > MAX_RECENT_ERRORS) {
      this.recentErrors.splice(0, this.recentErrors.length - MAX_RECENT_ERRORS);
    }
    this.notify();
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
    this.trimFeed();
    return item;
  }

  /** Apply prefs.logLimit. True if anything was dropped. */
  private trimFeed(): boolean {
    const limit = this.prefs.get("logLimit");
    if (this.feed.length <= limit) return false;
    this.feed.splice(0, this.feed.length - limit);
    return true;
  }

  private onTx(msg: TxMsg): void {
    this.pushFeed("tx", msg);
    this.notify();
  }

  private onRx(msg: RxMsg): void {
    const item = this.pushFeed("rx", msg);
    const src = msg.src ?? item.parsed.tnc2?.src;
    if (src) {
      const prev = this.stations.get(src);
      const row: StationRow = {
        src,
        lastAt: item.at,
        count: (prev?.count ?? 0) + 1,
        own: prev?.own ?? false,
      };
      // Only a position report or Mic-E tells where the sender is. Objects, items, third-party
      // packets and status locators carry somebody else's (or an approximate) position.
      const ll = senderPosition(msg, item.parsed);
      const lat = ll ? ll.lat : prev?.lat;
      const lon = ll ? ll.lon : prev?.lon;
      if (lat !== undefined && lon !== undefined) {
        row.lat = lat;
        row.lon = lon;
      }
      const lvl = msg.lvl_db ?? prev?.lvlDb;
      if (lvl !== undefined) row.lvlDb = lvl;
      // The symbol goes with the position: an object's symbol is not the sender's.
      const sym = (ll ? msg.sym : undefined) ?? prev?.sym;
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

/**
 * The position of the station that sent an rx packet: only from a position report or Mic-E.
 * What the app parsed wins over the device's `lat`/`lon`, which serve only when the app cannot
 * read the packet at all but the device (kind "position" or "mice", §8.2) could.
 */
function senderPosition(msg: RxMsg, parsed: AprsPacket): LatLon | undefined {
  const d = parsed.data;
  if (d.type === "position" || d.type === "mice") {
    return { lat: d.position.lat, lon: d.position.lon };
  }
  if (
    d.type === "unknown" &&
    (msg.kind === "position" || msg.kind === "mice") &&
    msg.lat !== undefined &&
    msg.lon !== undefined
  ) {
    return { lat: msg.lat, lon: msg.lon };
  }
  return undefined;
}

export { STATUS_STALE_MS };
export { describeConnectError };
