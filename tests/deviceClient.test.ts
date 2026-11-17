import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeviceClient, DeviceError } from "../src/client/deviceClient.ts";
import type { DeviceClientOptions } from "../src/client/deviceClient.ts";
import { MockTransport } from "../src/transport/mock/mockTransport.ts";
import type { MockTransportOptions } from "../src/transport/mock/mockTransport.ts";
import type { ErrMsg, ParseError, RxMsg, StatusMsg } from "../src/protocol/types.ts";

type Obj = Record<string, unknown>;

let transport: MockTransport;
let client: DeviceClient;
let lines: Obj[]; // request lines that reached the device

function setup(t: MockTransportOptions = {}, c: DeviceClientOptions = {}): void {
  transport = new MockTransport({ autoRx: false, ...t });
  client = new DeviceClient(transport, c);
  lines = [];
  const orig = transport.device.handleLine.bind(transport.device);
  vi.spyOn(transport.device, "handleLine").mockImplementation((line: string) => {
    try {
      lines.push(JSON.parse(line) as Obj);
    } catch {
      lines.push({ unparsable: line });
    }
    return orig(line);
  });
}

async function ready(): Promise<void> {
  await client.start();
}

beforeEach(() => {
  vi.useFakeTimers();
  setup();
});
afterEach(async () => {
  await client.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("connection flow (§6.2)", () => {
  it("runs hello -> status -> schema -> get -> stations and becomes ready", async () => {
    const states: string[] = [];
    client.on("state", (s) => states.push(s));
    await ready();
    expect(states).toEqual(["connecting", "handshaking", "ready"]);
    expect(lines.map((l) => l.op)).toEqual([
      "hello",
      "status",
      "settings.schema",
      "settings.get",
      "stations.list",
    ]);
    expect(client.hello).toMatchObject({ proto: 1, mode: "tnc" });
    expect(client.schema.length).toBeGreaterThan(5);
    expect(client.settings).toHaveProperty("callsign", "Q1TEST");
    expect(client.stations.map((s) => s.src)).toEqual(["Q1AAA-9", "Q1BBB", "Q1TEST-7"]);
  });

  it("numbers requests 1, 2, 3, ... and matches each response to its request", async () => {
    await ready();
    expect(lines.map((l) => l.id)).toEqual([1, 2, 3, 4, 5]);
    const st = await client.getStatus();
    expect(lines.at(-1)).toMatchObject({ op: "status", id: 6 });
    expect(st.t).toBe("status");
  });

  it("works with very small writes and notifications (lines split everywhere)", async () => {
    setup({ notifySize: 3 }, { maxWriteBytes: 3 });
    await ready();
    expect(client.state).toBe("ready");
    expect(lines.every((l) => !("unparsable" in l))).toBe(true);
    expect(client.stations).toHaveLength(3);
  });

  it("has the status right after connecting (event + explicit request), then every 5 seconds", async () => {
    const statuses: StatusMsg[] = [];
    client.on("status", (s) => statuses.push(s));
    await ready();
    expect(statuses).toHaveLength(2); // the on-connect event, and the answer to our status request
    expect(client.lastStatus).toBe(statuses[1]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(statuses).toHaveLength(3);
    expect(client.lastStatus).toBe(statuses[2]);
  });

  it("still has the state if the on-connect status event was missed (§6.2)", async () => {
    setup({ authDelayMs: 0 });
    // Drop every notification that is sent before the client asks for anything.
    const orig = transport.onData.bind(transport);
    let first = true;
    transport.onData = (cb) =>
      orig((chunk) => {
        if (first) {
          if (chunk.includes(0x0a)) first = false;
          return; // the first status line is lost
        }
        cb(chunk);
      });
    const c = new DeviceClient(transport);
    await c.start();
    expect(c.lastStatus).toMatchObject({ t: "status", call: "Q1TEST-7" });
    await c.stop();
  });
});

describe("hello resend (commands before authentication are dropped, §4)", () => {
  it("resends hello every 3 s until the device is authenticated", async () => {
    setup({ authDelayMs: 4000 });
    const p = client.start();
    await vi.advanceTimersByTimeAsync(6000);
    await p;
    expect(client.state).toBe("ready");
    expect(transport.droppedBeforeAuth).toBe(2); // sent at 0 s and 3 s, accepted at 6 s
    expect(lines[0]).toMatchObject({ op: "hello", id: 1 }); // every resend keeps the same id
  });

  it("gives up after helloAttempts", async () => {
    setup({ authDelayMs: 1_000_000 });
    const p = client.start();
    const assertion = expect(p).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(transport.droppedBeforeAuth).toBe(5);
    expect(client.state).toBe("error");
  });

  it("can be started again after a failure", async () => {
    setup({ authDelayMs: 1_000_000 });
    const p = client.start();
    const assertion = expect(p).rejects.toBeInstanceOf(DeviceError);
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    setup(); // a fresh device that answers at once
    await ready();
    expect(client.state).toBe("ready");
  });
});

describe("proto check", () => {
  it("stops and reports proto_mismatch without sending anything else", async () => {
    transport.device.protoOverride = 2;
    await expect(client.start()).rejects.toMatchObject({ code: "proto_mismatch" });
    expect(client.state).toBe("proto_mismatch");
    expect(lines.map((l) => l.op)).toEqual(["hello"]);
  });
});

describe("busy", () => {
  beforeEach(ready);

  it("resends the request in flight once, after a short wait", async () => {
    lines.length = 0;
    transport.busyOnNextLine = true;
    const p = client.getStatus();
    await vi.advanceTimersByTimeAsync(499);
    expect(lines).toHaveLength(0); // the first line was dropped as busy
    await vi.advanceTimersByTimeAsync(1);
    expect((await p).t).toBe("status");
    expect(lines).toHaveLength(1);
  });

  it("fails with busy if the retry is busy too", async () => {
    transport.busyOnNextLine = true;
    const p = client.getStatus();
    const assertion = expect(p).rejects.toMatchObject({ code: "busy" });
    await vi.advanceTimersByTimeAsync(0);
    transport.busyOnNextLine = true;
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
    // the client keeps working afterwards
    expect((await client.getStatus()).t).toBe("status");
  });
});

describe("timeouts and disconnects", () => {
  beforeEach(ready);

  it("times out a request that gets no response", async () => {
    vi.mocked(transport.device.handleLine).mockReturnValue([]);
    const p = client.getStatus();
    const assertion = expect(p).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });

  it("fails the pending and queued requests on disconnect, then can restart", async () => {
    vi.mocked(transport.device.handleLine).mockReturnValue([]);
    const first = expect(client.getStatus()).rejects.toMatchObject({ code: "disconnected" });
    const second = expect(client.getSettings()).rejects.toMatchObject({ code: "disconnected" });
    await vi.advanceTimersByTimeAsync(0);
    transport.simulateDisconnect();
    await first;
    await second;
    expect(client.state).toBe("disconnected");
    await expect(client.getStatus()).rejects.toMatchObject({ code: "not_connected" });

    vi.mocked(transport.device.handleLine).mockRestore();
    await client.start();
    expect(client.state).toBe("ready");
  });
});

describe("settings", () => {
  beforeEach(ready);

  it("sends only the items that differ, in one settings.set", async () => {
    lines.length = 0;
    const r = await client.setSettings({ ssid: 7, comment: "Hello", tx_enabled: false });
    expect(lines).toEqual([
      { op: "settings.set", id: expect.any(Number), values: { comment: "Hello" } },
    ]);
    expect(r.changed).toEqual(["comment"]);
    expect(client.settings.comment).toBe("Hello");
  });

  it("sends nothing when nothing differs", async () => {
    lines.length = 0;
    const r = await client.setSettings({ ssid: 7 });
    expect(lines).toHaveLength(0);
    expect(r.changed).toEqual([]);
  });

  it("emits settings events", async () => {
    const seen: string[][] = [];
    client.on("settings", (m) => seen.push(m.changed ?? []));
    await client.setSettings({ comment: "A" });
    await client.resetSettings();
    expect(seen).toEqual([["comment"], ["comment"]]);
  });

  it("rejects invalid with the key, and nothing changes (all or nothing)", async () => {
    const before = { ...client.settings };
    const err = await client.setSettings({ comment: "Changed", ssid: 99 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceError);
    expect(err).toMatchObject({ code: "invalid", key: "ssid", msg: "integer 0-15" });
    expect(client.settings).toEqual(before);
    expect(transport.device.settings.comment).toBe(before.comment);
  });

  it("reports io errors", async () => {
    transport.device.failNextSave = true;
    await expect(client.setSettings({ comment: "x" })).rejects.toMatchObject({ code: "io" });
    expect(transport.device.settings.comment).not.toBe("x");
  });

  it("reports unknown_op", async () => {
    const send = (client as unknown as { request(r: Obj): Promise<unknown> }).request.bind(client);
    await expect(send({ op: "bogus" })).rejects.toMatchObject({ code: "unknown_op", msg: "bogus" });
  });

  it("resets to the device defaults", async () => {
    await client.setSettings({ comment: "A" });
    const r = await client.resetSettings();
    expect(r.changed).toEqual(["comment"]);
    expect(client.settings.comment).toBe("Pico2 APRS");
  });
});

describe("serialized writes", () => {
  it("never mixes the chunks of concurrent requests", async () => {
    setup({ notifySize: 5 }, { maxWriteBytes: 4 });
    await ready();
    lines.length = 0;
    const [st, se, sl] = await Promise.all([
      client.getStatus(),
      client.setSettings({ comment: "concurrent" }),
      client.listStations(),
    ]);
    expect(st.t).toBe("status");
    expect(se.changed).toEqual(["comment"]);
    expect(sl).toHaveLength(3);
    expect(lines.map((l) => l.op)).toEqual(["status", "settings.set", "stations.list"]);
    expect(lines.every((l) => !("unparsable" in l))).toBe(true);
  });
});

describe("events and odd input", () => {
  beforeEach(ready);

  it("emits rx events", async () => {
    const got: RxMsg[] = [];
    client.on("rx", (m) => got.push(m));
    transport.emitRx();
    expect(got).toHaveLength(1);
    expect(got[0]!.tnc2).toMatch(/^Q1/);
  });

  it("emits lineError for unreadable lines and ignores unknown kinds of message", async () => {
    const bad: ParseError[] = [];
    client.on("lineError", (e) => bad.push(e));
    transport.sendRaw("this is not json");
    transport.sendRaw('{"t":"from_the_future","x":1}');
    expect(bad).toHaveLength(1);
    expect(client.state).toBe("ready");
    expect((await client.getStatus()).t).toBe("status");
  });

  it("emits deviceError for errors without a matching request", async () => {
    const errs: ErrMsg[] = [];
    client.on("deviceError", (e) => errs.push(e));
    transport.sendRaw('{"t":"err","code":"bad_json"}');
    transport.sendRaw('{"t":"err","id":999,"code":"internal","msg":"x"}');
    expect(errs.map((e) => e.code)).toEqual(["bad_json", "internal"]);
  });

  it("ignores a late duplicate reply (same id as an earlier request)", async () => {
    transport.sendRaw('{"t":"hello","id":1,"proto":1}');
    const st = await client.getStatus();
    expect(st.t).toBe("status");
  });
});
