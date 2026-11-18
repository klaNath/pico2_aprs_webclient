import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/store/state.ts";
import { MockDevice } from "../src/transport/mock/mockDevice.ts";
import { MockTransport } from "../src/transport/mock/mockTransport.ts";
import type { MockTransportOptions } from "../src/transport/mock/mockTransport.ts";

// App is plain state: it never touches the DOM, so these run in node.

let transports: MockTransport[];
let devices: MockDevice[];
let app: App;

function makeApp(): App {
  transports = [];
  devices = [];
  return new App({
    createMockTransport: (o: MockTransportOptions) => {
      const device = devices.shift() ?? new MockDevice();
      const t = new MockTransport({ ...o, autoRx: false, device });
      transports.push(t);
      return t;
    },
  });
}

async function run<T>(p: Promise<T>, ms = 2000): Promise<T> {
  await vi.advanceTimersByTimeAsync(ms);
  return p;
}

async function connect(a: App = app): Promise<MockTransport> {
  await run(a.connectMock());
  return transports[transports.length - 1]!;
}

function rx(t: MockTransport, tnc2: string, extra: Record<string, unknown> = {}): void {
  const src = tnc2.split(">")[0];
  t.sendRaw(JSON.stringify({ t: "rx", tnc2, src, ...extra }));
}

const POSITION = "Q1AAA>APRS:!3540.12N/13945.67E>Hello";
const POSITION_LL = { lat: 35 + 40.12 / 60, lon: 139 + 45.67 / 60 };
const MICE = 'Q1MIC>SU4PX0,WIDE1-1:`CIXl <0x1C>[/"4!}Pico2 APRS';
const OBJECT = "Q1OBJ>APRS:;OBJNAME  *111111z3500.00N/13500.00E>obj";
const THIRD = "Q1GATE>APRS:}Q1INNER>APRS,TCPIP,Q1GATE*:!3500.00N/13500.00E>Hi";
const STATUS_GRID = "Q1STAT>APRS:>IO91SX/G Hi";

beforeEach(() => {
  vi.useFakeTimers();
  app = makeApp();
});
afterEach(async () => {
  await app.disconnect();
  vi.useRealTimers();
});

describe("App runs without a DOM", () => {
  it("has no document here, and works", async () => {
    expect(typeof document).toBe("undefined");
    await connect();
    expect(app.state).toBe("ready");
  });
});

