import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeviceClient, DeviceError } from "../src/client/deviceClient.ts";
import { KNOWN_SETTINGS, MICE_MESSAGES } from "../src/protocol/settings.ts";
import type { SettingsRisk } from "../src/protocol/settings.ts";
import type { SchemaItem, SettingsValues } from "../src/protocol/types.ts";
import { MockTransport } from "../src/transport/mock/mockTransport.ts";
import { DEFAULT_SETTINGS } from "../src/transport/mock/mockDevice.ts";
import type { ConfirmOptions } from "../src/ui/dialog.ts";
import {
  ALL_RISKS,
  confirmationFor,
  describeError,
  choiceOptions,
  deviceChangedKeys,
  emptyDraft,
  evaluateForm,
  executeReset,
  executeSave,
  fieldLabel,
  fieldUnit,
  fullCall,
  getOwn,
  groupItems,
  humanSeconds,
  itemDesc,
  miceLabel,
  miceOptions,
  parseNumberInput,
  resetConfirmation,
  savedMessage,
  setDraft,
  widgetKindFor,
} from "../src/ui/settingsForm.ts";
import type { ResettableClient, SavableClient } from "../src/ui/settingsForm.ts";

const SCHEMA = KNOWN_SETTINGS as SchemaItem[];
const CURRENT: SettingsValues = structuredClone(DEFAULT_SETTINGS);

function item(key: string): SchemaItem {
  const i = SCHEMA.find((s) => s.key === key);
  if (!i) throw new Error(`no schema item ${key}`);
  return i;
}

describe("widgetKindFor", () => {
  it("gives the known items their dedicated widgets", () => {
    expect(widgetKindFor(item("callsign"))).toBe("callsign");
    expect(widgetKindFor(item("symbol"))).toBe("symbol");
    expect(widgetKindFor(item("path"))).toBe("path");
    expect(widgetKindFor(item("mice_message"))).toBe("mice");
  });
  it("uses the type for everything else", () => {
    expect(widgetKindFor(item("comment"))).toBe("text");
    expect(widgetKindFor(item("ssid"))).toBe("number");
    expect(widgetKindFor(item("beacon_move_m"))).toBe("number");
    expect(widgetKindFor(item("tx_enabled"))).toBe("toggle");
    expect(widgetKindFor({ key: "x", type: "list" })).toBe("list");
  });
  it("falls back to a generic widget when a known key has another type on the device", () => {
    expect(widgetKindFor({ key: "mice_message", type: "str" })).toBe("text");
    expect(widgetKindFor({ key: "callsign", type: "int" })).toBe("number");
  });
  it("shows an unknown type read-only instead of failing", () => {
    expect(widgetKindFor({ key: "blob", type: "bytes" })).toBe("readonly");
  });
  it("every known item has a kind and a label", () => {
    for (const i of KNOWN_SETTINGS) {
      expect(widgetKindFor(i)).not.toBe("readonly");
      expect(fieldLabel(i)).not.toBe(i.key);
    }
  });
  it("shows an unknown item by its key", () => {
    expect(fieldLabel({ key: "new_thing", type: "int" })).toBe("new_thing");
  });
});

describe("units and groups", () => {
  it("knows the units of the beacon items", () => {
    expect(fieldUnit(item("beacon_still_s"))).toBe("s");
    expect(fieldUnit(item("beacon_move_m"))).toBe("m");
    expect(fieldUnit(item("ssid"))).toBeUndefined();
  });
  it("reads a unit at the end of an unknown item's description", () => {
    expect(fieldUnit({ key: "gain", type: "int", desc: "Gain (dB)" })).toBe("dB");
    expect(fieldUnit({ key: "mm", type: "int", desc: "Mic-E message (0-6)" })).toBeUndefined();
  });
  it("puts every item in exactly one group, unknown ones in Other", () => {
    const schema: SchemaItem[] = [...SCHEMA, { key: "zzz", type: "bool" }];
    const groups = groupItems(schema);
    expect(groups.flatMap((g) => g.items.map((i) => i.key)).sort()).toEqual(
      schema.map((i) => i.key).sort(),
    );
    expect(groups.at(-1)?.title).toBe("Other");
    expect(groups.at(-1)?.items.map((i) => i.key)).toEqual(["zzz"]);
  });
  it("leaves out empty groups", () => {
    expect(groupItems([])).toEqual([]);
    expect(groupItems([{ key: "q", type: "int" }]).map((g) => g.title)).toEqual(["Other"]);
  });
  it("humanSeconds", () => {
    expect(humanSeconds(900)).toBe("15 min");
    expect(humanSeconds(90)).toBe("1 min 30 s");
    expect(humanSeconds(7200)).toBe("2 h");
    expect(humanSeconds(30)).toBe("30 s");
  });
  it("parseNumberInput keeps text that is not a number as text", () => {
    expect(parseNumberInput("60")).toBe(60);
    expect(parseNumberInput(" 7.5 ")).toBe(7.5);
    expect(parseNumberInput("")).toBe("");
    expect(parseNumberInput("abc")).toBe("abc");
    expect(parseNumberInput("Infinity")).toBe("Infinity");
  });
});

