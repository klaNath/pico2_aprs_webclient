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

  it("sends only the items that differ, in one settings.set (tx_enabled is always sent)", async () => {
    lines.length = 0;
    const r = await client.setSettings({ ssid: 7, comment: "Hello", tx_enabled: false });
    expect(lines).toEqual([
      {
        op: "settings.set",
        id: expect.any(Number),
        values: { comment: "Hello", tx_enabled: false },
      },
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
    await client.resetSettings({ confirmed: true });
    expect(seen).toEqual([["comment"], ["comment"]]);
  });

  it("rejects invalid values with the key before sending anything", async () => {
    lines.length = 0;
    const before = { ...client.settings };
    const err = await client.setSettings({ comment: "Changed", ssid: 99 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceError);
    expect(err).toMatchObject({ code: "invalid", key: "ssid", msg: "integer 0-15" });
    expect(lines).toHaveLength(0);
    expect(client.settings).toEqual(before);
  });

  it("is all or nothing on the device too (an invalid item that got past the client check)", async () => {
    const before = { ...client.settings };
    const send = (client as unknown as { request(r: Obj): Promise<unknown> }).request.bind(client);
    const err = await send({
      op: "settings.set",
      values: { comment: "Changed", ssid: 99 },
    }).catch((e: unknown) => e);
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
    const r = await client.resetSettings({ confirmed: true });
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
    // (setSettings waits its turn in the settings lock, so the order is not the call order.)
    expect(lines.map((l) => l.op).sort()).toEqual(["settings.set", "stations.list", "status"]);
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

// ---- review fixes ---------------------------------------------------------------------------

/** Wrap the (already recording) device: `fn` sees each request and the real replies, and returns what is sent. */
function intercept(fn: (req: Obj, out: string[]) => string[]): void {
  const spy = vi.mocked(transport.device.handleLine);
  const base = spy.getMockImplementation()!;
  spy.mockImplementation((line: string) => {
    const out = base(line);
    let req: Obj = {};
    try {
      req = JSON.parse(line) as Obj;
    } catch {
      /* leave empty */
    }
    return fn(req, out);
  });
}

/** Spy on every chunk the client writes. */
function recordWrites(): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  const orig = transport.write.bind(transport);
  vi.spyOn(transport, "write").mockImplementation((c: Uint8Array) => {
    chunks.push(c);
    return orig(c);
  });
  return chunks;
}

describe("H1: the cached settings and the connection state", () => {
  it("refuses with not_connected when not connected, even if nothing would differ", async () => {
    await expect(client.setSettings({ ssid: 7 })).rejects.toMatchObject({ code: "not_connected" });
    await expect(client.setSettings({})).rejects.toMatchObject({ code: "not_connected" });
    await expect(client.resetSettings({ confirmed: true })).rejects.toMatchObject({
      code: "not_connected",
    });
    await ready();
    transport.simulateDisconnect();
    await expect(client.setSettings({ ssid: 7 })).rejects.toMatchObject({ code: "not_connected" });
  });

  it("checks the connection before it looks at the values", async () => {
    await expect(client.setSettings({ ssid: 99 })).rejects.toMatchObject({ code: "not_connected" });
  });

  it("a lost settings.set reply does not make the next setSettings do nothing", async () => {
    await ready();
    // The device applies the change, but its reply never arrives.
    let dropSet = true;
    intercept((req, out) => (req.op === "settings.set" && dropSet ? [] : out));
    const p = client.setSettings({ tx_enabled: true }, { confirmed: ["tx_enable"] });
    const lost = expect(p).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(5000);
    await lost;
    expect(transport.device.settings.tx_enabled).toBe(true); // applied on the device

    // The client reads the settings again by itself, so it knows, and can switch TX off.
    await vi.advanceTimersByTimeAsync(0);
    expect(lines.at(-1)).toMatchObject({ op: "settings.get" });
    expect(client.settings.tx_enabled).toBe(true);
    expect(client.settingsKnown).toBe(true);
    dropSet = false;
    await client.setSettings({ tx_enabled: false });
    expect(transport.device.settings.tx_enabled).toBe(false);
  });

  it("reads the settings again before the next change if the refresh after a lost reply failed too", async () => {
    await ready();
    let dropSet = true;
    let dropGets = 1;
    intercept((req, out) => {
      if (req.op === "settings.set" && dropSet) return [];
      if (req.op === "settings.get" && dropGets-- > 0) return []; // the background refresh is lost
      return out;
    });
    const p = client.setSettings({ tx_enabled: true }, { confirmed: ["tx_enable"] });
    const lost = expect(p).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(5000);
    await lost;
    await vi.advanceTimersByTimeAsync(5000); // the refresh times out
    expect(client.settingsKnown).toBe(false);
    expect(transport.device.settings.tx_enabled).toBe(true); // while the cache still says false

    dropSet = false;
    lines.length = 0;
    await client.setSettings({ tx_enabled: false });
    expect(lines.map((l) => l.op)).toEqual(["settings.get", "settings.set"]);
    expect(transport.device.settings.tx_enabled).toBe(false);
  });

  it("always sends tx_enabled, even if the cache says it already has that value", async () => {
    await ready();
    expect(client.settings.tx_enabled).toBe(false);
    transport.device.settings.tx_enabled = true; // changed behind the client's back
    lines.length = 0;
    await client.setSettings({ tx_enabled: false });
    expect(lines).toEqual([
      { op: "settings.set", id: expect.any(Number), values: { tx_enabled: false } },
    ]);
    expect(transport.device.settings.tx_enabled).toBe(false);
  });

  it("a failed reset also puts the cache in doubt", async () => {
    await ready();
    intercept((req, out) => (req.op === "settings.reset" ? [] : out));
    const p = client.resetSettings({ confirmed: true });
    const lost = expect(p).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(5000);
    await lost;
    await vi.advanceTimersByTimeAsync(0);
    expect(lines.at(-1)).toMatchObject({ op: "settings.get" }); // read again
  });

  it("keeps the cache after errors that mean nothing was changed (io, invalid)", async () => {
    await ready();
    transport.device.failNextSave = true;
    await expect(client.setSettings({ comment: "x" })).rejects.toMatchObject({ code: "io" });
    expect(client.settingsKnown).toBe(true);
  });

  it("reads the settings again when status disagrees (tx_enabled)", async () => {
    await ready();
    transport.device.settings.tx_enabled = true;
    lines.length = 0;
    transport.sendRaw(JSON.stringify(transport.device.status()));
    await vi.advanceTimersByTimeAsync(0);
    expect(lines.map((l) => l.op)).toEqual(["settings.get"]);
    expect(client.settings.tx_enabled).toBe(true);
  });

  it("reads the settings again when status disagrees (call)", async () => {
    await ready();
    transport.device.settings.callsign = "Q1NEW";
    lines.length = 0;
    transport.sendRaw(JSON.stringify(transport.device.status()));
    await vi.advanceTimersByTimeAsync(0);
    expect(client.settings.callsign).toBe("Q1NEW");
  });

  it("does not read the settings when status agrees", async () => {
    await ready();
    lines.length = 0;
    transport.sendRaw(JSON.stringify(transport.device.status()));
    await vi.advanceTimersByTimeAsync(0);
    expect(lines).toHaveLength(0);
  });

  it("returns a copy, not the internal object", async () => {
    await ready();
    const r = await client.setSettings({ ssid: 7 });
    expect(r.changed).toEqual([]);
    (r.values.path as string[]).push("TAMPER");
    r.values.ssid = 99;
    expect(client.settings.ssid).toBe(7);
    expect(client.settings.path).toEqual(["WIDE1-1"]);
  });

  it("runs setSettings calls one after another, each against the result of the previous", async () => {
    await ready();
    lines.length = 0;
    await Promise.all([client.setSettings({ comment: "A" }), client.setSettings({ comment: "A" })]);
    expect(lines.filter((l) => l.op === "settings.set")).toHaveLength(1); // the second saw "A"
  });
});

describe("H3: validation and confirmation", () => {
  beforeEach(ready);

  const bad: [string, Record<string, unknown>][] = [
    ["NaN", { beacon_move_m: NaN }],
    ["Infinity", { beacon_move_m: Infinity }],
    ["mice_message 7", { mice_message: 7 }],
    ["lowercase callsign", { callsign: "q1test" }],
    ["callsign with spaces", { callsign: " Q1TEST " }],
    ["string ssid", { ssid: "7" }],
    ["string tx_enabled", { tx_enabled: "true" }],
    ["unknown key", { nope: 1 }],
  ];
  for (const [name, values] of bad) {
    it(`rejects ${name} without sending anything`, async () => {
      lines.length = 0;
      await expect(
        client.setSettings(values, { confirmed: ["callsign", "tx_enable"] }),
      ).rejects.toMatchObject({
        code: "invalid",
        key: Object.keys(values)[0],
      });
      expect(lines).toHaveLength(0);
    });
  }

  it("ignores undefined values", async () => {
    lines.length = 0;
    const r = await client.setSettings({ tx_enabled: undefined, comment: undefined });
    expect(lines).toHaveLength(0);
    expect(r.changed).toEqual([]);
    await client.setSettings({ tx_enabled: undefined, comment: "A" });
    expect(lines.at(-1)).toMatchObject({ values: { comment: "A" } });
  });

  it("sends the normalized value (path in upper case)", async () => {
    await client.setSettings({ path: ["wide2-2"] });
    expect(lines.at(-1)).toMatchObject({ values: { path: ["WIDE2-2"] } });
    // and compares in normalized form: the same path again is no change
    lines.length = 0;
    await client.setSettings({ path: ["wide2-2"] });
    expect(lines).toHaveLength(0);
  });

  it("refuses tx_enabled: true without confirmation, and sends nothing", async () => {
    lines.length = 0;
    await expect(client.setSettings({ tx_enabled: true })).rejects.toMatchObject({
      code: "confirmation_required",
      key: "tx_enabled",
    });
    expect(lines).toHaveLength(0);
    expect(transport.device.settings.tx_enabled).toBe(false);
  });

  it("refuses a callsign change or null without confirmation", async () => {
    await expect(client.setSettings({ callsign: "Q1NEW" })).rejects.toMatchObject({
      code: "confirmation_required",
      key: "callsign",
    });
    await expect(client.setSettings({ callsign: null })).rejects.toMatchObject({
      code: "confirmation_required",
    });
    expect(transport.device.settings.callsign).toBe("Q1TEST");
  });

  it("needs each confirmation that applies, not just any", async () => {
    await expect(
      client.setSettings({ callsign: "Q1NEW", tx_enabled: true }, { confirmed: ["tx_enable"] }),
    ).rejects.toMatchObject({ code: "confirmation_required", key: "callsign" });
    expect(transport.device.settings.callsign).toBe("Q1TEST");
    await client.setSettings(
      { callsign: "Q1NEW", tx_enabled: true },
      { confirmed: ["callsign", "tx_enable"] },
    );
    expect(transport.device.settings).toMatchObject({ callsign: "Q1NEW", tx_enabled: true });
  });

  it("needs no confirmation for tx_enabled: false, for the same callsign, or for other items", async () => {
    await client.setSettings({ tx_enabled: false, callsign: "Q1TEST", comment: "ok" });
    expect(transport.device.settings.comment).toBe("ok");
  });

  it("tells the UI what to confirm", async () => {
    expect(client.requiredConfirmations({ tx_enabled: true })).toEqual(["tx_enable"]);
    expect(client.requiredConfirmations({ callsign: "Q1TEST", tx_enabled: false })).toEqual([]);
    expect(client.requiredConfirmations({ callsign: null })).toEqual(["callsign"]);
  });

  it("refuses a reset without confirmation (also when the type check is bypassed)", async () => {
    lines.length = 0;
    const reset = client.resetSettings as unknown as (c?: unknown) => Promise<unknown>;
    await expect(reset.call(client)).rejects.toMatchObject({ code: "confirmation_required" });
    await expect(reset.call(client, { confirmed: false })).rejects.toMatchObject({
      code: "confirmation_required",
    });
    expect(lines).toHaveLength(0);
  });
});

describe("H2: a failing listener does not break the client", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("keeps resolving requests and calling the other listeners", async () => {
    await ready();
    const seen: string[] = [];
    client.on("status", () => {
      throw new Error("listener bug");
    });
    client.on("status", () => seen.push("second"));
    const st = await client.getStatus();
    expect(st.t).toBe("status");
    expect(seen).toEqual(["second"]);
    expect(console.error).toHaveBeenCalled();
  });

  it("handles the rest of a chunk after a listener threw", async () => {
    await ready();
    const rx: string[] = [];
    client.on("rx", (m) => {
      rx.push(m.tnc2);
      throw new Error("listener bug");
    });
    transport.sendRaw('{"t":"rx","tnc2":"Q1AAA>APRS:one"}\n{"t":"rx","tnc2":"Q1AAA>APRS:two"}');
    expect(rx).toEqual(["Q1AAA>APRS:one", "Q1AAA>APRS:two"]);
  });

  it("handles the lines after one whose handling failed for any other reason", async () => {
    await ready();
    const got: string[] = [];
    client.on("rx", (m) => got.push(m.tnc2));
    const emit = (client as unknown as { emit: (e: string, v: unknown) => void }).emit;
    let first = true;
    vi.spyOn(client as unknown as { emit: typeof emit }, "emit").mockImplementation(function (
      this: unknown,
      e: string,
      v: unknown,
    ) {
      if (e === "rx" && first) {
        first = false;
        throw new Error("internal bug");
      }
      emit.call(this, e, v);
    });
    transport.sendRaw('{"t":"rx","tnc2":"Q1AAA>APRS:one"}\n{"t":"rx","tnc2":"Q1AAA>APRS:two"}');
    expect(got).toEqual(["Q1AAA>APRS:two"]);
    expect(console.error).toHaveBeenCalled();
  });

  it("start() is not blocked by a state listener that throws", async () => {
    client.on("state", () => {
      throw new Error("listener bug");
    });
    await ready();
    expect(client.state).toBe("ready");
    await expect(client.start()).rejects.toMatchObject({ code: "already_started" }); // ready, not stuck
  });

  it("does not leave an unhandled rejection for an async listener", async () => {
    await ready();
    client.on("rx", () => Promise.reject(new Error("async bug")));
    transport.emitRx();
    await vi.advanceTimersByTimeAsync(0);
    expect(console.error).toHaveBeenCalled();
  });

  it("calls a callback registered twice twice, and removes only the registration that is undone", async () => {
    await ready();
    const calls: number[] = [];
    const cb = (): void => void calls.push(1);
    const off1 = client.on("rx", cb);
    client.on("rx", cb);
    transport.emitRx();
    expect(calls).toHaveLength(2);
    off1();
    transport.emitRx();
    expect(calls).toHaveLength(3);
  });
});

describe("H4: writes are at most 20 bytes (§5.2)", () => {
  it("never writes more than 20 bytes, for any line of the connection flow and a long settings.set", async () => {
    const chunks = recordWrites();
    await ready();
    await client.setSettings({ comment: "x".repeat(40), path: ["WIDE1-1", "WIDE2-2"], ssid: 3 });
    expect(chunks.length).toBeGreaterThan(8);
    expect(Math.max(...chunks.map((c) => c.length))).toBe(20); // full 20-byte writes do happen
    expect(chunks.every((c) => c.length <= 20)).toBe(true);
  });

  it("clamps maxWriteBytes to 20", async () => {
    setup({}, { maxWriteBytes: 50 });
    const chunks = recordWrites();
    await ready();
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.every((c) => c.length <= 20)).toBe(true);
    setup({}, { maxWriteBytes: Number.NaN });
    const c2 = recordWrites();
    await ready();
    expect(c2.every((c) => c.length <= 20)).toBe(true);
  });

  it("reports a failed write as a DeviceError", async () => {
    await ready();
    vi.spyOn(transport, "write").mockRejectedValue(new Error("GATT operation failed"));
    await expect(client.getStatus()).rejects.toMatchObject({
      name: "DeviceError",
      code: "write_failed",
    });
  });
});

describe("M1: a failed start keeps its error", () => {
  it("stays in error (not disconnected) after the transport reports the disconnect, with lastError", async () => {
    setup({ authDelayMs: 1_000_000 });
    const p = client.start();
    const assertion = expect(p).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    await vi.advanceTimersByTimeAsync(0); // the disconnect callback of the (mock) link has run
    expect(client.state).toBe("error");
    expect(client.lastError).toMatchObject({ code: "timeout" });
  });

  it("proto_mismatch also survives the disconnect, and keeps hello", async () => {
    transport.device.protoOverride = 9;
    await expect(client.start()).rejects.toMatchObject({ code: "proto_mismatch" });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.state).toBe("proto_mismatch");
    expect(client.hello?.proto).toBe(9);
    expect(client.lastError).toMatchObject({ code: "proto_mismatch" });
  });

  it("start() clears lastError and the old hello", async () => {
    transport.device.protoOverride = 9;
    await expect(client.start()).rejects.toMatchObject({ code: "proto_mismatch" });
    transport.device.protoOverride = undefined;
    await client.start();
    expect(client.lastError).toBeUndefined();
    expect(client.hello?.proto).toBe(1);
  });
});

describe("M2: a line from an old connection is not finished on a new one", () => {
  it("drops the remaining chunks of the old line after a disconnect and reconnect", async () => {
    setup({}, { maxWriteBytes: 4 });
    const orig = transport.write.bind(transport);
    let n = 0;
    let restart: Promise<void> | undefined;
    vi.spyOn(transport, "write").mockImplementation((chunk: Uint8Array) => {
      n++;
      const r = orig(chunk);
      if (n === 2) {
        // The link drops and the app reconnects while the first hello is half written.
        transport.simulateDisconnect();
        restart = client.start();
      }
      return r;
    });
    const first = expect(client.start()).rejects.toMatchObject({ code: "disconnected" });
    await first;
    await restart;
    expect(client.state).toBe("ready");
    expect(lines.some((l) => "unparsable" in l)).toBe(false); // no stray tail of the old line
    expect(lines.filter((l) => l.op === "hello")).toHaveLength(1); // only the new one arrived whole
  });
});

describe("M3: nothing from the old connection looks current", () => {
  it("clears status, hello and settings on disconnect and keeps lastDisconnectReason (M8)", async () => {
    await ready();
    expect(client.lastStatus?.tx_ready).toBeDefined();
    transport.simulateDisconnect("link lost");
    expect(client.lastStatus).toBeUndefined();
    expect(client.lastStatusAt).toBeUndefined();
    expect(client.hello).toBeUndefined();
    expect(client.settings).toEqual({});
    expect(client.settingsKnown).toBe(false);
    expect(client.statusStale).toBe(true);
    expect(client.lastDisconnectReason).toBe("link lost");
  });

  it("clears them on stop() too, and on start() before the first reply", async () => {
    await ready();
    await client.stop();
    expect(client.lastStatus).toBeUndefined();
    expect(client.hello).toBeUndefined();
    setup({ authDelayMs: 1_000_000 });
    client.lastStatus = { t: "status", tx_ready: true }; // left over from before
    const p = client.start().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.lastStatus).toBeUndefined();
    await client.stop();
    await p;
  });

  it("marks the status stale after 15 s without one, and fresh again with the next", async () => {
    setup({ statusIntervalMs: 1_000_000 });
    const events: boolean[] = [];
    client.on("statusStale", (s) => events.push(s));
    await ready();
    expect(client.statusStale).toBe(false);
    expect(client.lastStatusAt).toBe(Date.now());
    await vi.advanceTimersByTimeAsync(14_999);
    expect(client.statusStale).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.statusStale).toBe(true);
    expect(events).toEqual([true]);
    transport.sendRaw(JSON.stringify(transport.device.status()));
    expect(client.statusStale).toBe(false);
    expect(events).toEqual([true, false]);
  });

  it("keeps the status fresh while the 5 s status events arrive", async () => {
    await ready();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.statusStale).toBe(false);
  });

  it("ignores notifications that arrive after the disconnect", async () => {
    await ready();
    transport.simulateDisconnect();
    transport.sendRaw(JSON.stringify({ t: "status", tx_ready: true }));
    expect(client.lastStatus).toBeUndefined();
  });
});

