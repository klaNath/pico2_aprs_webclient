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
}

const MOCK_STATIONS = [
  { src: "Q1AAA-9", lat: 35.66867, lon: 139.76117, sym: "/>", comment: "Hello" },
  { src: "Q1BBB", lat: 35.7, lon: 139.8, sym: "/-", comment: "Home" },
  { src: "Q1CCC-1", lat: 35.6, lon: 139.7, sym: "\\k", comment: "Truck" },
];

export class MockTransport implements Transport {
  readonly device: MockDevice;
  /** Skip (silently drop) the next request line and answer `err busy` instead. */
  busyOnNextLine = false;
  /** Number of lines silently dropped because they were written before authentication. */
  droppedBeforeAuth = 0;

  private readonly opts: Required<Omit<MockTransportOptions, "device">>;
  private dataCb: ((chunk: Uint8Array) => void) | undefined;
  private disconnectCb: ((reason?: string) => void) | undefined;
  private connected = false;
  private authenticated = false;
  private readonly assembler = new LineAssembler();
  private readonly encoder = new TextEncoder();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private statusTimer: ReturnType<typeof setInterval> | undefined;

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
    };
  }

  connect(): Promise<void> {
    this.cleanup();
    this.assembler.reset();
    this.connected = true;
    this.authenticated = false;
    if (this.opts.authDelayMs > 0) this.later(this.opts.authDelayMs, () => this.onAuthenticated());
    else this.onAuthenticated();
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    this.cleanup();
    this.connected = false;
    this.authenticated = false;
    return Promise.resolve();
  }

  write(chunk: Uint8Array): Promise<void> {
    if (!this.connected) return Promise.reject(new Error("not connected"));
    if (!this.authenticated) {
      // Commands before authentication are silently dropped (§4).
      for (const b of chunk) if (b === 0x0a) this.droppedBeforeAuth++; // count whole lines
      return Promise.resolve();
    }
    for (const line of this.assembler.push(chunk)) {
      if (this.busyOnNextLine) {
        this.busyOnNextLine = false;
        this.notify(JSON.stringify({ t: "err", code: "busy" }));
        continue;
      }
      for (const out of this.device.handleLine(line)) this.notify(out);
    }
    return Promise.resolve();
  }

  onData(cb: (chunk: Uint8Array) => void): void {
    this.dataCb = cb;
  }

  onDisconnect(cb: (reason?: string) => void): void {
    this.disconnectCb = cb;
  }

  /** Drop the link as if the device went out of range. */
  simulateDisconnect(reason = "link lost"): void {
    this.cleanup();
    this.connected = false;
    this.authenticated = false;
    this.disconnectCb?.(reason);
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
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.statusTimer !== undefined) clearInterval(this.statusTimer);
    this.statusTimer = undefined;
  }
}