describe("mice_message offers only 0 to 6", () => {
  it("has exactly the seven named choices and no 7", () => {
    const o = miceOptions();
    expect(o.map((x) => x.value)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(o).toHaveLength(MICE_MESSAGES.length);
    expect(o.some((x) => x.value === 7)).toBe(false);
    expect(o[0]?.label).toBe("0 Off Duty");
    expect(o[6]?.label).toBe("6 Priority");
  });
  it("describes a value the app cannot set without offering it", () => {
    expect(miceLabel(7)).toMatch(/Emergency/);
    expect(miceLabel(7)).toMatch(/cannot be set/);
    expect(miceLabel(3)).toBe("3 Returning");
  });
  it("rejects 7 in the form", () => {
    const e = evaluateForm(SCHEMA, CURRENT, { mice_message: 7 });
    expect(e.errors.mice_message).toBeDefined();
    expect(e.canSave).toBe(false);
    expect(e.changes).toEqual({});
  });
});

describe("form values: current + edits -> changes", () => {
  it("has no changes and Save disabled when nothing was edited", () => {
    const e = evaluateForm(SCHEMA, CURRENT, {});
    expect(e).toEqual({ changes: {}, errors: {}, dirty: [], canSave: false });
  });
  it("an edit back to the device's value removes the edit", () => {
    let d = setDraft({}, CURRENT, "comment", "Changed");
    expect(Object.keys(d)).toEqual(["comment"]);
    d = setDraft(d, CURRENT, "comment", CURRENT.comment);
    expect(d).toEqual({});
    expect(evaluateForm(SCHEMA, CURRENT, d).canSave).toBe(false);
  });
  it("a draft that equals the device after normalization is not a change", () => {
    const e = evaluateForm(SCHEMA, CURRENT, { path: ["wide1-1"] });
    expect(e.changes).toEqual({});
    expect(e.canSave).toBe(false);
  });
  it("sends only the changed items, normalized", () => {
    const d = { comment: "Hello", path: ["wide2-2"], ssid: 7, beacon_still_s: 600 };
    const e = evaluateForm(SCHEMA, CURRENT, d);
    expect(e.changes).toEqual({ comment: "Hello", path: ["WIDE2-2"], beacon_still_s: 600 });
    expect(e.dirty).toEqual(["path", "comment", "beacon_still_s"]);
    expect(e.canSave).toBe(true);
  });
  it("one invalid item blocks Save and names the item", () => {
    const e = evaluateForm(SCHEMA, CURRENT, { comment: "ok", beacon_still_s: 5 });
    expect(e.errors.beacon_still_s).toBeDefined();
    expect(e.canSave).toBe(false);
    expect(e.dirty).toContain("beacon_still_s");
  });
  it("treats empty or non-numeric number input as invalid", () => {
    expect(evaluateForm(SCHEMA, CURRENT, { ssid: "" }).errors.ssid).toMatch(/number/i);
    expect(evaluateForm(SCHEMA, CURRENT, { ssid: parseNumberInput("x") }).canSave).toBe(false);
    expect(evaluateForm(SCHEMA, CURRENT, { ssid: 1.5 }).canSave).toBe(false);
  });
  it("checks the symbol", () => {
    expect(evaluateForm(SCHEMA, CURRENT, { symbol: "/k" }).changes).toEqual({ symbol: "/k" });
    expect(evaluateForm(SCHEMA, CURRENT, { symbol: "/" }).canSave).toBe(false);
    expect(evaluateForm(SCHEMA, CURRENT, { symbol: "a>" }).canSave).toBe(false);
  });
  it("checks the path length and format", () => {
    expect(evaluateForm(SCHEMA, CURRENT, { path: ["A1", "B1", "C1"] }).canSave).toBe(false);
    expect(evaluateForm(SCHEMA, CURRENT, { path: ["WIDE1-1*"] }).canSave).toBe(false);
    expect(evaluateForm(SCHEMA, CURRENT, { path: [] }).changes).toEqual({ path: [] });
  });
  it("ignores edits of items that are not in the schema, and read-only items", () => {
    const schema: SchemaItem[] = [{ key: "blob", type: "bytes" }, item("comment")];
    expect(evaluateForm(schema, { blob: "x" }, { blob: "y", nope: 1 }).dirty).toEqual([]);
  });
  it("validates unknown items by their schema", () => {
    const schema: SchemaItem[] = [
      { key: "volume", type: "int", min: 0, max: 10 },
      { key: "name", type: "str", max_len: 3, nullable: true },
    ];
    const cur: SettingsValues = { volume: 3, name: null };
    expect(evaluateForm(schema, cur, { volume: 11 }).canSave).toBe(false);
    expect(evaluateForm(schema, cur, { volume: 4, name: "abc" }).changes).toEqual({
      volume: 4,
      name: "abc",
    });
    expect(evaluateForm(schema, cur, { name: "abcd" }).canSave).toBe(false);
    expect(evaluateForm(schema, { volume: 3, name: "ab" }, { name: null }).changes).toEqual({
      name: null,
    });
  });
  it("reports edited items that the device changed meanwhile", () => {
    const prev = { comment: "A", ssid: 1 };
    const cur = { comment: "B", ssid: 1 };
    expect(deviceChangedKeys(prev, cur, { comment: "mine", ssid: 2 })).toEqual(["comment"]);
    expect(deviceChangedKeys(prev, cur, {})).toEqual([]);
  });
});

describe("callsign is validated, never rewritten", () => {
  it("rejects lower case, spaces, an SSID, a missing digit, and empty", () => {
    for (const bad of ["q1test", " Q1TEST", "Q1TEST ", "Q1 TEST", "Q1TEST-7", "ABCDE", "", "Q1"]) {
      const e = evaluateForm(SCHEMA, CURRENT, { callsign: bad });
      expect(e.errors.callsign, JSON.stringify(bad)).toBeDefined();
      expect(e.changes).toEqual({});
      expect(e.canSave).toBe(false);
    }
  });
  it("explains the lower case mistake", () => {
    expect(evaluateForm(SCHEMA, CURRENT, { callsign: "q1new" }).errors.callsign).toMatch(/upper/i);
  });
  it("passes a valid callsign through unchanged", () => {
    const e = evaluateForm(SCHEMA, CURRENT, { callsign: "Q1NEW" });
    expect(e.changes).toEqual({ callsign: "Q1NEW" });
  });
  it("accepts null (not set) as a change", () => {
    expect(evaluateForm(SCHEMA, CURRENT, { callsign: null }).changes).toEqual({ callsign: null });
  });
});

describe("confirmations", () => {
  it("every SettingsRisk has a dialog with a title, text and a danger confirm button", () => {
    // ALL_RISKS is a Record<SettingsRisk, true> underneath, so a new risk fails to compile
    // until it is added there; this checks that each one has real text.
    const probe: SettingsValues = {
      callsign: "Q1NEW",
      ssid: 3,
      tx_enabled: true,
      beacon_mode: "auto",
    };
    expect(ALL_RISKS).toEqual(["callsign", "ssid", "tx_enable", "beacon_auto"]); // the order the user is asked in
    for (const risk of ALL_RISKS) {
      const o = confirmationFor(risk, CURRENT, probe);
      expect(o.title.length).toBeGreaterThan(5);
      expect(o.body.join(" ").length).toBeGreaterThan(30);
      expect(o.confirmLabel).not.toBe("Confirm");
      expect(o.danger).toBe(true);
      expect(o.facts?.length).toBeGreaterThan(0);
    }
  });
  it("an unknown kind of risk still gets a dialog (never skipped)", () => {
    const o = confirmationFor("future_risk" as SettingsRisk, CURRENT, { comment: "x" });
    expect(o.title).toBeTruthy();
    expect(o.body.join(" ")).toContain("future_risk");
  });
  it("the tx_enable dialog says what will be sent as whom", () => {
    const o = confirmationFor("tx_enable", CURRENT, { tx_enabled: true });
    expect(o.body[0]).toBe(
      "Transmit will be enabled. The tracker will send beacons on the air as Q1TEST-7 when the beacon switch is on.",
    );
    expect(o.facts).toContain("Transmit enabled: off → on");
  });
  it("the tx_enable dialog uses the new callsign and SSID when they change in the same save", () => {
    const o = confirmationFor("tx_enable", CURRENT, {
      tx_enabled: true,
      callsign: "Q1NEW",
      ssid: 0,
    });
    expect(o.body[0]).toContain("as Q1NEW when");
  });
  it("the tx_enable dialog admits that there is no callsign", () => {
    const o = confirmationFor("tx_enable", { ...CURRENT, callsign: null }, { tx_enabled: true });
    expect(o.body[0]).toMatch(/no callsign is set/);
  });
  it("the callsign dialog shows old -> new", () => {
    const o = confirmationFor("callsign", CURRENT, { callsign: "Q1NEW" });
    expect(o.facts).toEqual(["Callsign: Q1TEST → Q1NEW"]);
    const cleared = confirmationFor("callsign", CURRENT, { callsign: null });
    expect(cleared.facts).toEqual(["Callsign: Q1TEST → not set"]);
    expect(cleared.title).toMatch(/Clear/);
    expect(cleared.body.join(" ")).toMatch(/not transmit/);
  });
  it("the ssid dialog shows old -> new on the air, with the current callsign", () => {
    const o = confirmationFor("ssid", CURRENT, { ssid: 3 });
    expect(o.title).toBe("Change the SSID?");
    expect(o.facts).toEqual(["On the air as: Q1TEST-7 → Q1TEST-3", "SSID: 7 → 3"]);
    expect(o.body.join(" ")).toMatch(/CALL-SSID/);
    expect(o.danger).toBe(true);
    expect(confirmationFor("ssid", CURRENT, { ssid: 0 }).facts?.[0]).toBe(
      "On the air as: Q1TEST-7 → Q1TEST",
    );
  });
  it("the ssid dialog uses the new callsign when it changes in the same save", () => {
    const o = confirmationFor("ssid", CURRENT, { ssid: 3, callsign: "Q1NEW" });
    expect(o.facts?.[0]).toBe("On the air as: Q1TEST-7 → Q1NEW-3");
  });
  it("the ssid dialog admits that there is no callsign", () => {
    const o = confirmationFor("ssid", { ...CURRENT, callsign: null }, { ssid: 3 });
    expect(o.facts?.[0]).toBe("On the air as: not set → not set");
    expect(o.body.join(" ")).toMatch(/will not transmit/);
  });
  it("the reset dialog is dangerous and says what is lost", () => {
    const o = resetConfirmation(CURRENT, true, false);
    expect(o.danger).toBe(true);
    expect(o.body.join(" ")).toMatch(/deletes every saved setting/);
    expect(o.body.join(" ")).toMatch(/callsign/);
    expect(o.facts).toContain("Callsign now: Q1TEST-7");
    expect(o.facts).toContain("Transmit enabled now: off");
    expect(resetConfirmation(CURRENT, true, true).body.join(" ")).toMatch(/unsaved edits/);
    expect(resetConfirmation(CURRENT, false, false).facts).toEqual([
      "The current settings are not known.",
    ]);
  });
  it("fullCall", () => {
    expect(fullCall("Q1TEST", 7)).toBe("Q1TEST-7");
    expect(fullCall("Q1TEST", 0)).toBe("Q1TEST");
    expect(fullCall(null, 7)).toBeUndefined();
  });
});

// ---- the confirm-then-save sequence ----------------------------------------------------------

class FakeClient implements SavableClient {
  settings: SettingsValues = structuredClone(DEFAULT_SETTINGS);
  sent: { values: Record<string, unknown>; confirmed: readonly SettingsRisk[] | undefined }[] = [];
  requiredConfirmations(values: Record<string, unknown>): SettingsRisk[] {
    const r: SettingsRisk[] = [];
    if ("callsign" in values && values.callsign !== this.settings.callsign) r.push("callsign");
    if ("ssid" in values && values.ssid !== this.settings.ssid) r.push("ssid");
    if (values.tx_enabled === true && this.settings.tx_enabled !== true) r.push("tx_enable");
    return r;
  }
  setSettings(
    values: Record<string, unknown>,
    options: { confirmed?: readonly SettingsRisk[] } = {},
  ): ReturnType<SavableClient["setSettings"]> {
    this.sent.push({ values, confirmed: options.confirmed });
    return Promise.resolve({
      t: "settings",
      values: { ...this.settings },
      changed: Object.keys(values),
    });
  }
}

describe("executeSave (dialogs before sending)", () => {
  it("sends a plain change without any dialog", async () => {
    const c = new FakeClient();
    const confirm = vi.fn(() => Promise.resolve(true));
    const out = await executeSave(c, { comment: "Hello" }, confirm);
    expect(out.kind).toBe("saved");
    expect(confirm).not.toHaveBeenCalled();
    expect(c.sent).toEqual([{ values: { comment: "Hello" }, confirmed: [] }]);
  });
  it("turning transmit off needs no dialog", async () => {
    const c = new FakeClient();
    c.settings.tx_enabled = true;
    const confirm = vi.fn(() => Promise.resolve(true));
    await executeSave(c, { tx_enabled: false }, confirm);
    expect(confirm).not.toHaveBeenCalled();
    expect(c.sent).toHaveLength(1);
  });
  it("tx_enabled true: asks first; cancel sends nothing", async () => {
    const c = new FakeClient();
    const confirm = vi.fn<(o: ConfirmOptions) => Promise<boolean>>(() => Promise.resolve(false));
    const out = await executeSave(c, { tx_enabled: true }, confirm);
    expect(out).toEqual({ kind: "cancelled", risk: "tx_enable" });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]?.[0].title).toBe("Enable transmit?");
    expect(c.sent).toEqual([]);
  });
  it("tx_enabled true: approval sends it with the confirmation", async () => {
    const c = new FakeClient();
    const out = await executeSave(c, { tx_enabled: true }, () => Promise.resolve(true));
    expect(out.kind).toBe("saved");
    expect(c.sent).toEqual([{ values: { tx_enabled: true }, confirmed: ["tx_enable"] }]);
  });
  it("callsign change or null always asks", async () => {
    for (const cs of ["Q1NEW", null]) {
      const c = new FakeClient();
      const confirm = vi.fn<(o: ConfirmOptions) => Promise<boolean>>(() => Promise.resolve(false));
      const out = await executeSave(c, { callsign: cs }, confirm);
      expect(out).toEqual({ kind: "cancelled", risk: "callsign" });
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(c.sent).toEqual([]);
    }
  });
  it("asks for every risk; one refusal stops everything, in order callsign then tx_enable", async () => {
    const c = new FakeClient();
    const titles: string[] = [];
    const out = await executeSave(c, { tx_enabled: true, callsign: "Q1NEW" }, (o) => {
      titles.push(o.title);
      return Promise.resolve(o.title !== "Enable transmit?");
    });
    expect(titles).toEqual(["Change the callsign?", "Enable transmit?"]);
    expect(out).toEqual({ kind: "cancelled", risk: "tx_enable" });
    expect(c.sent).toEqual([]);
  });
  it("sends both confirmations when both are given", async () => {
    const c = new FakeClient();
    await executeSave(c, { tx_enabled: true, callsign: "Q1NEW", comment: "x" }, () =>
      Promise.resolve(true),
    );
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]?.confirmed).toEqual(["callsign", "tx_enable"]);
    expect(c.sent[0]?.values).toEqual({ tx_enabled: true, callsign: "Q1NEW", comment: "x" });
  });
  it("the values shown in the dialog are the values sent", async () => {
    const c = new FakeClient();
    const changes: SettingsValues = { callsign: "Q1NEW", tx_enabled: true };
    const shown: string[] = [];
    await executeSave(c, changes, (o) => {
      shown.push(...(o.facts ?? []), ...o.body);
      // The caller changes its object while the dialog is open: it must not matter.
      changes.callsign = "Q1EVIL";
      return Promise.resolve(true);
    });
    expect(shown.join("\n")).toContain("Q1TEST → Q1NEW");
    expect(shown.join("\n")).toContain("as Q1NEW-7");
    expect(c.sent[0]?.values.callsign).toBe("Q1NEW");
  });
  it("an ssid change always asks, whether or not transmit is enabled", async () => {
    for (const tx of [false, true]) {
      const c = new FakeClient();
      c.settings.tx_enabled = tx;
      const titles: string[] = [];
      const out = await executeSave(c, { ssid: 3 }, (o) => {
        titles.push(o.title);
        return Promise.resolve(false);
      });
      expect(out).toEqual({ kind: "cancelled", risk: "ssid" });
      expect(titles).toEqual(["Change the SSID?"]);
      expect(c.sent).toEqual([]);
    }
  });
  it("an ssid change is sent with the ssid confirmation", async () => {
    const c = new FakeClient();
    await executeSave(c, { ssid: 3 }, () => Promise.resolve(true));
    expect(c.sent).toEqual([{ values: { ssid: 3 }, confirmed: ["ssid"] }]);
  });
  it("asks callsign, then ssid, then tx_enable, and sends all three confirmations", async () => {
    const c = new FakeClient();
    const titles: string[] = [];
    const out = await executeSave(c, { tx_enabled: true, ssid: 3, callsign: "Q1NEW" }, (o) => {
      titles.push(o.title);
      return Promise.resolve(true);
    });
    expect(out.kind).toBe("saved");
    expect(titles).toEqual(["Change the callsign?", "Change the SSID?", "Enable transmit?"]);
    expect(c.sent[0]?.confirmed).toEqual(["callsign", "ssid", "tx_enable"]);
  });
  it("refusing the ssid dialog stops everything, tx_enable is not even asked", async () => {
    const c = new FakeClient();
    const titles: string[] = [];
    const out = await executeSave(c, { tx_enabled: true, ssid: 3, callsign: "Q1NEW" }, (o) => {
      titles.push(o.title);
      return Promise.resolve(o.title !== "Change the SSID?");
    });
    expect(out).toEqual({ kind: "cancelled", risk: "ssid" });
    expect(titles).toEqual(["Change the callsign?", "Change the SSID?"]);
    expect(c.sent).toEqual([]);
  });
  it("tx_enable: a callsign or SSID changed on the device meanwhile makes it stale", async () => {
    for (const change of [
      (c: FakeClient) => (c.settings.callsign = "Q1ZZZ"),
      (c: FakeClient) => (c.settings.ssid = 1),
    ]) {
      const c = new FakeClient();
      const out = await executeSave(c, { tx_enabled: true }, () => {
        change(c);
        return Promise.resolve(true);
      });
      expect(out.kind).toBe("stale");
      expect(c.sent).toEqual([]);
    }
  });
  it("ssid: a callsign changed on the device meanwhile makes it stale", async () => {
    const c = new FakeClient();
    const out = await executeSave(c, { ssid: 3 }, () => {
      c.settings.callsign = "Q1ZZZ";
      return Promise.resolve(true);
    });
    expect(out.kind).toBe("stale");
    expect(c.sent).toEqual([]);
  });
  it("does not send when the device's values changed while a dialog was open", async () => {
    const c = new FakeClient();
    const out = await executeSave(c, { callsign: "Q1NEW" }, () => {
      c.settings.callsign = "Q1ZZZ";
      return Promise.resolve(true);
    });
    expect(out.kind).toBe("stale");
    expect(c.sent).toEqual([]);
  });
});

