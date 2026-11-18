import { describe, expect, it } from "vitest";
import {
  KNOWN_SETTINGS,
  MICE_MESSAGES,
  normalizeSettings,
  settingEquals,
  settingsRisks,
  validateSetting,
} from "../src/protocol/settings.ts";
import type { SchemaItem } from "../src/protocol/types.ts";

// The examples below are written out by hand from ble-protocol.md §9.1 (an oracle that does not
// depend on KNOWN_SETTINGS). The next describe derives its cases from KNOWN_SETTINGS itself, so
// the two cannot drift apart unnoticed.

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

describe("validateSetting against KNOWN_SETTINGS", () => {
  const numeric = KNOWN_SETTINGS.filter((i) => i.type === "int" || i.type === "float");

  it("covers every known item", () => {
    expect(KNOWN_SETTINGS.map((i) => i.key)).toContain("mice_message");
    expect(numeric.length).toBeGreaterThanOrEqual(5);
  });

  for (const item of numeric) {
    const { key, min, max } = item as SchemaItem & { min: number; max: number };
    const maxOk = key === "mice_message" ? MICE_MESSAGES.length - 1 : max;
    it(`${key}: accepts ${min} and ${maxOk}, rejects ${min - 1} and ${maxOk + 1}`, () => {
      expect(validateSetting(key, min)).toEqual({ value: min });
      expect(validateSetting(key, maxOk)).toEqual({ value: maxOk });
      expect(validateSetting(key, min - 1)).toHaveProperty("error");
      expect(validateSetting(key, maxOk + 1)).toHaveProperty("error");
    });
  }

  it("mice_message is limited to the 7 messages the app may set (0-6): 7 (Emergency) is not allowed", () => {
    expect(MICE_MESSAGES).toHaveLength(7);
    const item = KNOWN_SETTINGS.find((i) => i.key === "mice_message")!;
    expect([item.min, item.max]).toEqual([0, MICE_MESSAGES.length - 1]);
    expect(validateSetting("mice_message", 7)).toHaveProperty("error");
  });

  it("rejects values of the wrong type for every known item", () => {
    for (const item of KNOWN_SETTINGS) {
      for (const v of [undefined, NaN, Infinity, {}, () => 1, Symbol("x")]) {
        expect(validateSetting(item.key, v), `${item.key} = ${String(v)}`).toHaveProperty("error");
      }
    }
  });
});

describe("validateSetting: bad values that used to slip through", () => {
  it("rejects NaN and Infinity (JSON.stringify would turn them into null)", () => {
    for (const key of ["ssid", "beacon_move_m", "beacon_moving_s", "mice_message"]) {
      for (const v of [NaN, Infinity, -Infinity]) {
        expect(validateSetting(key, v), `${key} = ${v}`).toHaveProperty("error");
      }
    }
  });

  it("does not alter a callsign: lowercase and spaces are errors, not fixed", () => {
    for (const v of ["q1test", " Q1TEST", "Q1TEST ", "Q1 TEST", "Q1TEST\n", ""]) {
      expect(validateSetting("callsign", v), JSON.stringify(v)).toHaveProperty("error");
    }
    expect(validateSetting("callsign", "Q1TEST")).toEqual({ value: "Q1TEST" });
  });

  it("is strict about types: no string numbers or string booleans", () => {
    expect(validateSetting("ssid", "7")).toHaveProperty("error");
    expect(validateSetting("tx_enabled", "true")).toHaveProperty("error");
    expect(validateSetting("fx25_tx", 0)).toHaveProperty("error");
  });

  it("upper-cases path (§9.1) and returns a copy", () => {
    const input = ["wide1-1"];
    const r = validateSetting("path", input);
    expect(r).toEqual({ value: ["WIDE1-1"] });
    expect(input).toEqual(["wide1-1"]);
    expect(validateSetting("path", [" wide1-1"])).toHaveProperty("error");
  });
});

