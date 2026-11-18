import { describe, expect, it } from "vitest";
import { bearingDeg, distanceM } from "../src/aprs/geo.ts";
import {
  CENTER,
  formatRingLabel,
  isOutOfRange,
  MIN_DOT_FRACTION,
  OUTER_R,
  placeStation,
  polarToXY,
  radiusFraction,
  ringValues,
} from "../src/ui/radarGeometry.ts";

const MAX = 50_000;

describe("radiusFraction", () => {
  it.each(["linear", "log"] as const)("is 0 at distance 0 and 1 at exactly max (%s)", (scale) => {
    expect(radiusFraction(0, MAX, scale)).toBe(0);
    expect(radiusFraction(MAX, MAX, scale)).toBeCloseTo(1, 12);
  });
  it.each(["linear", "log"] as const)("clamps beyond max to 1 (%s)", (scale) => {
    expect(radiusFraction(MAX * 10, MAX, scale)).toBe(1);
    expect(radiusFraction(Infinity, MAX, scale)).toBe(0); // not finite: treated as invalid
  });
  it("linear is proportional", () => {
    expect(radiusFraction(12_500, MAX, "linear")).toBeCloseTo(0.25, 12);
  });
  it("log shows near stations much further out than linear", () => {
    const lin = radiusFraction(100, MAX, "linear");
    const log = radiusFraction(100, MAX, "log");
    expect(lin).toBeLessThan(0.01);
    expect(log).toBeGreaterThan(0.3);
  });
  it("log is strictly increasing", () => {
    let prev = -1;
    for (const d of [0, 1, 10, 100, 1000, 5000, 20_000, 49_999, 50_000]) {
      const f = radiusFraction(d, MAX, "log");
      expect(f).toBeGreaterThan(prev);
      prev = f;
    }
  });
  it("handles negative and invalid input without NaN", () => {
    expect(radiusFraction(-5, MAX, "log")).toBe(0);
    expect(radiusFraction(NaN, MAX, "linear")).toBe(0);
    expect(radiusFraction(100, 0, "log")).toBe(0);
    expect(radiusFraction(100, NaN, "linear")).toBe(0);
  });
});

describe("polarToXY (north up, clockwise)", () => {
  const at = (b: number) => polarToXY(1, b);
  it("0 deg is straight up", () => {
    expect(at(0).x).toBeCloseTo(CENTER, 9);
    expect(at(0).y).toBeCloseTo(CENTER - OUTER_R, 9);
  });
  it("90 deg is right, 180 down, 270 left", () => {
    expect(at(90).x).toBeCloseTo(CENTER + OUTER_R, 9);
    expect(at(90).y).toBeCloseTo(CENTER, 9);
    expect(at(180).x).toBeCloseTo(CENTER, 9);
    expect(at(180).y).toBeCloseTo(CENTER + OUTER_R, 9);
    expect(at(270).x).toBeCloseTo(CENTER - OUTER_R, 9);
    expect(at(270).y).toBeCloseTo(CENTER, 9);
  });
  it("fraction 0 is the centre", () => {
    expect(polarToXY(0, 123)).toEqual({ x: CENTER, y: CENTER });
  });
  it("agrees with real coordinates: a station due east of the tracker is drawn to the right", () => {
    const me = { lat: 35.68124, lon: 139.76712 };
    const east = { lat: me.lat, lon: me.lon + 0.05 };
    const p = placeStation(distanceM(me, east), bearingDeg(me, east), MAX, "linear");
    expect(p.x).toBeGreaterThan(CENTER);
    expect(Math.abs(p.y - CENTER)).toBeLessThan(1);
    const north = { lat: me.lat + 0.05, lon: me.lon };
    const q = placeStation(distanceM(me, north), bearingDeg(me, north), MAX, "linear");
    expect(q.y).toBeLessThan(CENTER);
    expect(Math.abs(q.x - CENTER)).toBeLessThan(1);
  });
});

