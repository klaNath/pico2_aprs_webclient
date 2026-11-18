// Device client: request/response matching, retries, and the connection flow (§6.2).
//
// Requests are sent one at a time (the next one waits for the previous response). `busy` errors
// carry no id, so with a single request in flight it is always clear which one to resend.

import {
  LineAssembler,
  MAX_LINE_BYTES,
  MAX_WRITE_BYTES,
  encodeLine,
  splitBytes,
} from "../protocol/framing.ts";
import { normalizeSettings, settingEquals, settingsRisks } from "../protocol/settings.ts";
import type { SettingsRisk } from "../protocol/settings.ts";
import { PROTO_VERSION, isParseError, parseMessage } from "../protocol/types.ts";
import type {
  ErrMsg,
  HelloMsg,
  Incoming,
  ParseError,
  Request,
  RxMsg,
  SchemaItem,
  SchemaMsg,
  SettingsMsg,
  SettingsValues,
  StationMsg,
  StatusMsg,
  TxMsg,
} from "../protocol/types.ts";
import type { Transport } from "../transport/transport.ts";
import { Emitter } from "./emitter.ts";

export type ClientState =
  "disconnected" | "connecting" | "handshaking" | "ready" | "proto_mismatch" | "error";

export type ClientEvents = {
  state: ClientState;
  /** The device answered `hello` and its protocol version is the one this app speaks. */
  hello: HelloMsg;
  status: StatusMsg;
  /** The status became stale (no `status` for STATUS_STALE_MS) or fresh again. */
  statusStale: boolean;
  rx: RxMsg;
  tx: TxMsg;
  stations: StationMsg[];
  schema: SchemaItem[];
  settings: SettingsMsg;
  /** An `err` that is not the answer to a pending request. */
  deviceError: ErrMsg;
  /** A line that could not be read as a valid message. */
  lineError: ParseError;
};

export interface DeviceClientOptions {
  requestTimeoutMs?: number;
  /** How often `hello` is resent until the device answers (§4). */
  helloRetryMs?: number;
  /**
   * How long `hello` keeps being resent. The device drops a connection that is not authenticated
   * 60 s after connecting (§4), and the user has 30 s from the moment the passkey shows to type
   * it, so the app must not give up before then.
   */
  helloWindowMs?: number;
  busyRetryDelayMs?: number;
  /** Bytes per write, 1 to MAX_WRITE_BYTES (§5.2). Larger values are clamped to 20. */
  maxWriteBytes?: number;
}

/**
 * The device sends `status` every 5 seconds (§8.1). After this long without one, `tx_ready` and
 * the rest of the last status can no longer be trusted.
 */
export const STATUS_STALE_MS = 15_000;

/** How long `hello` is resent (§4: the device cuts an unauthenticated connection at 60 s). */
export const HELLO_WINDOW_MS = 60_000;

/**
 * Local codes: timeout, disconnected, not_connected, proto_mismatch, already_started, disposed,
 * invalid (a value failed the client-side check), confirmation_required, too_long (the request
 * line exceeds 512 bytes), bad_response (a reply with the wrong shape), write_failed.
 */
export class DeviceError extends Error {
  code: string;
  key?: string;
  msg?: string;

  constructor(code: string, msg?: string, key?: string) {
    super(`${code}${key ? ` (${key})` : ""}${msg ? `: ${msg}` : ""}`);
    this.name = "DeviceError";
    this.code = code;
    this.msg = msg;
    this.key = key;
  }
}

/** Confirmations the caller has obtained from the user (see `settingsRisks`). */
export interface SetSettingsOptions {
  confirmed?: readonly SettingsRisk[];
}

/** Proof that the user confirmed a reset. Required by `resetSettings`. */
export interface ResetConfirmation {
  confirmed: true;
}

