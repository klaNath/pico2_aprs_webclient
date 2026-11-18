import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeviceClient, DeviceError } from "../src/client/deviceClient.ts";
import type { ClientState } from "../src/client/deviceClient.ts";
import { DEFAULT_SETTINGS } from "../src/transport/mock/mockDevice.ts";
import { MockTransport } from "../src/transport/mock/mockTransport.ts";
import type { ConfirmOptions } from "../src/ui/dialog.ts";
import { SettingsController } from "../src/ui/settingsController.ts";
import type { ControllerClient, ControllerHost } from "../src/ui/settingsController.ts";

// The Settings tab logic without a DOM. The point of these tests: nothing reaches the device's
// setSettings / resetSettings without the user's "yes", whatever happens around the dialogs.

class FakeHost implements ControllerHost {
  client: ControllerClient | undefined;
  /** When set, `state` is this instead of the client's own state. */
  stateOverride: ClientState | undefined;
  private listeners = new Set<() => void>();
  get state(): ClientState {
    return this.stateOverride ?? this.client?.state ?? "disconnected";
  }
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  notify(): void {
    for (const l of [...this.listeners]) l();
  }
}

interface PendingDialog {
  opts: ConfirmOptions;
  signal: AbortSignal;
  answer: (yes: boolean) => void;
}

/** A confirm function that behaves like confirmDialog: a dialog stays open until it is answered or aborted. */
class Dialogs {
  shown: PendingDialog[] = [];
  confirm = (opts: ConfirmOptions, signal: AbortSignal): Promise<boolean> => {
    if (signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const d: PendingDialog = { opts, signal, answer: resolve };
      signal.addEventListener("abort", () => resolve(false), { once: true });
      this.shown.push(d);
    });
  };
  get titles(): string[] {
    return this.shown.map((d) => d.opts.title);
  }
  /** The newest dialog that has not been answered. */
  last(): PendingDialog {
    const d = this.shown[this.shown.length - 1];
    if (!d) throw new Error("no dialog is open");
    return d;
  }
}

