import { describe, expect, it } from "vitest";
import { expectType } from "./util.ts";

const MPH = 0.44704;

describe("position-less weather report", () => {
  const d = expectType("Q1WX>APRS:_10090556c220s004g005t077r000p000P000h50b09900wRSW", "weather");

  it("reads the timestamp", () => {
    expect(d.timestamp).toEqual({ format: "mdhm", month: 10, day: 9, hour: 5, minute: 56 });
  });

  it("converts to metric", () => {
    expect(d.weather.windDirDeg).toBe(220);
    expect(d.weather.windSpeedMs).toBeCloseTo(4 * MPH, 6);
    expect(d.weather.gustMs).toBeCloseTo(5 * MPH, 6);
    expect(d.weather.tempC).toBeCloseTo(25, 6);
    expect(d.weather.rain1hMm).toBe(0);
    expect(d.weather.humidity).toBe(50);
    expect(d.weather.pressureHpa).toBeCloseTo(990, 6);
  });

  it("keeps the trailing software code", () => {
    expect(d.weather.extra).toBe("wRSW");
  });

  it("leaves out missing values", () => {
    const m = expectType("Q1WX>APRS:_10090556c...s...g...t...r...p...P...h..b.....", "weather");
    expect(m.weather).toEqual({});
  });

  it("handles negative temperatures, h00, rain and luminosity", () => {
    const w = expectType(
      "Q1WX>APRS:_10090556c180s010g015t-05r010p100P250h00b10132L123",
      "weather",
    ).weather;
    expect(w.tempC).toBeCloseTo(((-5 - 32) * 5) / 9, 6);
    expect(w.humidity).toBe(100);
    expect(w.rain1hMm).toBeCloseTo(2.54, 6);
    expect(w.rain24hMm).toBeCloseTo(25.4, 6);
    expect(w.rainMidnightMm).toBeCloseTo(63.5, 6);
    expect(w.pressureHpa).toBeCloseTo(1013.2, 6);
    expect(w.luminosityWm2).toBe(123);
    const l = expectType("Q1WX>APRS:_10090556c180s010l012", "weather").weather;
    expect(l.luminosityWm2).toBe(1012);
  });

  it("stops at text that is not a field", () => {
    const w = expectType("Q1WX>APRS:_10090556c180s010tnc", "weather").weather;
    expect(w.windDirDeg).toBe(180);
    expect(w.tempC).toBeUndefined();
    expect(w.extra).toBe("tnc");
  });
});

describe("weather after a position", () => {
  it("reads wind from ccc/sss and the fields that follow", () => {
    const d = expectType(
      "Q1WX>APRS:!4903.50N/07201.75W_220/004g005t077r000p000P000h50b09900wRSW",
      "position",
    );
    const w = d.position.weather!;
    expect(d.position.symbol.code).toBe("_");
    expect(w.windDirDeg).toBe(220);
    expect(w.windSpeedMs).toBeCloseTo(4 * MPH, 6);
    expect(w.gustMs).toBeCloseTo(5 * MPH, 6);
    expect(w.tempC).toBeCloseTo(25, 6);
    expect(w.humidity).toBe(50);
    expect(w.pressureHpa).toBeCloseTo(990, 6);
    expect(d.position.comment).toBe("wRSW");
    expect(d.position.courseDeg).toBeUndefined();
  });

  it("reads s as snowfall (inches -> mm) after the wind prefix", () => {
    const w = expectType("Q1WX>APRS:!4903.50N/07201.75W_220/004g005t077s.50", "position").position
      .weather!;
    expect(w.snowMm).toBeCloseTo(12.7, 6);
    expect(w.windSpeedMs).toBeCloseTo(4 * MPH, 6);
  });

  it("works with a timestamp", () => {
    const d = expectType("Q1WX>APRS:@092345z4903.50N/07201.75W_090/000t050", "position");
    expect(d.position.weather?.windDirDeg).toBe(90);
    expect(d.position.weather?.windSpeedMs).toBe(0);
    expect(d.position.weather?.tempC).toBeCloseTo(10, 6);
  });
});