describe("M4: line limits", () => {
  beforeEach(ready);

  it("drops an endless line, tells lineError once, and carries on", async () => {
    const bad: ParseError[] = [];
    client.on("lineError", (e) => bad.push(e));
    transport.sendRaw("x".repeat(40_000));
    expect(bad).toHaveLength(1);
    expect((await client.getStatus()).t).toBe("status");
  });

  it("accepts a long reply (settings.schema is 1.1 KB)", async () => {
    expect(JSON.stringify(client.schema).length).toBeGreaterThan(500);
    expect(client.schema.length).toBeGreaterThan(5);
  });

  it("takes CRLF line ends and a lone CR in stride", async () => {
    const bad: ParseError[] = [];
    const seen: StatusMsg[] = [];
    client.on("lineError", (e) => bad.push(e));
    client.on("status", (s) => seen.push(s));
    transport.sendRaw('{"t":"status","fix":2}\r');
    transport.sendRaw("\r");
    expect(bad).toHaveLength(0);
    expect(seen).toHaveLength(1);
  });
});

describe("M5: request line size", () => {
  beforeEach(ready);

  it("refuses a request over 512 bytes at once, without sending it", async () => {
    const send = (client as unknown as { request(r: Obj): Promise<unknown> }).request.bind(client);
    lines.length = 0;
    const writes = recordWrites();
    await expect(send({ op: "status", pad: "x".repeat(600) })).rejects.toMatchObject({
      code: "too_long",
    }); // no timers advanced: it did not wait for the 5 s timeout
    expect(lines).toHaveLength(0);
    expect(writes).toHaveLength(0);
    expect((await client.getStatus()).t).toBe("status"); // and the client goes on
  });

  it("sends a request of exactly 512 bytes", async () => {
    const send = (client as unknown as { request(r: Obj): Promise<unknown> }).request.bind(client);
    const base = JSON.stringify({ op: "status", id: 6, pad: "" }).length;
    const r = (await send({ op: "status", pad: "x".repeat(512 - base) })) as StatusMsg;
    expect(r.t).toBe("status");
  });

  it("fails the request in flight when the device answers too_long or bad_json without an id", async () => {
    for (const code of ["too_long", "bad_json"]) {
      intercept(() => [JSON.stringify({ t: "err", code })]);
      // no timers advanced: it fails at once, not after 5 s
      await expect(client.getStatus()).rejects.toMatchObject({ code });
    }
  });

  it("still reports an id-less error as deviceError when nothing is in flight", async () => {
    const errs: ErrMsg[] = [];
    client.on("deviceError", (e) => errs.push(e));
    transport.sendRaw('{"t":"err","code":"too_long"}');
    expect(errs).toHaveLength(1);
  });
});