class FakeResetClient implements ResettableClient {
  settings: SettingsValues = structuredClone(DEFAULT_SETTINGS);
  settingsKnown = true;
  resets = 0;
  resetSettings(c: { confirmed: true }): ReturnType<ResettableClient["resetSettings"]> {
    expect(c).toEqual({ confirmed: true });
    this.resets++;
    return Promise.resolve({ t: "settings", values: { ...DEFAULT_SETTINGS }, changed: [] });
  }
}

describe("executeReset (dialog before resetting)", () => {
  it("asks first, with the reset dialog, and resets after a yes", async () => {
    const c = new FakeResetClient();
    const seen: ConfirmOptions[] = [];
    const out = await executeReset(
      c,
      (o) => {
        seen.push(o);
        expect(c.resets).toBe(0); // nothing is sent before the answer
        return Promise.resolve(true);
      },
      true,
    );
    expect(out.kind).toBe("reset");
    expect(c.resets).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.title).toBe("Reset all settings?");
    expect(seen[0]?.body.join(" ")).toMatch(/unsaved edits/);
  });
  it("a no sends nothing", async () => {
    const c = new FakeResetClient();
    expect(await executeReset(c, () => Promise.resolve(false), false)).toEqual({
      kind: "cancelled",
    });
    expect(c.resets).toBe(0);
  });
  it("does not reset when the callsign, SSID or transmit permission changed during the dialog", async () => {
    for (const change of [
      (c: FakeResetClient) => (c.settings.callsign = "Q1ZZZ"),
      (c: FakeResetClient) => (c.settings.ssid = 1),
      (c: FakeResetClient) => (c.settings.tx_enabled = true),
    ]) {
      const c = new FakeResetClient();
      const out = await executeReset(
        c,
        () => {
          change(c);
          return Promise.resolve(true);
        },
        false,
      );
      expect(out.kind).toBe("stale");
      expect(c.resets).toBe(0);
    }
  });
});

