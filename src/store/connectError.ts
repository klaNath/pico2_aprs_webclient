// Turns the error of a failed connection attempt into a sentence for the user. Pure.

import { DeviceError } from "../client/deviceClient.ts";

const FALLBACK = "Could not connect to the device.";

/** DeviceError codes (local ones and the device's `err` codes) as English sentences. */
const BY_CODE: Record<string, string> = {
  timeout: "The device did not respond. Check that it is powered on and in range, then try again.",
  write_failed: "Could not send data to the device. Check the connection and try again.",
  disconnected: "The connection to the device was lost.",
  not_connected: "Not connected to the device.",
  already_started: "A connection is already in progress.",
  disposed: "The connection was closed.",
  bad_response: "The device sent a reply the app could not understand.",
  too_long: "The request was too long for the device.",
  invalid: "The device did not accept the request.",
  confirmation_required: "The request needs your confirmation first.",
  busy: "The device is busy. Try again in a moment.",
  io: "The device could not save the change.",
  bad_json: "The device could not read the request.",
  unknown_op: "The device does not support this request.",
};

/**
 * A readable sentence for a failed connection attempt (what `start()` threw, or what the
 * transport's `connect()` threw). Never contains an internal code.
 *
 * For `proto_mismatch` it returns "": the app's state is then "proto_mismatch" and the screen
 * shows its own explanation, so no notice is needed.
 */
export function describeConnectError(e: unknown): string {
  if (e instanceof DeviceError) {
    if (e.code === "proto_mismatch") return "";
    return BY_CODE[e.code] ?? "The device reported an error.";
  }
  if (e instanceof Error) {
    // Web Bluetooth rejects with DOMExceptions.
    if (e.name === "NotFoundError") return "No device was selected.";
    if (e.name === "TimeoutError") return BY_CODE.timeout!;
    if (e.name === "SecurityError" || e.name === "NotAllowedError") {
      return "Bluetooth is not allowed here. Check the permission for this site.";
    }
    return e.message.trim() || FALLBACK;
  }
  if (typeof e === "string" && e.trim()) return e.trim();
  return FALLBACK;
}