describe("placeStation", () => {
  it("keeps a station at distance 0 off the centre marker", () => {
    const p = placeStation(0, 0, MAX, "log");
    expect(p.frac).toBe(MIN_DOT_FRACTION);
    expect(p.outOfRange).toBe(false);
  });
  it("max exactly is in range and on the rim", () => {
    const p = placeStation(MAX, 90, MAX, "linear");
    expect(p.outOfRange).toBe(false);
    expect(p.frac).toBeCloseTo(1, 12);
  });
  it("beyond max is out of range and drawn on the rim, in the right direction", () => {
    const p = placeStation(MAX + 1, 270, MAX, "log");
    expect(p.outOfRange).toBe(true);
    expect(p.frac).toBe(1);
    expect(p.x).toBeCloseTo(CENTER - OUTER_R, 9);
  });
  it("a bearing that is not finite does not produce NaN", () => {
    const p = placeStation(1000, NaN, MAX, "linear");
    expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
  });
  it("100 m and 400 km both work on a 500 km log range (and linear keeps them apart from the centre)", () => {
    for (const scale of ["log", "linear"] as const) {
      const near = placeStation(100, 45, 500_000, scale);
      const far = placeStation(400_000, 225, 500_000, scale);
      expect(near.outOfRange).toBe(false);
      expect(far.outOfRange).toBe(false);
      expect(far.frac).toBeGreaterThan(near.frac);
      expect(far.frac).toBeLessThanOrEqual(1);
    }
  });
  it("isOutOfRange", () => {
    expect(isOutOfRange(MAX, MAX)).toBe(false);
    expect(isOutOfRange(MAX + 0.001, MAX)).toBe(true);
  });
});

describe("ringValues", () => {
  it.each([5, 10, 20, 50, 100, 500, 7, 1, 0.3])(
    "ends with the max, ascending, unique (%s km)",
    (km) => {
      for (const scale of ["log", "linear"] as const) {
        const r = ringValues(km * 1000, scale);
        expect(r.at(-1)).toBe(km * 1000);
        for (let i = 1; i < r.length; i++) expect(r[i]!).toBeGreaterThan(r[i - 1]!);
        expect(r.length).toBeGreaterThanOrEqual(2);
        expect(r.length).toBeLessThanOrEqual(7);
      }
    },
  );
  it("linear: evenly spaced at a round step", () => {
    expect(ringValues(50_000, "linear")).toEqual([10_000, 20_000, 30_000, 40_000, 50_000]);
    expect(ringValues(100_000, "linear")).toEqual([20_000, 40_000, 60_000, 80_000, 100_000]);
    expect(ringValues(5_000, "linear")).toEqual([1000, 2000, 3000, 4000, 5000]);
  });
  it("log: decades, with room between rings", () => {
    const r = ringValues(50_000, "log");
    expect(r).toEqual([100, 1000, 10_000, 50_000]);
    const fr = r.map((m) => radiusFraction(m, 50_000, "log"));
    for (let i = 1; i < fr.length; i++) expect(fr[i]! - fr[i - 1]!).toBeGreaterThanOrEqual(0.12);
  });
  it("log rings are never packed together or at the centre", () => {
    for (const km of [1, 5, 10, 20, 50, 100, 500, 5000]) {
      const fr = ringValues(km * 1000, "log").map((m) => radiusFraction(m, km * 1000, "log"));
      expect(fr[0]!).toBeGreaterThanOrEqual(0.1);
      for (let i = 1; i < fr.length; i++) expect(fr[i]! - fr[i - 1]!).toBeGreaterThanOrEqual(0.11);
    }
  });
  it("an invalid max has no rings", () => {
    expect(ringValues(0, "log")).toEqual([]);
    expect(ringValues(NaN, "linear")).toEqual([]);
  });
});

describe("formatRingLabel", () => {
  it("uses m below 1 km and km above", () => {
    expect(formatRingLabel(100)).toBe("100 m");
    expect(formatRingLabel(1000)).toBe("1 km");
    expect(formatRingLabel(1500)).toBe("1.5 km");
    expect(formatRingLabel(50_000)).toBe("50 km");
    expect(formatRingLabel(NaN)).toBe("");
  });
});
