import { afterEach, describe, expect, it, vi } from "vitest";
import { DeviceClient } from "../src/client/deviceClient.ts";
import { LineAssembler } from "../src/protocol/framing.ts";
import { MockDevice } from "../src/transport/mock/mockDevice.ts";
import {
  NUS_RX,
  NUS_SERVICE,
  NUS_TX,
  requestTrackerDevice,
  WebBluetoothTransport,
  type BluetoothLike,
} from "../src/transport/webBluetooth.ts";

// A fake GATT server in front of MockDevice, shaped like Chrome's Web Bluetooth objects.

const enc = new TextEncoder();

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

class FakeTx extends EventTarget {
  value: DataView | undefined;
  notifying = false;
  /** Set to hold startNotifications() (the pairing dialog). */
  gate: Promise<void> | undefined;
  private readonly dev: FakeDevice;
  constructor(dev: FakeDevice) {
    super();
    this.dev = dev;
  }
  async startNotifications(): Promise<FakeTx> {
    await this.gate;
    if (!this.dev.gatt.connected) throw Object.assign(new Error("gone"), { name: "NetworkError" });
    this.notifying = true;
    return this;
  }
  /** Send bytes as notifications of at most `size` bytes. Reuses one buffer, like Chrome may. */
  notify(bytes: Uint8Array, size = 20): void {
    const buf = new ArrayBuffer(size);
    for (let i = 0; i < bytes.length; i += size) {
      const part = bytes.subarray(i, i + size);
      new Uint8Array(buf).set(part);
      this.value = new DataView(buf, 0, part.length);
      this.dispatchEvent(new Event("characteristicvaluechanged"));
    }
  }
}

class FakeRx {
  writes: number[] = [];
  inFlight = 0;
  maxInFlight = 0;
  failNext: string | undefined;
  private readonly assembler = new LineAssembler();
  private readonly dev: FakeDevice;
  constructor(dev: FakeDevice) {
    this.dev = dev;
  }
  async writeValueWithResponse(data: BufferSource): Promise<void> {
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await Promise.resolve();
      if (this.failNext) {
        const name = this.failNext;
        this.failNext = undefined;
        throw Object.assign(new Error("GATT operation failed"), { name });
      }
      const bytes = new Uint8Array(data as ArrayBuffer);
      this.writes.push(bytes.length);
      for (const line of this.assembler.push(bytes)) {
        for (const out of this.dev.device.handleLine(line)) {
          this.dev.tx.notify(enc.encode(out + "\n"), this.dev.notifySize);
        }
      }
    } finally {
      this.inFlight--;
    }
  }
}

class FakeServer {
  connected = false;
  private readonly dev: FakeDevice;
  constructor(dev: FakeDevice) {
    this.dev = dev;
  }
  async connect(): Promise<FakeServer> {
    await this.dev.connectGate;
    this.connected = true;
    return this;
  }
  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    this.dev.dispatchEvent(new Event("gattserverdisconnected"));
  }
  async getPrimaryService(uuid: string): Promise<unknown> {
    expect(uuid).toBe(NUS_SERVICE);
    return {
      getCharacteristic: async (c: string) => {
        if (c === NUS_TX) return this.dev.tx;
        if (c === NUS_RX) return this.dev.rx;
        throw Object.assign(new Error("no such characteristic"), { name: "NotFoundError" });
      },
    };
  }
}

class FakeDevice extends EventTarget {
  id = "dev-1";
  name = "PicoAPRS-1A2B";
  device = new MockDevice();
  notifySize = 20;
  connectGate: Promise<void> | undefined;
  gatt = new FakeServer(this);
  tx = new FakeTx(this);
  rx = new FakeRx(this);
  /** The device drops the link (out of range). */
  dropLink(): void {
    this.gatt.disconnect();
  }
}

