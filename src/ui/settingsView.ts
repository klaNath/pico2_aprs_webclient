// The Settings tab: the device's settings (built from `settings.schema`), then the settings of
// this app, then About.
//
// This file only draws. What is edited, saved and reset (and every confirmation dialog) is in
// settingsController.ts / settingsForm.ts, which have no DOM and are tested in node: the buttons
// here call `controller.save()` and `controller.reset()` and nothing else can send to the device.
//
// Transmit safety (CLAUDE.md): nothing is sent until Save is pressed. A change of callsign or SSID
// or turning tx_enabled on is confirmed in a dialog first (executeSave), and Reset to defaults is
// confirmed in a danger dialog (executeReset). Nothing is sent on a keystroke.
//
// While the app is not connected the device's form is read-only (and shown only when there are
// values to show); App preferences and About keep working.
//
// Rendering: the form is built once per connection (and again only when the schema changes).
// `render()` only updates what it must, and a field is never overwritten while the user is
// editing it, so the status that arrives every 5 seconds cannot erase typed text. The schema comes
// from the device and is not trusted: one item that cannot be drawn becomes a "Cannot show this
// item" row and the rest of the screen works.

import "./settings.css";
import { PROTO_VERSION } from "../protocol/types.ts";
import type { SchemaItem } from "../protocol/types.ts";
import { LOG_LIMIT_MAX, LOG_LIMIT_MIN } from "../store/prefs.ts";
import type { Theme } from "../store/prefs.ts";
import type { App } from "../store/state.ts";
import { confirmDialog } from "./dialog.ts";
import { h, setChildren, setText } from "./dom.ts";
import { SettingsController } from "./settingsController.ts";
import type { FormModel, Slot } from "./settingsController.ts";
import { getOwn, groupItems, hasOwn } from "./settingsForm.ts";
import type { View } from "./view.ts";
import { createField } from "./widgets/field.ts";
import type { FieldWidget } from "./widgets/types.ts";

/** A row for an item that could not be drawn (a broken schema item from the device). */
function brokenRow(item: SchemaItem): HTMLElement {
  return h(
    "div",
    { class: "field sf-field sf-broken" },
    h("code", { class: "sf-key", text: String(item.key) }),
    h("div", { class: "muted", text: "Cannot show this item" }),
  );
}

