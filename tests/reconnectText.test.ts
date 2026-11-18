import { describe, expect, it } from "vitest";
import { reconnectText } from "../src/ui/connectView.ts";

describe("reconnectText", () => {
  it("is empty without a reconnect", () => {
    expect(reconnectText(undefined, 0, 20)).toBeUndefined();
  });
  it("counts down to the next try, rounding up and never below 0", () => {
    expect(reconnectText({ attempt: 2, at: 10_500 }, 8_000, 20)).toBe(
      "Link lost. Reconnecting in 3 s (attempt 2 of 20).",
    );
    expect(reconnectText({ attempt: 2, at: 1000 }, 5000, 20)).toBe(
      "Link lost. Reconnecting in 0 s (attempt 2 of 20).",
    );
  });
  it("says a try is running", () => {
    expect(reconnectText({ attempt: 1, at: undefined }, 0, 20)).toBe(
      "Link lost. Reconnecting… (attempt 1 of 20)",
    );
  });
});
