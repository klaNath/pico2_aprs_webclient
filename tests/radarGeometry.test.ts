import { describe, expect, it } from "vitest";
import { bearingDeg, distanceM } from "../src/aprs/geo.ts";
import {
  AT_POSITION_M,
  CENTER,
  COMPASS_R,
  fallbackBearing,
  FALLBACK_BEARING_DEG,
  formatRingLabel,
  isOutOfRange,
  MAX_LABEL_CHARS,
  MIN_DOT_FRACTION,
  nearestStation,
  OUT_OF_RANGE_R,
  OUTER_R,
  OWN_MARK_R,
  OWN_MARK_STROKE,
  placeStation,
  polarToXY,
  radiusFraction,
  ringValues,
  shortLabel,
  tabStops,
  unitsForPx,
  VIEW_SIZE,
  type HitPoint,
} from "../src/ui/radarGeometry.ts";

const MAX = 50_000;

describe("radiusFraction", () => {
  it.each(["linear", "log"] as const)("is 0 at distance 0 and 1 at exactly max (%s)", (scale) => {
    expect(radiusFraction(0, MAX, scale)).toBe(0);
    expect(radiusFraction(MAX, MAX, scale)).toBeCloseTo(1, 12);
  });
  it.each(["linear", "log"] as const)("clamps beyond max to 1 (%s)", (scale) => {
    expect(radiusFraction(MAX * 10, MAX, scale)).toBe(1);
  });
  it.each(["linear", "log"] as const)(
    "a distance of Infinity is beyond the range: 1 (%s)",
    (scale) => {
      // Too far to be drawn is the outer edge (out of range), not "invalid" and not the centre.
      expect(radiusFraction(Infinity, MAX, scale)).toBe(1);
      expect(radiusFraction(-Infinity, MAX, scale)).toBe(0);
      expect(radiusFraction(NaN, MAX, scale)).toBe(0);
    },
  );
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
  it("keeps a station at distance 0 clear of the marker of this tracker", () => {
    for (const scale of ["log", "linear"] as const) {
      for (const bearing of [0, 45, 135, 200, 315]) {
        const p = placeStation(0, bearing, MAX, scale);
        expect(p.outOfRange).toBe(false);
        // On the screen the dot's centre is further out than the edge of the own-position ring
        // (radius plus half of its stroke), so the dot is not under it.
        const dist = Math.hypot(p.x - CENTER, p.y - CENTER);
        expect(dist).toBeGreaterThan(OWN_MARK_R + OWN_MARK_STROKE / 2);
        expect(dist).toBeCloseTo(OUTER_R * MIN_DOT_FRACTION, 9);
      }
    }
  });
  it("a station at your position (no bearing) is not drawn due north", () => {
    for (const b of [undefined, NaN]) {
      const p = placeStation(0, b, MAX, "log");
      expect(Math.abs(p.x - CENTER)).toBeGreaterThan(1); // not straight up
      expect(p.x).toBeCloseTo(polarToXY(p.frac, FALLBACK_BEARING_DEG).x, 9);
    }
  });
  it("fallbackBearing is stable, never north, and spreads callsigns around", () => {
    expect(fallbackBearing("Q1AAA")).toBe(fallbackBearing("Q1AAA"));
    const seen = new Set<number>();
    for (let i = 0; i < 64; i++) {
      const b = fallbackBearing(`Q1T${i}`);
      expect(b % 45).toBe(22.5);
      seen.add(b);
    }
    expect(seen.size).toBeGreaterThan(4);
    expect(AT_POSITION_M).toBeGreaterThan(0);
  });
  it("max exactly is in range and on the rim", () => {
    const p = placeStation(MAX, 90, MAX, "linear");
    expect(p.outOfRange).toBe(false);
    expect(p.frac).toBeCloseTo(1, 12);
  });
  it("beyond max is out of range and drawn outside the ring, in the right direction", () => {
    const p = placeStation(MAX + 1, 270, MAX, "log");
    expect(p.outOfRange).toBe(true);
    expect(p.frac).toBeCloseTo(OUT_OF_RANGE_R / OUTER_R, 12);
    expect(p.x).toBeCloseTo(CENTER - OUT_OF_RANGE_R, 9);
    expect(placeStation(Infinity, 0, MAX, "log").outOfRange).toBe(true);
  });
  it("the out-of-range circle is outside the outer ring and inside the compass letters", () => {
    expect(OUT_OF_RANGE_R).toBeGreaterThan(OUTER_R + 6);
    // Room for a mark of radius 7 and a letter about 9 units high between them.
    expect(COMPASS_R - 4.5).toBeGreaterThan(OUT_OF_RANGE_R + 7);
    expect(COMPASS_R + 6).toBeLessThan(VIEW_SIZE / 2);
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

describe("nearestStation (taps)", () => {
  const pt = (id: string, x: number, y: number): HitPoint => ({ id, x, y });

  it("picks the nearest point within the radius", () => {
    const pts = [pt("a", 100, 100), pt("b", 110, 100), pt("c", 150, 150)];
    expect(nearestStation(pts, 102, 100, 14)?.id).toBe("a");
    expect(nearestStation(pts, 108, 100, 14)?.id).toBe("b");
    expect(nearestStation(pts, 149, 149, 14)?.id).toBe("c");
  });
  it("overlapping dots: always the one nearest to the tap, not the one drawn first", () => {
    // Two dots 6 units apart (closer than one fingertip). Tapping on either picks that one.
    const pts = [pt("a", 100, 100), pt("b", 106, 100)];
    expect(nearestStation(pts, 99, 100, 14)?.id).toBe("a");
    expect(nearestStation(pts, 107, 100, 14)?.id).toBe("b");
    expect(nearestStation(pts, 102.9, 100, 14)?.id).toBe("a");
    expect(nearestStation(pts, 103.1, 100, 14)?.id).toBe("b");
    expect(nearestStation([...pts].reverse(), 99, 100, 14)?.id).toBe("a");
  });
  it("a crowd: every dot is picked by a tap on its own centre", () => {
    const pts: HitPoint[] = [];
    for (let i = 0; i < 64; i++) {
      const p = placeStation(500 + i * 700, (i * 137.5) % 360, MAX, "log");
      pts.push(pt(`Q1S${i}`, p.x, p.y));
    }
    for (const p of pts) expect(nearestStation(pts, p.x, p.y, 14)?.id).toBe(p.id);
  });
  it("identical points: one of them, the later one (drawn on top)", () => {
    const pts = [pt("a", 100, 100), pt("b", 100, 100)];
    expect(nearestStation(pts, 100, 100, 14)?.id).toBe("b");
    expect(nearestStation(pts, 103, 100, 14)?.id).toBe("b");
  });
  it("nothing within the radius: undefined (the radius is inclusive)", () => {
    const pts = [pt("a", 100, 100)];
    expect(nearestStation(pts, 100, 114.1, 14)).toBeUndefined();
    expect(nearestStation(pts, 100, 114, 14)?.id).toBe("a");
    expect(nearestStation(pts, 300, 300, 14)).toBeUndefined();
  });
  it("no points, or a tap or radius that is not a number", () => {
    expect(nearestStation([], 1, 1, 14)).toBeUndefined();
    expect(nearestStation([pt("a", 1, 1)], NaN, 1, 14)).toBeUndefined();
    expect(nearestStation([pt("a", 1, 1)], 1, 1, NaN)).toBeUndefined();
    expect(nearestStation([pt("a", 1, 1)], 1, 1, -1)).toBeUndefined();
  });
});

describe("unitsForPx (sizes that must not shrink with the screen)", () => {
  it("converts screen pixels to viewBox units", () => {
    expect(unitsForPx(24, 240)).toBe(24);
    expect(unitsForPx(24, 480)).toBe(12);
    expect(unitsForPx(1, 296)).toBeCloseTo(240 / 296, 12);
  });
  it("a tap radius of 24 px covers at least 22 px at the narrowest and the widest screens", () => {
    for (const w of [288, 296, 344, 380, 560]) {
      const units = unitsForPx(24, w);
      expect((units * w) / VIEW_SIZE).toBeCloseTo(24, 9);
    }
  });
  it("falls back to 1:1 when the width is not known", () => {
    expect(unitsForPx(11, 0)).toBe(11);
    expect(unitsForPx(11, NaN)).toBe(11);
  });
});

describe("shortLabel", () => {
  it("keeps short names and cuts long ones with an ellipsis", () => {
    expect(shortLabel("Q1TEST-7")).toBe("Q1TEST-7");
    expect(shortLabel("A".repeat(MAX_LABEL_CHARS))).toBe("A".repeat(MAX_LABEL_CHARS));
    expect(shortLabel("A".repeat(MAX_LABEL_CHARS + 1))).toBe(`${"A".repeat(MAX_LABEL_CHARS)}…`);
    expect(shortLabel("Q1VERYLONGCALLSIGN-15")).toBe("Q1VERYLONGCA…");
  });
  it("counts characters, not UTF-16 units", () => {
    expect(shortLabel("😀".repeat(12))).toBe("😀".repeat(12));
    expect(shortLabel("😀".repeat(13))).toBe(`${"😀".repeat(12)}…`);
  });
});

describe("tabStops (keyboard access with many stations)", () => {
  const ids = Array.from({ length: 64 }, (_, i) => `Q1S${i}`);
  it("gives every station a stop when there are few", () => {
    expect(tabStops(ids.slice(0, 5), undefined)).toEqual(new Set(ids.slice(0, 5)));
    expect(tabStops(ids.slice(0, 16), undefined).size).toBe(16);
  });
  it("at most 16 stops, the first (nearest) ones, with 64 stations", () => {
    const s = tabStops(ids, undefined);
    expect(s.size).toBe(16);
    expect(s.has("Q1S0")).toBe(true);
    expect(s.has("Q1S15")).toBe(true);
    expect(s.has("Q1S16")).toBe(false);
  });
  it("the selected station always has a stop, one more than the limit", () => {
    const s = tabStops(ids, "Q1S40");
    expect(s.size).toBe(17);
    expect(s.has("Q1S40")).toBe(true);
    expect(tabStops(ids, "Q1S3").size).toBe(16);
  });
  it("a selection that is not on the radar is ignored", () => {
    expect(tabStops(ids, "Q1GONE").size).toBe(16);
  });
});