describe("validateSetting for items the app does not know", () => {
  const schema: SchemaItem[] = [
    { key: "volume", type: "int", min: 0, max: 10 },
    { key: "name", type: "str", nullable: true, max_len: 4, pattern: "^[a-z]+$" },
    { key: "tags", type: "list", max_items: 2 },
    { key: "weird", type: "blob" },
  ];

  it("rejects them without a schema", () => {
    expect(validateSetting("volume", 3)).toEqual({ error: "unknown item" });
  });

  it("checks them against the device's schema", () => {
    expect(validateSetting("volume", 3, schema)).toEqual({ value: 3 });
    expect(validateSetting("volume", 11, schema)).toHaveProperty("error");
    expect(validateSetting("name", null, schema)).toEqual({ value: null });
    expect(validateSetting("name", "abcd", schema)).toEqual({ value: "abcd" });
    expect(validateSetting("name", "abcde", schema)).toHaveProperty("error");
    // The pattern comes from the device and is only a hint: it is not run (see the ReDoS test).
    expect(validateSetting("name", "ABC", schema)).toEqual({ value: "ABC" });
    expect(validateSetting("tags", ["a", "b"], schema)).toEqual({ value: ["a", "b"] });
    expect(validateSetting("tags", ["a", "b", "c"], schema)).toHaveProperty("error");
    expect(validateSetting("weird", 1, schema)).toHaveProperty("error");
    expect(validateSetting("volume", NaN, schema)).toHaveProperty("error");
  });
});