describe("M6: replies and events are checked", () => {
  beforeEach(ready);

  it("turns an rx without tnc2 and a status with a string tx_ready into lineError", async () => {
    const bad: ParseError[] = [];
    const rx: RxMsg[] = [];
    const st: StatusMsg[] = [];
    client.on("lineError", (e) => bad.push(e));
    client.on("rx", (m) => rx.push(m));
    client.on("status", (m) => st.push(m));
    const before = client.lastStatus;
    transport.sendRaw('{"t":"rx"}');
    transport.sendRaw('{"t":"status","tx_ready":"false"}');
    expect(bad).toHaveLength(2);
    expect(rx).toHaveLength(0);
    expect(st).toHaveLength(0);
    expect(client.lastStatus).toBe(before);
  });

  it("fails a request at once when its reply is malformed", async () => {
    intercept((req) => [JSON.stringify({ t: "settings", id: req.id })]); // no values
    await expect(client.getSettings()).rejects.toMatchObject({ code: "bad_response" });
  });
});

describe("M7: the timeout starts after the write", () => {
  it("does not spend the response time on a slow write (pairing dialog, passkey entry)", async () => {
    setup({ writeDelayMs: 9000 }); // every line takes 2 chunks = 18 s to write
    const p = client.start();
    await vi.advanceTimersByTimeAsync(120_000);
    await p;
    expect(client.state).toBe("ready");
    expect(transport.droppedBeforeAuth).toBe(0);
    expect(lines.filter((l) => l.op === "hello")).toHaveLength(1); // not resent while writing
  });
});

