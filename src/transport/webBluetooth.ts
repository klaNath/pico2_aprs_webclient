// Web Bluetooth transport (ble-protocol.md §2-§5, §10). Nordic UART Service:
// the app writes lines to RX (20 bytes per write, with response, one at a time) and receives
// TX notifications. Pairing (§4) happens inside connect(): Chrome shows the OS dialog when an
// encrypted characteristic is first touched, so connect() may take as long as the user needs.

import { MAX_WRITE_BYTES } from "../protocol/framing.ts";
import type { Transport } from "./transport.ts";

export const NUS_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
export const NUS_RX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"; // app -> device
export const NUS_TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"; // device -> app

/** The part of `navigator.bluetooth` the app uses (a fake in tests). */
export interface BluetoothLike {
  requestDevice(options: RequestDeviceOptions): Promise<BluetoothDevice>;
  getDevices?: () => Promise<BluetoothDevice[]>;
}

export function getBluetooth(): BluetoothLike | undefined {
  return typeof navigator !== "undefined" && "bluetooth" in navigator
    ? navigator.bluetooth
    : undefined;
}

/**
 * Open Chrome's device chooser. Call it directly in a click handler, before any `await`: Chrome
 * only allows it during a user action (§10). Filters by the NUS service UUID, not by name (§2).
 */
export function requestTrackerDevice(bt: BluetoothLike): Promise<BluetoothDevice> {
  return bt.requestDevice({ filters: [{ services: [NUS_SERVICE] }] });
}

/** Devices this site was allowed to use before (for reconnecting without the chooser). */
export async function knownTrackerDevices(bt: BluetoothLike): Promise<BluetoothDevice[]> {
  if (!bt.getDevices) return [];
  try {
    return await bt.getDevices();
  } catch {
    return [];
  }
}

function errorName(e: unknown): string {
  return typeof e === "object" && e !== null && "name" in e ? String(e.name) : "";
}

export class WebBluetoothTransport implements Transport {
  readonly deviceId: string;
  readonly device: BluetoothDevice;

  private rx: BluetoothRemoteGATTCharacteristic | undefined;
  private tx: BluetoothRemoteGATTCharacteristic | undefined;
  private connected = false;
  /** Bumped by every connect() and disconnect(); a step of an older connect() is void. */
  private epoch = 0;
  private abortConnect: ((e: Error) => void) | undefined;
  private readonly dataCbs = new Set<(chunk: Uint8Array) => void>();
  private readonly disconnectCbs = new Set<(reason?: string) => void>();
  /** Set when the app itself asked to disconnect, so the reason can say so. */
  private closing = false;

  private readonly onValue = (ev: Event): void => {
    const v = (ev.target as BluetoothRemoteGATTCharacteristic | null)?.value;
    if (!v) return;
    // Copy: Chrome may reuse the buffer for the next notification.
    const chunk = new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
    for (const cb of this.dataCbs) cb(chunk);
  };

  private readonly onGattDisconnected = (): void => {
    const wasConnected = this.connected;
    this.dropLink();
    const reason = this.closing ? "closed by the app" : "link lost";
    this.closing = false;
    this.abortConnect?.(new Error(`connect aborted: ${reason}`));
    if (wasConnected) for (const cb of this.disconnectCbs) cb(reason);
  };

  constructor(device: BluetoothDevice) {
    this.device = device;
    this.deviceId = device.id;
    device.addEventListener("gattserverdisconnected", this.onGattDisconnected);
  }

  /** The advertised name (`PicoAPRS-XXXX`), for showing which unit this is. */
  get name(): string | undefined {
    return this.device.name ?? undefined;
  }

  async connect(): Promise<void> {
    const gatt = this.device.gatt;
    if (!gatt) throw new Error("This Bluetooth device has no GATT server");
    const epoch = ++this.epoch;
    this.closing = false;
    this.dropLink();
    const aborted = new Promise<never>((_, reject) => {
      this.abortConnect = reject;
    });
    aborted.catch(() => undefined); // only observed through the race below
    const step = <T>(p: Promise<T>): Promise<T> => Promise.race([p, aborted]);
    try {
      const server = await step(gatt.connect());
      const service = await step(server.getPrimaryService(NUS_SERVICE));
      const tx = await step(service.getCharacteristic(NUS_TX));
      const rx = await step(service.getCharacteristic(NUS_RX));
      tx.addEventListener("characteristicvaluechanged", this.onValue);
      this.tx = tx;
      // Encrypted characteristic: on a first connection this is where pairing (§4) happens.
      await step(tx.startNotifications());
      if (epoch !== this.epoch) throw new Error("connect aborted");
      this.rx = rx;
      this.connected = true;
    } catch (e) {
      if (epoch === this.epoch) {
        this.dropLink();
        if (gatt.connected) gatt.disconnect();
      }
      throw e instanceof Error ? e : new Error(String(e));
    } finally {
      if (epoch === this.epoch) this.abortConnect = undefined;
    }
  }

  disconnect(): Promise<void> {
    this.epoch++;
    this.closing = true;
    this.abortConnect?.(new Error("connect aborted"));
    this.abortConnect = undefined;
    const gatt = this.device.gatt;
    if (gatt?.connected) {
      gatt.disconnect(); // fires gattserverdisconnected -> onDisconnect
    } else {
      this.closing = false;
      this.dropLink();
    }
    return Promise.resolve();
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (chunk.length > MAX_WRITE_BYTES) {
      throw new Error(`write of ${chunk.length} bytes exceeds ${MAX_WRITE_BYTES} (§5.2)`);
    }
    const rx = this.rx;
    if (!this.connected || !rx) throw new Error("not connected");
    const epoch = this.epoch;
    try {
      // With response, and the caller waits for each one (§5.2). Copy into a plain ArrayBuffer.
      await rx.writeValueWithResponse(new Uint8Array(chunk));
    } catch (e) {
      const name = errorName(e);
      throw new Error(`write failed${name ? ` (${name})` : ""}`, { cause: e });
    }
    if (epoch !== this.epoch || !this.connected) throw new Error("write failed: disconnected");
  }

  onData(cb: (chunk: Uint8Array) => void): () => void {
    this.dataCbs.add(cb);
    return () => this.dataCbs.delete(cb);
  }

  onDisconnect(cb: (reason?: string) => void): () => void {
    this.disconnectCbs.add(cb);
    return () => this.disconnectCbs.delete(cb);
  }

  private dropLink(): void {
    this.connected = false;
    this.rx = undefined;
    if (this.tx) this.tx.removeEventListener("characteristicvaluechanged", this.onValue);
    this.tx = undefined;
  }
}
