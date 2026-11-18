import { describe, expect, it } from "vitest";
import { fmtAge, fmtClock, fmtDb, fmtDistance, NO_VALUE } from "../src/ui/format.ts";

describe("fmtDistance", () => {
  it("meters below 1 km", () => {
    expect(fmtDistance(0)).toBe("0 m");
    expect(fmtDistance(850)).toBe("850 m");
    expect(fmtDistance(999.4)).toBe("999 m");
  });
  it("carries over to km where the rounded meters would read 1000", () => {
    expect(fmtDistance(999.5)).toBe("1.0 km");
    expect(fmtDistance(999.6)).toBe("1.0 km");
    expect(fmtDistance(1000)).toBe("1.0 km");
  });
  it("one decimal from 1 km up to 100 km", () => {
    expect(fmtDistance(1234)).toBe("1.2 km");
    expect(fmtDistance(12_345)).toBe("12.3 km");
    expect(fmtDistance(99_949)).toBe("99.9 km");
  });
  it("carries over to whole km where one decimal would read 100.0", () => {
    expect(fmtDistance(99_950)).toBe("100 km");
    expect(fmtDistance(99_999.96)).toBe("100 km");
    expect(fmtDistance(100_000)).toBe("100 km");
  });
  it("whole km from 100 km up", () => {
    expect(fmtDistance(245_400)).toBe("245 km");
    expect(fmtDistance(245_600)).toBe("246 km");
  });
  it("shows a dash for a value that is missing or not finite", () => {
    for (const v of [undefined, NaN, Infinity, -Infinity]) expect(fmtDistance(v)).toBe(NO_VALUE);
  });
  it("a tiny negative value is 0 m, not -0 m", () => {
    expect(fmtDistance(-0.2)).toBe("0 m");
  });
});

describe("fmtDb", () => {
  it("one decimal", () => {
    expect(fmtDb(-27.5)).toBe("-27.5 dB");
    expect(fmtDb(3)).toBe("3.0 dB");
    expect(fmtDb(-31.25)).toBe("-31.3 dB");
  });
  it("never shows negative zero", () => {
    expect(fmtDb(-0.04)).toBe("0.0 dB");
    expect(fmtDb(-0)).toBe("0.0 dB");
    expect(fmtDb(0)).toBe("0.0 dB");
    expect(fmtDb(0.04)).toBe("0.0 dB");
  });
  it("keeps the sign of a value that rounds to a non-zero number", () => {
    expect(fmtDb(-0.06)).toBe("-0.1 dB");
  });
  it("shows a dash for a value that is missing or not finite", () => {
    for (const v of [undefined, NaN, Infinity]) expect(fmtDb(v)).toBe(NO_VALUE);
  });
});

describe("fmtAge", () => {
  it("seconds, minutes, hours, days", () => {
    expect(fmtAge(45)).toBe("45 s");
    expect(fmtAge(125)).toBe("2 min");
    expect(fmtAge(7300)).toBe("2 h");
    expect(fmtAge(3 * 86400)).toBe("3 d");
  });
  it("a dash for an invalid age", () => {
    for (const v of [undefined, NaN, -1]) expect(fmtAge(v)).toBe(NO_VALUE);
  });
});

describe("fmtClock", () => {
  it("is HH:MM:SS in local time, zero padded", () => {
    expect(fmtClock(new Date(2026, 10, 18, 3, 4, 5).getTime())).toBe("03:04:05");
  });
});
