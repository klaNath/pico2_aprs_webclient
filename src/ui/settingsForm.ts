// Settings form logic that does not touch the DOM (so that it can be tested in node):
// which widget a schema item gets, building the changes from the edits, validation, the text of
// every confirmation dialog, the confirm-then-save sequence, and error texts.
//
// Transmit safety (CLAUDE.md): the values the user is shown in a confirmation dialog are exactly
// the values that are sent. `executeSave` takes one snapshot of the changes, builds the dialogs
// from it, and sends the same snapshot with the confirmations the user gave.

import type { DeviceClient } from "../client/deviceClient.ts";
import { MICE_MESSAGES, settingEquals, validateSetting } from "../protocol/settings.ts";
import type { SettingsRisk } from "../protocol/settings.ts";
import type { SchemaItem, SettingValue, SettingsMsg, SettingsValues } from "../protocol/types.ts";
import type { ConfirmOptions } from "./dialog.ts";

// ---- keys from the device are data, never property names ---------------------------------------
// A schema key may be "constructor" or "toString". Plain objects must not answer for such a key.

/** `obj[key]` only when `key` is an own property of `obj`. */
export function getOwn<T>(
  obj: Readonly<Record<string, T>> | undefined,
  key: string,
): T | undefined {
  return obj !== undefined && Object.hasOwn(obj, key) ? obj[key] : undefined;
}

/** True when `key` is an own property (the safe form of `key in obj`). */
export function hasOwn(obj: object | undefined, key: string): boolean {
  return obj !== undefined && Object.hasOwn(obj, key);
}

/** A new empty object with no prototype, so that any key (even "__proto__") is plain data. */
function bareObject<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/** The items with a repeated key left out (the first one wins), so that one key is one form row. */
export function uniqueItems(schema: readonly SchemaItem[]): SchemaItem[] {
  const seen = new Set<string>();
  return schema.filter((i) => {
    if (seen.has(i.key)) return false;
    seen.add(i.key);
    return true;
  });
}

// ---- which widget does an item get ------------------------------------------------------------

export type WidgetKind =
  | "callsign"
  | "symbol"
  | "path"
  | "mice"
  | "text"
  | "number"
  | "toggle"
  | "list"
  /** An unknown type: shown, never edited. */
  | "readonly";

/**
 * Known items get a dedicated widget (when their schema type is what the widget expects, so a
 * future change of a type on the device falls back to the generic widget). Everything else is
 * decided by `type`; an unknown type becomes read-only.
 */
export function widgetKindFor(item: SchemaItem): WidgetKind {
  switch (item.key) {
    case "callsign":
      if (item.type === "str") return "callsign";
      break;
    case "symbol":
      if (item.type === "str") return "symbol";
      break;
    case "path":
      if (item.type === "list") return "path";
      break;
    case "mice_message":
      if (item.type === "int") return "mice";
      break;
  }
  switch (item.type) {
    case "str":
      return "text";
    case "int":
    case "float":
      return "number";
    case "bool":
      return "toggle";
    case "list":
      return "list";
    default:
      return "readonly";
  }
}

const LABELS: Readonly<Record<string, string>> = {
  callsign: "Callsign",
  ssid: "SSID",
  symbol: "Symbol",
  path: "Digipeater path",
  comment: "Comment",
  mice_message: "Mic-E message",
  beacon_moving_s: "Beacon interval, moving",
  beacon_still_s: "Beacon interval, still",
  beacon_move_m: "Movement threshold",
  tx_enabled: "Transmit enabled",
  fx25_tx: "Transmit with FX.25",
};

/** A readable name for the item; an item the app does not know is shown by its key. */
export function fieldLabel(item: SchemaItem): string {
  return getOwn(LABELS, item.key) ?? item.key;
}

/** The description of the item, when the device sent a usable one (a string). */
export function itemDesc(item: SchemaItem): string | undefined {
  return typeof item.desc === "string" && item.desc !== "" ? item.desc : undefined;
}

const UNITS: Readonly<Record<string, string>> = {
  beacon_moving_s: "s",
  beacon_still_s: "s",
  beacon_move_m: "m",
};

/** The unit shown after a number input (known items, or a short "(unit)" ending the description). */
export function fieldUnit(item: SchemaItem): string | undefined {
  const known = getOwn(UNITS, item.key);
  if (known) return known;
  const m = /\(([A-Za-z°%/]{1,5})\)\s*$/.exec(itemDesc(item) ?? "");
  return m?.[1];
}

export type GroupTitle = "Identity" | "Beacon" | "Transmit" | "Other";