describe("A: a station's position is the sender's, not an object's or a locator's", () => {
  it("takes the position of a position report and of Mic-E", async () => {
    const t = await connect();
    rx(t, POSITION, { kind: "position", lat: 1, lon: 2 });
    expect(app.stations.get("Q1AAA")).toMatchObject(POSITION_LL);
    rx(t, MICE, { kind: "mice" });
    const m = app.stations.get("Q1MIC")!;
    expect(m.lat).toBeCloseTo(35 + 40.8 / 60, 6);
    expect(m.lon).toBeCloseTo(139 + 45.6 / 60, 6);
  });

  it("does not give an object's position to the station that sent it", async () => {
    const t = await connect();
    rx(t, OBJECT, { kind: "object", lat: 35, lon: 135 });
    const row = app.stations.get("Q1OBJ")!;
    expect(row.count).toBe(1);
    expect(row.lat).toBeUndefined();
    expect(row.lon).toBeUndefined();
  });

  it("does not use the device's lat/lon for an object or item, even if the packet cannot be read", async () => {
    const t = await connect();
    rx(t, "Q1OBJ>APRS:;broken", { kind: "object", lat: 35, lon: 135 });
    rx(t, "Q1ITM>APRS:)broken", { kind: "item", lat: 35, lon: 135 });
    expect(app.stations.get("Q1OBJ")!.lat).toBeUndefined();
    expect(app.stations.get("Q1ITM")!.lat).toBeUndefined();
  });

  it("does not give a third-party packet's inner position to the gateway", async () => {
    const t = await connect();
    rx(t, THIRD, { kind: "other" });
    expect(app.stations.get("Q1GATE")!.lat).toBeUndefined();
  });

  it("does not use the centre of a status locator", async () => {
    const t = await connect();
    rx(t, STATUS_GRID, { kind: "status" });
    const row = app.stations.get("Q1STAT")!;
    expect(row.count).toBe(1);
    expect(row.lat).toBeUndefined();
  });

  it("leaves a station without position without one", async () => {
    const t = await connect();
    rx(t, "Q1MSG>APRS::Q1AAA    :hello{1}", { kind: "message" });
    expect(app.stations.get("Q1MSG")).toMatchObject({ count: 1 });
    expect(app.stations.get("Q1MSG")!.lat).toBeUndefined();
  });

  it("keeps a known position when a packet of another kind arrives", async () => {
    const t = await connect();
    rx(t, POSITION, { kind: "position" });
    for (const [tnc2, extra] of [
      [OBJECT.replace("Q1OBJ", "Q1AAA"), { kind: "object", lat: 35, lon: 135 }],
      [THIRD.replace("Q1GATE", "Q1AAA"), { kind: "other" }],
      [STATUS_GRID.replace("Q1STAT", "Q1AAA"), { kind: "status" }],
    ] as const) {
      rx(t, tnc2, extra);
    }
    const row = app.stations.get("Q1AAA")!;
    expect(row.count).toBe(4);
    expect(row).toMatchObject(POSITION_LL);
  });

  it("uses the device's lat/lon when the app cannot parse a position/mice packet", async () => {
    const t = await connect();
    rx(t, "Q1ODD>APRS:\u0001garbage", { kind: "position", lat: 10, lon: 20 });
    expect(app.stations.get("Q1ODD")).toMatchObject({ lat: 10, lon: 20 });
  });

  it("does not take the symbol of an object either", async () => {
    const t = await connect();
    rx(t, POSITION, { kind: "position", sym: "/>" });
    rx(t, OBJECT.replace("Q1OBJ", "Q1AAA"), { kind: "object", sym: "/-" });
    expect(app.stations.get("Q1AAA")!.sym).toBe("/>");
  });
});

describe("B: connecting is serialized", () => {
  const live = (): MockTransport[] => transports.filter((t) => t.isConnected);

  it("two calls without await leave one live transport", async () => {
    await run(Promise.all([app.connectMock(), app.connectMock()]));
    expect(transports).toHaveLength(2);
    expect(live()).toEqual([transports[1]]);
    expect(app.state).toBe("ready");
    expect(app.notice).toBeUndefined();
  });

  it("three calls in a row leave one live transport, the last one", async () => {
    await run(Promise.all([app.connectMock(), app.connectMock(), app.connectMock()]), 5000);
    expect(live()).toEqual([transports[transports.length - 1]]);
    expect(app.state).toBe("ready");
  });

  it("a second call while the first is still connecting replaces it", async () => {
    const first = app.connectMock();
    await vi.advanceTimersByTimeAsync(100);
    expect(app.state).toBe("connecting");
    const second = app.connectMock();
    await vi.advanceTimersByTimeAsync(3000);
    await Promise.all([first, second]);
    expect(live()).toEqual([transports[transports.length - 1]]);
    expect(app.state).toBe("ready");
    expect(app.notice).toBeUndefined();
    expect(app.disconnectKind).toBeUndefined();
  });

  it("a connect while connected replaces the link, and the old client is quiet", async () => {
    await connect();
    const oldClient = app.client;
    await connect();
    expect(app.client).not.toBe(oldClient);
    expect(live()).toEqual([transports[1]]);
    expect(app.state).toBe("ready");
    expect(app.disconnectKind).toBeUndefined();
  });

  it("disconnect() cancels a queued attempt", async () => {
    const first = app.connectMock();
    const second = app.connectMock();
    const d = app.disconnect();
    await vi.advanceTimersByTimeAsync(3000);
    await Promise.all([first, second, d]);
    expect(live()).toEqual([]);
    expect(app.state).toBe("disconnected");
    expect(app.notice).toBeUndefined();
  });
});