interface Pending {
  id: number;
  bytes: Uint8Array;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  sends: number;
  busyRetried: boolean;
  /** Resend every `everyMs` until `Date.now()` reaches `until`. */
  retry?: { everyMs: number; until: number };
  /** Set for stations.list: collects `station` lines until `stations.end`. */
  stations?: StationMsg[];
  timer?: ReturnType<typeof setTimeout>;
  busyTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Errors that mean the device did not change anything. For any other failure of a settings
 * request (timeout, disconnect, ...) the device may have applied the change, so the cached
 * settings can no longer be trusted.
 */
/** The bare newline that resynchronizes the device's line buffer (§5.3). */
const NEWLINE = new Uint8Array([0x0a]);

const NOT_APPLIED = new Set(["invalid", "io", "too_long", "bad_json", "busy", "unknown_op"]);

const noop = (): void => undefined;

export class DeviceClient extends Emitter<ClientEvents> {
  state: ClientState = "disconnected";
  hello: HelloMsg | undefined;
  /** The last status (event or reply). Cleared on disconnect. Check `statusStale` before using it. */
  lastStatus: StatusMsg | undefined;
  /** When `lastStatus` arrived (Date.now()). */
  lastStatusAt: number | undefined;
  schema: SchemaItem[] = [];
  /** The device's settings as last reported. Empty when unknown (see `settingsKnown`). */
  settings: SettingsValues = {};
  stations: StationMsg[] = [];
  /** Why the last `start()` failed (state "error" or "proto_mismatch"). */
  lastError: Error | undefined;
  /** The reason the transport gave for the last disconnect, if any. */
  lastDisconnectReason: string | undefined;

  private readonly opts: Required<DeviceClientOptions>;
  private readonly assembler: LineAssembler;
  private nextId = 1;
  private pending: Pending | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private writeChain: Promise<void> = Promise.resolve();
  /** Bumped on every start and disconnect; requests from an older connection are rejected. */
  private generation = 0;
  /** The transport's connect() while it is in progress (a stop() waits for it). */
  private connecting: Promise<unknown> | undefined;
  private disposed = false;
  private settingsValid = false;
  private refreshing: Promise<void> | undefined;
  private settingsLock: Promise<unknown> = Promise.resolve();
  private staleFlag = false;
  /** A write failed: send a bare newline before the next request (§5.3). */
  private needsResync = false;
  /** A resync newline was sent: one id-less `bad_json` may come back, and is not an error. */
  private expectBadJson = false;
  private staleTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly unsubscribe: (() => void)[] = [];

  private readonly transport: Transport;

  constructor(transport: Transport, options: DeviceClientOptions = {}) {
    super();
    this.transport = transport;
    const maxWrite = Math.floor(options.maxWriteBytes ?? MAX_WRITE_BYTES);
    this.opts = {
      requestTimeoutMs: options.requestTimeoutMs ?? 5000,
      helloRetryMs: options.helloRetryMs ?? 3000,
      helloWindowMs: options.helloWindowMs ?? HELLO_WINDOW_MS,
      busyRetryDelayMs: options.busyRetryDelayMs ?? 500,
      // The device accepts at most 20 bytes per write (§5.2): never more, whatever is asked.
      maxWriteBytes: Number.isFinite(maxWrite)
        ? Math.min(MAX_WRITE_BYTES, Math.max(1, maxWrite))
        : MAX_WRITE_BYTES,
    };
    this.assembler = new LineAssembler({
      onOverflow: (head) => this.emit("lineError", { error: "line too long, dropped", line: head }),
    });
    this.unsubscribe.push(
      transport.onData((chunk) => this.onChunk(chunk)),
      transport.onDisconnect((reason) => this.handleDisconnect(reason)),
    );
  }

  // ---- connection flow (§6.2) -------------------------------------------------------------

