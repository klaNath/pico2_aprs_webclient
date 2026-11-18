// The Settings tab: the device's settings (built from `settings.schema`), then the settings of
// this app, then About.
//
// Transmit safety (CLAUDE.md): nothing is sent until Save is pressed. A change of callsign or
// turning tx_enabled on is confirmed in a dialog first (executeSave), and Reset to defaults is
// confirmed in a danger dialog. Nothing is sent on a keystroke.
//
// Rendering: the form is built once per connection (and again only when the schema changes).
// `render()` only updates what it must, and a field is never overwritten while the user is
// editing it, so the status that arrives every 5 seconds cannot erase typed text.

import "./settings.css";
import type { DeviceClient } from "../client/deviceClient.ts";
import { PROTO_VERSION } from "../protocol/types.ts";
import type { SchemaItem, SettingsValues } from "../protocol/types.ts";
import { LOG_LIMIT_MAX, LOG_LIMIT_MIN } from "../store/prefs.ts";
import type { Theme } from "../store/prefs.ts";
import type { App } from "../store/state.ts";
import { confirmDialog } from "./dialog.ts";
import { h, setChildren, setText } from "./dom.ts";
import {
  describeError,
  deviceChangedKeys,
  evaluateForm,
  executeSave,
  fullCall,
  groupItems,
  resetConfirmation,
  savedMessage,
  setDraft,
} from "./settingsForm.ts";
import type { Draft } from "./settingsForm.ts";
import type { View } from "./view.ts";
import { createField } from "./widgets/field.ts";
import type { FieldWidget } from "./widgets/types.ts";

interface Message {
  level: "ok" | "error" | "info";
  text: string;
  /** Date.now() after which the message is hidden. */
  until?: number;
}

const SAVED_MS = 8000;

type Slot = "device" | "reset";