const GROUP_BY_KEY: Readonly<Record<string, GroupTitle>> = {
  callsign: "Identity",
  ssid: "Identity",
  symbol: "Identity",
  comment: "Identity",
  path: "Beacon",
  mice_message: "Beacon",
  beacon_moving_s: "Beacon",
  beacon_still_s: "Beacon",
  beacon_move_m: "Beacon",
  tx_enabled: "Transmit",
  fx25_tx: "Transmit",
};

const GROUP_ORDER: readonly GroupTitle[] = ["Identity", "Beacon", "Transmit", "Other"];

/** Split the schema into titled groups (schema order inside a group). Empty groups are left out. */
export function groupItems(
  schema: readonly SchemaItem[],
): { title: GroupTitle; items: SchemaItem[] }[] {
  const items = uniqueItems(schema);
  return GROUP_ORDER.map((title) => ({
    title,
    items: items.filter((i) => (getOwn(GROUP_BY_KEY, i.key) ?? "Other") === title),
  })).filter((g) => g.items.length > 0);
}

/** The only choices for `mice_message`: 0 to 6 with their names (7, Emergency, is not offered). */
export function miceOptions(): { value: number; label: string }[] {
  return MICE_MESSAGES.map((name, i) => ({ value: i, label: `${i} ${name}` }));
}

/** "Off Duty" for 0; for anything the app cannot set (7, odd values) a plain description. */
export function miceLabel(v: unknown): string {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < MICE_MESSAGES.length) {
    return `${v} ${MICE_MESSAGES[v]}`;
  }
  if (v === 7) return "7 Emergency (cannot be set from the app)";
  return v === undefined || v === null ? "not set" : `${String(v)} (not a valid choice)`;
}

/** 900 -> "15 min", 90 -> "1 min 30 s", 7200 -> "2 h". */
export function humanSeconds(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "";
  const n = Math.round(s);
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const sec = n % 60;
  const parts = [h ? `${h} h` : "", m ? `${m} min` : "", sec || n === 0 ? `${sec} s` : ""];
  return parts.filter(Boolean).join(" ");
}

/** Turn the text of a number input into a value. Text that is not a number stays text (so that it fails validation). */
export function parseNumberInput(text: string): number | string {
  const t = text.trim();
  if (t === "") return "";
  const n = Number(t);
  return Number.isFinite(n) ? n : text;
}

// ---- the edits (draft) and the changes to send ------------------------------------------------

/** The edits made in the form: only the items the user has touched, with the raw edited value. */
export type Draft = Readonly<Record<string, unknown>>;

/** An empty draft (no prototype: a key from the device is never a property name). */
export function emptyDraft(): Draft {
  return bareObject<unknown>();
}

/**
 * Record an edit. An edit back to the device's value removes the entry, so that "edited" means
 * "different from the device".
 */
export function setDraft(
  draft: Draft,
  current: Readonly<SettingsValues>,
  key: string,
  value: unknown,
): Draft {
  const next: Record<string, unknown> = Object.assign(bareObject<unknown>(), draft);
  if (hasOwn(current, key) && settingEquals(value, current[key])) delete next[key];
  else next[key] = value;
  return next;
}

export interface FormEval {
  /** Valid, normalized values that differ from the device. This is what gets sent. */
  changes: SettingsValues;
  /** Validation message per edited item. */
  errors: Record<string, string>;
  /** Items that differ from the device (valid or not), in schema order. */
  dirty: string[];
  /** Save is possible: something changed, and nothing is invalid. */
  canSave: boolean;
}

/**
 * Compare the edits with the device's values. Only items in `schema` count. Values are checked
 * with `validateSetting`; the callsign is never rewritten (a lower case callsign is an error).
 */
export function evaluateForm(
  schema: readonly SchemaItem[],
  current: Readonly<SettingsValues>,
  draft: Draft,
): FormEval {
  const changes: SettingsValues = bareObject<SettingValue>();
  const errors: Record<string, string> = bareObject<string>();
  const dirty: string[] = [];
  for (const item of uniqueItems(schema)) {
    const key = item.key;
    if (!hasOwn(draft, key) || widgetKindFor(item) === "readonly") continue;
    const raw = draft[key];
    const r = validateSetting(key, raw, schema);
    if ("error" in r) {
      errors[key] = fieldError(key, raw, r.error);
      dirty.push(key);
    } else if (!hasOwn(current, key) || !settingEquals(r.value, current[key])) {
      changes[key] = r.value;
      dirty.push(key);
    }
  }
  return { changes, errors, dirty, canSave: dirty.length > 0 && Object.keys(errors).length === 0 };
}