describe("M8: lifetime", () => {
  it("dispose() removes the callbacks it registered on the transport", async () => {
    const offData = vi.fn();
    const offDisconnect = vi.fn();
    const t = new MockTransport({ autoRx: false });
    vi.spyOn(t, "onData").mockReturnValue(offData);
    vi.spyOn(t, "onDisconnect").mockReturnValue(offDisconnect);
    const c = new DeviceClient(t);
    await c.dispose();
    expect(offData).toHaveBeenCalledTimes(1);
    expect(offDisconnect).toHaveBeenCalledTimes(1);
  });

  it("dispose() stops, detaches from the transport and drops the listeners", async () => {
    await ready();
    const rx = vi.fn();
    client.on("rx", rx);
    await client.dispose();
    expect(client.state).toBe("disconnected");
    transport.emitRx();
    expect(rx).not.toHaveBeenCalled();
    await expect(client.start()).rejects.toMatchObject({ code: "disposed" });
    await client.dispose(); // twice is fine
  });

  it("stop() during connect() ends the connect and leaves nothing open", async () => {
    setup({ connectDelayMs: 1000 });
    const p = client.start();
    const failed = expect(p).rejects.toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(100);
    expect(client.state).toBe("connecting");
    const stopped = client.stop();
    await vi.advanceTimersByTimeAsync(0);
    await stopped;
    await failed;
    expect(client.state).toBe("disconnected");
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.state).toBe("disconnected");
    expect(lines).toHaveLength(0);
    // start() works afterwards, and there is exactly one link
    setup();
    await ready();
    expect(client.state).toBe("ready");
  });

  it("start() while stop() is still waiting for the connect is refused (no two connects at once)", async () => {
    setup({ connectDelayMs: 1000 });
    const p = client.start().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    const stopped = client.stop();
    await expect(client.start()).rejects.toMatchObject({ code: "already_started" });
    await vi.advanceTimersByTimeAsync(0);
    await stopped;
    await p;
  });

  it("a connect that finishes anyway after stop() is closed again", async () => {
    // A transport whose connect() ignores disconnect() and resolves later.
    setup();
    let finish!: () => void;
    const slowConnect = new Promise<void>((r) => (finish = r));
    const conn = vi.spyOn(transport, "connect").mockImplementation(() => slowConnect);
    const disc = vi.spyOn(transport, "disconnect");
    const p = client.start().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    const stopped = client.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(disc).toHaveBeenCalledTimes(1);
    finish();
    await stopped;
    await p;
    expect(disc).toHaveBeenCalledTimes(2); // closed again
    expect(conn).toHaveBeenCalledTimes(1);
    expect(client.state).toBe("disconnected");
  });
});

