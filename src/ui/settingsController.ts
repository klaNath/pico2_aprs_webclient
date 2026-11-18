// The logic of the Settings tab for the device's settings, without any DOM: the edits (draft),
// busy, messages, errors from the device, and the Save / Reset / Reload actions. The view
// (settingsView.ts) only draws what `refresh()` returns and forwards clicks, so everything that
// decides whether something is SENT can be tested in node.
//
// Transmit safety (CLAUDE.md). There is exactly one place where a settings.set is sent (`save`,
// through `executeSave`) and one where a settings.reset is sent (`reset`, through `executeReset`).
// Both ask the user first, and both are given only a confirm function that
//  - shows nothing and answers "no" once the connection is gone or the operation was dropped,
//  - answers "no" when the dialog was closed because the connection was lost.
// The confirmations are decided again at every Save from the device's values at that moment, so
// an edit that survived a disconnect (it does not: see `resetSession`) could not skip a dialog.
//
// Read-only: unless the client is `ready` nothing can be edited or sent. A new connection (another
// client, another hello, or ready again after having left it) starts with an empty draft.

import type { ClientState, DeviceClient } from "../client/deviceClient.ts";
import type { SchemaItem, SettingsValues } from "../protocol/types.ts";
import type { ConfirmOptions } from "./dialog.ts";
import {
  describeError,
  deviceChangedKeys,
  emptyDraft,
  evaluateForm,
  executeReset,
  executeSave,
  fullCall,
  hasOwn,
  savedMessage,
  setDraft,
  uniqueItems,
} from "./settingsForm.ts";
import type { Draft, FormEval } from "./settingsForm.ts";

/** What the controller uses of a client (a DeviceClient, or a fake in tests). */
export type ControllerClient = Pick<
  DeviceClient,
  | "state"
  | "hello"
  | "schema"
  | "settings"
  | "settingsKnown"
  | "requiredConfirmations"
  | "setSettings"
  | "resetSettings"
  | "getSettings"
>;

/** What the controller uses of the App. */
export interface ControllerHost {
  readonly client: ControllerClient | undefined;
  readonly state: ClientState;
  onChange(cb: () => void): () => void;
}

export interface ControllerDeps {
  host: ControllerHost;
  /** Show a dialog; resolves false when `signal` is aborted. */
  confirm: (opts: ConfirmOptions, signal: AbortSignal) => Promise<boolean>;
  /** Something changed: draw again. */
  onChange: () => void;
  now?: () => number;
}

export interface Message {
  level: "ok" | "error" | "info";
  text: string;
  /** Date.now() after which the message is hidden. */
  until?: number;
}

export type Slot = "device" | "reset";

const SAVED_MS = 8000;

/** One Save, Reset or Reload in progress. */
interface Op {
  abort: AbortController;
}

/** What the view draws. */
export interface FormModel {
  /** The client is ready: the form can be edited and sent. */
  ready: boolean;
  /** Not ready: the values may be shown, nothing can be changed. */
  readOnly: boolean;
  busy: boolean;
  schema: readonly SchemaItem[];
  current: Readonly<SettingsValues>;
  /** The device's values are known (no save is in doubt). */
  known: boolean;
  /** The form is shown (there is a schema and values to show). */
  hasForm: boolean;
  ev: FormEval;
  draft: Draft;
  /** Messages from the device about one item, by key. */
  serverErrors: ReadonlyMap<string, string>;
  /** Edited items whose device value changed meanwhile. */
  deviceChanged: ReadonlySet<string>;
  canSave: boolean;
  canRevert: boolean;
  canReload: boolean;
  canReset: boolean;
}

export class SettingsController {
  private draft: Draft = emptyDraft();
  private readonly serverErrors = new Map<string, string>();
  private readonly deviceChanged = new Set<string>();
  private prevCurrent: SettingsValues = {};
  private readonly messages: Record<Slot, Message | undefined> = {
    device: undefined,
    reset: undefined,
  };
  private forceNext = false;
  private activeOp: Op | undefined;

  // What the last sync saw, to notice a new connection.
  private seenClient: ControllerClient | undefined;
  private seenHello: unknown;
  private wasReady = false;

  private readonly off: () => void;
  private readonly now: () => number;

  private readonly deps: ControllerDeps;

  constructor(deps: ControllerDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.sync();
    // The Settings tab is not drawn while another screen is shown (for example the connect
    // screen after a disconnect), so the controller watches the app itself.
    this.off = deps.host.onChange(() => this.sync());
  }

  dispose(): void {
    this.off();
    this.activeOp?.abort.abort();
    this.activeOp = undefined;
  }

  // ---- connection tracking -------------------------------------------------------------------

  private get client(): ControllerClient | undefined {
    return this.deps.host.client;
  }

