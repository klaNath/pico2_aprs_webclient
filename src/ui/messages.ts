// APRS messages (ble-protocol.md §7.6-§7.8, provisional): when "Send" can be pressed, the
// confirmation, the words for states and errors. No DOM here, so it can be tested.
//
// Transmit safety (CLAUDE.md): a message is sent only when the user presses "Send". It goes on the
// air and the device retries it, so the user confirms once per connection before the first one.
// Messages are never dry runs (§7.6): when the device cannot transmit, "Send" cannot be pressed.

import type { ClientState, MessageConfirmation } from "../client/deviceClient.ts";
import { MSG_MAX_TRIES, MSG_QUEUE_MAX, msgStateKind } from "../protocol/messages.ts";
import type { MsgMsg, StatusMsg } from "../protocol/types.ts";
import type { ConfirmOptions } from "./dialog.ts";

export interface SendButton {
  enabled: boolean;
  /** Why it cannot be pressed (shown under the form). Empty when it can. */
  reason: string;
}

export function messageSendState(
  state: ClientState,
  stale: boolean,
  status: Pick<StatusMsg, "sw" | "tx_ready" | "tx_refuse" | "msg_pending"> | undefined,
  sending: boolean,
): SendButton {
  const no = (reason: string): SendButton => ({ enabled: false, reason });
  if (state !== "ready" || status === undefined) return no("Not connected.");
  if (stale) return no("No recent status from the device.");
  if (sending) return no("Sending…");
  if (status.sw !== true) return no("The beacon switch on the unit is off.");
  if (status.tx_ready !== true) {
    return no(
      `The tracker cannot transmit${status.tx_refuse ? ` (${status.tx_refuse})` : ""}. Messages are never sent as a dry run.`,
    );
  }
  if ((status.msg_pending ?? 0) >= MSG_QUEUE_MAX) {
    return no(`${MSG_QUEUE_MAX} messages are still being sent. Wait, or cancel one.`);
  }
  return { enabled: true, reason: "" };
}

/** The dialog before the first message of a connection. */
export function messageConfirmation(call: string | undefined): ConfirmOptions {
  return {
    title: "Send APRS messages?",
    body: [
      "Messages are transmitted on the air. The tracker repeats each one until the other station acknowledges it, up to 5 times over about 12 minutes.",
      "The tracker also acknowledges messages addressed to it by itself.",
      "Only do this if you are licensed to transmit with this callsign. You will not be asked again until you reconnect.",
    ],
    facts: [`On the air as: ${call ?? "not set"}`],
    confirmLabel: "Send",
    danger: true,
  };
}

/** A sent message's state for the user. */
export function messageStateText(m: Pick<MsgMsg, "state" | "tries">): string {
  const tries = m.tries ?? 0;
  switch (msgStateKind(m.state)) {
    case "pending":
      return tries === 0
        ? "Waiting to send"
        : `Sent ${tries} of ${MSG_MAX_TRIES}, waiting for acknowledgement`;
    case "acked":
      return "Delivered";
    case "rejected":
      return "Rejected by the station";
    case "failed":
      return `Not acknowledged after ${MSG_MAX_TRIES} tries`;
    case "cancelled":
      return tries === 0
        ? "Cancelled"
        : `Cancelled after ${tries} ${tries === 1 ? "try" : "tries"}`;
    case "stopped":
      return "Stopped (the tracker restarted)";
    default:
      return `Ended (${m.state ?? "unknown"})`;
  }
}

/** A CSS-friendly class for the state. */
export function messageStateClass(m: Pick<MsgMsg, "state">): string {
  const k = msgStateKind(m.state);
  if (k === "acked") return "msg-ok";
  if (k === "pending") return "msg-pending";
  if (k === "rejected" || k === "failed") return "msg-bad";
  return "msg-ended";
}

/** Words for an error from msg.send / msg.cancel. Never shows a bare internal code. */
export function describeMessageError(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  const key = (e as { key?: unknown } | null)?.key;
  const msg = (e as { msg?: unknown } | null)?.msg;
  const detail = typeof msg === "string" && msg ? `: ${msg}` : "";
  switch (code) {
    case "invalid":
      return key === "to"
        ? `Not sent: the callsign is not valid${detail}.`
        : key === "text"
          ? `Not sent: the text is not valid${detail}.`
          : `The tracker did not accept the request${detail}.`;
    case "switch_off":
      return "Not sent: the beacon switch on the unit is off.";
    case "tx_not_ready":
      return `Not sent: the tracker cannot transmit${detail}.`;
    case "queue_full":
      return `Not sent: ${MSG_QUEUE_MAX} messages are still being sent. Wait, or cancel one.`;
    case "unknown_msg":
      return "The tracker no longer has that message.";
    case "unknown_op":
      return "This tracker's firmware does not support messages yet.";
    case "busy":
      return "The device is busy. Wait a moment and try again.";
    case "timeout":
      return "The device did not answer in time. Check the list before sending again.";
    case "disconnected":
      return "The connection was lost. Check the list after reconnecting before sending again.";
    case "not_connected":
      return "Not connected to a device.";
    case "write_failed":
      return "Sending to the device over Bluetooth failed. The message was probably not queued.";
    case "confirmation_required":
      return "This needs your confirmation, so nothing was sent.";
    default:
      return `The device reported a problem${detail}.`;
  }
}

/** What the send flow needs from the app. `current()` is read again after the dialog. */
export interface MessageFlowDeps {
  /** The confirmation already given on this connection, if any. */
  confirmation(): MessageConfirmation | undefined;
  /** Record the user's yes for this connection. */
  confirmConnection(): MessageConfirmation | undefined;
  confirm(options: ConfirmOptions): Promise<boolean>;
  send(to: string, text: string, confirmation: MessageConfirmation): Promise<MsgMsg>;
  current(): {
    usable: boolean;
    status: Pick<StatusMsg, "sw" | "tx_ready" | "tx_refuse" | "msg_pending" | "call"> | undefined;
  };
}

export type MessageSendResult =
  { ok: true; msg: MsgMsg } | { ok: false; text: string } | { ok: false; cancelled: true };

/** The press of "Send". Asks once per connection; sends nothing if the state changed meanwhile. */
export async function runMessageSend(
  deps: MessageFlowDeps,
  to: string,
  text: string,
): Promise<MessageSendResult> {
  const fail = (t: string): MessageSendResult => ({ ok: false, text: t });
  const start = deps.current();
  if (!start.usable) return fail(describeMessageError({ code: "not_connected" }));
  try {
    let c = deps.confirmation();
    if (!c) {
      if (!(await deps.confirm(messageConfirmation(start.status?.call)))) {
        return { ok: false, cancelled: true };
      }
      const now = deps.current();
      if (!now.usable || now.status?.tx_ready !== true) {
        return fail("The transmit state changed. Nothing was sent. Check it and try again.");
      }
      c = deps.confirmConnection();
      if (!c) return fail(describeMessageError({ code: "not_connected" }));
    }
    return { ok: true, msg: await deps.send(to, text, c) };
  } catch (e) {
    return fail(describeMessageError(e));
  }
}