/** A validation message, with clearer words for the mistakes people actually make. */
function fieldError(key: string, raw: unknown, base: string): string {
  if (key === "callsign" && typeof raw === "string") {
    if (raw === "") return "Enter a callsign, or tick “Not set”.";
    if (raw !== raw.trim() || /\s/.test(raw)) return "No spaces allowed. Use A-Z and 0-9 only.";
    if (raw !== raw.toUpperCase()) return "Use upper case letters (for example Q1TEST).";
    if (raw.includes("-")) return "Enter the callsign without the SSID (set the SSID separately).";
  }
  const num = /^(integer|number)(?: (-?[\d.]+)-(-?[\d.]+))?$/.exec(base);
  if (num) {
    const what = num[1] === "integer" ? "a whole number" : "a number";
    return num[2] !== undefined ? `Enter ${what} from ${num[2]} to ${num[3]}.` : `Enter ${what}.`;
  }
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/** Items whose draft is set and whose device value has changed since `prev` (a conflict note). */
export function deviceChangedKeys(
  prev: Readonly<SettingsValues>,
  current: Readonly<SettingsValues>,
  draft: Draft,
): string[] {
  return Object.keys(draft).filter((k) => !settingEquals(getOwn(prev, k), getOwn(current, k)));
}

// ---- confirmations ---------------------------------------------------------------------------

/** Every kind of confirmation. A new `SettingsRisk` makes this fail to compile until it is added. */
const RISK_TABLE: Record<SettingsRisk, true> = { callsign: true, ssid: true, tx_enable: true };
export const ALL_RISKS = Object.keys(RISK_TABLE) as SettingsRisk[];

function show(v: unknown): string {
  if (v === null || v === undefined) return "not set";
  if (Array.isArray(v)) return v.length ? v.join(" ") : "(none)";
  return String(v);
}

/** "Q1TEST-7" from callsign and SSID, or undefined when there is no callsign. */
export function fullCall(callsign: unknown, ssid: unknown): string | undefined {
  if (typeof callsign !== "string" || callsign === "") return undefined;
  return typeof ssid === "number" && ssid > 0 ? `${callsign}-${ssid}` : callsign;
}

/**
 * The dialog for one kind of confirmation. `current` is what the device has, `changes` is what is
 * about to be sent: the text is built from these two and from nothing else.
 */
export function confirmationFor(
  risk: SettingsRisk,
  current: Readonly<SettingsValues>,
  changes: Readonly<SettingsValues>,
): ConfirmOptions {
  switch (risk) {
    case "callsign": {
      const oldCall = current.callsign;
      const newCall = changes.callsign;
      return {
        title: newCall === null ? "Clear the callsign?" : "Change the callsign?",
        body:
          newCall === null
            ? [
                "The callsign will be removed from the device. The tracker will not transmit until a callsign is set again.",
              ]
            : [
                "Beacons will be sent on the air with the new callsign. Only use a callsign you are licensed to transmit with.",
              ],
        facts: [`Callsign: ${show(oldCall)} → ${show(newCall)}`],
        confirmLabel: newCall === null ? "Clear callsign" : "Change callsign",
        danger: true,
      };
    }
    case "ssid": {
      // The identity on the air is CALL-SSID. A callsign changed in the same save counts.
      const oldCall = fullCall(current.callsign, current.ssid);
      const newCall = fullCall(
        "callsign" in changes ? changes.callsign : current.callsign,
        "ssid" in changes ? changes.ssid : current.ssid,
      );
      return {
        title: "Change the SSID?",
        body: [
          newCall
            ? "The SSID is part of the name the tracker uses on the air (CALL-SSID). Beacons sent after this change will carry the new name, so other stations will see a different station."
            : "The SSID is part of the name the tracker uses on the air (CALL-SSID). No callsign will be set, so the tracker will not transmit until a callsign is set.",
          "Only change it if you mean to be identified by the new name.",
        ],
        facts: [
          `On the air as: ${oldCall ?? "not set"} → ${newCall ?? "not set"}`,
          `SSID: ${show(current.ssid)} → ${show(changes.ssid)}`,
        ],
        confirmLabel: "Change SSID",
        danger: true,
      };
    }
    case "tx_enable": {
      const call = fullCall(
        "callsign" in changes ? changes.callsign : current.callsign,
        "ssid" in changes ? changes.ssid : current.ssid,
      );
      return {
        title: "Enable transmit?",
        body: [
          call
            ? `Transmit will be enabled. The tracker will send beacons on the air as ${call} when the beacon switch is on.`
            : "Transmit will be enabled, but no callsign is set, so the tracker will not transmit until a callsign is set.",
          "The physical beacon switch on the unit still decides whether it transmits.",
        ],
        facts: [`Callsign: ${call ?? "not set"}`, "Transmit enabled: off → on"],
        confirmLabel: "Enable transmit",
        danger: true,
      };
    }
    default: {
      // A kind of confirmation that this app version does not know: never skip it.
      const unknown: string = risk;
      return {
        title: "Confirm this change?",
        body: [`This change needs your confirmation (${unknown}).`],
        facts: Object.entries(changes).map(([k, v]) => `${k}: ${show(v)}`),
        confirmLabel: "Confirm",
        danger: true,
      };
    }
  }
}

/** The dialog for "Reset to defaults". `dirty` is true when the form has unsaved edits. */
export function resetConfirmation(
  current: Readonly<SettingsValues>,
  settingsKnown: boolean,
  dirty: boolean,
): ConfirmOptions {
  const call = fullCall(current.callsign, current.ssid);
  return {
    title: "Reset all settings?",
    body: [
      "This deletes every saved setting on the device (callsign, SSID, symbol, path, comment, Mic-E message, beacon intervals, transmit permission, FX.25) and goes back to the defaults written in the device firmware.",
      "The defaults may differ from what you use now, including the callsign and whether transmit is enabled. The physical beacon switch still decides whether the unit transmits.",
      ...(dirty ? ["Your unsaved edits in this form will be discarded."] : []),
    ],
    facts: settingsKnown
      ? [
          `Callsign now: ${call ?? "not set"}`,
          `Transmit enabled now: ${current.tx_enabled === true ? "on" : "off"}`,
        ]
      : ["The current settings are not known."],
    confirmLabel: "Reset to defaults",
    danger: true,
  };
}

// ---- the confirm-then-save sequence -----------------------------------------------------------

export type SaveOutcome =
  | { kind: "saved"; result: SettingsMsg }
  /** The user refused `risk`. Nothing was sent. */
  | { kind: "cancelled"; risk: SettingsRisk }
  /** The device's values changed while the dialogs were open. Nothing was sent. */
  | { kind: "stale" };

export type SavableClient = Pick<
  DeviceClient,
  "requiredConfirmations" | "setSettings" | "settings"
>;

function sameOn(a: Readonly<SettingsValues>, b: Readonly<SettingsValues>, keys: string[]): boolean {
  return keys.every((k) => settingEquals(getOwn(a, k), getOwn(b, k)));
}

/** The kinds of confirmation in the order the user is asked (the order of ALL_RISKS). */
function orderRisks(needed: readonly SettingsRisk[]): SettingsRisk[] {
  return [
    ...ALL_RISKS.filter((r) => needed.includes(r)),
    ...needed.filter((r) => !ALL_RISKS.includes(r)),
  ];
}

/**
 * Items whose device value must not change while a dialog is open. The dialogs name the callsign
 * and SSID the tracker will use on the air: the tx_enable dialog uses both, the ssid dialog the
 * callsign.
 */
function guardedKeys(changed: string[], risks: readonly SettingsRisk[]): string[] {
  const keys = new Set(changed);
  if (risks.includes("tx_enable")) {
    keys.add("callsign");
    keys.add("ssid");
  }
  if (risks.includes("ssid")) keys.add("callsign");
  return [...keys];
}

/**
 * Ask for every confirmation the client requires, one dialog each, in the order of ALL_RISKS.
 * If the user refuses any one, nothing is sent. Otherwise send the same snapshot of `changes`
 * that the dialogs described, with the confirmations given.
 */
export async function executeSave(
  client: SavableClient,
  changes: Readonly<SettingsValues>,
  confirm: (opts: ConfirmOptions) => Promise<boolean>,
): Promise<SaveOutcome> {
  const snapshot = structuredClone(changes) as SettingsValues;
  const current = structuredClone(client.settings);
  const ordered = orderRisks(client.requiredConfirmations(snapshot));
  const keys = guardedKeys(Object.keys(snapshot), ordered);
  const confirmed: SettingsRisk[] = [];
  for (const risk of ordered) {
    if (!(await confirm(confirmationFor(risk, current, snapshot)))) {
      return { kind: "cancelled", risk };
    }
    confirmed.push(risk);
  }
  // The device may have reported other values while a dialog was open (for example the unit
  // changed itself). The user confirmed against `current`, so do not send on top of something else.
  if (
    ordered.length > 0 &&
    (!sameOn(current, client.settings, keys) ||
      client.requiredConfirmations(snapshot).some((r) => !confirmed.includes(r)))
  ) {
    return { kind: "stale" };
  }
  return { kind: "saved", result: await client.setSettings(snapshot, { confirmed }) };
}

export type ResetOutcome =
  | { kind: "reset"; result: SettingsMsg }
  /** The user refused. Nothing was sent. */
  | { kind: "cancelled" }
  /** The callsign, SSID or transmit permission changed while the dialog was open. Nothing was sent. */
  | { kind: "stale" };

export type ResettableClient = Pick<DeviceClient, "resetSettings" | "settings" | "settingsKnown">;

/**
 * Ask for the confirmation of "Reset to defaults", then reset. Nothing is sent without a "yes".
 * `dirty` says whether the form has unsaved edits (the dialog mentions that they are discarded).
 */
export async function executeReset(
  client: ResettableClient,
  confirm: (opts: ConfirmOptions) => Promise<boolean>,
  dirty: boolean,
): Promise<ResetOutcome> {
  const current = structuredClone(client.settings);
  const known = client.settingsKnown;
  if (!(await confirm(resetConfirmation(current, known, dirty)))) return { kind: "cancelled" };
  // The dialog said what the callsign and transmit permission are now. If they are not that any
  // more, the user did not confirm this reset.
  if (!sameOn(current, client.settings, ["callsign", "ssid", "tx_enabled"])) {
    return { kind: "stale" };
  }
  return { kind: "reset", result: await client.resetSettings({ confirmed: true }) };
}

// ---- errors ----------------------------------------------------------------------------------

export interface ErrorText {
  /** Put this under the item `key` (the device said which item is wrong). */
  key?: string;
  /** The text for the item, or for the top of the screen when there is no `key`. */
  text: string;
}

/** Turn an error from the client into words for the user. Never shows a bare internal code. */
export function describeError(e: unknown): ErrorText {
  const code = (e as { code?: unknown } | null)?.code;
  const msg = (e as { msg?: unknown } | null)?.msg;
  const key = (e as { key?: unknown } | null)?.key;
  const detail = typeof msg === "string" && msg ? msg : undefined;
  if (typeof code !== "string") {
    return { text: "Something went wrong. Reload from the device to check its settings." };
  }
  switch (code) {
    case "invalid":
      return typeof key === "string" && key
        ? {
            key,
            text: detail
              ? `The device rejected this value: ${detail}.`
              : "The device rejected this value.",
          }
        : { text: `A value is not valid${detail ? `: ${detail}` : ""}. Nothing was saved.` };
    case "confirmation_required":
      return {
        text: "This change needs your confirmation, so it was not sent. Check the form and press Save again.",
      };
    case "timeout":
      return {
        text: "The device did not answer in time. The change may or may not have been saved. Press “Reload from device” to see what the device has.",
      };
    case "disconnected":
      return {
        text: "The connection was lost. The change may not have been saved. Reconnect and check the settings.",
      };
    case "not_connected":
      return { text: "Not connected to a device." };
    case "busy":
      return { text: "The device is busy. Wait a moment and try again." };
    case "io":
      return {
        text: "The device could not write to its flash memory. Nothing was changed. Try again.",
      };
    case "too_long":
      return { text: "The request was too long for the device. Change fewer items at a time." };
    case "write_failed":
      return {
        text: "Sending to the device over Bluetooth failed. The change may not have been saved.",
      };
    case "bad_response":
      return {
        text: "The device sent a reply this app could not understand. Reload from the device to check.",
      };
    case "internal":
      return {
        text: `The device reported an internal error${detail ? ` (${detail})` : ""}. Try again.`,
      };
    case "proto_mismatch":
      return { text: "This device speaks a different protocol version than this app." };
    case "disposed":
    case "already_started":
      return { text: "The connection was closed. Reconnect and try again." };
    default:
      return { text: `The device reported a problem${detail ? `: ${detail}` : ""}.` };
  }
}

/** "Saved: Comment, Transmit enabled" for the items the device says it changed. */
export function savedMessage(
  changed: readonly string[] | undefined,
  schema: readonly SchemaItem[],
): string {
  if (!changed || changed.length === 0) return "Saved. The device already had these values.";
  const names = changed.map((k) => {
    const item = schema.find((i) => i.key === k);
    return item ? fieldLabel(item) : k;
  });
  return `Saved: ${names.join(", ")}.`;
}

/** The device's current value of an item, as plain text (read-only items and logs). */
export function valueText(v: SettingValue | undefined): string {
  if (v === undefined) return "";
  return typeof v === "string" ? v : JSON.stringify(v);
}
