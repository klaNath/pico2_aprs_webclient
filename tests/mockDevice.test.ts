import { beforeEach, describe, expect, it } from "vitest";
import { KNOWN_SETTINGS } from "../src/protocol/settings.ts";
import { DEFAULT_SETTINGS, MockDevice, validateSetting } from "../src/transport/mock/mockDevice.ts";

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

describe("validateSetting (§9.1 ranges)", () => {
  const ok: [string, unknown][] = [
    ["ssid", 0],
    ["ssid", 15],
    ["beacon_moving_s", 30],
    ["beacon_moving_s", 3600],
    ["beacon_still_s", 60],
    ["beacon_still_s", 7200],
    ["beacon_move_m", 1],
    ["beacon_move_m", 1000],
    ["beacon_move_m", 5], // an integer is accepted for a float item
    ["mice_message", 0],
    ["mice_message", 6],
    ["callsign", "Q1TEST"],
    ["callsign", "Q1T"],
    ["callsign", null],
    ["symbol", "/>"],
    ["symbol", "\\k"],
    ["symbol", "5!"],
    ["path", []],
    ["path", ["WIDE1-1", "WIDE2-1"]],
    ["path", ["Q1DIGI-0"]],
    ["comment", ""],
    ["comment", "x".repeat(40)],
    ["tx_enabled", true],
    ["fx25_tx", false],
  ];
  for (const [key, v] of ok) {
    it(`accepts ${key} = ${JSON.stringify(v)}`, () => {
      expect(validateSetting(key, v)).toHaveProperty("value");
    });
  }

  const bad: [string, unknown][] = [
    ["ssid", -1],
    ["ssid", 16],
    ["ssid", 1.5],
    ["ssid", true],
    ["ssid", "5"],
    ["beacon_moving_s", 29],
    ["beacon_moving_s", 3601],
    ["beacon_still_s", 59],
    ["beacon_still_s", 7201],
    ["beacon_move_m", 0.5],
    ["beacon_move_m", 1001],
    ["beacon_move_m", "5"],
    ["mice_message", 7], // Emergency cannot be set from the app
    ["mice_message", -1],
    ["mice_message", 2.5],
    ["callsign", "ABCDEF"], // no digit
    ["callsign", "Q1"], // too short
    ["callsign", "Q1TEST7"], // too long
    ["callsign", "q1test"], // lowercase
    ["callsign", "Q1TEST-7"], // SSID is a separate item
    ["symbol", "/"],
    ["symbol", "/>>"],
    ["symbol", "a>"],
    ["symbol", "/ "],
    ["path", ["WIDE1-1", "WIDE2-1", "Q1DIGI"]],
    ["path", ["WIDE1-1*"]],
    ["path", ["WIDE1-16"]],
    ["path", ["TOOLONGNAME"]],
    ["path", "WIDE1-1"],
    ["path", [1]],
    ["comment", "x".repeat(41)],
    ["comment", "日本語"],
    ["comment", "tab\there"],
    ["comment", 5],
    ["tx_enabled", "yes"],
    ["tx_enabled", 1],
    ["fx25_tx", null],
    ["no_such_item", 1],
  ];
  for (const [key, v] of bad) {
    it(`rejects ${key} = ${JSON.stringify(v)}`, () => {
      expect(validateSetting(key, v)).toHaveProperty("error");
    });
  }

  it("converts path entries to upper case", () => {
    expect(validateSetting("path", ["wide1-1"])).toEqual({ value: ["WIDE1-1"] });
  });
});

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