export function createSettingsView(app: App): View {
  // ---- state ---------------------------------------------------------------------------
  let builtSchema: SchemaItem[] | undefined;
  let builtClient: unknown;
  let fields = new Map<string, FieldWidget>();
  /** Items whose widget failed to update: they are shown as "Cannot show this item". */
  const broken = new Set<string>();
  const controller = new SettingsController({
    host: app,
    confirm: confirmDialog,
    onChange: () => view.render(),
  });

  // ---- elements ------------------------------------------------------------------------
  // Messages sit next to the buttons that cause them: the Save bar stays on screen while the form
  // is scrolled, and the reset message is in the reset card.
  const deviceMsg = h("p", { class: "sf-msg", hidden: true });
  const resetMsg = h("p", { class: "sf-msg", hidden: true });

  const readOnlyBanner = h("p", {
    class: "sf-readonly-banner",
    text: "Read-only: not connected",
    attrs: { role: "status" },
    hidden: true,
  });
  const guide = h("p", { class: "muted" });
  const unknownText = h("p");
  const unknownReload = h("button", {
    class: "btn",
    text: "Reload from device",
    attrs: { type: "button" },
    on: { click: () => void controller.reload() },
  });
  const unknownBox = h("div", { class: "sf-warn", hidden: true }, unknownText, unknownReload);
  const groups = h("div", { class: "sf-device" });

  const summary = h("div", { class: "sf-summary muted", attrs: { "aria-live": "polite" } });
  const saveBtn = h("button", {
    class: "btn btn-primary",
    text: "Save",
    attrs: { type: "button" },
    on: { click: () => void controller.save() },
  });
  const revertBtn = h("button", {
    class: "btn",
    text: "Revert",
    attrs: { type: "button" },
    on: { click: () => controller.revert() },
  });
  const reloadBtn = h("button", {
    class: "btn",
    text: "Reload from device",
    attrs: { type: "button" },
    on: { click: () => void controller.reload() },
  });
  const buttons = h("div", { class: "row" }, saveBtn, revertBtn, reloadBtn);
  const actions = h("div", { class: "sf-actions" }, deviceMsg, summary, buttons);

  const device = h("div", { class: "sf-device" }, guide, unknownBox, groups, actions);

  const resetBtn = h("button", {
    class: "btn btn-danger",
    text: "Reset to defaults",
    attrs: { type: "button" },
    on: { click: () => void controller.reset() },
  });
  const resetNote = h("p", {
    class: "muted",
    text: "Read-only: not connected. Reset is available while connected to a tracker.",
    hidden: true,
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
    resetNote,
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
      readOnlyBanner,
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

  // ---- building and updating ---------------------------------------------------------------

  /** Build the form again when the connection or its schema is not the one built for. */
  function ensureBuilt(): void {
    const client = app.client;
    const schema = client?.schema;
    if (client === builtClient && schema === builtSchema) return;
    builtClient = client;
    builtSchema = schema;
    fields = new Map();
    broken.clear();
    const parts: Node[] = [];
    for (const g of groupItems(schema ?? [])) {
      const card = h("div", { class: "card sf-card" }, h("h3", { text: g.title }));
      for (const item of g.items) {
        try {
          const f = createField(item, (key, value) => controller.edit(key, value));
          fields.set(item.key, f);
          card.append(f.el);
        } catch (e) {
          console.error("settings: cannot draw item", item.key, e);
          card.append(brokenRow(item));
        }
      }
      parts.push(card);
    }
    setChildren(groups, ...parts);
    controller.forceRewrite();
  }

  function renderMessage(el: HTMLElement, slot: Slot): void {
    const live = controller.message(slot);
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

  function summaryText(m: FormModel, errs: number): string {
    if (m.readOnly) return "Read-only: not connected.";
    if (m.busy) return "Talking to the device…";
    if (!m.known) return "Reload from the device before saving.";
    if (errs > 0) return "Fix the highlighted items to save.";
    const n = m.ev.dirty.length;
    if (n === 0) return "No changes.";
    const also = m.deviceChanged.size > 0 ? " (some items also changed on the device)" : "";
    return `${n} unsaved change${n === 1 ? "" : "s"}${also}.`;
  }

  function renderDevice(): void {
    ensureBuilt();
    const m = controller.refresh();
    const hasForm = m.hasForm;

    readOnlyBanner.hidden = m.ready;
    resetNote.hidden = m.ready;
    guide.hidden = hasForm;
    if (!m.ready) {
      setText(guide, "Not connected. Connect to a tracker to see its settings.");
    } else if (m.schema.length === 0) {
      setText(guide, "The device did not send a list of settings, so there is nothing to edit.");
    }
    groups.hidden = !hasForm;
    summary.hidden = !hasForm;
    buttons.hidden = !hasForm;
    actions.hidden = !hasForm && deviceMsg.hidden;
    resetBtn.disabled = !m.canReset;
    unknownBox.hidden = !(m.ready && !m.known);
    if (m.ready && !m.known) {
      setText(
        unknownText,
        "The settings on the device are not known right now (a save may not have finished). Reload them before saving.",
      );
    }
    unknownReload.disabled = !m.canReload;
    if (!hasForm) return;

    const force = controller.consumeForce();
    const locked = m.busy || m.readOnly;
    for (const item of m.schema) {
      const key = item.key;
      const f = fields.get(key);
      if (!f || broken.has(key)) continue;
      const edited = hasOwn(m.draft, key);
      try {
        f.update(
          {
            value: edited ? m.draft[key] : getOwn(m.current, key),
            // An error from the device is shown even for an item that is not being edited.
            error: getOwn(m.ev.errors, key) ?? m.serverErrors.get(key),
            dirty: m.ev.dirty.includes(key),
            disabled: locked,
            changedOnDevice: edited && m.deviceChanged.has(key),
          },
          force,
        );
      } catch (e) {
        console.error("settings: cannot update item", key, e);
        broken.add(key);
        f.el.replaceChildren(brokenRow(item));
      }
    }

    const blocking = [...m.serverErrors.keys()].filter((k) => hasOwn(m.draft, k)).length;
    const errs = Object.keys(m.ev.errors).length + blocking;
    saveBtn.disabled = !m.canSave;
    revertBtn.disabled = !m.canRevert;
    reloadBtn.disabled = !m.canReload;
    saveBtn.textContent = m.busy ? "Saving…" : "Save";
    setText(summary, summaryText(m, errs));
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
      controller.sync(); // a new connection drops old messages before they are drawn
      // Each part on its own: a failure in the device's form must not take the preferences down.
      for (const part of [renderMessages, renderDevice, renderPrefs, renderAbout]) {
        try {
          part();
        } catch (e) {
          console.error("settings: drawing failed", e);
        }
      }
    },
  };
  return view;
}
