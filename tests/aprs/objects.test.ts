import { describe, expect, it } from "vitest";
import { parseAprs } from "../../src/aprs/parse.ts";
import { expectType } from "./util.ts";

describe("object", () => {
  it("parses a live object with position and extension", () => {
    const d = expectType("Q1AAA>APRS:;LEADER   *092345z4903.50N/07201.75W>088/036Convoy", "object");
    expect(d.name).toBe("LEADER");
    expect(d.live).toBe(true);
    expect(d.timestamp).toEqual({ format: "dhm-z", day: 9, hour: 23, minute: 45 });
    expect(d.position.lat).toBeCloseTo(49 + 3.5 / 60, 8);
    expect(d.position.courseDeg).toBe(88);
    expect(d.position.comment).toBe("Convoy");
  });

  it("parses a killed object and a 9-character name", () => {
    const d = expectType("Q1AAA>APRS:;ABCDEFGHI_092345z4903.50N/07201.75W>", "object");
    expect(d.name).toBe("ABCDEFGHI");
    expect(d.live).toBe(false);
  });

  it("parses a compressed object", () => {
    const d = expectType("Q1AAA>APRS:;OBJ      *092345z/5L!!<*e7>7P[", "object");
    expect(d.name).toBe("OBJ");
    expect(d.position.compressed).toBe(true);
    expect(d.position.lat).toBeCloseTo(49.5, 4);
  });

  it("parses a weather object", () => {
    const d = expectType(
      "Q1AAA>APRS:;WX1      *092345z4903.50N/07201.75W_220/004g005t077",
      "object",
    );
    expect(d.position.weather?.windDirDeg).toBe(220);
    expect(d.position.weather?.windSpeedMs).toBeCloseTo(4 * 0.44704, 6);
    expect(d.position.weather?.tempC).toBeCloseTo(25, 6);
  });

  it("is unknown when it is malformed", () => {
    for (const line of [
      "Q1AAA>APRS:;SHORT",
      "Q1AAA>APRS:;LEADER   x092345z4903.50N/07201.75W>",
      "Q1AAA>APRS:;LEADER   *09234xz4903.50N/07201.75W>",
      "Q1AAA>APRS:;LEADER   *092345zjunk",
    ]) {
      expect(parseAprs(line).data.type, line).toBe("unknown");
    }
  });
});

describe("item", () => {
  it("parses a live item", () => {
    const d = expectType("Q1AAA>APRS:)AID #2!4903.50N/07201.75WA", "item");
    expect(d.name).toBe("AID #2");
    expect(d.live).toBe(true);
    expect(d.position.symbol).toEqual({ table: "/", code: "A" });
  });

  it("parses a killed item and a 3-character name", () => {
    const k = expectType("Q1AAA>APRS:)AID#2_4903.50N/07201.75WA", "item");
    expect(k.name).toBe("AID#2");
    expect(k.live).toBe(false);
    expect(expectType("Q1AAA>APRS:)ABC!4903.50N/07201.75WA", "item").name).toBe("ABC");
  });

  it("is unknown without the end of the name", () => {
    expect(parseAprs("Q1AAA>APRS:)AID #2 4903.50N/07201.75WA").data.type).toBe("unknown");
    expect(parseAprs("Q1AAA>APRS:)AB!4903.50N/07201.75WA").data.type).toBe("unknown");
  });
});