  /** Connect and run hello -> status -> schema -> settings -> stations. Resolves when ready. */
  async start(): Promise<void> {
    if (this.disposed) throw new DeviceError("disposed");
    if (
      this.state !== "disconnected" &&
      this.state !== "error" &&
      this.state !== "proto_mismatch"
    ) {
      throw new DeviceError("already_started");
    }
    const gen = ++this.generation;
    this.resetConnectionData();
    this.hello = undefined;
    this.lastError = undefined;
    this.lastDisconnectReason = undefined;
    this.assembler.reset();
    this.resetResync(); // the device clears its line buffer on every connection (§5.3)
    try {
      this.setState("connecting");
      const connect = this.transport.connect();
      const mine = connect.then(noop, noop);
      this.connecting = mine;
      try {
        await connect;
      } finally {
        if (this.connecting === mine) this.connecting = undefined;
      }
      if (gen !== this.generation) throw new DeviceError("disconnected");
      this.setState("handshaking");

      // Commands before authentication are refused or dropped (§4), so hello is resent until the
      // device answers, the link drops, or the device's own time limit has passed.
      const hello = (await this.request(
        { op: "hello" },
        {
          retry: {
            everyMs: this.opts.helloRetryMs,
            until: Date.now() + this.opts.helloWindowMs,
          },
        },
      )) as HelloMsg;
      this.hello = hello;
      if (hello.proto !== PROTO_VERSION) {
        const e = new DeviceError(
          "proto_mismatch",
          `device proto ${String(hello.proto)}, app proto ${PROTO_VERSION}`,
        );
        this.lastError = e;
        this.setState("proto_mismatch");
        await this.transport.disconnect().catch(noop);
        throw e;
      }
      this.emit("hello", hello);
      // The first status event is sent on authentication and may arrive before notifications
      // are started (§6.2), so ask for the state explicitly.
      await this.getStatus();
      await this.getSchema();
      await this.getSettings();
      await this.listStations();
      if (gen !== this.generation) throw new DeviceError("disconnected");
      this.setState("ready");
    } catch (e) {
      const now = this.currentState(); // TS narrowed `this.state` before the awaits
      if (gen === this.generation && (now === "connecting" || now === "handshaking")) {
        // Keep the reason. The disconnect below fires onDisconnect on a real transport, which
        // must not turn this state into "disconnected" (see handleDisconnect).
        this.lastError = e instanceof Error ? e : new Error(String(e));
        this.setState("error");
        await this.transport.disconnect().catch(noop);
      }
      throw e;
    }
  }

  /** Disconnect. Also ends a `start()` that is still connecting, and waits until it has ended. */
  async stop(): Promise<void> {
    this.generation++;
    this.failPending(new DeviceError("disconnected"));
    const inFlight = this.connecting;
    await this.transport.disconnect().catch(noop);
    if (inFlight) {
      await inFlight;
      // If the connect won the race against the disconnect, close what it opened.
      await this.transport.disconnect().catch(noop);
    }
    this.resetConnectionData();
    this.hello = undefined;
    this.setState("disconnected");
  }

  /** Stop and release everything: the transport callbacks and all listeners. Final. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.stop();
    for (const off of this.unsubscribe.splice(0)) off();
    this.clearListeners();
  }

  /**
   * True when no `status` arrived recently (or none at all since connecting). The clock is read
   * here too: when the tab is in the background or the device sleeps, the timer behind the
   * `statusStale` event runs late, and a getter that trusted the flag alone would still say the
   * old `tx_ready` is current.
   */
  get statusStale(): boolean {
    if (this.lastStatus === undefined || this.staleFlag) return true;
    return this.lastStatusAt === undefined || Date.now() - this.lastStatusAt > STATUS_STALE_MS;
  }

  /** True when `settings` holds values the device reported and that no failed save has put in doubt. */
  get settingsKnown(): boolean {
    return this.settingsValid;
  }

  // ---- operations -------------------------------------------------------------------------

  async getStatus(): Promise<StatusMsg> {
    return (await this.request({ op: "status" })) as StatusMsg;
  }

  async getSchema(): Promise<SchemaItem[]> {
    const msg = (await this.request({ op: "settings.schema" })) as SchemaMsg;
    this.schema = Array.isArray(msg.items) ? msg.items : [];
    this.emit("schema", this.schema);
    return this.schema;
  }