  /** The client when it is ready to be used, otherwise undefined. */
  private readyClient(): ControllerClient | undefined {
    const c = this.client;
    return c !== undefined && this.deps.host.state === "ready" && c.state === "ready"
      ? c
      : undefined;
  }

  get busy(): boolean {
    return this.activeOp !== undefined;
  }

  /**
   * Notice a change of connection. Called by the app's change events and at every refresh.
   * - Leaving `ready` (disconnect, error): a dialog that is open is closed (answer: no).
   * - Another client, another hello, or `ready` again after having left it: the draft and
   *   everything that belongs to the old connection is dropped.
   */
  sync(): void {
    const client = this.client;
    const ready = this.readyClient() !== undefined;
    const hello = client?.hello;
    const newSession =
      client !== this.seenClient || hello !== this.seenHello || (ready && !this.wasReady);
    this.seenClient = client;
    this.seenHello = hello;
    this.wasReady = ready;
    if (newSession) this.resetSession(client);
    else if (!ready) this.activeOp?.abort.abort();
  }

  private resetSession(client: ControllerClient | undefined): void {
    // Whatever is in progress belongs to the old connection: close its dialog, ignore its result.
    this.activeOp?.abort.abort();
    this.activeOp = undefined;
    this.draft = emptyDraft();
    this.serverErrors.clear();
    this.deviceChanged.clear();
    this.prevCurrent = structuredClone(client?.settings ?? {});
    this.messages.device = undefined;
    this.messages.reset = undefined;
    this.forceNext = true;
  }

  private changed(): void {
    try {
      this.deps.onChange();
    } catch (e) {
      console.error("settings: drawing failed", e);
    }
  }

  // ---- what to draw --------------------------------------------------------------------------

  /** Sync, then work out what the view shows. Call once per render. */
  refresh(): FormModel {
    this.sync();
    const client = this.client;
    const ready = this.readyClient() !== undefined;
    const schema = uniqueItems(client?.schema ?? []);
    const current = client?.settings ?? {};
    const known = client?.settingsKnown ?? false;
    if (ready) {
      // Edited items that the device has changed under the user: keep the edit, say so.
      for (const k of deviceChangedKeys(this.prevCurrent, current, this.draft)) {
        this.deviceChanged.add(k);
      }
      this.prevCurrent = structuredClone(current);
    }
    const ev = evaluateForm(schema, current, this.draft);
    const busy = this.busy;
    return {
      ready,
      readOnly: !ready,
      busy,
      schema,
      current,
      known,
      hasForm: schema.length > 0 && (ready || known),
      ev,
      draft: this.draft,
      serverErrors: this.serverErrors,
      deviceChanged: this.deviceChanged,
      canSave: ready && !busy && known && ev.canSave && this.blockingServerErrors().length === 0,
      canRevert: ready && !busy && Object.keys(this.draft).length > 0,
      canReload: ready && !busy,
      canReset: ready && !busy,
    };
  }

  /** True once after the form must be written from the device's values (new form, revert, save). */
  consumeForce(): boolean {
    const f = this.forceNext;
    this.forceNext = false;
    return f;
  }

  /** Ask for the next render to rewrite the inputs (the form was built again). */
  forceRewrite(): void {
    this.forceNext = true;
  }

  message(slot: Slot): Message | undefined {
    const m = this.messages[slot];
    return m && (m.until === undefined || this.now() < m.until) ? m : undefined;
  }

  private setMessage(m: Message | undefined, slot: Slot = "device"): void {
    this.messages[slot] = m;
  }

  /** Errors from the device about an item that is still in the draft: they block Save. */
  private blockingServerErrors(): string[] {
    return [...this.serverErrors.keys()].filter((k) => hasOwn(this.draft, k));
  }

  // ---- edits ---------------------------------------------------------------------------------

  edit(key: string, value: unknown): void {
    const client = this.readyClient();
    if (!client || this.busy || !client.schema.some((i) => i.key === key)) return;
    this.draft = setDraft(this.draft, client.settings, key, value);
    // The device's complaint about this item is answered by the edit. A complaint about an item
    // that is not being edited cannot block anything and is only a note: drop it too.
    this.serverErrors.delete(key);
    for (const k of [...this.serverErrors.keys()]) {
      if (!hasOwn(this.draft, k)) this.serverErrors.delete(k);
    }
    if (!hasOwn(this.draft, key)) this.deviceChanged.delete(key);
    this.setMessage(undefined);
    this.changed();
  }

  private clearEdits(): void {
    this.draft = emptyDraft();
    this.serverErrors.clear();
    this.deviceChanged.clear();
    this.forceNext = true;
  }

  revert(): void {
    if (!this.readyClient() || this.busy) return;
    this.clearEdits();
    this.setMessage({
      level: "info",
      text: "Reverted to the values on the device.",
      until: this.now() + 4000,
    });
    this.changed();
  }

  // ---- operations ----------------------------------------------------------------------------