describe("validateSetting does not trust the device's schema", () => {
  it("never runs a pattern from the device (ReDoS)", () => {
    const schema: SchemaItem[] = [{ key: "evil", type: "str", pattern: "^(a+)+$" }];
    const t0 = Date.now();
    expect(validateSetting("evil", `${"a".repeat(40)}!`, schema)).toEqual({
      value: `${"a".repeat(40)}!`,
    });
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it("still checks the callsign with the app's own pattern", () => {
    expect(validateSetting("callsign", "AB")).toHaveProperty("error");
    expect(validateSetting("callsign", "Q1TESTX")).toHaveProperty("error");
  });

  it("treats a limit that is not a finite number as no limit", () => {
    const bad = [null, "5", NaN, Infinity, {}, [], true];
    for (const b of bad) {
      const schema = [
        { key: "n", type: "int", min: b, max: b },
        { key: "f", type: "float", min: b, max: b },
        { key: "s", type: "str", len: b, max_len: b },
        { key: "l", type: "list", max_items: b },
      ] as unknown as SchemaItem[];
      const tag = JSON.stringify(b) ?? String(b);
      expect(validateSetting("n", 99999, schema), tag).toEqual({ value: 99999 });
      expect(validateSetting("n", 1.5, schema), tag).toHaveProperty("error"); // still an integer
      expect(validateSetting("f", -1e9, schema), tag).toEqual({ value: -1e9 });
      expect(validateSetting("f", NaN, schema), tag).toHaveProperty("error");
      expect(validateSetting("s", "x".repeat(500), schema), tag).toEqual({
        value: "x".repeat(500),
      });
      expect(validateSetting("l", ["a", "b", "c", "d"], schema), tag).toEqual({
        value: ["a", "b", "c", "d"],
      });
    }
  });

  it("a limit that is a finite number still applies", () => {
    const schema: SchemaItem[] = [{ key: "n", type: "int", min: 0, max: 5, nullable: false }];
    expect(validateSetting("n", 6, schema)).toHaveProperty("error");
    expect(validateSetting("n", null, schema)).toHaveProperty("error");
  });

  it("nullable counts only when it is exactly true", () => {
    const schema = [{ key: "n", type: "int", nullable: "yes" }] as unknown as SchemaItem[];
    expect(validateSetting("n", null, schema)).toHaveProperty("error");
  });

  it("keeps a key such as __proto__ or constructor as data", () => {
    const schema: SchemaItem[] = [
      { key: "__proto__", type: "int" },
      { key: "constructor", type: "int" },
    ];
    const r = normalizeSettings(JSON.parse('{"__proto__": 1, "constructor": 2}'), schema);
    expect(r).toHaveProperty("values");
    const values = (r as { values: Record<string, unknown> }).values;
    expect(Object.hasOwn(values, "__proto__")).toBe(true);
    expect(values.constructor).toBe(2);
    expect(Object.getPrototypeOf(values)).toBeNull();
  });
});

describe("path is checked before it is upper-cased", () => {
  it("rejects letters that upper-case into ASCII", () => {
    // "ß".toUpperCase() is "SS", "ﬁ" is "FI", a dotless "ı" is "I".
    for (const e of ["ß", "ﬁ1", "wıde1-1", "ſ1", "Ａ1"]) {
      expect(validateSetting("path", [e]), e).toEqual({ error: "entries like WIDE1-1" });
    }
  });
  it("still accepts and upper-cases ASCII entries", () => {
    expect(validateSetting("path", ["wide1-1", "Wide2-15"])).toEqual({
      value: ["WIDE1-1", "WIDE2-15"],
    });
    expect(validateSetting("path", ["WIDE1-16"])).toHaveProperty("error");
    expect(validateSetting("path", ["TOOLONG1"])).toHaveProperty("error");
  });
});

describe("normalizeSettings", () => {
  it("normalizes and skips undefined", () => {
    expect(normalizeSettings({ path: ["wide1-1"], comment: undefined, ssid: 3 })).toEqual({
      values: { path: ["WIDE1-1"], ssid: 3 },
    });
    expect(normalizeSettings({ tx_enabled: undefined })).toEqual({ values: {} });
  });

  it("reports the offending key", () => {
    expect(normalizeSettings({ ssid: 1, mice_message: 7 })).toMatchObject({ key: "mice_message" });
    expect(normalizeSettings({ nope: 1 })).toMatchObject({ key: "nope" });
    expect(normalizeSettings(null)).toMatchObject({ key: "values" });
    expect(normalizeSettings([1])).toMatchObject({ key: "values" });
  });
});

describe("settingEquals", () => {
  it("compares scalars and lists by value, strictly", () => {
    expect(settingEquals(["A", "B"], ["A", "B"])).toBe(true);
    expect(settingEquals(["A", "B"], ["B", "A"])).toBe(false);
    expect(settingEquals([], ["A"])).toBe(false);
    expect(settingEquals(null, null)).toBe(true);
    expect(settingEquals(null, undefined)).toBe(false);
    expect(settingEquals(1, "1")).toBe(false);
    expect(settingEquals(0, false)).toBe(false);
  });
});

describe("settingsRisks: an SSID change is always confirmed", () => {
  const cur = { callsign: "Q1TEST", tx_enabled: false, ssid: 7 };
  it.each([
    ["transmit off", { ...cur, tx_enabled: false }],
    ["transmit on", { ...cur, tx_enabled: true }],
    ["no callsign", { ...cur, callsign: null }],
  ])("flags ssid when %s", (_name, current) => {
    expect(settingsRisks(current, { ssid: 3 })).toEqual(["ssid"]);
    expect(settingsRisks(current, { ssid: 0 })).toEqual(["ssid"]);
  });
  it("is reported together with the other risks, in a stable order", () => {
    expect(settingsRisks(cur, { ssid: 1, callsign: "Q1NEW", tx_enabled: true })).toEqual([
      "callsign",
      "ssid",
      "tx_enable",
    ]);
  });
});

describe("settingsRisks (what needs a confirmation dialog)", () => {
  const cur = { callsign: "Q1TEST", tx_enabled: false, ssid: 7 };

  it("flags enabling transmit and changing or clearing the callsign", () => {
    expect(settingsRisks(cur, { tx_enabled: true })).toEqual(["tx_enable"]);
    expect(settingsRisks(cur, { callsign: "Q1NEW" })).toEqual(["callsign"]);
    expect(settingsRisks(cur, { callsign: null })).toEqual(["callsign"]);
    expect(settingsRisks(cur, { callsign: "Q1NEW", tx_enabled: true })).toEqual([
      "callsign",
      "tx_enable",
    ]);
  });

  it("does not flag what is not a change or is not risky", () => {
    expect(settingsRisks(cur, { callsign: "Q1TEST" })).toEqual([]);
    expect(settingsRisks(cur, { tx_enabled: false })).toEqual([]);
    expect(settingsRisks(cur, { ssid: 7 })).toEqual([]); // same SSID: not a change
    expect(settingsRisks({ ...cur, tx_enabled: true }, { tx_enabled: true })).toEqual([]);
  });
});
