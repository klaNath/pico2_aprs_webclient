// Checks for APRS messages sent with `msg.send` (ble-protocol.md §7.6, provisional). The device
// checks the same rules; checking here first gives the user the reason before anything is sent.

import { MSG_STATES } from "./types.ts";

/** Longest addressee: a callsign with an optional SSID (§7.6). */
export const MSG_TO_MAX = 9;
/** Longest message text (§7.6). */
export const MSG_TEXT_MAX = 67;
/** The device keeps at most this many messages pending (§7.6). */
export const MSG_QUEUE_MAX = 4;
/** Transmissions of one message at most (§7.6). */
export const MSG_MAX_TRIES = 5;

const TO_RE = /^[A-Z0-9-]{1,9}$/;

/** The addressee as the device stores it: trimmed and uppercase (§7.6 converts lowercase). */
export function normalizeTo(to: string): string {
  return to.trim().toUpperCase();
}

/**
 * Why `to` cannot be used, or undefined when it can. `ownCall` is this device's callsign-SSID
 * (`status.call`): the device rejects a message to itself.
 */
export function checkMsgTo(to: string, ownCall?: string): string | undefined {
  const t = normalizeTo(to);
  if (t.length === 0) return "Enter the callsign to send to.";
  if (t.length > MSG_TO_MAX) return `At most ${MSG_TO_MAX} characters (callsign and SSID).`;
  if (!TO_RE.test(t)) return "Only letters, digits and “-” (for example Q1AAA-9).";
  if (ownCall !== undefined && t === ownCall.toUpperCase()) {
    return "That is this tracker's own callsign.";
  }
  return undefined;
}

/** Characters the text may not hold: outside printable ASCII, or `|`, `~`, `{` (§7.6). */
export function badTextChars(text: string): string[] {
  const bad = new Set<string>();
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 || c > 0x7e || ch === "|" || ch === "~" || ch === "{") bad.add(ch);
  }
  return [...bad];
}

/** Why `text` cannot be sent, or undefined when it can. The device does not trim spaces. */
export function checkMsgText(text: string): string | undefined {
  if (text.length === 0) return "Enter a message.";
  const bad = badTextChars(text);
  if (bad.length > 0) {
    const shown = bad.map((c) => (c.codePointAt(0)! < 0x20 ? "a control character" : `“${c}”`));
    return `Not allowed: ${shown.join(", ")}. Use plain ASCII, without the characters | ~ and {.`;
  }
  if (text.length > MSG_TEXT_MAX) return `At most ${MSG_TEXT_MAX} characters.`;
  return undefined;
}

/** A known state, or "ended" for a value the spec may add later (§8.8: treat it as ended). */
export function msgStateKind(state: string | undefined): (typeof MSG_STATES)[number] | "ended" {
  return (MSG_STATES as readonly string[]).includes(state ?? "")
    ? (state as (typeof MSG_STATES)[number])
    : "ended";
}
