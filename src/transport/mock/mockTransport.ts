// Mock Transport: a simulated device behind the Transport interface.
// Reproduces: silent drop of writes before authentication (§4), status every 5 s,
// irregular rx events, notification splitting (even in the middle of a UTF-8 char), `busy`.

import { LineAssembler } from "../../protocol/framing.ts";
import type { RxMsg } from "../../protocol/types.ts";
import type { Transport } from "../transport.ts";
import { MockDevice } from "./mockDevice.ts";

export interface MockTransportOptions {
  device?: MockDevice;
  /** Time until the connection counts as authenticated. Writes before that are dropped. */
  authDelayMs?: number;
  /** Max bytes per notification. */
  notifySize?: number;
  statusIntervalMs?: number;
  /** Generate random rx events. */
  autoRx?: boolean;
  rxMinMs?: number;
  rxMaxMs?: number;
  rng?: () => number;
  /** Time connect() takes (pairing, notifications). 0 = resolves at once. */
  connectDelayMs?: number;
  /** Initial value of `writeDelayMs`. */
  writeDelayMs?: number;
}

/** §8.1: a change of fix, sw, tx_ready, tx_enabled, call or beacon_mode is sent as a status about this long later. */
const STATUS_CHANGE_DELAY_MS = 20;

/** The real limit (§5.2). Written out here on purpose, not imported, so that a change of the app's constant is caught. */
const DEVICE_MAX_WRITE_BYTES = 20;

const MOCK_STATIONS = [
  { src: "Q1AAA-9", lat: 35.66867, lon: 139.76117, sym: "/>", comment: "Hello" },
  { src: "Q1BBB", lat: 35.7, lon: 139.8, sym: "/-", comment: "Home" },
  { src: "Q1CCC-1", lat: 35.6, lon: 139.7, sym: "\\k", comment: "Truck" },
];

export class MockTransport implements Transport {
  readonly device: MockDevice;
  /** Skip (silently drop) the next request line and answer `err busy` instead. */
  busyOnNextLine = false;
  /** Time each write takes before the device sees it (0 = at once). May be changed at any time. */
  writeDelayMs: number;
  /** Number of lines silently dropped because they were written before authentication. */
  droppedBeforeAuth = 0;