describe("M10: details the mutation tests showed to be unprotected", () => {
  beforeEach(ready);

  it("a busy resend of stations.list starts the list again (no duplicate stations)", async () => {
    vi.mocked(transport.device.handleLine).mockReturnValueOnce([]);
    const p = client.listStations();
    await vi.advanceTimersByTimeAsync(0);
    const id = (JSON.parse(vi.mocked(transport.device.handleLine).mock.calls.at(-1)![0]) as Obj).id;
    for (const src of ["Q1AAA-9", "Q1BBB"]) {
      transport.sendRaw(JSON.stringify({ t: "station", id, src }));
    }
    transport.sendRaw('{"t":"err","code":"busy"}');
    await vi.advanceTimersByTimeAsync(500); // resent; the device answers with all three
    expect((await p).map((s) => s.src)).toEqual(["Q1AAA-9", "Q1BBB", "Q1TEST-7"]);
  });

  it("every station line extends the timeout of stations.list", async () => {
    vi.mocked(transport.device.handleLine).mockReturnValueOnce([]);
    const p = client.listStations();
    await vi.advanceTimersByTimeAsync(0);
    const id = (JSON.parse(vi.mocked(transport.device.handleLine).mock.calls.at(-1)![0]) as Obj).id;
    await vi.advanceTimersByTimeAsync(4000);
    transport.sendRaw(JSON.stringify({ t: "station", id, src: "Q1AAA-9" }));
    await vi.advanceTimersByTimeAsync(4000); // 8 s in: more than one timeout, but a line came in between
    transport.sendRaw(JSON.stringify({ t: "station", id, src: "Q1BBB" }));
    await vi.advanceTimersByTimeAsync(4000);
    transport.sendRaw(JSON.stringify({ t: "stations.end", id, n: 2 }));
    expect((await p).map((s) => s.src)).toEqual(["Q1AAA-9", "Q1BBB"]);
  });

  it("a station list that goes quiet still times out", async () => {
    vi.mocked(transport.device.handleLine).mockReturnValueOnce([]);
    const p = client.listStations();
    const assertion = expect(p).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(0);
    const id = (JSON.parse(vi.mocked(transport.device.handleLine).mock.calls.at(-1)![0]) as Obj).id;
    transport.sendRaw(JSON.stringify({ t: "station", id, src: "Q1AAA-9" }));
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });

  it("chunks of two writes never interleave, even when a resend overlaps a slow write", async () => {
    // The first status is half written when the device says busy; the resend (150 ms) starts
    // while that write is still going (it takes 6 chunks x 100 ms).
    setup({ writeDelayMs: 0 }, { maxWriteBytes: 4, busyRetryDelayMs: 150 });
    await ready();
    lines.length = 0;
    transport.writeDelayMs = 100;
    const p = client.getStatus();
    await vi.advanceTimersByTimeAsync(50);
    transport.sendRaw('{"t":"err","code":"busy"}');
    await vi.advanceTimersByTimeAsync(3000);
    expect((await p).t).toBe("status");
    expect(lines.every((l) => !("unparsable" in l))).toBe(true);
    expect(lines.filter((l) => l.op === "status")).toHaveLength(2);
  });
});
