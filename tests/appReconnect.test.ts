import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  App,
  RECONNECT_MAX_ATTEMPTS,
  reconnectDelayMs,
  type AppOptions,
} from "../src/store/state.ts";
import { MockDevice } from "../src/transport/mock/mockDevice.ts";
import { MockTransport } from "../src/transport/mock/mockTransport.ts";
import type { BluetoothLike } from "../src/transport/webBluetooth.ts";

// Automatic reconnect and the Bluetooth chooser, in node (App never touches the DOM).

let transports: MockTransport[];

function makeApp(extra: AppOptions = {}): App {
  transports = [];
  return new App({
    bluetooth: null,
    createMockTransport: (o) => {
      const t = new MockTransport({ ...o, autoRx: false, device: new MockDevice() });
      transports.push(t);
      return t;
    },
    ...extra,
  });
}

async function connected(app: App): Promise<MockTransport> {
  const p = app.connectMock();
  await vi.advanceTimersByTimeAsync(2000);
  await p;
  expect(app.state).toBe("ready");
  return transports[transports.length - 1]!;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("reconnectDelayMs", () => {
  it("doubles from 1 s and stays at 30 s", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 50].map(reconnectDelayMs)).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000,
    ]);
    expect(reconnectDelayMs(0)).toBe(1000);
    expect(reconnectDelayMs(NaN)).toBe(1000);
  });
});

describe("automatic reconnect", () => {
  it("reconnects after a dropped link, on the same client, keeping the feed", async () => {
    const app = makeApp();
    const t = await connected(app);
    const client = app.client;
    t.sendRaw(JSON.stringify({ t: "rx", tnc2: "Q1AAA>APRS:>hi", src: "Q1AAA" }));
    expect(app.feed.length).toBe(1);
    t.simulateDisconnect();
    expect(app.state).toBe("disconnected");
    expect(app.disconnectKind).toBe("link");
    expect(app.reconnect).toMatchObject({ attempt: 1 });
    await vi.advanceTimersByTimeAsync(1000 + 2000);
    expect(app.state).toBe("ready");
    expect(app.client).toBe(client);
    expect(app.reconnect).toBeUndefined();
    expect(app.feed.length).toBe(1);
    expect(transports.length).toBe(1);
  });

  it("backs off while the device cannot be reached, then gives up with a notice", async () => {
    const app = makeApp();
    const t = await connected(app);
    // The device is gone: every connect fails.
    vi.spyOn(t, "connect").mockRejectedValue(new Error("out of range"));
    t.simulateDisconnect();
    const attempts: number[] = [];
    for (let i = 1; i <= RECONNECT_MAX_ATTEMPTS; i++) {
      expect(app.reconnect?.attempt).toBe(i);
      attempts.push(i);
      await vi.advanceTimersByTimeAsync(reconnectDelayMs(i) + 10);
    }
    expect(app.reconnect).toBeUndefined();
    expect(app.notice).toMatch(/Could not reconnect/);
    expect(t.connect).toHaveBeenCalledTimes(RECONNECT_MAX_ATTEMPTS);
    expect(attempts.length).toBe(RECONNECT_MAX_ATTEMPTS);
  });

  it("does not reconnect after the user's disconnect", async () => {
    const app = makeApp();
    await connected(app);
    await app.disconnect();
    expect(app.disconnectKind).toBe("user");
    expect(app.reconnect).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(app.state).toBe("disconnected");
  });

  it("the user's disconnect cancels a pending reconnect", async () => {
    const app = makeApp();
    const t = await connected(app);
    const connect = vi.spyOn(t, "connect");
    t.simulateDisconnect();
    expect(app.reconnect).toBeDefined();
    await app.disconnect();
    expect(app.reconnect).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connect).not.toHaveBeenCalled();
    expect(app.state).toBe("disconnected");
  });

  it("a new connection (Demo or another device) cancels a pending reconnect", async () => {
    const app = makeApp();
    const t = await connected(app);
    const connect = vi.spyOn(t, "connect");
    t.simulateDisconnect();
    await connected(app);
    expect(app.reconnect).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connect).not.toHaveBeenCalled();
    expect(transports.length).toBe(2);
  });

  it("reconnectNow() tries at once", async () => {
    const app = makeApp();
    const t = await connected(app);
    t.simulateDisconnect();
    vi.spyOn(t, "connect");
    app.reconnectNow();
    expect(t.connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(app.state).toBe("ready");
  });

  it("stops on a protocol mismatch (trying again cannot help)", async () => {
    const app = makeApp();
    const t = await connected(app);
    t.device.protoOverride = 2;
    t.simulateDisconnect();
    await vi.advanceTimersByTimeAsync(1000 + 2000);
    expect(app.state).toBe("proto_mismatch");
    expect(app.reconnect).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(app.state).toBe("proto_mismatch");
  });
});

describe("connectBluetooth (the chooser)", () => {
  it("opens the chooser synchronously, inside the click (§10)", () => {
    const requestDevice = vi.fn(() => new Promise<BluetoothDevice>(() => undefined));
    const app = makeApp({ bluetooth: { requestDevice } });
    void app.connectBluetooth();
    expect(requestDevice).toHaveBeenCalledTimes(1); // before any await
  });

  it("a cancelled chooser is not an error", async () => {
    const err = Object.assign(new Error("User cancelled the requestDevice() chooser."), {
      name: "NotFoundError",
    });
    const app = makeApp({ bluetooth: { requestDevice: () => Promise.reject(err) } });
    await app.connectBluetooth();
    expect(app.notice).toBeUndefined();
    expect(app.client).toBeUndefined();
  });

  it("other chooser errors are explained", async () => {
    const err = Object.assign(new Error("blocked"), { name: "SecurityError" });
    const app = makeApp({ bluetooth: { requestDevice: () => Promise.reject(err) } });
    await app.connectBluetooth();
    expect(app.notice).toMatch(/not allowed/);
  });

  it("without Web Bluetooth it says so", async () => {
    const app = makeApp({ bluetooth: null });
    expect(app.hasBluetooth).toBe(false);
    await app.connectBluetooth();
    expect(app.notice).toMatch(/not available/);
  });

  it("lists devices allowed before (getDevices), empty where unsupported", async () => {
    const dev = { id: "d1", name: "PicoAPRS-2574" } as unknown as BluetoothDevice;
    const bt: BluetoothLike = {
      requestDevice: () => Promise.reject(new Error("unused")),
      getDevices: () => Promise.resolve([dev]),
    };
    const app = makeApp({ bluetooth: bt });
    await app.loadKnownDevices();
    expect(app.knownDevices.map((d) => [d.id, d.name])).toEqual([["d1", "PicoAPRS-2574"]]);
    const plain = makeApp({ bluetooth: { requestDevice: () => Promise.reject(new Error("x")) } });
    await plain.loadKnownDevices();
    expect(plain.knownDevices).toEqual([]);
  });
});