  private readonly opts: Required<Omit<MockTransportOptions, "device" | "writeDelayMs">>;
  private dataCb: ((chunk: Uint8Array) => void) | undefined;
  private disconnectCb: ((reason?: string) => void) | undefined;
  private connected = false;
  /** Bumped when the link goes away; writes still in flight for an older link fail. */
  private epoch = 0;
  private abortConnect: (() => void) | undefined;
  private authenticated = false;
  private readonly assembler = new LineAssembler();
  private readonly encoder = new TextEncoder();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private statusTimer: ReturnType<typeof setInterval> | undefined;
  /** The fields of §8.1 whose change triggers a status event, as of the last check. */
  private statusKey = "";
  private statusChangeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: MockTransportOptions = {}) {
    this.device = options.device ?? new MockDevice();
    this.opts = {
      authDelayMs: options.authDelayMs ?? 0,
      notifySize: options.notifySize ?? 20,
      statusIntervalMs: options.statusIntervalMs ?? 5000,
      autoRx: options.autoRx ?? true,
      rxMinMs: options.rxMinMs ?? 3000,
      rxMaxMs: options.rxMaxMs ?? 15000,
      rng: options.rng ?? Math.random,
      connectDelayMs: options.connectDelayMs ?? 0,
    };
    this.writeDelayMs = options.writeDelayMs ?? 0;
  }

  /** True while the link is up (connected and not yet disconnected). For tests. */
  get isConnected(): boolean {
    return this.connected;
  }

  connect(): Promise<void> {
    this.cleanup();
    this.assembler.reset();
    const epoch = ++this.epoch;
    const finish = (): void => {
      this.connected = true;
      this.authenticated = false;
      if (this.opts.authDelayMs > 0)
        this.later(this.opts.authDelayMs, () => this.onAuthenticated());
      else this.onAuthenticated();
    };
    if (this.opts.connectDelayMs <= 0) {
      finish();
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.abortConnect = undefined;
        if (epoch !== this.epoch) return;
        finish();
        resolve();
      }, this.opts.connectDelayMs);
      // disconnect() during connect() makes it reject (see the Transport contract).
      this.abortConnect = () => {
        clearTimeout(t);
        this.abortConnect = undefined;
        reject(new Error("connect aborted"));
      };
    });
  }

  /** Like a real link: closing it also fires the disconnect callback (asynchronously). */
  disconnect(): Promise<void> {
    const wasUp = this.connected;
    this.abortConnect?.();
    this.closeLink();
    if (wasUp) queueMicrotask(() => this.disconnectCb?.());
    return Promise.resolve();
  }

  write(chunk: Uint8Array): Promise<void> {
    if (chunk.length > DEVICE_MAX_WRITE_BYTES) {
      return Promise.reject(
        new Error(`write of ${chunk.length} bytes exceeds ${DEVICE_MAX_WRITE_BYTES} (§5.2)`),
      );
    }
    if (!this.connected) return Promise.reject(new Error("not connected"));
    const delay = this.writeDelayMs;
    if (delay <= 0) {
      this.deliver(chunk);
      return Promise.resolve();
    }
    const epoch = this.epoch;
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        if (epoch !== this.epoch || !this.connected) {
          reject(new Error("write failed: disconnected"));
          return;
        }
        this.deliver(chunk);
        resolve();
      }, delay);
    });
  }

  private deliver(chunk: Uint8Array): void {
    if (!this.authenticated) {
      // Commands before authentication are silently dropped (§4).
      for (const b of chunk) if (b === 0x0a) this.droppedBeforeAuth++; // count whole lines
      return;
    }
    for (const line of this.assembler.push(chunk)) {
      if (this.busyOnNextLine) {
        this.busyOnNextLine = false;
        this.notify(JSON.stringify({ t: "err", code: "busy" }));
        continue;
      }
      for (const out of this.device.handleLine(line)) this.notify(out);
      this.checkStatusChange();
    }
  }

  /**
   * Like the device (§8.1): when `fix`, `sw`, `tx_ready`, `tx_enabled` or `call` changed since the
   * last check, one `status` event follows about 20 ms later. Called after every request; a test
   * that changes `device.sw` or `device.fix` itself calls it too.
   */
  checkStatusChange(): void {
    const key = this.currentStatusKey();
    if (key === this.statusKey) return;
    this.statusKey = key;
    if (!this.connected || !this.authenticated || this.statusChangeTimer !== undefined) return;
    this.statusChangeTimer = setTimeout(() => {
      this.statusChangeTimer = undefined;
      this.notify(JSON.stringify(this.device.status()));
    }, STATUS_CHANGE_DELAY_MS);
  }

  private currentStatusKey(): string {
    const { fix, sw, tx_enabled, tx_ready, call, beacon_mode } = this.device.status();
    return JSON.stringify([fix, sw, tx_enabled, tx_ready, call, beacon_mode]);
  }

  onData(cb: (chunk: Uint8Array) => void): () => void {
    this.dataCb = cb;
    return () => {
      if (this.dataCb === cb) this.dataCb = undefined;
    };
  }

  onDisconnect(cb: (reason?: string) => void): () => void {
    this.disconnectCb = cb;
    return () => {
      if (this.disconnectCb === cb) this.disconnectCb = undefined;
    };
  }

  /** Drop the link as if the device went out of range. */
  simulateDisconnect(reason = "link lost"): void {
    this.abortConnect?.();
    this.closeLink();
    this.disconnectCb?.(reason);
  }

  private closeLink(): void {
    this.cleanup();
    this.connected = false;
    this.authenticated = false;
    this.epoch++;
  }

  /** Send one rx event now (also used by the random timer). */
  emitRx(): RxMsg {
    const s = MOCK_STATIONS[Math.floor(this.opts.rng() * MOCK_STATIONS.length)]!;
    this.device.rxCount++;
    const rx: RxMsg = {
      t: "rx",
      tnc2: `${s.src}>APRS,WIDE1-1*:!3540.12N/13945.67E${s.sym[1]}${s.comment}`,
      src: s.src,
      kind: "position",
      lat: s.lat,
      lon: s.lon,
      sym: s.sym,
      lvl_db: Math.round((-30 + this.opts.rng() * 20) * 10) / 10,
    };
    if (this.connected && this.authenticated) this.notify(JSON.stringify(rx));
    return rx;
  }

  /** Send an arbitrary line to the app (for tests of odd input). */
  sendRaw(line: string): void {
    this.notify(line);
  }

  private onAuthenticated(): void {
    this.authenticated = true;
    this.statusKey = this.currentStatusKey();
    this.notify(JSON.stringify(this.device.status())); // status right after connecting
    this.statusTimer = setInterval(
      () => this.notify(JSON.stringify(this.device.status())),
      this.opts.statusIntervalMs,
    );
    if (this.opts.autoRx) this.scheduleRx();
  }

  private scheduleRx(): void {
    const { rxMinMs, rxMaxMs, rng } = this.opts;
    this.later(rxMinMs + rng() * (rxMaxMs - rxMinMs), () => {
      this.emitRx();
      this.scheduleRx();
    });
  }

  /** Deliver one line as notifications of at most `notifySize` bytes. */
  private notify(line: string): void {
    if (!this.connected) return;
    const bytes = this.encoder.encode(line + "\n");
    const size = this.opts.notifySize;
    for (let i = 0; i < bytes.length; i += size) this.dataCb?.(bytes.slice(i, i + size));
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  private cleanup(): void {
    clearTimeout(this.statusChangeTimer);
    this.statusChangeTimer = undefined;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.statusTimer !== undefined) clearInterval(this.statusTimer);
    this.statusTimer = undefined;
  }
}