describe("keys from the device are data, not property names", () => {
  const weird = ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"];
  it("labels, groups and units do not answer for them", () => {
    for (const key of weird) {
      const it = { key, type: "str" };
      expect(fieldLabel(it)).toBe(key);
      expect(fieldUnit(it)).toBeUndefined();
      expect(groupItems([it]).map((g) => g.title)).toEqual(["Other"]);
      expect(getOwn({ a: 1 }, key)).toBeUndefined();
    }
  });
  it("edits and evaluation work for such a key", () => {
    for (const key of weird) {
      const schema: SchemaItem[] = [{ key, type: "int", min: 0, max: 5 }];
      const current: SettingsValues = Object.create(null) as SettingsValues;
      const d = setDraft(emptyDraft(), current, key, 3);
      expect(Object.hasOwn(d, key)).toBe(true);
      const ev = evaluateForm(schema, current, d);
      expect(ev.dirty).toEqual([key]);
      expect(ev.changes[key]).toBe(3);
      // Not edited: nothing, even though `key in {}` would be true for "constructor".
      expect(evaluateForm(schema, current, emptyDraft()).dirty).toEqual([]);
      expect(evaluateForm(schema, {}, {}).dirty).toEqual([]);
    }
  });
  it("an edit back to the device's value removes the edit also for such a key", () => {
    const current = JSON.parse('{"constructor": 2}') as SettingsValues;
    const d1 = setDraft(emptyDraft(), current, "constructor", 4);
    expect(Object.hasOwn(d1, "constructor")).toBe(true);
    const d2 = setDraft(d1, current, "constructor", 2);
    expect(Object.hasOwn(d2, "constructor")).toBe(false);
  });
  it("a repeated key is one item", () => {
    const schema: SchemaItem[] = [
      { key: "x", type: "int" },
      { key: "x", type: "str" },
    ];
    expect(groupItems(schema)[0]?.items).toHaveLength(1);
    const d = setDraft(emptyDraft(), {}, "x", 1);
    expect(evaluateForm(schema, {}, d).dirty).toEqual(["x"]);
  });
  it("a description that is not a string is ignored", () => {
    for (const desc of [5, null, {}, [], true]) {
      const it = { key: "x", type: "int", desc } as unknown as SchemaItem;
      expect(itemDesc(it)).toBeUndefined();
      expect(fieldUnit(it)).toBeUndefined();
    }
    expect(itemDesc({ key: "x", type: "int", desc: "Hello (s)" })).toBe("Hello (s)");
    expect(fieldUnit({ key: "x", type: "int", desc: "Hello (s)" })).toBe("s");
  });
});