  async getSettings(): Promise<SettingsMsg> {
    return this.applySettings((await this.request({ op: "settings.get" })) as SettingsMsg);
  }

  /** Which confirmations `setSettings(values)` would require now. Ask the user for each. */
  requiredConfirmations(values: Record<string, unknown>): SettingsRisk[] {
    const norm = normalizeSettings(values, this.schema);
    if ("error" in norm) return [];
    if (!this.settingsValid) {
      // Unknown current values: be careful.
      const r: SettingsRisk[] = [];
      if ("callsign" in norm.values) r.push("callsign");
      if ("ssid" in norm.values) r.push("ssid");
      if (norm.values.tx_enabled === true) r.push("tx_enable");
      return r;
    }
    return settingsRisks(this.settings, norm.values);
  }

  /**
   * Validate `values` (invalid ones are rejected with code `invalid` and the key; nothing is
   * sent), then send the items that differ from the device's values, in one settings.set.
   * `undefined` values are ignored. `tx_enabled` is always sent when given, never skipped as
   * "unchanged". If the cached settings are in doubt (a save timed out, or `status` disagrees),
   * they are read again first. If nothing differs, nothing is sent.
   *
   * A change of callsign (including to null) and `tx_enabled: true` need the user's confirmation:
   * pass `{ confirmed: [...] }` with the risks from `requiredConfirmations`, or the call is
   * refused with code `confirmation_required`.
   */
  async setSettings(
    values: Record<string, unknown>,
    options: SetSettingsOptions = {},
  ): Promise<SettingsMsg> {
    this.requireReady();
    const norm = normalizeSettings(values, this.schema);
    if ("error" in norm) throw new DeviceError("invalid", norm.error, norm.key);
    const wanted = norm.values;
    return this.serializeSettings(async () => {
      this.requireReady();
      if (Object.keys(wanted).length === 0) return this.emptyResult();
      await this.ensureSettings();
      const diff: SettingsValues = {};
      for (const [k, v] of Object.entries(wanted)) {
        if (k === "tx_enabled" || !settingEquals(v, this.settings[k])) diff[k] = v;
      }
      const needed = settingsRisks(this.settings, diff);
      const missing = needed.filter((r) => !options.confirmed?.includes(r));
      if (missing.length > 0) {
        throw new DeviceError(
          "confirmation_required",
          `needs confirmation: ${missing.join(", ")}`,
          missing[0] === "callsign" ? "callsign" : "tx_enabled",
        );
      }
      if (Object.keys(diff).length === 0) return this.emptyResult();
      return this.saveSettings({ op: "settings.set", values: diff });
    });
  }

  /** Reset the settings to the device defaults. The user must have confirmed (type-enforced). */
  async resetSettings(confirmation: ResetConfirmation): Promise<SettingsMsg> {
    this.requireReady();
    if ((confirmation as Partial<ResetConfirmation> | undefined)?.confirmed !== true) {
      throw new DeviceError("confirmation_required", "reset needs confirmation");
    }
    return this.serializeSettings(() => {
      this.requireReady();
      return this.saveSettings({ op: "settings.reset" });
    });
  }

  async listStations(): Promise<StationMsg[]> {
    this.stations = (await this.request(
      { op: "stations.list" },
      { collect: true },
    )) as StationMsg[];
    this.emit("stations", this.stations);
    return this.stations;
  }

  // ---- settings helpers -------------------------------------------------------------------

  private requireReady(): void {
    if (this.state !== "ready") throw new DeviceError("not_connected");
  }

  private emptyResult(): SettingsMsg {
    return { t: "settings", values: structuredClone(this.settings), changed: [] };
  }

  /** setSettings and resetSettings run one at a time, so each sees the result of the previous. */
  private serializeSettings<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.settingsLock.then(() => fn());
    this.settingsLock = run.then(noop, noop);
    return run;
  }