describe("C: the feed outlives the link", () => {
  it("keeps feed, stations and client when the link drops, and says it was the link", async () => {
    const t = await connect();
    rx(t, POSITION, { kind: "position" });
    expect(app.feed).toHaveLength(1);
    const client = app.client;
    t.simulateDisconnect();
    expect(app.state).toBe("disconnected");
    expect(app.disconnectKind).toBe("link");
    expect(app.feed).toHaveLength(1);
    expect(app.stations.has("Q1AAA")).toBe(true);
    expect(app.client).toBe(client);
    expect(app.client!.schema.length).toBeGreaterThan(0);
    expect(app.statusStale).toBe(true);
  });

  it("says it was the user when the user disconnects, and keeps the feed", async () => {
    const t = await connect();
    rx(t, POSITION, { kind: "position" });
    await app.disconnect();
    expect(app.state).toBe("disconnected");
    expect(app.disconnectKind).toBe("user");
    expect(app.feed).toHaveLength(1);
  });

  it("keeps the feed when it connects to the same device again", async () => {
    const t = await connect();
    rx(t, POSITION, { kind: "position" });
    const seq = app.feed[0]!.seq;
    t.simulateDisconnect();
    await connect();
    expect(app.disconnectKind).toBeUndefined();
    expect(app.feed.map((f) => f.seq)).toContain(seq);
    expect(app.stations.has("Q1AAA")).toBe(true);
  });

  it("clears the feed and stations when it is another device", async () => {
    const t = await connect();
    rx(t, POSITION, { kind: "position" });
    const other = new MockDevice();
    other.helloName = "other_unit";
    devices.push(other);
    await connect();
    expect(app.feed).toHaveLength(0);
    expect(app.stations.has("Q1AAA")).toBe(false);
    expect(app.stations.has("Q1AAA-9")).toBe(true); // from the new device's own list
    expect(t.isConnected).toBe(false);
  });

  it("treats Demo and a real device as different devices", async () => {
    const t = await connect();
    rx(t, POSITION, { kind: "position" });
    const real = new MockTransport({ autoRx: false });
    await run(app.connectWith(real, false));
    expect(app.mock).toBe(false);
    expect(app.feed).toHaveLength(0);
    expect(app.state).toBe("ready");
  });

  it("uses the transport's deviceId to tell two real devices apart", async () => {
    const a = Object.assign(new MockTransport({ autoRx: false }), { deviceId: "id-a" });
    await run(app.connectWith(a, false));
    rx(a, POSITION, { kind: "position" });
    const same = Object.assign(new MockTransport({ autoRx: false }), { deviceId: "id-a" });
    await run(app.connectWith(same, false));
    expect(app.feed).toHaveLength(1);
    const b = Object.assign(new MockTransport({ autoRx: false }), { deviceId: "id-b" });
    await run(app.connectWith(b, false));
    expect(app.feed).toHaveLength(0);
  });

  it("clearFeed empties the feed", async () => {
    const t = await connect();
    rx(t, POSITION, { kind: "position" });
    app.clearFeed();
    expect(app.feed).toHaveLength(0);
  });

  it("the same client can start() again after the link dropped (the place for auto-reconnect)", async () => {
    const t = await connect();
    rx(t, POSITION, { kind: "position" });
    const client = app.client!;
    t.simulateDisconnect();
    expect(app.disconnectKind).toBe("link");
    const p = client.start();
    await run(p, 2000);
    expect(app.client).toBe(client);
    expect(app.state).toBe("ready");
    expect(app.disconnectKind).toBeUndefined();
    expect(app.status).toBeDefined();
    expect(app.feed).toHaveLength(1); // same hello: nothing cleared
    rx(t, POSITION, { kind: "position" }); // the events are still wired
    expect(app.feed).toHaveLength(2);
  });
});

