import { describe, expect, it } from "vitest";
import { isParseError, parseMessage, rxKind } from "../src/protocol/types.ts";

describe("parseMessage", () => {
  it("keeps unknown keys", () => {
    const m = parseMessage('{"t":"status","fix":3,"future_key":[1,2]}');
    expect(isParseError(m)).toBe(false);
    expect(m).toMatchObject({ t: "status", fix: 3, future_key: [1, 2] });
  });

  it("passes an unknown t through", () => {
    expect(parseMessage('{"t":"newthing","x":1}')).toEqual({ t: "newthing", x: 1 });
  });

  it("reports unreadable lines", () => {
    for (const line of ["{", "not json", "[1,2]", "5", "null", '{"no_t":1}', '{"t":5}']) {
      expect(isParseError(parseMessage(line)), line).toBe(true);
    }
  });

  it("treats a non-integer id as absent", () => {
    expect(parseMessage('{"t":"hello","id":1.5}')).not.toHaveProperty("id");
    expect(parseMessage('{"t":"hello","id":"1"}')).not.toHaveProperty("id");
    expect(parseMessage('{"t":"hello","id":7}')).toHaveProperty("id", 7);
  });
});

describe("rxKind", () => {
  it("returns known kinds", () => {
    expect(rxKind({ kind: "mice" })).toBe("mice");
    expect(rxKind({ kind: "position" })).toBe("position");
  });

  it("maps unknown or missing kinds to other", () => {
    expect(rxKind({ kind: "telemetry" })).toBe("other");
    expect(rxKind({})).toBe("other");
    expect(rxKind({ kind: 5 })).toBe("other");
  });
});
