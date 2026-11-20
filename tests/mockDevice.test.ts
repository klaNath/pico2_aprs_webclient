import { beforeEach, describe, expect, it } from "vitest";
import { KNOWN_SETTINGS } from "../src/protocol/settings.ts";
import { DEFAULT_SETTINGS, MockDevice } from "../src/transport/mock/mockDevice.ts";

type Obj = Record<string, unknown>;

let dev: MockDevice;
beforeEach(() => {
  dev = new MockDevice();
});

function call(req: unknown): Obj[] {
  return dev
    .handleLine(typeof req === "string" ? req : JSON.stringify(req))
    .map((l) => JSON.parse(l) as Obj);
}
function set(values: unknown, id = 5): Obj {
  return call({ op: "settings.set", id, values })[0]!;
}

describe("settings.set", () => {
  it("returns every item and lists only the items that really changed", () => {
    const r = set({ comment: "Hello", ssid: 7 }); // ssid 7 is already the value
    expect(r).toMatchObject({ t: "settings", id: 5, changed: ["comment"] });
    expect((r.values as Obj).comment).toBe("Hello");
    expect(Object.keys(r.values as Obj).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
  });

  it("reports no change when values are identical", () => {
    expect(set({ ssid: 7 })).toMatchObject({ t: "settings", changed: [] });
  });

  it("is all or nothing", () => {
    const r = set({ comment: "Changed", ssid: 99 });
    expect(r).toEqual({ t: "err", id: 5, code: "invalid", key: "ssid", msg: "integer 0-15" });
    expect(dev.settings.comment).toBe(DEFAULT_SETTINGS.comment);
  });

  it("rejects an empty or non-object values", () => {
    expect(set({})).toMatchObject({ t: "err", code: "invalid" });
    expect(set([1])).toMatchObject({ t: "err", code: "invalid" });
    expect(set(undefined)).toMatchObject({ t: "err", code: "invalid" });
  });

  it("stores the upper-cased path", () => {
    set({ path: ["wide1-1"] });
    expect(dev.settings.path).toEqual(["WIDE1-1"]);
  });

  it("returns io and changes nothing when saving fails, then recovers", () => {
    dev.failNextSave = true;
    expect(set({ comment: "x" })).toMatchObject({ t: "err", id: 5, code: "io" });
    expect(dev.settings.comment).toBe(DEFAULT_SETTINGS.comment);
    expect(set({ comment: "x" })).toMatchObject({ t: "settings", changed: ["comment"] });
  });
});

describe("settings.reset / get / schema", () => {
  it("resets to the defaults and lists what changed", () => {
    set({ comment: "x", ssid: 3 });
    const r = call({ op: "settings.reset", id: 6 })[0]!;
    expect(r).toMatchObject({ t: "settings", id: 6 });
    expect([...(r.changed as string[])].sort()).toEqual(["comment", "ssid"]);
    expect(r.values).toEqual(DEFAULT_SETTINGS);
  });

  it("returns the current values", () => {
    expect(call({ op: "settings.get", id: 3 })[0]).toEqual({
      t: "settings",
      id: 3,
      values: DEFAULT_SETTINGS,
    });
  });

  it("lists the schema in §9.1 order", () => {
    const r = call({ op: "settings.schema", id: 2 })[0]!;
    expect((r.items as { key: string }[]).map((i) => i.key)).toEqual(
      KNOWN_SETTINGS.map((i) => i.key),
    );
    expect((r.items as { key: string }[])[0]!.key).toBe("callsign");
  });
});

describe("line handling errors (§5.1, §8.6)", () => {
  it("accepts a line of exactly 512 bytes and rejects 513", () => {
    const base = '{"op":"status","pad":""}';
    const pad = (n: number): string => `{"op":"status","pad":"${"x".repeat(n)}"}`;
    const n = 512 - base.length;
    expect(pad(n).length).toBe(512);
    expect(call(pad(n))[0]).toMatchObject({ t: "status" });
    expect(call(pad(n + 1))[0]).toEqual({ t: "err", code: "too_long" });
  });

  it("counts bytes, not characters", () => {
    const line = `{"op":"status","pad":"${"あ".repeat(200)}"}`; // ~225 chars, ~625 bytes
    expect(call(line)[0]).toEqual({ t: "err", code: "too_long" });
  });

  it("returns bad_json without an id", () => {
    for (const line of ["{", "[1]", "5", "null", "garbage"]) {
      expect(call(line)).toEqual([{ t: "err", code: "bad_json" }]);
    }
  });

  it("returns unknown_op with the first 32 characters of op", () => {
    expect(call({ op: "nope", id: 9 })[0]).toEqual({
      t: "err",
      id: 9,
      code: "unknown_op",
      msg: "nope",
    });
    const long = "o".repeat(50);
    expect(call({ op: long })[0]).toMatchObject({ code: "unknown_op", msg: "o".repeat(32) });
    expect(call({ id: 1 })[0]).toMatchObject({ t: "err", id: 1, code: "unknown_op" });
  });

  it("treats a non-integer id as absent", () => {
    expect(call({ op: "hello", id: "x" })[0]).not.toHaveProperty("id");
    expect(call({ op: "hello", id: 1.5 })[0]).not.toHaveProperty("id");
    expect(call({ op: "hello", id: 4 })[0]).toHaveProperty("id", 4);
  });
});

describe("hello / status / stations.list", () => {
  it("answers hello with proto 1 and mode tnc (or an overridden proto)", () => {
    expect(call({ op: "hello", id: 1 })[0]).toEqual({
      t: "hello",
      id: 1,
      proto: 1,
      name: "pico2_aprs",
      mode: "tnc",
    });
    dev.protoOverride = 2;
    expect(call({ op: "hello" })[0]).toHaveProperty("proto", 2);
  });

  it("derives tx_ready and tx_refuse from the switch and the settings", () => {
    expect(dev.status()).toMatchObject({
      tx_ready: false,
      tx_refuse: "TX not enabled",
      call: "Q1TEST-7",
    });
    set({ tx_enabled: true });
    const ready = dev.status();
    expect(ready.tx_ready).toBe(true);
    expect(ready).not.toHaveProperty("tx_refuse");
    dev.sw = false;
    const off = dev.status();
    expect(off.tx_ready).toBe(false);
    expect(off).not.toHaveProperty("tx_refuse"); // conditions are met; only the switch is off
    dev.sw = true;
    set({ callsign: null });
    expect(dev.status()).toMatchObject({
      tx_ready: false,
      tx_refuse: "callsign not set",
      call: "NOCALL",
    });
  });

  it("omits lat/lon without a fix", () => {
    expect(dev.status()).toHaveProperty("lat");
    dev.fix = 0;
    const s = dev.status();
    expect(s).not.toHaveProperty("lat");
    expect(s).not.toHaveProperty("lon");
  });

  it("lists stations then stations.end, all with the request id", () => {
    const out = call({ op: "stations.list", id: 4 });
    expect(out.map((m) => m.t)).toEqual(["station", "station", "station", "stations.end"]);
    expect(out.every((m) => m.id === 4)).toBe(true);
    expect(out.at(-1)).toMatchObject({ n: 3 });
    expect(out[0]).toMatchObject({ src: "Q1AAA-9" });
  });
});

describe("beacon.send (§7.5, v0.5)", () => {
  let t = 1_700_000_000_000;
  beforeEach(() => {
    dev.now = () => t;
  });

  it("answers beacon and then sends the tx event", () => {
    dev.settings.tx_enabled = true;
    const out = call({ op: "beacon.send", id: 7 });
    expect(out[0]).toEqual({ t: "beacon", id: 7, dry: false });
    expect(out[1]).toMatchObject({ t: "tx", dry: false });
    expect(String(out[1]!.tnc2)).toMatch(/^Q1TEST-7>/);
    expect(dev.txCount).toBe(1);
  });
  it("is a dry run when the transmit gate refuses", () => {
    expect(call({ op: "beacon.send", id: 1 })[0]).toEqual({ t: "beacon", id: 1, dry: true });
  });
  it("checks the switch, then the fix, then the 10 s rule, in that order", () => {
    dev.sw = false;
    dev.fix = 0;
    expect(call({ op: "beacon.send", id: 1 })).toEqual([{ t: "err", id: 1, code: "switch_off" }]);
    dev.sw = true;
    expect(call({ op: "beacon.send", id: 2 })).toEqual([{ t: "err", id: 2, code: "no_fix" }]);
    dev.fix = 3;
    expect(call({ op: "beacon.send", id: 3 })[0]).toMatchObject({ t: "beacon" });
    t += 4000;
    expect(call({ op: "beacon.send", id: 4 })).toEqual([
      { t: "err", id: 4, code: "too_soon", wait_s: 6 },
    ]);
    t += 6000;
    expect(call({ op: "beacon.send", id: 5 })[0]).toMatchObject({ t: "beacon" });
  });
  it("sends nothing when it fails", () => {
    dev.failNextBeacon = "frame_too_long";
    expect(call({ op: "beacon.send", id: 1 })).toEqual([
      { t: "err", id: 1, code: "frame_too_long" },
    ]);
    expect(dev.txCount).toBe(0);
  });
  it("status shows beacon_mode, utc and last_tx_s", () => {
    expect(dev.status()).toMatchObject({ beacon_mode: "auto" });
    expect(dev.status().last_tx_s).toBeUndefined();
    call({ op: "beacon.send" });
    t += 3000;
    expect(dev.status().last_tx_s).toBe(3);
    dev.fix = 0;
    expect(dev.status().utc).toBeUndefined();
  });
});

describe("APRS messages (§7.6-§7.8, v0.8)", () => {
  let t = 1_000_000;
  beforeEach(() => {
    t = 1_000_000;
    dev.now = () => t;
    dev.settings.tx_enabled = true;
  });
  const parse = (lines: string[]): Obj[] => lines.map((l) => JSON.parse(l) as Obj);

  it("checks in the spec's order and queues nothing on an error", () => {
    expect(call({ op: "msg.send", id: 1, to: "Q1 AAA", text: "x" })[0]).toMatchObject({
      code: "invalid",
      key: "to",
    });
    expect(call({ op: "msg.send", id: 1, to: "Q1AAA", text: "a{b" })[0]).toMatchObject({
      code: "invalid",
      key: "text",
    });
    expect(call({ op: "msg.send", id: 1, to: "Q1TEST-7", text: "me" })[0]).toMatchObject({
      key: "to",
    });
    dev.sw = false;
    expect(call({ op: "msg.send", id: 1, to: "Q1AAA", text: "x" })[0]).toMatchObject({
      code: "switch_off",
    });
    dev.sw = true;
    dev.settings.tx_enabled = false;
    expect(call({ op: "msg.send", id: 1, to: "Q1AAA", text: "x" })[0]).toMatchObject({
      code: "tx_not_ready",
      msg: "TX not enabled",
    });
    expect(dev.messages).toEqual([]);
  });

  it("answers pending at once, then tries with 30/60/120/240 s gaps and fails after 5", () => {
    const r = call({ op: "msg.send", id: 9, to: "q1aaa-9", text: "Hello" })[0]!;
    expect(r).toMatchObject({
      t: "msg",
      id: 9,
      dir: "out",
      to: "Q1AAA-9",
      state: "pending",
      tries: 0,
    });
    expect(dev.status()).toMatchObject({ msg_pending: 1 });
    const first = parse(dev.tick());
    expect(first[0]).toMatchObject({ t: "tx", dry: false });
    expect(String(first[0]!.tnc2)).toContain("::Q1AAA-9  :Hello{");
    expect(first[1]).toMatchObject({ t: "msg", tries: 1, state: "pending" });
    expect(first[1]).not.toHaveProperty("id");
    for (const gap of [30, 60, 120, 240]) {
      t += (gap - 1) * 1000;
      expect(dev.tick()).toEqual([]);
      t += 1000;
      expect(parse(dev.tick())[1]).toMatchObject({ state: "pending" });
    }
    t += 240_000;
    expect(parse(dev.tick())).toEqual([expect.objectContaining({ state: "failed", tries: 5 })]);
  });

  it("a due try waits while the channel is busy or the switch is off, and is not counted", () => {
    call({ op: "msg.send", id: 1, to: "Q1AAA", text: "x" });
    dev.chBusy = true;
    expect(dev.tick()).toEqual([]);
    dev.chBusy = false;
    dev.sw = false;
    expect(dev.tick()).toEqual([]);
    dev.sw = true;
    expect(parse(dev.tick())[1]).toMatchObject({ tries: 1 });
  });

  it("refuses a 5th pending message, and cancel ends one", () => {
    for (let i = 0; i < 4; i++) call({ op: "msg.send", id: i, to: "Q1AAA", text: `m${i}` });
    expect(call({ op: "msg.send", id: 5, to: "Q1AAA", text: "x" })[0]).toMatchObject({
      code: "queue_full",
    });
    const no = dev.messages[0]!.row.no;
    expect(call({ op: "msg.cancel", id: 6, no })[0]).toMatchObject({ state: "cancelled", id: 6 });
    expect(call({ op: "msg.cancel", id: 7, no })[0]).toMatchObject({ state: "cancelled" });
    expect(call({ op: "msg.cancel", id: 8, no: "nope" })[0]).toMatchObject({ code: "unknown_msg" });
  });

  it("msg.list returns newest first, ends with msg.end and clears the unread count", () => {
    call({ op: "msg.send", id: 1, to: "Q1AAA", text: "out" });
    const inLines = parse(dev.receiveMessage("Q1BBB", "Hi", "7"));
    expect(inLines[0]).toMatchObject({ t: "msg", dir: "in", src: "Q1BBB", no: "7" });
    expect(String(inLines[1]!.tnc2)).toContain("::Q1BBB    :ack7");
    expect(dev.status().msg_unread).toBe(1);
    const list = call({ op: "msg.list", id: 3 });
    expect(list.map((m) => m.t)).toEqual(["msg", "msg", "msg.end"]);
    expect(list[0]).toMatchObject({ dir: "in", id: 3 });
    expect(list[2]).toMatchObject({ n: 2 });
    expect(dev.status().msg_unread).toBe(0);
  });

  it("demo: the addressee acknowledges after autoAckMs", () => {
    dev.autoAckMs = 4000;
    call({ op: "msg.send", id: 1, to: "Q1AAA", text: "x" });
    dev.tick();
    t += 4000;
    expect(parse(dev.tick())).toEqual([expect.objectContaining({ state: "acked", tries: 1 })]);
  });
});