const tick = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("SettingsController with the real client and the demo device", () => {
  let transport: MockTransport;
  let client: DeviceClient;
  let host: FakeHost;
  let dialogs: Dialogs;
  let renders: number;
  let ctl: SettingsController;
  let setSpy: ReturnType<typeof vi.spyOn>;
  let resetSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.useFakeTimers();
    transport = new MockTransport({ autoRx: false });
    client = new DeviceClient(transport);
    await client.start();
    host = new FakeHost();
    host.client = client;
    client.on("state", () => host.notify());
    dialogs = new Dialogs();
    renders = 0;
    ctl = new SettingsController({ host, confirm: dialogs.confirm, onChange: () => renders++ });
    setSpy = vi.spyOn(client, "setSettings");
    resetSpy = vi.spyOn(client, "resetSettings");
  });
  afterEach(async () => {
    ctl.dispose();
    await client.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const dev = (): Record<string, unknown> => transport.device.settings;

  // ---- the three confirmations, and Cancel -------------------------------------------------

  it("a comment alone is sent without any dialog", async () => {
    ctl.edit("comment", "Hello");
    await ctl.save();
    expect(dialogs.shown).toEqual([]);
    expect(dev().comment).toBe("Hello");
    expect(ctl.message("device")?.level).toBe("ok");
  });

  it("an SSID change asks even when tx_enabled is false; Cancel sends nothing", async () => {
    expect(dev().tx_enabled).toBe(false);
    ctl.edit("ssid", 3);
    const p = ctl.save();
    await tick();
    expect(dialogs.titles).toEqual(["Change the SSID?"]);
    expect(dialogs.last().opts.facts).toContain("On the air as: Q1TEST-7 → Q1TEST-3");
    expect(setSpy).not.toHaveBeenCalled();
    dialogs.last().answer(false);
    await p;
    expect(setSpy).not.toHaveBeenCalled();
    expect(dev().ssid).toBe(7);
    expect(ctl.message("device")?.text).toMatch(/Cancelled/);
    expect(ctl.busy).toBe(false);
  });

  it("an SSID change asks even when tx_enabled is true; OK sends it with the confirmation", async () => {
    dev().tx_enabled = true;
    await client.getSettings();
    ctl.edit("ssid", 3);
    const p = ctl.save();
    await tick();
    expect(dialogs.titles).toEqual(["Change the SSID?"]);
    dialogs.last().answer(true);
    await p;
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(setSpy.mock.calls[0]?.[1]).toEqual({ confirmed: ["ssid"] });
    expect(dev().ssid).toBe(3);
  });

  it("callsign + SSID + tx_enabled: three dialogs in order, one send at the end", async () => {
    ctl.edit("callsign", "Q1NEW");
    ctl.edit("ssid", 3);
    ctl.edit("tx_enabled", true);
    const p = ctl.save();
    await tick();
    expect(dialogs.titles).toEqual(["Change the callsign?"]);
    dialogs.last().answer(true);
    await tick();
    expect(dialogs.titles).toEqual(["Change the callsign?", "Change the SSID?"]);
    expect(dialogs.last().opts.facts?.[0]).toBe("On the air as: Q1TEST-7 → Q1NEW-3");
    dialogs.last().answer(true);
    await tick();
    expect(dialogs.titles).toEqual([
      "Change the callsign?",
      "Change the SSID?",
      "Enable transmit?",
    ]);
    expect(setSpy).not.toHaveBeenCalled();
    dialogs.last().answer(true);
    await p;
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(setSpy.mock.calls[0]?.[1]).toEqual({ confirmed: ["callsign", "ssid", "tx_enable"] });
    expect(dev()).toMatchObject({ callsign: "Q1NEW", ssid: 3, tx_enabled: true });
  });

  it("refusing the last of three dialogs sends nothing at all", async () => {
    ctl.edit("callsign", "Q1NEW");
    ctl.edit("ssid", 3);
    ctl.edit("tx_enabled", true);
    const p = ctl.save();
    for (const yes of [true, true, false]) {
      await tick();
      dialogs.last().answer(yes);
    }
    await p;
    expect(dialogs.shown).toHaveLength(3);
    expect(setSpy).not.toHaveBeenCalled();
    expect(dev()).toMatchObject({ callsign: "Q1TEST", ssid: 7, tx_enabled: false });
  });

  it("Reset asks first; Cancel resets nothing; OK resets", async () => {
    dev().comment = "custom";
    await client.getSettings();
    const p = ctl.reset();
    await tick();
    expect(dialogs.titles).toEqual(["Reset all settings?"]);
    expect(resetSpy).not.toHaveBeenCalled();
    dialogs.last().answer(false);
    await p;
    expect(resetSpy).not.toHaveBeenCalled();
    expect(dev().comment).toBe("custom");
    expect(ctl.message("reset")?.text).toMatch(/Cancelled/);

    const p2 = ctl.reset();
    await tick();
    dialogs.last().answer(true);
    await p2;
    expect(resetSpy).toHaveBeenCalledTimes(1);
    expect(dev().comment).toBe(DEFAULT_SETTINGS.comment);
  });

  // ---- things that happen while a dialog is open -------------------------------------------

  it("a double click does not open two dialogs or send twice", async () => {
    ctl.edit("ssid", 3);
    const p1 = ctl.save();
    const p2 = ctl.save();
    await tick();
    expect(dialogs.shown).toHaveLength(1);
    dialogs.last().answer(true);
    await Promise.all([p1, p2]);
    expect(setSpy).toHaveBeenCalledTimes(1);
    // Reset while a save is in progress is ignored too.
    ctl.edit("ssid", 5);
    const p3 = ctl.save();
    const p4 = ctl.reset();
    await tick();
    expect(dialogs.shown).toHaveLength(2);
    dialogs.last().answer(false);
    await Promise.all([p3, p4]);
    expect(resetSpy).not.toHaveBeenCalled();
  });

  it("a disconnect while a dialog is open closes it (answer: no) and sends nothing", async () => {
    ctl.edit("callsign", "Q1NEW");
    const p = ctl.save();
    await tick();
    const d = dialogs.last();
    expect(d.signal.aborted).toBe(false);
    transport.simulateDisconnect();
    await tick();
    expect(d.signal.aborted).toBe(true);
    await p;
    expect(setSpy).not.toHaveBeenCalled();
    expect(ctl.busy).toBe(false);
    expect(ctl.refresh().readOnly).toBe(true);
  });

  it("a disconnect while the Reset dialog is open sends nothing", async () => {
    const p = ctl.reset();
    await tick();
    const d = dialogs.last();
    transport.simulateDisconnect();
    await tick();
    expect(d.signal.aborted).toBe(true);
    await p;
    expect(resetSpy).not.toHaveBeenCalled();
    expect(ctl.busy).toBe(false);
  });

  it("a dialog that answers yes after the connection was lost still sends nothing", async () => {
    ctl.edit("ssid", 3);
    const p = ctl.save();
    await tick();
    const d = dialogs.last();
    // A dialog that ignores the abort signal (a bug elsewhere) and answers yes late.
    host.stateOverride = "error";
    host.notify();
    d.answer(true);
    await p;
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("the device's callsign changing during the tx_enable dialog is stale: nothing is sent", async () => {
    ctl.edit("tx_enabled", true);
    const p = ctl.save();
    await tick();
    expect(dialogs.titles).toEqual(["Enable transmit?"]);
    client.settings.callsign = "Q1ZZZ";
    dialogs.last().answer(true);
    await p;
    expect(setSpy).not.toHaveBeenCalled();
    expect(dev().tx_enabled).toBe(false);
    expect(ctl.message("device")?.text).toMatch(/changed while you were confirming/);
  });

  it("the device's SSID changing during the tx_enable dialog is stale", async () => {
    ctl.edit("tx_enabled", true);
    const p = ctl.save();
    await tick();
    client.settings.ssid = 1;
    dialogs.last().answer(true);
    await p;
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("the device's callsign changing during the ssid dialog is stale", async () => {
    ctl.edit("ssid", 3);
    const p = ctl.save();
    await tick();
    client.settings.callsign = "Q1ZZZ";
    dialogs.last().answer(true);
    await p;
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("a Reset whose dialog described other values is stale", async () => {
    const p = ctl.reset();
    await tick();
    client.settings.tx_enabled = true;
    dialogs.last().answer(true);
    await p;
    expect(resetSpy).not.toHaveBeenCalled();
    expect(ctl.message("reset")?.level).toBe("error");
  });

  it("confirmation is decided at Save from the device's values at that moment", async () => {
    // Edited while the device had SSID 7; by the time of Save the device has SSID 3, so
    // "ssid: 3" is not a change and needs no dialog, while "ssid: 5" still does.
    ctl.edit("ssid", 3);
    ctl.edit("comment", "x");
    client.settings.ssid = 3;
    expect(ctl.refresh().ev.changes).toEqual({ comment: "x" });
    await ctl.save();
    expect(dialogs.shown).toEqual([]);
    expect(setSpy.mock.calls[0]?.[0]).toEqual({ comment: "x" });
    ctl.edit("ssid", 5);
    client.settings.ssid = 4;
    const p = ctl.save();
    await tick();
    expect(dialogs.titles).toEqual(["Change the SSID?"]);
    dialogs.last().answer(false);
    await p;
  });

  // ---- read-only while not connected -------------------------------------------------------

  it("is read-only when not ready: no edit, Save, Reset or Reload reaches the device", async () => {
    ctl.edit("callsign", "Q1NEW");
    transport.simulateDisconnect();
    await tick();
    const m = ctl.refresh();
    expect(m.readOnly).toBe(true);
    expect(m.canSave || m.canRevert || m.canReload || m.canReset).toBe(false);
    ctl.edit("comment", "x");
    await ctl.save();
    await ctl.reset();
    await ctl.reload();
    ctl.revert();
    expect(setSpy).not.toHaveBeenCalled();
    expect(resetSpy).not.toHaveBeenCalled();
    expect(dialogs.shown).toEqual([]);
  });

  it("is read-only in every state but ready", async () => {
    for (const st of [
      "connecting",
      "handshaking",
      "error",
      "proto_mismatch",
      "disconnected",
    ] as const) {
      host.stateOverride = st;
      expect(ctl.refresh().readOnly, st).toBe(true);
      ctl.edit("comment", "x");
      await ctl.save();
      expect(setSpy).not.toHaveBeenCalled();
    }
    host.stateOverride = undefined;
    expect(ctl.refresh().readOnly).toBe(false);
  });

  it("shows the last values read-only only when they are known", async () => {
    // The real client forgets its settings on disconnect: nothing to show, only the guidance.
    transport.simulateDisconnect();
    await tick();
    expect(ctl.refresh().hasForm).toBe(false);
  });

  // ---- errors from the device (M2) and a stuck busy (L4) -----------------------------------

  it("an invalid for an item that was not edited is shown, and does not block Save", async () => {
    ctl.edit("beacon_still_s", 600);
    setSpy.mockRejectedValueOnce(new DeviceError("invalid", "too long", "comment"));
    await ctl.save();
    let m = ctl.refresh();
    expect(m.serverErrors.get("comment")).toMatch(/rejected/);
    expect(ctl.message("device")?.text).toMatch(/highlighted/);
    expect(m.canSave).toBe(true); // not stuck: `comment` is not part of the draft
    // Editing something else tidies the note up.
    ctl.edit("beacon_still_s", 601);
    m = ctl.refresh();
    expect(m.serverErrors.size).toBe(0);
    expect(m.canSave).toBe(true);
  });

  it("an invalid for an edited item blocks Save until that item is edited", async () => {
    ctl.edit("comment", "bad");
    ctl.edit("beacon_still_s", 600);
    setSpy.mockRejectedValueOnce(new DeviceError("invalid", "no", "comment"));
    await ctl.save();
    expect(ctl.refresh().canSave).toBe(false);
    ctl.edit("beacon_still_s", 601); // another item: the complaint about `comment` stays
    expect(ctl.refresh().serverErrors.has("comment")).toBe(true);
    expect(ctl.refresh().canSave).toBe(false);
    ctl.edit("comment", "good");
    expect(ctl.refresh().canSave).toBe(true);
    ctl.revert();
    expect(ctl.refresh().serverErrors.size).toBe(0);
  });

  it("an invalid that names an item the schema does not have goes to the top", async () => {
    ctl.edit("comment", "x");
    setSpy.mockRejectedValueOnce(new DeviceError("invalid", "no", "nonexistent"));
    await ctl.save();
    expect(ctl.refresh().serverErrors.size).toBe(0);
    expect(ctl.message("device")?.text).toContain("nonexistent");
    expect(ctl.refresh().canSave).toBe(true);
  });

  it("busy is released when the send, the dialog or the drawing throws", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    ctl.edit("comment", "x");
    setSpy.mockRejectedValueOnce(new Error("boom"));
    await ctl.save();
    expect(ctl.busy).toBe(false);
    expect(ctl.message("device")?.level).toBe("error");

    ctl.edit("ssid", 3);
    const failing = new SettingsController({
      host,
      confirm: () => Promise.reject(new Error("dialog broke")),
      onChange: () => undefined,
    });
    failing.edit("ssid", 3);
    await failing.save();
    expect(failing.busy).toBe(false);
    expect(setSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ ssid: 3 }),
      expect.anything(),
    );
    failing.dispose();

    // The view's drawing throws on every change: the controller still finishes.
    const bad = new SettingsController({
      host,
      confirm: dialogs.confirm,
      onChange: () => {
        throw new Error("render broke");
      },
    });
    bad.edit("comment", "y");
    await bad.save();
    expect(bad.busy).toBe(false);
    expect(dev().comment).toBe("y");
    bad.dispose();
    expect(err).toHaveBeenCalled();
  });

  it("asks the view to draw when it changes", async () => {
    const before = renders;
    ctl.edit("comment", "z");
    expect(renders).toBeGreaterThan(before);
  });
});

// ---- a new connection starts clean (L6) ------------------------------------------------------

class FakeClient implements ControllerClient {
  state: ClientState = "ready";
  hello: ControllerClient["hello"] = { t: "hello", proto: 1, name: "PicoAPRS-0001", mode: "app" };
  schema: ControllerClient["schema"] = [
    { key: "callsign", type: "str", nullable: true, pattern: "^[A-Z0-9]{3,6}$" },
    { key: "ssid", type: "int", min: 0, max: 15 },
    { key: "comment", type: "str", max_len: 40 },
    { key: "tx_enabled", type: "bool" },
  ];
  settings: Record<string, string | number | boolean | null> = {
    callsign: "Q1TEST",
    ssid: 7,
    comment: "",
    tx_enabled: false,
  };
  settingsKnown = true;
  sent: unknown[] = [];
  resets = 0;
  requiredConfirmations(
    values: Record<string, unknown>,
  ): ReturnType<DeviceClient["requiredConfirmations"]> {
    const r: ReturnType<DeviceClient["requiredConfirmations"]> = [];
    if ("callsign" in values && values.callsign !== this.settings.callsign) r.push("callsign");
    if ("ssid" in values && values.ssid !== this.settings.ssid) r.push("ssid");
    if (values.tx_enabled === true && this.settings.tx_enabled !== true) r.push("tx_enable");
    return r;
  }
  setSettings(
    values: Record<string, unknown>,
    options?: { confirmed?: readonly string[] },
  ): ReturnType<DeviceClient["setSettings"]> {
    this.sent.push({ values, confirmed: options?.confirmed });
    return Promise.resolve({ t: "settings", values: { ...this.settings }, changed: [] });
  }
  resetSettings(): ReturnType<DeviceClient["resetSettings"]> {
    this.resets++;
    return Promise.resolve({ t: "settings", values: { ...this.settings }, changed: [] });
  }
  getSettings(): ReturnType<DeviceClient["getSettings"]> {
    return Promise.resolve({ t: "settings", values: { ...this.settings }, changed: [] });
  }
}

describe("SettingsController: a new connection never inherits edits", () => {
  let host: FakeHost;
  let dialogs: Dialogs;
  let a: FakeClient;
  let ctl: SettingsController;
  beforeEach(() => {
    host = new FakeHost();
    dialogs = new Dialogs();
    a = new FakeClient();
    host.client = a;
    ctl = new SettingsController({ host, confirm: dialogs.confirm, onChange: () => undefined });
  });
  afterEach(() => ctl.dispose());

  it("drops the draft when the state leaves ready and comes back", async () => {
    ctl.edit("tx_enabled", true);
    ctl.edit("callsign", "Q1NEW");
    expect(Object.keys(ctl.refresh().draft)).toHaveLength(2);
    a.state = "disconnected";
    host.notify();
    a.state = "ready";
    host.notify();
    expect(Object.keys(ctl.refresh().draft)).toHaveLength(0);
    // Save does nothing: there is nothing to send, and certainly nothing sent unconfirmed.
    await ctl.save();
    expect(a.sent).toEqual([]);
    expect(dialogs.shown).toEqual([]);
  });

  it("drops the draft even when nobody drew the tab in between", () => {
    ctl.edit("ssid", 3);
    host.stateOverride = "connecting";
    host.notify(); // the controller listens to the app by itself
    host.stateOverride = undefined;
    host.notify();
    expect(ctl.refresh().ev.dirty).toEqual([]);
  });

  it("drops the draft when another device (another hello) is connected through the same client", () => {
    ctl.edit("ssid", 3);
    a.hello = { t: "hello", proto: 1, name: "PicoAPRS-0002", mode: "app" };
    host.notify();
    expect(ctl.refresh().ev.dirty).toEqual([]);
  });

  it("drops the draft when the client is another instance", () => {
    ctl.edit("ssid", 3);
    const b = new FakeClient();
    host.client = b;
    host.notify();
    expect(ctl.refresh().ev.dirty).toEqual([]);
    ctl.edit("ssid", 4);
    expect(ctl.refresh().ev.dirty).toEqual(["ssid"]);
  });

  it("a draft that is still there while not ready cannot be saved, reset or edited further", async () => {
    // Same client, same hello, only the state is not ready (an error): the draft is kept for
    // display, but nothing can be sent until the connection is ready again (and then it is gone).
    ctl.edit("comment", "plain"); // needs no dialog at all: only the ready check keeps it back
    host.stateOverride = "error";
    host.notify();
    expect(Object.keys(ctl.refresh().draft)).toEqual(["comment"]);
    ctl.edit("ssid", 3);
    expect(Object.keys(ctl.refresh().draft)).toEqual(["comment"]);
    await ctl.save();
    await ctl.reset();
    await ctl.reload();
    ctl.revert();
    expect(dialogs.shown).toEqual([]);
    expect(a.sent).toEqual([]);
    expect(a.resets).toBe(0);
    expect(ctl.message("device")).toBeUndefined();
    expect(ctl.message("reset")).toBeUndefined();
    expect(Object.keys(ctl.refresh().draft)).toEqual(["comment"]);
  });

  it("leaving ready (same client, same hello) closes an open dialog", async () => {
    ctl.edit("ssid", 3);
    const p = ctl.save();
    await tick();
    const d = dialogs.last();
    host.stateOverride = "error";
    host.notify();
    expect(d.signal.aborted).toBe(true);
    await p;
    expect(a.sent).toEqual([]);
  });

  it("a dialog that ignores the abort signal and says yes late still sends nothing", async () => {
    const answers: ((yes: boolean) => void)[] = [];
    const stubborn = new SettingsController({
      host,
      confirm: () => new Promise<boolean>((resolve) => answers.push(resolve)),
      onChange: () => undefined,
    });
    stubborn.edit("ssid", 3);
    const p = stubborn.save();
    await tick();
    expect(answers).toHaveLength(1);
    host.stateOverride = "error";
    host.notify();
    answers[0]?.(true);
    await p;
    expect(a.sent).toEqual([]);
    // Same for Reset.
    host.stateOverride = undefined;
    host.notify();
    const q = stubborn.reset();
    await tick();
    host.stateOverride = "error";
    host.notify();
    answers[1]?.(true);
    await q;
    expect(a.resets).toBe(0);
    stubborn.dispose();
  });

  it("closes an open dialog when the client is replaced and sends nothing to either", async () => {
    ctl.edit("tx_enabled", true);
    const p = ctl.save();
    await tick();
    const d = dialogs.last();
    const b = new FakeClient();
    host.client = b;
    host.notify();
    expect(d.signal.aborted).toBe(true);
    await p;
    expect(a.sent).toEqual([]);
    expect(b.sent).toEqual([]);
    expect(ctl.busy).toBe(false);
  });

  it("an old save finishing late does not touch the new connection's form", async () => {
    ctl.edit("comment", "x");
    // The send hangs until we let it finish.
    let finish: (() => void) | undefined;
    a.setSettings = (v, o) => {
      a.sent.push({ v, o });
      return new Promise((resolve) => {
        finish = () => resolve({ t: "settings", values: {}, changed: ["comment"] });
      });
    };
    const p = ctl.save();
    await tick();
    expect(ctl.busy).toBe(true);
    const b = new FakeClient();
    host.client = b;
    host.notify();
    expect(ctl.busy).toBe(false); // the new connection is usable at once
    b.settings.comment = "mine";
    ctl.edit("comment", "new edit");
    finish?.();
    await p;
    expect(ctl.message("device")).toBeUndefined();
    expect(Object.keys(ctl.refresh().draft)).toEqual(["comment"]); // the new edit is intact
  });
});

describe("SettingsController: a dialog is never skipped by a missing field", () => {
  it("a Save with a schema that has a hostile key still works for the others", async () => {
    const host = new FakeHost();
    const c = new FakeClient();
    c.schema = [
      ...c.schema,
      { key: "constructor", type: "str" },
      { key: "__proto__", type: "int" },
    ];
    host.client = c;
    const dialogs = new Dialogs();
    const ctl = new SettingsController({
      host,
      confirm: dialogs.confirm,
      onChange: () => undefined,
    });
    ctl.edit("constructor", "x");
    ctl.edit("ssid", 3);
    const p = ctl.save();
    await tick();
    expect(dialogs.titles).toEqual(["Change the SSID?"]);
    dialogs.last().answer(true);
    await p;
    expect(c.sent).toHaveLength(1);
    ctl.dispose();
  });
});
