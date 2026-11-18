import { describe, expect, it } from "vitest";
import { DeviceError } from "../src/client/deviceClient.ts";
import { describeConnectError } from "../src/store/connectError.ts";

describe("describeConnectError", () => {
  const codes = [
    "timeout",
    "write_failed",
    "disconnected",
    "not_connected",
    "already_started",
    "disposed",
    "bad_response",
    "too_long",
    "invalid",
    "confirmation_required",
    "busy",
    "io",
    "bad_json",
    "unknown_op",
    "something_new",
  ];

  it("turns every DeviceError code into a plain sentence without the code", () => {
    for (const code of codes) {
      const s = describeConnectError(new DeviceError(code, "internal detail"));
      expect(s, code).toMatch(/^[A-Z].*\.$/);
      expect(s, code).not.toContain("_");
      expect(s, code).not.toContain("internal detail");
    }
  });

  it("gives specific advice for the common ones", () => {
    expect(describeConnectError(new DeviceError("timeout"))).toMatch(/did not respond/i);
    expect(describeConnectError(new DeviceError("disconnected"))).toMatch(/lost|closed/i);
    expect(describeConnectError(new DeviceError("write_failed", "x"))).toMatch(/send/i);
  });

  it("is empty for proto_mismatch: the app state carries it", () => {
    expect(describeConnectError(new DeviceError("proto_mismatch", "device proto 9"))).toBe("");
  });

  it("keeps the readable message of other errors", () => {
    expect(describeConnectError(new Error("User cancelled the requestDevice() chooser."))).toBe(
      "User cancelled the requestDevice() chooser.",
    );
  });

  it("names DOM errors of Web Bluetooth", () => {
    const notFound = Object.assign(new Error("x"), { name: "NotFoundError" });
    expect(describeConnectError(notFound)).toMatch(/no device/i);
    const denied = Object.assign(new Error("x"), { name: "SecurityError" });
    expect(describeConnectError(denied)).toMatch(/permission|denied|allowed/i);
  });

  it("copes with things that are not errors", () => {
    expect(describeConnectError(undefined)).toMatch(/^Could not connect/);
    expect(describeConnectError("boom")).toBe("boom");
    expect(describeConnectError(new Error(""))).toMatch(/^Could not connect/);
  });
});
