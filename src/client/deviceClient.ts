// Device client: request/response matching, retries, and the connection flow (§6.2).
//
// Requests are sent one at a time (the next one waits for the previous response). `busy` errors
// carry no id, so with a single request in flight it is always clear which one to resend.

import { LineAssembler, MAX_WRITE_BYTES, encodeLine, splitBytes } from "../protocol/framing.ts";
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
  SettingValue,
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
  status: StatusMsg;
  rx: RxMsg;
  tx: TxMsg;
  stations: StationMsg[];
  schema: SchemaItem[];
  settings: SettingsMsg;
  /** An `err` that is not the answer to a pending request. */
  deviceError: ErrMsg;
  /** A line that could not be read as a JSON object. */
  lineError: ParseError;
};

export interface DeviceClientOptions {
  requestTimeoutMs?: number;
  helloRetryMs?: number;
  helloAttempts?: number;
  busyRetryDelayMs?: number;
  maxWriteBytes?: number;
}

/** Local codes: timeout, disconnected, not_connected, proto_mismatch, already_started. */
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

interface Pending {
  id: number;
  bytes: Uint8Array;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  sends: number;
  busyRetried: boolean;
  retry?: { everyMs: number; max: number };
  /** Set for stations.list: collects `station` lines until `stations.end`. */
  stations?: StationMsg[];
  timer?: ReturnType<typeof setTimeout>;
  busyTimer?: ReturnType<typeof setTimeout>;
}

export class DeviceClient extends Emitter<ClientEvents> {
  state: ClientState = "disconnected";
  hello: HelloMsg | undefined;
  lastStatus: StatusMsg | undefined;
  schema: SchemaItem[] = [];
  settings: SettingsValues = {};
  stations: StationMsg[] = [];

  private readonly opts: Required<DeviceClientOptions>;
  private readonly assembler = new LineAssembler();
  private nextId = 1;
  private pending: Pending | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private writeChain: Promise<void> = Promise.resolve();
  /** Bumped on every start and disconnect; requests from an older connection are rejected. */
  private generation = 0;

  private readonly transport: Transport;

  constructor(transport: Transport, options: DeviceClientOptions = {}) {
    super();
    this.transport = transport;
    this.opts = {
      requestTimeoutMs: options.requestTimeoutMs ?? 5000,
      helloRetryMs: options.helloRetryMs ?? 3000,
      helloAttempts: options.helloAttempts ?? 5,
      busyRetryDelayMs: options.busyRetryDelayMs ?? 500,
      maxWriteBytes: options.maxWriteBytes ?? MAX_WRITE_BYTES,
    };
    transport.onData((chunk) => {
      for (const line of this.assembler.push(chunk)) this.onLine(line);
    });
    transport.onDisconnect(() => this.handleDisconnect());
  }

  // ---- connection flow (§6.2) -------------------------------------------------------------

  /** Connect and run hello -> schema -> settings -> stations. Resolves when ready. */
  async start(): Promise<void> {
    if (
      this.state !== "disconnected" &&
      this.state !== "error" &&
      this.state !== "proto_mismatch"
    ) {
      throw new DeviceError("already_started");
    }
    const gen = ++this.generation;
    this.assembler.reset();
    this.setState("connecting");
    try {
      await this.transport.connect();
      if (gen !== this.generation) throw new DeviceError("disconnected");
      this.setState("handshaking");

      // Commands before authentication are silently dropped, so hello is resent.
      const hello = (await this.request(
        { op: "hello" },
        { retry: { everyMs: this.opts.helloRetryMs, max: this.opts.helloAttempts } },
      )) as HelloMsg;
      this.hello = hello;
      if (hello.proto !== PROTO_VERSION) {
        this.setState("proto_mismatch");
        await this.transport.disconnect().catch(() => undefined);
        throw new DeviceError(
          "proto_mismatch",
          `device proto ${String(hello.proto)}, app proto ${PROTO_VERSION}`,
        );
      }
      await this.getSchema();
      await this.getSettings();
      await this.listStations();
      if (gen !== this.generation) throw new DeviceError("disconnected");
      this.setState("ready");
    } catch (e) {
      const now = this.currentState(); // TS narrowed `this.state` before the awaits
      if (gen === this.generation && (now === "connecting" || now === "handshaking")) {
        this.setState("error");
        await this.transport.disconnect().catch(() => undefined);
      }
      throw e;
    }
  }

