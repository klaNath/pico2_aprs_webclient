import { describe, expect, it } from "vitest";
import { base91 } from "../../src/aprs/compressed.ts";
import { parseAprs } from "../../src/aprs/parse.ts";
import { expectType } from "./util.ts";

describe("base91", () => {
  it("decodes", () => {
    expect(base91("!")).toBe(0);
    expect(base91("!#")).toBe(2);
    expect(base91('"!')).toBe(91);
    expect(base91("{")).toBe(90);
  });
  it("rejects characters outside ! to {", () => {
    expect(base91(" ")).toBeNaN();
    expect(base91("|")).toBeNaN();
  });
});

describe("compressed position (APRS101 example)", () => {
  // =/5L!!<*e7>7P[  ->  49 30.00N, 72 45.00W, course 88, speed 36.2 knots
  const d = expectType("Q1TEST>APRS:=/5L!!<*e7>7P[", "position");

  it("decodes the position", () => {
    expect(d.position.lat).toBeCloseTo(49.5, 4);
    expect(d.position.lon).toBeCloseTo(-72.75, 4);
    expect(d.position.compressed).toBe(true);
    expect(d.position.symbol).toEqual({ table: "/", code: ">" });
    expect(d.messaging).toBe(true);
  });

  it("decodes course and speed from cs", () => {
    expect(d.position.courseDeg).toBe(88);
    expect(d.position.speedKmh).toBeCloseTo((1.08 ** 47 - 1) * 1.852, 6);
    expect(d.position.speedKmh).toBeCloseTo(67.1, 1);
  });

  it("keeps the text after the block as the comment", () => {
    expect(expectType("Q1TEST>APRS:!/5L!!<*e7>7P[Hi there", "position").position.comment).toBe(
      "Hi there",
    );
  });
});

describe("compressed symbol table", () => {
  it("maps a-j to the overlays 0-9 and keeps A-Z", () => {
    expect(expectType("Q1TEST>APRS:=a5L!!<*e7>7P[", "position").position.symbol).toEqual({
      table: "\\",
      code: ">",
      overlay: "0",
    });
    expect(expectType("Q1TEST>APRS:=j5L!!<*e7>7P[", "position").position.symbol.overlay).toBe("9");
    expect(expectType("Q1TEST>APRS:=A5L!!<*e7>7P[", "position").position.symbol.overlay).toBe("A");
    expect(expectType("Q1TEST>APRS:=\\5L!!<*e7>7P[", "position").position.symbol).toEqual({
      table: "\\",
      code: ">",
    });
  });
});

describe("compressed cs field", () => {
  it("decodes a radio range when c is {", () => {
    const d = expectType("Q1TEST>APRS:=/5L!!<*e7>{7[", "position");
    expect(d.position.rangeM).toBeCloseTo(2 * 1.08 ** 22 * 1609.344, 3);
    expect(d.position.courseDeg).toBeUndefined();
    expect(d.position.speedKmh).toBeUndefined();
  });

  it("decodes an altitude when the T byte says GGA", () => {
    // T = 0b110000 (current fix, GGA) -> 'Q'; cs "S!" = 50*91 + 0
    const d = expectType("Q1TEST>APRS:=/5L!!<*e7>S!Q", "position");
    expect(d.position.altitudeM).toBeCloseTo(1.002 ** 4550 * 0.3048, 3);
    expect(d.position.speedKmh).toBeUndefined();
  });

  it("has no extra data when cs is blank", () => {
    const d = expectType("Q1TEST>APRS:=/5L!!<*e7>  !", "position");
    expect(d.position.courseDeg).toBeUndefined();
    expect(d.position.speedKmh).toBeUndefined();
    expect(d.position.altitudeM).toBeUndefined();
  });
});

describe("compressed weather", () => {
  it("reads the weather fields after the block and leaves the wind from cs alone", () => {
    const d = expectType("Q1WX>APRS:=/5L!!<*e7_  !g005t077", "position");
    expect(d.position.weather?.gustMs).toBeCloseTo(5 * 0.44704, 6);
    expect(d.position.weather?.tempC).toBeCloseTo(25, 6);
    expect(d.position.speedKmh).toBeUndefined();
  });
});

describe("bad compressed positions", () => {
  it("are unknown", () => {
    for (const line of [
      "Q1TEST>APRS:=/5L!!<*e7",
      "Q1TEST>APRS:=/5L!!<*e7>7P",
      "Q1TEST>APRS:=/\x7f5L!!<*e>7P[",
    ]) {
      expect(parseAprs(line).data.type, line).toBe("unknown");
    }
  });
});