function transportFor(dev: FakeDevice): WebBluetoothTransport {
  return new WebBluetoothTransport(dev as unknown as BluetoothDevice);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("requestTrackerDevice", () => {
  it("filters by the NUS service UUID only, not by name (§2)", async () => {
    const dev = new FakeDevice();
    const requestDevice = vi.fn(async () => dev as unknown as BluetoothDevice);
    const bt: BluetoothLike = { requestDevice };
    await requestTrackerDevice(bt);
    expect(requestDevice).toHaveBeenCalledWith({ filters: [{ services: [NUS_SERVICE] }] });
  });
});

describe("WebBluetoothTransport", () => {
  it("connects, starts notifications and only then resolves", async () => {
    const dev = new FakeDevice();
    const pairing = deferred();
    dev.tx.gate = pairing.promise; // the passkey dialog is open
    const t = transportFor(dev);
    let done = false;
    const p = t.connect().then(() => (done = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false);
    pairing.resolve();
    await p;
    expect(dev.tx.notifying).toBe(true);
    expect(t.deviceId).toBe("dev-1");
    expect(t.name).toBe("PicoAPRS-1A2B");
  });

  it("disconnect() during pairing makes connect() reject instead of hanging", async () => {
    const dev = new FakeDevice();
    dev.tx.gate = new Promise(() => undefined); // the user never answers
    const t = transportFor(dev);
    const p = t.connect();
    await new Promise((r) => setTimeout(r, 0));
    await t.disconnect();
    await expect(p).rejects.toThrow(/aborted/);
    expect(dev.gatt.connected).toBe(false);
  });

  it("a link that drops while connecting makes connect() reject", async () => {
    const dev = new FakeDevice();
    const pairing = deferred();
    dev.tx.gate = pairing.promise;
    const t = transportFor(dev);
    const p = t.connect();
    await new Promise((r) => setTimeout(r, 0));
    dev.dropLink();
    await expect(p).rejects.toThrow(/link lost/);
  });

  it("delivers copies of notifications (the buffer may be reused)", async () => {
    const dev = new FakeDevice();
    const t = transportFor(dev);
    const got: Uint8Array[] = [];
    t.onData((c) => got.push(c));
    await t.connect();
    dev.tx.notify(enc.encode("abcdefghij"), 4);
    expect(got.map((c) => new TextDecoder().decode(c))).toEqual(["abcd", "efgh", "ij"]);
  });

  it("reports a dropped link as 'link lost' and its own close as 'closed by the app'", async () => {
    const dev = new FakeDevice();
    const t = transportFor(dev);
    const reasons: (string | undefined)[] = [];
    t.onDisconnect((r) => reasons.push(r));
    await t.connect();
    dev.dropLink();
    await expect(t.write(new Uint8Array([1]))).rejects.toThrow(/not connected/);
    await t.connect();
    await t.disconnect();
    expect(reasons).toEqual(["link lost", "closed by the app"]);
  });

  it("does not report a disconnect when it was never connected", async () => {
    const dev = new FakeDevice();
    const t = transportFor(dev);
    const cb = vi.fn();
    t.onDisconnect(cb);
    await t.disconnect();
    expect(cb).not.toHaveBeenCalled();
  });

  it("rejects writes over 20 bytes (§5.2), before connecting, and on GATT errors", async () => {
    const dev = new FakeDevice();
    const t = transportFor(dev);
    await expect(t.write(new Uint8Array(3))).rejects.toThrow(/not connected/);
    await t.connect();
    await expect(t.write(new Uint8Array(21))).rejects.toThrow(/exceeds 20/);
    dev.rx.failNext = "NetworkError";
    await expect(t.write(new Uint8Array(3))).rejects.toThrow(/write failed \(NetworkError\)/);
  });

  it("a write that completes after the link dropped still rejects", async () => {
    const dev = new FakeDevice();
    const t = transportFor(dev);
    await t.connect();
    const p = t.write(new Uint8Array([0x7b]));
    dev.dropLink();
    await expect(p).rejects.toThrow(/disconnected/);
  });
});

describe("DeviceClient over Web Bluetooth (fake GATT + MockDevice)", () => {
  it("runs the §6.2 flow, writes at most 20 bytes, one at a time", async () => {
    const dev = new FakeDevice();
    const t = transportFor(dev);
    const client = new DeviceClient(t);
    await client.start();
    expect(client.state).toBe("ready");
    expect(client.hello?.proto).toBe(1);
    expect(Object.keys(client.settings).length).toBeGreaterThan(5);
    expect(Math.max(...dev.rx.writes)).toBeLessThanOrEqual(20);
    expect(dev.rx.maxInFlight).toBe(1);
    await client.stop();
  });

  it("decodes a UTF-8 character split across notifications", async () => {
    const dev = new FakeDevice();
    dev.notifySize = 7; // splits "あ" (3 bytes) at some point
    const client = new DeviceClient(transportFor(dev));
    await client.start();
    const got: string[] = [];
    client.on("rx", (m) => got.push(m.tnc2));
    const line = JSON.stringify({ t: "rx", tnc2: "Q1AAA>APRS:>あいう", src: "Q1AAA" }) + "\n";
    for (let shift = 0; shift < 7; shift++) {
      dev.tx.notify(enc.encode(line), 7 - (shift % 3));
    }
    expect(got.every((g) => g === "Q1AAA>APRS:>あいう")).toBe(true);
    expect(got.length).toBe(7);
    await client.stop();
  });

  it("can start again on the same transport after the link dropped (reconnect, §10)", async () => {
    const dev = new FakeDevice();
    const client = new DeviceClient(transportFor(dev));
    await client.start();
    dev.dropLink();
    expect(client.state).toBe("disconnected");
    await client.start();
    expect(client.state).toBe("ready");
    await client.stop();
  });
});