  async stop(): Promise<void> {
    this.generation++;
    this.failPending(new DeviceError("disconnected"));
    await this.transport.disconnect().catch(() => undefined);
    this.setState("disconnected");
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

  /**
   * Send only the items that differ from the known values, in one settings.set.
   * If nothing differs, nothing is sent. The caller is responsible for confirmation dialogs.
   */
  async setSettings(values: Record<string, SettingValue>): Promise<SettingsMsg> {
    const diff: SettingsValues = {};
    for (const [k, v] of Object.entries(values)) {
      if (JSON.stringify(v) !== JSON.stringify(this.settings[k])) diff[k] = v;
    }
    if (Object.keys(diff).length === 0) {
      return { t: "settings", values: this.settings, changed: [] };
    }
    return this.applySettings(
      (await this.request({ op: "settings.set", values: diff })) as SettingsMsg,
    );
  }

  async resetSettings(): Promise<SettingsMsg> {
    return this.applySettings((await this.request({ op: "settings.reset" })) as SettingsMsg);
  }

  async listStations(): Promise<StationMsg[]> {
    this.stations = (await this.request(
      { op: "stations.list" },
      { collect: true },
    )) as StationMsg[];
    this.emit("stations", this.stations);
    return this.stations;
  }

  // ---- request machinery ------------------------------------------------------------------

  private applySettings(msg: SettingsMsg): SettingsMsg {
    this.settings = msg.values ?? {};
    this.emit("settings", msg);
    return msg;
  }

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
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private exec(
    req: Request,
    opts: { retry?: Pending["retry"]; collect?: boolean },
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const p: Pending = {
        id,
        bytes: encodeLine({ ...req, id }),
        resolve,
        reject,
        sends: 0,
        busyRetried: false,
        retry: opts.retry,
        stations: opts.collect ? [] : undefined,
      };
      this.pending = p;
      this.arm(p);
      this.send(p);
    });
  }

  private send(p: Pending): void {
    p.sends++;
    this.writeBytes(p.bytes).catch((e: unknown) =>
      this.settle(p, () => p.reject(e instanceof Error ? e : new Error(String(e)))),
    );
  }

  /** Whole lines are written one after another, so chunks of different lines never interleave. */
  private writeBytes(bytes: Uint8Array): Promise<void> {
    const chunks = splitBytes(bytes, this.opts.maxWriteBytes);
    const done = this.writeChain.then(async () => {
      for (const c of chunks) await this.transport.write(c);
    });
    this.writeChain = done.catch(() => undefined);
    return done;
  }

  /** (Re)start the timeout, or the resend timer for requests that are resent (hello). */
  private arm(p: Pending): void {
    clearTimeout(p.timer);
    if (p.retry) {
      p.timer = setTimeout(() => {
        if (this.pending !== p) return;
        if (p.sends < p.retry!.max) {
          this.send(p);
          this.arm(p);
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
    finish();
  }

  private failPending(e: Error): void {
    const p = this.pending;
    if (p) this.settle(p, () => p.reject(e));
  }

  // ---- incoming ---------------------------------------------------------------------------

  private onLine(line: string): void {
    const m = parseMessage(line);
    if (isParseError(m)) {
      this.emit("lineError", m);
      return;
    }
    if (m.t === "status") {
      this.lastStatus = m as StatusMsg;
      this.emit("status", this.lastStatus);
    } else if (m.t === "rx") {
      this.emit("rx", m as RxMsg);
    } else if (m.t === "tx") {
      this.emit("tx", m as TxMsg);
    }

    const p = this.pending;
    if (m.t === "err") {
      const e = m as ErrMsg;
      if (p && e.id === p.id) {
        this.settle(p, () => p.reject(new DeviceError(e.code, e.msg, e.key)));
      } else if (p && e.id === undefined && e.code === "busy") {
        this.onBusy(p);
      } else {
        this.emit("deviceError", e);
      }
      return;
    }
    if (!p || (m as { id?: number }).id !== p.id) return; // an event, or a late duplicate reply

    if (p.stations) {
      if (m.t === "station") {
        p.stations.push(m as StationMsg);
        this.arm(p); // each line extends the timeout
      } else if (m.t === "stations.end") {
        this.settle(p, () => p.resolve(p.stations));
      }
      return;
    }
    this.settle(p, () => p.resolve(m as Incoming));
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

  private handleDisconnect(): void {
    this.generation++;
    this.failPending(new DeviceError("disconnected"));
    if (this.state !== "proto_mismatch") this.setState("disconnected");
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
