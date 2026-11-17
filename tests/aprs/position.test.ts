import { describe, expect, it } from "vitest";
import { parseAprs } from "../../src/aprs/parse.ts";
import { resolveTimestamp } from "../../src/aprs/timestamp.ts";
import { packetPosition } from "../../src/aprs/types.ts";
import { expectType } from "./util.ts";

const KMH = 1.852;

describe("uncompressed position", () => {
  it("parses the example of ble-protocol.md §8.2", () => {
    const d = expectType("Q1AAA-9>APRS,WIDE1-1*:!3540.12N/13945.67E>Hello", "position");
    expect(d.position.lat).toBeCloseTo(35.66867, 5);
    expect(d.position.lon).toBeCloseTo(139.76117, 5);
    expect(d.position.symbol).toEqual({ table: "/", code: ">" });
    expect(d.position.comment).toBe("Hello");
    expect(d.position.ambiguity).toBe(0);
    expect(d.position.compressed).toBe(false);
    expect(d.messaging).toBe(false);
    expect(d.timestamp).toBeUndefined();
  });

  it("knows which types can receive messages", () => {
    expect(expectType("Q1AAA>APRS:=4903.50N/07201.75W>", "position").messaging).toBe(true);
    expect(expectType("Q1AAA>APRS:!4903.50N/07201.75W>", "position").messaging).toBe(false);
  });

  it("uses negative values for S and W", () => {
    const d = expectType("Q1AAA>APRS:!3356.32S/11825.43W>", "position");
    expect(d.position.lat).toBeCloseTo(-(33 + 56.32 / 60), 8);
    expect(d.position.lon).toBeCloseTo(-(118 + 25.43 / 60), 8);
  });

  it("reads a DHM zulu timestamp (/)", () => {
    const d = expectType("Q1AAA>APRS:/092345z4903.50N/07201.75W>Test", "position");
    expect(d.timestamp).toEqual({ format: "dhm-z", day: 9, hour: 23, minute: 45 });
    expect(d.position.lat).toBeCloseTo(49 + 3.5 / 60, 8);
    expect(d.position.lon).toBeCloseTo(-(72 + 1.75 / 60), 8);
    expect(d.messaging).toBe(false);
  });

  it("reads an HMS timestamp (@) and a local DHM timestamp", () => {
    const a = expectType("Q1AAA>APRS:@092345h4903.50N/07201.75W>", "position");
    expect(a.timestamp).toEqual({ format: "hms", hour: 9, minute: 23, second: 45 });
    expect(a.messaging).toBe(true);
    const b = expectType("Q1AAA>APRS:/092345/4903.50N/07201.75W>", "position");
    expect(b.timestamp?.format).toBe("dhm-local");
  });

  it("handles position ambiguity", () => {
    const a2 = expectType("Q1AAA>APRS:!4903.  N/07201.  W>", "position");
    expect(a2.position.ambiguity).toBe(2);
    expect(a2.position.lat).toBeCloseTo(49.05, 8);
    const a4 = expectType("Q1AAA>APRS:!49  .  N/072  .  W>", "position");
    expect(a4.position.ambiguity).toBe(4);
    expect(a4.position.lat).toBe(49);
    expect(a4.position.lon).toBe(-72);
  });

  it("reads the overlay of the alternate table", () => {
    const d = expectType("Q1AAA>APRS:!4903.50N107201.75W#", "position");
    expect(d.position.symbol).toEqual({ table: "\\", code: "#", overlay: "1" });
    expect(expectType("Q1AAA>APRS:!4903.50N\\07201.75W>", "position").position.symbol).toEqual({
      table: "\\",
      code: ">",
    });
  });

  it("reads course and speed (knots -> km/h)", () => {
    const d = expectType("Q1AAA>APRS:!4903.50N/07201.75W>088/036Comment", "position");
    expect(d.position.courseDeg).toBe(88);
    expect(d.position.speedKmh).toBeCloseTo(36 * KMH, 6);
    expect(d.position.comment).toBe("Comment");
  });

  it("treats course 000 as unknown but keeps the speed", () => {
    const d = expectType("Q1AAA>APRS:!4903.50N/07201.75W>000/010", "position");
    expect(d.position.courseDeg).toBeUndefined();
    expect(d.position.speedKmh).toBeCloseTo(10 * KMH, 6);
  });

  it("reads PHG, RNG and DFS", () => {
    const phg = expectType("Q1AAA>APRS:!4903.50N/07201.75W#PHG5132Digi", "position").position;
    expect(phg.phg?.powerW).toBe(25);
    expect(phg.phg?.heightM).toBeCloseTo(20 * 0.3048, 6);
    expect(phg.phg?.gainDb).toBe(3);
    expect(phg.phg?.directivityDeg).toBe(90);
    expect(phg.comment).toBe("Digi");
    expect(
      expectType("Q1AAA>APRS:!4903.50N/07201.75W#PHG2360", "position").position.phg?.directivityDeg,
    ).toBeNull();

    const rng = expectType("Q1AAA>APRS:!4903.50N/07201.75W#RNG0050Range", "position").position;
    expect(rng.rangeM).toBeCloseTo(50 * 1609.344, 3);
    expect(rng.comment).toBe("Range");

    const dfs = expectType("Q1AAA>APRS:!4903.50N/07201.75W\\DFS2360", "position").position;
    expect(dfs.dfs).toMatchObject({ strength: 2, gainDb: 6, directivityDeg: null });
  });

  it("takes /A= altitude (feet, may be negative) out of the comment", () => {
    const d = expectType("Q1AAA>APRS:!4903.50N/07201.75W>Test /A=001234 more", "position");
    expect(d.position.altitudeM).toBeCloseTo(1234 * 0.3048, 6);
    expect(d.position.comment).toBe("Test  more");
    const n = expectType("Q1AAA>APRS:!4903.50N/07201.75W>/A=-00100", "position");
    expect(n.position.altitudeM).toBeCloseTo(-100 * 0.3048, 6);
  });

  it("adds precision from a human-readable DAO (!W12!)", () => {
    const d = expectType("Q1AAA>APRS:!3540.12N/13945.67E>Hello !W12!", "position");
    expect(d.position.dao).toBe(true);
    expect(d.position.lat).toBeCloseTo(35 + 40.121 / 60, 9);
    expect(d.position.lon).toBeCloseTo(139 + 45.672 / 60, 9);
    expect(d.position.comment).toBe("Hello ");
  });

  it("adds precision from a base-91 DAO (!wXY!), away from zero", () => {
    const d = expectType("Q1AAA>APRS:!3356.32S/11825.43W>!wZZ!", "position");
    const extra = (57 / 91) * 0.01;
    expect(d.position.lat).toBeCloseTo(-(33 + (56.32 + extra) / 60), 9);
    expect(d.position.lon).toBeCloseTo(-(118 + (25.43 + extra) / 60), 9);
  });

  it("ignores a DAO when the position is ambiguous", () => {
    const d = expectType("Q1AAA>APRS:!3540.1 N/13945.6 E>x!W12!", "position");
    expect(d.position.dao).toBeUndefined();
    expect(d.position.comment).toBe("x!W12!");
  });

  it("reads compressed telemetry at the end of the comment", () => {
    const d = expectType("Q1AAA>APRS:!4903.50N/07201.75W>Test|!#!$!%|", "position");
    expect(d.position.telemetry).toEqual({ seq: 2, analog: [3, 4] });
    expect(d.position.comment).toBe("Test");
    const full = expectType("Q1AAA>APRS:!4903.50N/07201.75W>|!#!$!%!&!'!(!)|", "position");
    expect(full.position.telemetry).toEqual({ seq: 2, analog: [3, 4, 5, 6, 7], digital: 8 });
  });

  it("keeps the text of a comment that only looks like telemetry", () => {
    const d = expectType("Q1AAA>APRS:!4903.50N/07201.75W>a|!|", "position");
    expect(d.position.telemetry).toBeUndefined();
    expect(d.position.comment).toBe("a|!|");
  });

  it("reads UTF-8 text in the comment", () => {
    const d = expectType("Q1AAA>APRS:!4903.50N/07201.75W>Hi <0xE3><0x81><0x82>", "position");
    expect(d.position.comment).toBe("Hi あ");
  });

  it("reports an unreadable position as unknown", () => {
    for (const line of [
      "Q1AAA>APRS:!hello",
      "Q1AAA>APRS:!4903.50X/07201.75W>",
      "Q1AAA>APRS:/09234z4903.50N/07201.75W>",
      "Q1AAA>APRS:!",
    ]) {
      expect(parseAprs(line).data.type, line).toBe("unknown");
    }
  });
});