  /** Send a settings.set / settings.reset. If its outcome is unknown, distrust the cache. */
  private async saveSettings(req: Request): Promise<SettingsMsg> {
    try {
      return this.applySettings((await this.request(req)) as SettingsMsg);
    } catch (e) {
      if (!(e instanceof DeviceError && NOT_APPLIED.has(e.code))) {
        this.settingsValid = false;
        this.refreshSettingsSoon();
      }
      throw e;
    }
  }

  /** Read the settings again if they are in doubt. Concurrent callers share one request. */
  private ensureSettings(): Promise<void> {
    if (this.settingsValid) return Promise.resolve();
    if (!this.refreshing) {
      const p: Promise<void> = this.getSettings()
        .then(noop)
        .finally(() => {
          if (this.refreshing === p) this.refreshing = undefined;
        });
      this.refreshing = p;
    }
    return this.refreshing;
  }

  private refreshSettingsSoon(): void {
    if (this.state === "ready") this.ensureSettings().catch(noop);
  }

  private applySettings(msg: SettingsMsg): SettingsMsg {
    this.settings = structuredClone(msg.values);
    this.settingsValid = true;
    this.emit("settings", msg);
    return msg;
  }

  /** `status` repeats `tx_enabled` and `call`: if they disagree with the cache, read it again. */
  private checkStatusAgainstSettings(s: StatusMsg): void {
    if (!this.settingsValid) return;
    const cs = this.settings.callsign;
    let differs = typeof s.tx_enabled === "boolean" && s.tx_enabled !== this.settings.tx_enabled;
    if (typeof cs === "string" && typeof s.call === "string") {
      const ssid = this.settings.ssid;
      const expected = typeof ssid === "number" && ssid > 0 ? `${cs}-${ssid}` : cs;
      if (s.call !== expected) differs = true;
    }
    if (differs) {
      this.settingsValid = false;
      this.refreshSettingsSoon();
    }
  }

  // ---- request machinery ------------------------------------------------------------------

  private request(
    req: Request,
    opts: { retry?: Pending["retry"]; collect?: boolean } = {},
  ): Promise<unknown> {
    if (this.state !== "handshaking" && this.state !== "ready") {
      return Promise.reject(new DeviceError("not_connected"));
    }
    const gen = this.generation;
    const result = this.queue.then(() =>
      gen !== this.generation
        ? Promise.reject(new DeviceError("disconnected"))
        : this.exec(req, opts),
    );
    this.queue = result.then(noop, noop);
    return result;
  }