describe("executeSave with the real client and the demo device", () => {
  let transport: MockTransport;
  let client: DeviceClient;
  beforeEach(async () => {
    vi.useFakeTimers();
    transport = new MockTransport({ autoRx: false });
    client = new DeviceClient(transport);
    await client.start();
  });
  afterEach(async () => {
    await client.stop();
    vi.useRealTimers();
  });

  it("cancel leaves the device's tx_enabled false", async () => {
    const out = await executeSave(client, { tx_enabled: true }, () => Promise.resolve(false));
    expect(out.kind).toBe("cancelled");
    expect(client.settings.tx_enabled).toBe(false);
    expect(transport.device.settings.tx_enabled).toBe(false);
  });
  it("approval turns it on, and a comment alone needs no dialog", async () => {
    const confirm = vi.fn(() => Promise.resolve(true));
    await executeSave(client, { comment: "Hi there" }, confirm);
    expect(confirm).not.toHaveBeenCalled();
    expect(transport.device.settings.comment).toBe("Hi there");
    const out = await executeSave(client, { tx_enabled: true }, confirm);
    expect(out.kind).toBe("saved");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(transport.device.settings.tx_enabled).toBe(true);
  });
  it("a changed callsign is confirmed and arrives as shown", async () => {
    const seen: ConfirmOptions[] = [];
    const out = await executeSave(client, { callsign: "Q1NEW" }, (o) => {
      seen.push(o);
      return Promise.resolve(true);
    });
    expect(out.kind).toBe("saved");
    expect(seen[0]?.facts).toEqual(["Callsign: Q1TEST → Q1NEW"]);
    expect(transport.device.settings.callsign).toBe("Q1NEW");
  });
  it("a lower case callsign is refused by the client as invalid, with a dialog never reached", async () => {
    const confirm = vi.fn(() => Promise.resolve(true));
    await expect(executeSave(client, { callsign: "q1new" }, confirm)).rejects.toMatchObject({
      code: "invalid",
      key: "callsign",
    });
    expect(transport.device.settings.callsign).toBe("Q1TEST");
  });
});