describe("packetPosition", () => {
  it("returns the position of packets that have one", () => {
    expect(packetPosition(parseAprs("Q1AAA>APRS:!4903.50N/07201.75W>"))?.lat).toBeCloseTo(
      49.0583,
      4,
    );
    expect(packetPosition(parseAprs("Q1AAA>APRS:>status"))).toBeUndefined();
  });
});

describe("resolveTimestamp", () => {
  const ref = new Date(Date.UTC(2026, 10, 18, 12, 0, 0)); // 2026-11-18 12:00Z

  it("resolves day/hour/minute to the nearest month", () => {
    expect(
      resolveTimestamp({ format: "dhm-z", day: 18, hour: 11, minute: 30 }, ref)?.toISOString(),
    ).toBe("2026-11-18T11:30:00.000Z");
    const first = new Date(Date.UTC(2026, 10, 1, 0, 5, 0));
    expect(
      resolveTimestamp({ format: "dhm-z", day: 31, hour: 23, minute: 50 }, first)?.toISOString(),
    ).toBe("2026-10-31T23:50:00.000Z");
    const last = new Date(Date.UTC(2026, 9, 31, 23, 55, 0));
    expect(
      resolveTimestamp({ format: "dhm-z", day: 1, hour: 0, minute: 2 }, last)?.toISOString(),
    ).toBe("2026-11-01T00:02:00.000Z");
  });

  it("resolves HMS across midnight", () => {
    const justAfter = new Date(Date.UTC(2026, 10, 18, 0, 0, 10));
    expect(
      resolveTimestamp(
        { format: "hms", hour: 23, minute: 59, second: 30 },
        justAfter,
      )?.toISOString(),
    ).toBe("2026-11-17T23:59:30.000Z");
  });

  it("resolves month/day/hour/minute across New Year", () => {
    const newYear = new Date(Date.UTC(2027, 0, 1, 0, 10, 0));
    expect(
      resolveTimestamp(
        { format: "mdhm", month: 12, day: 31, hour: 23, minute: 50 },
        newYear,
      )?.toISOString(),
    ).toBe("2026-12-31T23:50:00.000Z");
  });

  it("cannot resolve local time", () => {
    expect(
      resolveTimestamp({ format: "dhm-local", day: 1, hour: 1, minute: 1 }, ref),
    ).toBeUndefined();
  });
});