  private exec(
    req: Request,
    opts: { retry?: Pending["retry"]; collect?: boolean },
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      let bytes: Uint8Array;
      try {
        bytes = encodeLine({ ...req, id });
      } catch (e) {
        // Too long: the device would answer `too_long` without an id, so refuse here.
        reject(
          e instanceof RangeError
            ? new DeviceError("too_long", `request exceeds ${MAX_LINE_BYTES} bytes`)
            : e,
        );
        return;
      }
      const p: Pending = {
        id,
        bytes,
        resolve,
        reject,
        sends: 0,
        busyRetried: false,
        retry: opts.retry,
        stations: opts.collect ? [] : undefined,
      };
      this.pending = p;
      this.send(p);
    });
  }

  /**
   * Write the request. The timeout (or the next resend of hello) starts only after the write has
   * completed: a write can wait a long time for the user to type the passkey (§4), and that wait
   * must not count against the response time.
   */
  private send(p: Pending): void {
    p.sends++;
    this.writeBytes(p.bytes).then(
      () => {
        if (this.pending === p) this.arm(p);
      },
      (e: unknown) => {
        // hello is resent after a failed write too, while the time is not up: before the device
        // authenticates, Chrome may reject the refused write instead of holding it (§4).
        if (
          p.retry &&
          this.pending === p &&
          !(e instanceof DeviceError) &&
          Date.now() < p.retry.until
        ) {
          clearTimeout(p.timer);
          p.timer = setTimeout(() => {
            if (this.pending === p) this.send(p);
          }, p.retry.everyMs);
          return;
        }
        this.settle(p, () =>
          p.reject(
            e instanceof DeviceError
              ? e
              : new DeviceError("write_failed", e instanceof Error ? e.message : String(e)),
          ),
        );
      },
    );
  }

  /**
   * Whole lines are written one after another, so chunks of different lines never interleave.
   * Chunks of a line from an earlier connection are not written to a newer one.
   */
  private writeBytes(bytes: Uint8Array): Promise<void> {
    const gen = this.generation;
    const chunks = splitBytes(bytes, this.opts.maxWriteBytes);
    const done = this.writeChain.then(async () => {
      if (gen !== this.generation) throw new DeviceError("disconnected");
      await this.resync();
      for (const c of chunks) {
        if (gen !== this.generation) throw new DeviceError("disconnected");
        try {
          await this.transport.write(c);
        } catch (e) {
          // The device may hold the first part of this line (§5.3).
          if (gen === this.generation) this.needsResync = true;
          throw e;
        }
      }
    });
    this.writeChain = done.catch(noop);
    return done;
  }

  /**
   * After a failed write the device may hold part of a line, which would be glued to the next
   * request. A single "\n" ends it (§5.3): the device answers one `bad_json` (no id) if it held a
   * fragment and nothing if it did not. That answer belongs to the resync, not to the request.
   */
  private async resync(): Promise<void> {
    if (!this.needsResync) return;
    this.expectBadJson = true; // before the write: the answer can overtake the write's completion
    try {
      await this.transport.write(NEWLINE);
    } catch (e) {
      this.expectBadJson = false;
      throw e;
    }
    this.needsResync = false;
  }

  private resetResync(): void {
    this.needsResync = false;
    this.expectBadJson = false;
  }

  /** (Re)start the timeout, or the resend timer for requests that are resent (hello). */
  private arm(p: Pending): void {
    clearTimeout(p.timer);
    if (p.retry) {
      p.timer = setTimeout(() => {
        if (this.pending !== p) return;
        if (Date.now() < p.retry!.until) {
          this.send(p); // arms again when the write has completed
        } else {
          this.settle(p, () => p.reject(new DeviceError("timeout", "no response")));
        }
      }, p.retry.everyMs);
    } else {
      p.timer = setTimeout(
        () => this.settle(p, () => p.reject(new DeviceError("timeout", "no response"))),
        this.opts.requestTimeoutMs,
      );
    }
  }

  private settle(p: Pending, finish: () => void): void {
    if (this.pending !== p) return;
    clearTimeout(p.timer);
    clearTimeout(p.busyTimer);
    this.pending = undefined;
    // The answer to a resync comes before the response to the request that followed it.
    this.expectBadJson = false;
    finish();
  }

  private failPending(e: Error): void {
    const p = this.pending;
    if (p) this.settle(p, () => p.reject(e));
  }

  // ---- incoming ---------------------------------------------------------------------------

  private onChunk(chunk: Uint8Array): void {
    // Notifications that arrive after the link is gone or the start has failed are ignored.
    if (
      this.state === "disconnected" ||
      this.state === "error" ||
      this.state === "proto_mismatch"
    ) {
      return;
    }
    let lines: string[];
    try {
      lines = this.assembler.push(chunk);
    } catch (e) {
      console.error("failed to read a notification:", e);
      return;
    }
    // One line must not stop the next ones, whatever a listener does.
    for (const line of lines) {
      try {
        this.onLine(line);
      } catch (e) {
        console.error("failed to handle a line:", e);
      }
    }
  }

  private onLine(line: string): void {
    const m = parseMessage(line);
    if (isParseError(m)) {
      const p = this.pending;
      if (p && m.id !== undefined && m.id === p.id) {
        // The reply to the request in flight is malformed: it will not be answered again.
        this.settle(p, () => p.reject(new DeviceError("bad_response", m.error)));
      }
      this.emit("lineError", m);
      return;
    }
    if (m.t === "status") {
      this.lastStatus = m as StatusMsg;
      this.lastStatusAt = Date.now();
      this.armStale();
    }
    // Resolve the request first, then tell the listeners.
    if (this.route(m)) return;
    if (m.t === "status") {
      this.checkStatusAgainstSettings(m as StatusMsg);
      this.emit("status", m as StatusMsg);
    } else if (m.t === "rx") {
      this.emit("rx", m as RxMsg);
    } else if (m.t === "tx") {
      this.emit("tx", m as TxMsg);
    }
  }

  /** Match a message to the request in flight. Returns true if it was an `err` (fully handled). */
  private route(m: Incoming): boolean {
    const p = this.pending;
    if (m.t === "err") {
      const e = m as ErrMsg;
      if (e.id === undefined && e.code === "bad_json" && this.expectBadJson) {
        this.expectBadJson = false; // the answer to the resync "\n" (§5.3)
      } else if (p && e.id === p.id) {
        this.settle(p, () => p.reject(new DeviceError(e.code, e.msg, e.key)));
      } else if (p && e.id === undefined && e.code === "busy") {
        this.onBusy(p);
      } else if (p && e.id === undefined && (e.code === "too_long" || e.code === "bad_json")) {
        // These come without an id. With one request in flight, it is the one that failed.
        this.settle(p, () => p.reject(new DeviceError(e.code, e.msg, e.key)));
      } else {
        this.emit("deviceError", e);
      }
      return true;
    }
    if (!p || (m as { id?: number }).id !== p.id) return false; // an event, or a late duplicate reply

    if (p.stations) {
      if (m.t === "station") {
        p.stations.push(m as StationMsg);
        this.arm(p); // each line extends the timeout
      } else if (m.t === "stations.end") {
        this.settle(p, () => p.resolve(p.stations));
      }
      return false;
    }
    this.settle(p, () => p.resolve(m as Incoming));
    return false;
  }

  /** `busy` has no id: resend the one request in flight, once, after a short wait. */
  private onBusy(p: Pending): void {
    if (p.busyRetried) {
      this.settle(p, () => p.reject(new DeviceError("busy", "device busy")));
      return;
    }
    p.busyRetried = true;
    if (p.stations) p.stations = [];
    clearTimeout(p.busyTimer);
    p.busyTimer = setTimeout(() => {
      if (this.pending === p) this.send(p);
    }, this.opts.busyRetryDelayMs);
  }

  private handleDisconnect(reason?: string): void {
    this.generation++;
    this.resetResync();
    this.lastDisconnectReason = reason;
    this.failPending(new DeviceError("disconnected"));
    this.resetConnectionData();
    if (this.state === "proto_mismatch") return; // keep `hello` and the state: they explain why
    this.hello = undefined;
    // A failed start() ends in "error" and then disconnects: that must not hide the error.
    if (this.state !== "error") this.setState("disconnected");
  }

  /** Forget what belongs to the connection: it must not look current after a disconnect. */
  private resetConnectionData(): void {
    this.resetResync();
    this.lastStatus = undefined;
    this.lastStatusAt = undefined;
    clearTimeout(this.staleTimer);
    this.staleTimer = undefined;
    this.staleFlag = false;
    this.settings = {};
    this.settingsValid = false;
    this.refreshing = undefined;
  }

  /** (Re)start the clock that marks the status stale. */
  private armStale(): void {
    clearTimeout(this.staleTimer);
    if (this.staleFlag) {
      this.staleFlag = false;
      this.emit("statusStale", false);
    }
    this.staleTimer = setTimeout(() => {
      this.staleFlag = true;
      this.emit("statusStale", true);
    }, STATUS_STALE_MS);
  }

  private currentState(): ClientState {
    return this.state;
  }

  private setState(s: ClientState): void {
    if (this.state === s) return;
    this.state = s;
    this.emit("state", s);
  }
}