describe("M5: cancelling is not an error", () => {
  it("disconnect() while connecting leaves no notice", async () => {
    const p = app.connectMock();
    await vi.advanceTimersByTimeAsync(100);
    expect(app.state).toBe("connecting");
    await app.disconnect();
    await run(p, 1000);
    expect(app.state).toBe("disconnected");
    expect(app.notice).toBeUndefined();
    expect(app.disconnectKind).toBe("user");
  });
});

describe("M6: device errors do not become the notice", () => {
  it("collects them in recentErrors (at most 20) and lastDeviceError", async () => {
    const t = await connect();
    expect(app.lastDeviceError).toBeUndefined();
    for (let i = 0; i < 25; i++) {
      t.sendRaw(JSON.stringify({ t: "err", code: "busy", msg: `n${i}` }));
      vi.advanceTimersByTime(10);
    }
    expect(app.notice).toBeUndefined();
    expect(app.recentErrors).toHaveLength(20);
    expect(app.recentErrors[19]!.text).toContain("n24");
    expect(app.recentErrors[0]!.text).toContain("n5");
    expect(app.lastDeviceError).toBe(app.recentErrors[19]);
    expect(typeof app.lastDeviceError!.at).toBe("number");
  });

  it("does not hide the reason for a later disconnect, and clears the notice", async () => {
    const t = await connect();
    t.sendRaw(JSON.stringify({ t: "err", code: "io" }));
    t.simulateDisconnect("link lost");
    expect(app.notice).toBeUndefined();
    expect(app.disconnectKind).toBe("link");
    expect(app.client!.lastDisconnectReason).toBe("link lost");
  });

  it("clears an old notice when a new connection starts", async () => {
    await app.connectBluetooth();
    expect(app.notice).toBeTruthy();
    const p = app.connectMock();
    await vi.advanceTimersByTimeAsync(0);
    expect(app.notice).toBeUndefined();
    await run(p);
  });
});

describe("M7: the notice is a sentence for people", () => {
  it("leaves it empty for proto_mismatch (the state says it)", async () => {
    const d = new MockDevice();
    d.protoOverride = 99;
    devices.push(d);
    await connect();
    expect(app.state).toBe("proto_mismatch");
    expect(app.notice).toBeUndefined();
  });

  it("explains a timeout without the internal code", async () => {
    devices.length = 0;
    const p = app.connectMock();
    transports[0]!.writeDelayMs = 0;
    // The device never authenticates: hello is never answered.
    (transports[0] as unknown as { opts: { authDelayMs: number } }).opts.authDelayMs = 10 ** 9;
    await run(p, 40_000);
    expect(app.state).toBe("error");
    expect(app.notice).toMatch(/did not respond/i);
    expect(app.notice).not.toMatch(/timeout|_|\(|:/);
  });

  it("explains a refused connection", async () => {
    const bad = new MockTransport({ autoRx: false });
    vi.spyOn(bad, "connect").mockRejectedValue(
      new Error("User cancelled the requestDevice() chooser."),
    );
    await run(app.connectWith(bad, false));
    expect(app.notice).toBe("User cancelled the requestDevice() chooser.");
    expect(app.state).toBe("error");
  });
});

describe("stale status", () => {
  it("is stale once the clock has passed, even if no timer ran", async () => {
    await connect();
    expect(app.statusStale).toBe(false);
    vi.setSystemTime(Date.now() + 20_000); // the timers did not run (a sleeping tab)
    expect(app.statusStale).toBe(true);
  });
});

describe("M13: logLimit applies at once", () => {
  it("trims the feed when the limit is lowered, also while disconnected", async () => {
    const t = await connect();
    for (let i = 0; i < 80; i++) rx(t, POSITION, { kind: "position" });
    expect(app.feed).toHaveLength(80);
    t.simulateDisconnect();
    const changed = vi.fn();
    app.onChange(changed);
    app.prefs.set("logLimit", 50);
    expect(app.feed).toHaveLength(50);
    expect(app.feed[49]!.seq).toBe(80);
    expect(changed).toHaveBeenCalled();
  });
});