export function createSettingsView(app: App): View {
  // ---- state ---------------------------------------------------------------------------
  let draft: Draft = {};
  /** Messages from the device about one item ("invalid"), cleared when that item is edited. */
  let serverErrors: Record<string, string> = {};
  /** Edited items whose device value changed meanwhile. */
  const deviceChanged = new Set<string>();
  let prevCurrent: SettingsValues = {};
  let busy = false;
  const messages: Record<Slot, Message | undefined> = { device: undefined, reset: undefined };
  let forceNext = false;
  let builtClient: DeviceClient | undefined;
  let builtSchema: SchemaItem[] | undefined;
  let fields = new Map<string, FieldWidget>();

  // ---- elements ------------------------------------------------------------------------
  // Messages sit next to the buttons that cause them: the Save bar stays on screen while the form
  // is scrolled, and the reset message is in the reset card.
  const deviceMsg = h("p", { class: "sf-msg", hidden: true });
  const resetMsg = h("p", { class: "sf-msg", hidden: true });

  const guide = h("p", { class: "muted" });
  const unknownText = h("p");
  const unknownReload = h("button", {
    class: "btn",
    text: "Reload from device",
    attrs: { type: "button" },
    on: { click: () => void reload() },
  });
  const unknownBox = h("div", { class: "sf-warn", hidden: true }, unknownText, unknownReload);
  const groups = h("div", { class: "sf-device" });

  const summary = h("div", { class: "sf-summary muted", attrs: { "aria-live": "polite" } });
  const saveBtn = h("button", {
    class: "btn btn-primary",
    text: "Save",
    attrs: { type: "button" },
    on: { click: () => void save() },
  });
  const revertBtn = h("button", {
    class: "btn",
    text: "Revert",
    attrs: { type: "button" },
    on: { click: revert },
  });
  const reloadBtn = h("button", {
    class: "btn",
    text: "Reload from device",
    attrs: { type: "button" },
    on: { click: () => void reload() },
  });
  const buttons = h("div", { class: "row" }, saveBtn, revertBtn, reloadBtn);
  const actions = h("div", { class: "sf-actions" }, deviceMsg, summary, buttons);

  const device = h("div", { class: "sf-device" }, guide, unknownBox, groups, actions);

  const resetBtn = h("button", {
    class: "btn btn-danger",
    text: "Reset to defaults",
    attrs: { type: "button" },
    on: { click: () => void reset() },
  });
  const resetCard = h(
    "div",
    { class: "card sf-card sf-danger" },
    h("h2", { text: "Reset" }),
    h("p", {
      class: "muted",
      text: "Delete all saved settings on the device and go back to the defaults written in its firmware. This can change the callsign and the transmit permission.",
    }),
    h("div", { class: "row" }, resetBtn),
    resetMsg,
  );

  // App preferences (this device only).
  const themeSel = h(
    "select",
    { id: "pref-theme" },
    h("option", { text: "Follow the system", attrs: { value: "auto" } }),
    h("option", { text: "Light", attrs: { value: "light" } }),
    h("option", { text: "Dark", attrs: { value: "dark" } }),
  );
  themeSel.addEventListener("change", () => {
    app.prefs.set("theme", themeSel.value as Theme);
  });
  const limitInput = h("input", {
    id: "pref-limit",
    attrs: {
      type: "number",
      inputmode: "numeric",
      step: "1",
      min: String(LOG_LIMIT_MIN),
      max: String(LOG_LIMIT_MAX),
    },
  });
  const limitError = h("div", { class: "error", attrs: { role: "alert" }, hidden: true });
  limitInput.addEventListener("change", () => {
    const n = Number(limitInput.value);
    if (limitInput.value.trim() === "" || !Number.isFinite(n)) {
      limitError.hidden = false;
      setText(limitError, `Enter a number from ${LOG_LIMIT_MIN} to ${LOG_LIMIT_MAX}.`);
      return;
    }
    limitError.hidden = true;
    app.prefs.set("logLimit", n); // clamped by the store
    limitInput.value = String(app.prefs.get("logLimit"));
  });
  const prefsCard = h(
    "div",
    { class: "card sf-card" },
    h("h2", { text: "App preferences" }),
    h("p", {
      class: "muted",
      text: "These are kept on this device only and are never sent to the tracker. They apply immediately.",
    }),
    h(
      "div",
      { class: "field sf-pref" },
      h("label", { text: "Theme", attrs: { for: "pref-theme" } }),
      themeSel,
    ),
    h(
      "div",
      { class: "field sf-pref" },
      h("label", { text: "Feed history", attrs: { for: "pref-limit" } }),
      limitInput,
      h("div", {
        class: "hint",
        text: `Keep the newest received and sent packets in memory, from ${LOG_LIMIT_MIN} to ${LOG_LIMIT_MAX}. Older ones are dropped.`,
      }),
      limitError,
    ),
  );

  // About.
  const aboutDl = h("dl", { class: "kv" });
  const aboutDemo = h("p", { class: "note card", hidden: true });
  const aboutCard = h(
    "div",
    { class: "card sf-card sf-about" },
    h("h2", { text: "About" }),
    aboutDemo,
    aboutDl,
    h("p", {
      class: "muted",
      text: "This app speaks the pico2_aprs BLE protocol, spec v0.3 (proto 1). It runs entirely in this browser; nothing is sent to a server.",
    }),
  );

  const el = h(
    "section",
    { class: "view sf" },
    h(
      "div",
      { class: "card sf-card" },
      h("h2", { text: "Device settings" }),
      h("p", {
        class: "muted",
        text: "Edit the values, then press Save. Nothing is sent to the tracker until you do.",
      }),
    ),
    device,
    resetCard,
    prefsCard,
    aboutCard,
  );

  // ---- actions -------------------------------------------------------------------------

  function setMessage(m: Message | undefined, slot: Slot = "device"): void {
    messages[slot] = m;
  }

  function setBusy(b: boolean): void {
    busy = b;
    view.render();
  }

  function onEdit(key: string, value: unknown): void {
    const client = app.client;
    if (!client || busy) return;
    draft = setDraft(draft, client.settings, key, value);
    delete serverErrors[key];
    if (!(key in draft)) deviceChanged.delete(key);
    setMessage(undefined);
    view.render();
  }

  function clearEdits(): void {
    draft = {};
    serverErrors = {};
    deviceChanged.clear();
    forceNext = true;
  }

  function revert(): void {
    if (busy) return;
    clearEdits();
    setMessage({
      level: "info",
      text: "Reverted to the values on the device.",
      until: Date.now() + 4000,
    });
    view.render();
  }

  /** Show an error from the client: under the item it names, or at the top. */
  function showError(e: unknown, slot: Slot = "device"): void {
    const d = describeError(e);
    if (d.key && fields.has(d.key) && slot === "device") {
      serverErrors[d.key] = d.text;
      setMessage({ level: "error", text: "Not saved. Check the highlighted item." });
    } else {
      setMessage({ level: "error", text: d.text }, slot);
    }
  }

  async function save(): Promise<void> {
    const client = app.client;
    if (!client || busy || client.state !== "ready" || !client.settingsKnown) return;
    const ev = evaluateForm(client.schema, client.settings, draft);
    if (!ev.canSave) return;
    setMessage(undefined);
    setBusy(true);
    try {
      const out = await executeSave(client, ev.changes, confirmDialog);
      switch (out.kind) {
        case "saved":
          clearEdits();
          setMessage({
            level: "ok",
            text: savedMessage(out.result.changed, client.schema),
            until: Date.now() + SAVED_MS,
          });
          break;
        case "cancelled":
          setMessage({ level: "info", text: "Cancelled. Nothing was sent to the device." });
          break;
        case "stale":
          setMessage({
            level: "error",
            text: "The device's settings changed while you were confirming. Nothing was sent. Check the form and press Save again.",
          });
          break;
      }
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  }

  async function reload(): Promise<void> {
    const client = app.client;
    if (!client || busy || client.state !== "ready") return;
    setMessage(undefined);
    serverErrors = {};
    setBusy(true);
    try {
      await client.getSettings();
      forceNext = Object.keys(draft).length === 0;
      setMessage({
        level: "info",
        text: "Loaded the settings from the device.",
        until: Date.now() + 4000,
      });
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  }

  async function reset(): Promise<void> {
    const client = app.client;
    if (!client || busy || client.state !== "ready") return;
    const ev = evaluateForm(client.schema, client.settings, draft);
    setMessage(undefined, "reset");
    setBusy(true);
    try {
      const ok = await confirmDialog(
        resetConfirmation(client.settings, client.settingsKnown, ev.dirty.length > 0),
      );
      if (!ok) {
        setMessage({ level: "info", text: "Cancelled. Nothing was changed." }, "reset");
        return;
      }
      const res = await client.resetSettings({ confirmed: true });
      clearEdits();
      const call = fullCall(res.values.callsign, res.values.ssid);
      const tx = res.values.tx_enabled === true;
      setMessage(
        {
          level: tx ? "error" : "ok",
          text: `Reset to defaults. Callsign: ${call ?? "not set"}. Transmit is ${tx ? "ENABLED" : "disabled"} (the beacon switch must still be on).`,
          until: Date.now() + SAVED_MS * 2,
        },
        "reset",
      );
    } catch (e) {
      showError(e, "reset");
    } finally {
      setBusy(false);
    }
  }

  // ---- building and updating ---------------------------------------------------------------

  /** Build the form again when the connection or its schema is not the one built for. */
  function ensureBuilt(client: DeviceClient | undefined): void {
    const schema = client?.schema;
    if (client === builtClient && schema === builtSchema) return;
    if (client !== builtClient) {
      draft = {};
      serverErrors = {};
      deviceChanged.clear();
      prevCurrent = structuredClone(client?.settings ?? {});
      setMessage(undefined);
      setMessage(undefined, "reset");
    }
    builtClient = client;
    builtSchema = schema;
    fields = new Map();
    const parts: Node[] = [];
    for (const g of groupItems(schema ?? [])) {
      const card = h("div", { class: "card sf-card" }, h("h3", { text: g.title }));
      for (const item of g.items) {
        const f = createField(item, onEdit);
        fields.set(item.key, f);
        card.append(f.el);
      }
      parts.push(card);
    }
    setChildren(groups, ...parts);
    forceNext = true;
  }

  function renderMessage(el: HTMLElement, slot: Slot): void {
    const m = messages[slot];
    const live = m && (m.until === undefined || Date.now() < m.until) ? m : undefined;
    el.hidden = !live;
    if (!live) return;
    el.className = `sf-msg sf-msg-${live.level}`;
    el.setAttribute("role", live.level === "error" ? "alert" : "status");
    setText(el, live.text);
  }

  function renderMessages(): void {
    renderMessage(deviceMsg, "device");
    renderMessage(resetMsg, "reset");
  }

  function renderDevice(): void {
    const client = app.client;
    ensureBuilt(client);
    const connected = client?.state === "ready";
    const schema = client?.schema ?? [];
    const hasForm = connected && schema.length > 0;
    const current = client?.settings ?? {};
    const known = client?.settingsKnown ?? false;

    guide.hidden = hasForm;
    if (!client || !connected)
      setText(guide, "Not connected. Connect to a tracker to see its settings.");
    else if (schema.length === 0) {
      setText(guide, "The device did not send a list of settings, so there is nothing to edit.");
    }
    groups.hidden = !hasForm;
    summary.hidden = !hasForm;
    buttons.hidden = !hasForm;
    actions.hidden = !hasForm && deviceMsg.hidden;
    resetBtn.disabled = !connected || busy;
    unknownBox.hidden = !(connected && !known);
    if (connected && !known) {
      setText(
        unknownText,
        "The settings on the device are not known right now (a save may not have finished). Reload them before saving.",
      );
    }
    unknownReload.disabled = busy;
    if (!hasForm) return;

    // Edited items that the device has changed under the user: keep the edit, say so.
    for (const k of deviceChangedKeys(prevCurrent, current, draft)) deviceChanged.add(k);
    prevCurrent = structuredClone(current);

    const ev = evaluateForm(schema, current, draft);
    const force = forceNext;
    forceNext = false;
    const locked = busy;
    for (const item of schema) {
      const f = fields.get(item.key);
      if (!f) continue;
      const edited = item.key in draft;
      f.update(
        {
          value: edited ? draft[item.key] : current[item.key],
          error: edited ? (ev.errors[item.key] ?? serverErrors[item.key]) : undefined,
          dirty: ev.dirty.includes(item.key),
          disabled: locked,
          changedOnDevice: edited && deviceChanged.has(item.key),
        },
        force,
      );
    }

    const n = ev.dirty.length;
    const errs = Object.keys(ev.errors).length + Object.keys(serverErrors).length;
    saveBtn.disabled = busy || !ev.canSave || !known || Object.keys(serverErrors).length > 0;
    revertBtn.disabled = busy || Object.keys(draft).length === 0;
    reloadBtn.disabled = busy;
    saveBtn.textContent = busy ? "Saving…" : "Save";
    setText(
      summary,
      busy
        ? "Talking to the device…"
        : !known
          ? "Reload from the device before saving."
          : errs > 0
            ? "Fix the highlighted items to save."
            : n > 0
              ? `${n} unsaved change${n === 1 ? "" : "s"}${deviceChanged.size > 0 ? " (some items also changed on the device)" : ""}.`
              : "No changes.",
    );
  }

  function renderAbout(): void {
    const client = app.client;
    const hello = client?.hello;
    aboutDemo.hidden = !app.mock;
    if (app.mock) {
      setText(
        aboutDemo,
        "Demo mode: this is a simulated tracker inside the app. Nothing is sent over Bluetooth or on the air.",
      );
    }
    const row = (k: string, v: string): HTMLElement[] => [
      h("dt", { text: k }),
      h("dd", { text: v }),
    ];
    setChildren(
      aboutDl,
      ...row("Device", hello ? (hello.name ?? "unnamed") : "not connected"),
      ...row("Mode", hello?.mode ?? "—"),
      ...row("Protocol", hello ? `proto ${hello.proto}` : "—"),
      ...row("App supports", `proto ${PROTO_VERSION}, spec v0.3`),
    );
  }

  function renderPrefs(): void {
    themeSel.value = app.prefs.get("theme");
    if (document.activeElement !== limitInput) {
      limitInput.value = String(app.prefs.get("logLimit"));
    }
  }

  const view: View = {
    el,
    render(): void {
      renderMessages();
      renderDevice();
      renderPrefs();
      renderAbout();
    },
  };
  return view;
}
