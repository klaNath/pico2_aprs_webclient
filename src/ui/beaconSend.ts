// "Send beacon now" (beacon.send, ble-protocol.md §7.5): when the button can be pressed, what the
// confirmation says, and the words for the result and the errors. No DOM here, so it can be tested.
//
// Transmit safety (CLAUDE.md): the beacon is sent only when the user presses the button. When it
// goes on the air (`tx_ready` is true) the user confirms first. The device makes the final decision.

import type { BeaconConfirmation, ClientState } from "../client/deviceClient.ts";
import type { BeaconMsg, StatusMsg } from "../protocol/types.ts";
import type { ConfirmOptions } from "./dialog.ts";

/** The device refuses a beacon sooner than this after the last one (§7.5). */
export const BEACON_MIN_INTERVAL_S = 10;

export interface BeaconButton {
  enabled: boolean;
  /** Why it cannot be pressed (shown under the button). Empty when it can. */
  reason: string;
}

/**
 * Can the button be pressed now? `lastStatusAt` is when `status` arrived (Date.now()): the age of
 * the last beacon (`last_tx_s`) is counted on from there. `sending` is true while a request is out.
 */
export function beaconButtonState(
  state: ClientState,
  stale: boolean,
  status: Pick<StatusMsg, "sw" | "fix" | "utc" | "last_tx_s"> | undefined,
  lastStatusAt: number | undefined,
  now: number,
  sending: boolean,
): BeaconButton {
  const no = (reason: string): BeaconButton => ({ enabled: false, reason });
  if (state !== "ready" || status === undefined) return no("Not connected.");
  if (stale) return no("No recent status from the device.");
  if (sending) return no("Sending…");
  if (status.sw !== true) return no("The beacon switch on the unit is off.");
  if ((status.fix ?? 0) < 2 || status.utc === undefined) {
    return no("No GPS fix yet (a fix and the time are needed).");
  }
  if (status.last_tx_s !== undefined && lastStatusAt !== undefined) {
    const age = status.last_tx_s + (now - lastStatusAt) / 1000;
    const wait = Math.ceil(BEACON_MIN_INTERVAL_S - age);
    if (wait > 0) return no(`The last beacon was just sent. Wait ${wait} s.`);
  }
  return { enabled: true, reason: "" };
}

/** Which confirmation the user must give: on the air, or a dry run. Undefined when unknown. */
export function beaconCase(
  status: Pick<StatusMsg, "tx_ready"> | undefined,
): "onAir" | "dryRun" | undefined {
  if (typeof status?.tx_ready !== "boolean") return undefined;
  return status.tx_ready ? "onAir" : "dryRun";
}

/** The dialog for a beacon that goes on the air. A dry run needs no dialog. */
export function beaconConfirmation(call: string | undefined): ConfirmOptions {
  return {
    title: "Send a beacon now?",
    body: [
      "The tracker will transmit a position beacon on the air right away.",
      "Only do this if you are licensed to transmit with this callsign.",
    ],
    facts: [`On the air as: ${call ?? "not set"}`],
    confirmLabel: "Send beacon",
    danger: true,
  };
}

/** What to tell the user after the device answered. */
export function beaconResultText(
  msg: BeaconMsg,
  status: Pick<StatusMsg, "tx_refuse"> | undefined,
): string {
  if (msg.dry === true) {
    const why = status?.tx_refuse ? ` (${status.tx_refuse})` : "";
    return `Dry run: the beacon was recorded but not transmitted${why}.`;
  }
  if (msg.dry === false) return "Beacon sent.";
  // The device did not say: do not claim that it went on the air.
  return "The device answered, but did not say whether the beacon was transmitted. Check the Feed.";
}

/** Words for an error from `sendBeacon`. Never shows a bare internal code. */
export function describeBeaconError(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  const waitS = (e as { waitS?: unknown } | null)?.waitS;
  switch (code) {
    case "switch_off":
      return "Not sent: the beacon switch on the unit is off.";
    case "no_fix":
      return "Not sent: the tracker has no GPS fix or does not know the time yet.";
    case "too_soon":
      return typeof waitS === "number"
        ? `Not sent: the last beacon was just sent. Wait ${waitS} s.`
        : "Not sent: the last beacon was just sent. Wait a little.";
    case "frame_too_long":
      return "Not sent: the beacon does not fit in the transmit buffer. Shorten the comment in Settings.";
    case "internal":
      return "The transmission failed inside the tracker. It restarts, so the connection will drop.";
    case "busy":
      return "The device is busy. Wait a moment and try again.";
    case "timeout":
      return "The device did not answer in time. It is not known whether the beacon was sent. Check the Feed.";
    case "disconnected":
      return "The connection was lost. It is not known whether the beacon was sent. Check the Feed after reconnecting.";
    case "not_connected":
      return "Not connected to a device.";
    case "write_failed":
      return "Sending to the device over Bluetooth failed. The beacon was probably not sent.";
    case "confirmation_required":
      return "This needs your confirmation, so nothing was sent.";
    default: {
      const msg = (e as { msg?: unknown } | null)?.msg;
      return `The device reported a problem${typeof msg === "string" && msg ? `: ${msg}` : ""}.`;
    }
  }
}

/** The confirmation to pass to `sendBeacon` for a case. */
export function confirmationFor(c: "onAir" | "dryRun"): BeaconConfirmation {
  return c === "onAir" ? { onAir: true } : { dryRun: true };
}

/** What the flow needs from the app. `current()` is read again after the dialog. */
export interface BeaconFlowDeps {
  sendBeacon(confirmation: BeaconConfirmation): Promise<BeaconMsg>;
  confirm(options: ConfirmOptions): Promise<boolean>;
  /** The state now: `usable` is false when disconnected, stale, or a different connection. */
  current(): { usable: boolean; status: StatusMsg | undefined };
}

/**
 * The press of "Send beacon now". On the air (`tx_ready` true, or unknown): ask first. The user
 * confirms (or, for a dry run, sees) one case; if the transmit state is no longer that case when
 * it is time to send, nothing is sent. Returns the text for the user, or undefined when the user
 * cancelled.
 */
export async function runBeaconSend(deps: BeaconFlowDeps): Promise<string | undefined> {
  const start = deps.current();
  if (!start.usable) return describeBeaconError({ code: "not_connected" });
  // An unknown tx_ready is treated as "on the air": ask.
  const first = beaconCase(start.status) ?? "onAir";
  try {
    if (first === "onAir" && !(await deps.confirm(beaconConfirmation(start.status?.call)))) {
      return undefined;
    }
    const now = deps.current();
    if (!now.usable || (beaconCase(now.status) ?? "onAir") !== first) {
      return "The transmit state changed. Nothing was sent. Check it and press the button again.";
    }
    return beaconResultText(await deps.sendBeacon(confirmationFor(first)), now.status);
  } catch (e) {
    return describeBeaconError(e);
  }
}