describe("error texts", () => {
  it("puts an invalid value under its item", () => {
    const e = new DeviceError("invalid", "integer 60-7200", "beacon_still_s");
    expect(describeError(e)).toMatchObject({ key: "beacon_still_s" });
    expect(describeError(e).text).toContain("integer 60-7200");
  });
  it("invalid without a key goes to the top", () => {
    expect(describeError(new DeviceError("invalid", "values")).key).toBeUndefined();
  });
  it.each([
    "confirmation_required",
    "timeout",
    "disconnected",
    "not_connected",
    "busy",
    "io",
    "too_long",
    "write_failed",
    "bad_response",
    "internal",
    "proto_mismatch",
    "disposed",
    "already_started",
    "bad_json",
    "unknown_op",
    "something_new",
  ])("says something readable for %s, not the code", (code) => {
    const t = describeError(new DeviceError(code)).text;
    expect(t.length).toBeGreaterThan(15);
    expect(t).toMatch(/^[A-Z]/);
    expect(t).not.toContain(code.includes("_") ? code : "\u0000");
  });
  it("warns that a timed out save may have been applied", () => {
    expect(describeError(new DeviceError("timeout")).text).toMatch(/may or may not/);
    expect(describeError(new DeviceError("disconnected")).text).toMatch(/may not have been saved/);
  });
  it("handles things that are not DeviceErrors", () => {
    expect(describeError(new Error("x")).text.length).toBeGreaterThan(10);
    expect(describeError(undefined).text.length).toBeGreaterThan(10);
    expect(describeError("oops").text.length).toBeGreaterThan(10);
  });
  it("savedMessage lists the changed items by name", () => {
    expect(savedMessage(["comment", "tx_enabled", "zzz"], SCHEMA)).toBe(
      "Saved: Comment, Transmit enabled, zzz.",
    );
    expect(savedMessage([], SCHEMA)).toMatch(/already had/);
    expect(savedMessage(undefined, SCHEMA)).toMatch(/already had/);
  });
});

describe("beacon_mode (v0.5)", () => {
  const bm = item("beacon_mode");
  it("gets the choice widget, and a str without choices stays a text input", () => {
    expect(widgetKindFor(bm)).toBe("choice");
    expect(widgetKindFor({ key: "x", type: "str" })).toBe("text");
    expect(widgetKindFor({ key: "x", type: "str", choices: [1] })).toBe("text");
  });
  it("lists its choices with words", () => {
    expect(choiceOptions(bm).map((o) => o.value)).toEqual(["auto", "manual"]);
    expect(choiceOptions(bm)[1]!.label).toMatch(/Manual/);
  });
  it("is in the Beacon group with a label", () => {
    expect(fieldLabel(bm)).toBe("Beacon mode");
    expect(groupItems([bm])[0]!.title).toBe("Beacon");
  });
  it("the beacon_auto dialog says a beacon may go out at once", () => {
    const o = confirmationFor(
      "beacon_auto",
      { ...DEFAULT_SETTINGS, beacon_mode: "manual", tx_enabled: true },
      { beacon_mode: "auto" },
    );
    expect(o.body.join(" ")).toMatch(/right away/);
    expect(o.facts).toContain("Beacon mode: manual → auto");
    expect(o.danger).toBe(true);
  });
});
