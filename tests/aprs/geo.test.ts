import { describe, expect, it } from "vitest";
import { bearingDeg, cardinal, distanceM, formatLatLon, gridToLatLon } from "../../src/aprs/geo.ts";
import { symbolInfo, symbolName } from "../../src/aprs/symbols.ts";

describe("distanceM", () => {
  it("is one degree of arc along the equator and a meridian", () => {
    const oneDegree = (2 * Math.PI * 6371008.8) / 360;
    expect(distanceM({ lat: 0, lon: 0 }, { lat: 0, lon: 1 })).toBeCloseTo(oneDegree, 1);
    expect(distanceM({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeCloseTo(oneDegree, 1);
  });

  it("is zero for the same point and symmetric", () => {
    const a = { lat: 35.68, lon: 139.76 };
    const b = { lat: 35.7, lon: 139.8 };
    expect(distanceM(a, a)).toBe(0);
    expect(distanceM(a, b)).toBeCloseTo(distanceM(b, a), 6);
  });

  it("works across the antimeridian", () => {
    const d = distanceM({ lat: 0, lon: 179.5 }, { lat: 0, lon: -179.5 });
    expect(d).toBeCloseTo((2 * Math.PI * 6371008.8) / 360, 1);
  });
});

describe("bearingDeg", () => {
  const o = { lat: 0, lon: 0 };
  it("gives the four directions", () => {
    expect(bearingDeg(o, { lat: 1, lon: 0 })).toBeCloseTo(0, 6);
    expect(bearingDeg(o, { lat: 0, lon: 1 })).toBeCloseTo(90, 6);
    expect(bearingDeg(o, { lat: -1, lon: 0 })).toBeCloseTo(180, 6);
    expect(bearingDeg(o, { lat: 0, lon: -1 })).toBeCloseTo(270, 6);
  });

  it("stays below 360 just west of north, and is 0 for the same point", () => {
    const b = bearingDeg(o, { lat: 1, lon: -0.0001 });
    expect(b).toBeGreaterThan(359.9);
    expect(b).toBeLessThan(360);
    expect(bearingDeg(o, o)).toBe(0);
  });
});

describe("cardinal", () => {
  it("names the 16 points", () => {
    expect(cardinal(0)).toBe("N");
    expect(cardinal(22.5)).toBe("NNE");
    expect(cardinal(45)).toBe("NE");
    expect(cardinal(90)).toBe("E");
    expect(cardinal(180)).toBe("S");
    expect(cardinal(270)).toBe("W");
    expect(cardinal(337.5)).toBe("NNW");
    expect(cardinal(359)).toBe("N");
    expect(cardinal(-90)).toBe("W");
  });
});

describe("formatLatLon", () => {
  it("shows degrees and decimal minutes", () => {
    expect(formatLatLon({ lat: 35.68, lon: 139.76 })).toBe("35°40.800'N 139°45.600'E");
    expect(formatLatLon({ lat: -(33 + 56.32 / 60), lon: -(118 + 25.43 / 60) })).toBe(
      "33°56.320'S 118°25.430'W",
    );
    expect(formatLatLon({ lat: 5.0875, lon: 7.0 })).toBe("05°05.250'N 007°00.000'E");
  });
});

describe("gridToLatLon", () => {
  it("returns the center of the square", () => {
    const six = gridToLatLon("IO91SX")!;
    expect(six.lat).toBeCloseTo(51.9792, 3);
    expect(six.lon).toBeCloseTo(-0.4583, 3);
    expect(gridToLatLon("IO91")).toEqual({ lat: 51.5, lon: -1 });
    expect(gridToLatLon("io91sx")!.lat).toBeCloseTo(51.9792, 3);
  });

  it("rejects invalid locators", () => {
    expect(gridToLatLon("ZZ99")).toBeNull();
    expect(gridToLatLon("IO9")).toBeNull();
    expect(gridToLatLon("")).toBeNull();
  });
});

describe("symbols", () => {
  it("names primary and alternate symbols", () => {
    expect(symbolName({ table: "/", code: ">" })).toBe("Car");
    expect(symbolName({ table: "/", code: "[" })).toBe("Person");
    expect(symbolName({ table: "\\", code: "#", overlay: "1" })).toBe("Digipeater (overlay 1)");
  });

  it("has categories for the UI", () => {
    expect(symbolInfo({ table: "/", code: ">" }).category).toBe("vehicle");
    expect(symbolInfo({ table: "/", code: "[" }).category).toBe("person");
    expect(symbolInfo({ table: "/", code: "-" }).category).toBe("fixed");
    expect(symbolInfo({ table: "/", code: "#" }).category).toBe("digi");
    expect(symbolInfo({ table: "/", code: "_" }).category).toBe("weather");
  });

  it("falls back for unknown codes", () => {
    // "D" is reserved in the primary table of APRS101
    expect(symbolInfo({ table: "/", code: "D" })).toEqual({
      name: "Symbol /D",
      category: "other",
      known: false,
    });
  });
});