  private begin(): Op {
    const op: Op = { abort: new AbortController() };
    this.activeOp = op;
    this.changed();
    return op;
  }

  private end(op: Op): void {
    if (this.activeOp === op) this.activeOp = undefined;
    this.changed();
  }

  /** Is `op` still the operation of the current connection? */
  private current(op: Op): boolean {
    return this.activeOp === op && !op.abort.signal.aborted;
  }

  /**
   * The only way a dialog is shown for an operation. It answers "no" without showing anything
   * when the operation is over or the connection is gone, and "no" when the dialog was closed
   * because of that.
   */
  private confirmFor(op: Op): (opts: ConfirmOptions) => Promise<boolean> {
    const usable = (): boolean => {
      this.sync();
      return this.current(op) && this.readyClient() !== undefined;
    };
    return async (opts) => {
      if (!usable()) return false;
      const ok = await this.deps.confirm(opts, op.abort.signal);
      return ok && usable();
    };
  }

  /** Show an error from the client: under the item it names, or at the top. */
  private showError(e: unknown, slot: Slot = "device"): void {
    const d = describeError(e);
    if (d.key && slot === "device") {
      if (this.client?.schema.some((i) => i.key === d.key)) {
        this.serverErrors.set(d.key, d.text);
        this.setMessage({ level: "error", text: "Not saved. Check the highlighted item." });
      } else {
        this.setMessage({ level: "error", text: `${d.key}: ${d.text}` });
      }
    } else {
      this.setMessage({ level: "error", text: d.text }, slot);
    }
  }

  async save(): Promise<void> {
    const client = this.readyClient();
    if (!client || this.busy || !client.settingsKnown) return;
    const ev = evaluateForm(uniqueItems(client.schema), client.settings, this.draft);
    if (!ev.canSave || this.blockingServerErrors().length > 0) return;
    // Notes about items that are not edited are out of date now.
    for (const k of [...this.serverErrors.keys()]) {
      if (!hasOwn(this.draft, k)) this.serverErrors.delete(k);
    }
    this.setMessage(undefined);
    const op = this.begin(); // busy from here on: a second click does nothing
    try {
      const out = await executeSave(client, ev.changes, this.confirmFor(op));
      if (!this.current(op)) return;
      switch (out.kind) {
        case "saved":
          this.clearEdits();
          this.setMessage({
            level: "ok",
            text: savedMessage(out.result.changed, client.schema),
            until: this.now() + SAVED_MS,
          });
          break;
        case "cancelled":
          this.setMessage({ level: "info", text: "Cancelled. Nothing was sent to the device." });
          break;
        case "stale":
          this.setMessage({
            level: "error",
            text: "The device's settings changed while you were confirming. Nothing was sent. Check the form and press Save again.",
          });
          break;
      }
    } catch (e) {
      if (this.activeOp === op) this.showError(e);
    } finally {
      this.end(op);
    }
  }

  async reload(): Promise<void> {
    const client = this.readyClient();
    if (!client || this.busy) return;
    this.setMessage(undefined);
    this.serverErrors.clear();
    const op = this.begin();
    try {
      await client.getSettings();
      if (!this.current(op)) return;
      this.forceNext = Object.keys(this.draft).length === 0;
      this.setMessage({
        level: "info",
        text: "Loaded the settings from the device.",
        until: this.now() + 4000,
      });
    } catch (e) {
      if (this.activeOp === op) this.showError(e);
    } finally {
      this.end(op);
    }
  }

  async reset(): Promise<void> {
    const client = this.readyClient();
    if (!client || this.busy) return;
    const ev = evaluateForm(uniqueItems(client.schema), client.settings, this.draft);
    this.setMessage(undefined, "reset");
    const op = this.begin();
    try {
      const out = await executeReset(client, this.confirmFor(op), ev.dirty.length > 0);
      if (!this.current(op)) return;
      switch (out.kind) {
        case "cancelled":
          this.setMessage({ level: "info", text: "Cancelled. Nothing was changed." }, "reset");
          break;
        case "stale":
          this.setMessage(
            {
              level: "error",
              text: "The device's callsign or transmit permission changed while you were confirming. Nothing was changed. Press Reset again if you still want to.",
            },
            "reset",
          );
          break;
        case "reset": {
          this.clearEdits();
          const v = out.result.values;
          const call = fullCall(v.callsign, v.ssid);
          const tx = v.tx_enabled === true;
          this.setMessage(
            {
              level: tx ? "error" : "ok",
              text: `Reset to defaults. Callsign: ${call ?? "not set"}. Transmit is ${tx ? "ENABLED" : "disabled"} (the beacon switch must still be on).`,
              until: this.now() + SAVED_MS * 2,
            },
            "reset",
          );
          break;
        }
      }
    } catch (e) {
      if (this.activeOp === op) this.showError(e, "reset");
    } finally {
      this.end(op);
    }
  }
}
