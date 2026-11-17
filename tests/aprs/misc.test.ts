import { describe, expect, it } from "vitest";
import { parseAprs } from "../../src/aprs/parse.ts";
import { expectType } from "./util.ts";

describe("status", () => {
  it("reads the text, with and without a timestamp", () => {
    expect(expectType("Q1AAA>APRS:>Net control", "status").text).toBe("Net control");
    const d = expectType("Q1AAA>APRS:>092345zNet control", "status");
    expect(d.timestamp).toEqual({ format: "dhm-z", day: 9, hour: 23, minute: 45 });
    expect(d.text).toBe("Net control");
  });

  it("reads a Maidenhead locator with a symbol", () => {
    const d = expectType("Q1AAA>APRS:>IO91SX/G Hi", "status");
    expect(d.grid).toBe("IO91SX");
    expect(d.symbol).toEqual({ table: "/", code: "G" });
    expect(d.gridLat).toBeCloseTo(51.9792, 3);
    expect(d.gridLon).toBeCloseTo(-0.4583, 3);
    expect(d.text).toBe("Hi");
  });

  it("does not take ordinary text for a locator", () => {
    const d = expectType("Q1AAA>APRS:>Hello world", "status");
    expect(d.grid).toBeUndefined();
    expect(d.text).toBe("Hello world");
  });

  it("reads UTF-8 text", () => {
    expect(expectType("Q1AAA>APRS:><0xE3><0x81><0x82>", "status").text).toBe("あ");
  });
});

describe("third-party, NMEA and the rest", () => {
  it("parses a third-party packet one level deep", () => {
    const d = expectType(
      "Q1GATE>APRS:}Q1AAA-9>APRS,TCPIP,Q1GATE*:!3540.12N/13945.67E>Hi",
      "thirdparty",
    );
    expect(d.inner?.tnc2?.src).toBe("Q1AAA-9");
    expect(d.inner?.tnc2?.path.map((p) => p.call)).toEqual(["TCPIP", "Q1GATE"]);
    expect(d.inner?.data.type).toBe("position");
  });

  it("does not nest third-party packets further", () => {
    const d = expectType("Q1A>APRS:}Q1B>APRS:}Q1C>APRS:!4903.50N/07201.75W>", "thirdparty");
    expect(d.inner?.data.type).toBe("unknown");
  });

  it("reports an unreadable inner packet", () => {
    const d = expectType("Q1A>APRS:}garbage", "thirdparty");
    expect(d.inner?.data.type).toBe("unknown");
    expect(d.inner?.error).toBeDefined();
  });

  it("records the NMEA sentence", () => {
    const d = expectType(
      "Q1AAA>APRS:$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394",
      "nmea",
    );
    expect(d.sentence).toBe("GPRMC");
  });

  it("reads capabilities and queries", () => {
    expect(expectType("Q1AAA>APRS:<IGATE,MSG_CNT=1", "capabilities").text).toBe("IGATE,MSG_CNT=1");
    expect(expectType("Q1AAA>APRS:?APRS?", "query").text).toBe("APRS?");
  });

  it("is unknown for other data types", () => {
    const d = expectType("Q1AAA>APRS:%foo", "unknown");
    expect(d.dataType).toBe("%");
    expect(expectType("Q1AAA>APRS:{foo", "unknown").dataType).toBe("{");
  });
});

describe("unreadable packets", () => {
  it("returns an error and no TNC2 parts for a line that is not TNC2", () => {
    const p = parseAprs("garbage");
    expect(p.tnc2).toBeNull();
    expect(p.error).toBeDefined();
    expect(p.data.type).toBe("unknown");
  });

  it("keeps the TNC2 parts when only the information field is empty", () => {
    const p = parseAprs("Q1AAA>APRS:");
    expect(p.tnc2?.src).toBe("Q1AAA");
    expect(p.data).toMatchObject({ type: "unknown", reason: "empty information field" });
  });
});

// ---- robustness: the parser must never throw -----------------------------------------------

const SAMPLES = [
  'Q1TEST-7>SU4PX0,WIDE1-1:`CIXl <0x1C>[/"4!}Pico2 APRS',
  "Q1AAA-9>APRS,WIDE1-1*:!3540.12N/13945.67E>Hello !W12! /A=001234",
  "Q1AAA>APRS:/092345z4903.50N/07201.75W>088/036Test|!#!$!%|",
  "Q1AAA>APRS:!4903.50N/07201.75W#PHG5132Digi",
  "Q1TEST>APRS:=/5L!!<*e7>7P[",
  "Q1AAA>APRS:;LEADER   *092345z4903.50N/07201.75W>088/036Convoy",
  "Q1AAA>APRS:)AID #2!4903.50N/07201.75WA",
  "Q1AAA>APRS::Q1BBB-7  :Hello there{123",
  "Q1AAA>APRS::Q1AAA    :EQNS.0,5.2,0,0,.53,-32,3,4.39,49,-32,3,18,1,2,3",
  "Q1WX>APRS:_10090556c220s004g005t077r000p000P000h50b09900wRSW",
  "Q1WX>APRS:!4903.50N/07201.75W_220/004g005t077r000p000P000h50b09900wRSW",
  "Q1AAA>APRS:T#005,199,000,255,073,123,01101001",
  "Q1AAA>APRS:>IO91SX/G Hi <0xE3><0x81><0x82>",
  "Q1GATE>APRS:}Q1AAA-9>APRS,TCPIP,Q1GATE*:!3540.12N/13945.67E>Hi",
];

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Invariants every result must satisfy, whatever the input:
 *  - no "internal parser error" (parseAprs turns exceptions into `unknown`, so an exception
 *    inside the parser is only visible through the reason);
 *  - every number in the result is finite;
 *  - every latitude is within 90 and every longitude within 180 degrees;
 *  - every timestamp is within its calendar ranges.
 */
function checkInvariants(line: string, value: unknown, path = "result"): void {
  const here = `${path} of ${JSON.stringify(line)}`;
  if (typeof value === "number") {
    expect(Number.isFinite(value), here).toBe(true);
    return;
  }
  if (typeof value === "string" && path.endsWith("reason")) {
    expect(value.startsWith("internal parser error"), here).toBe(false);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const o = value as Record<string, unknown>;
  for (const key of ["lat", "gridLat"]) {
    if (typeof o[key] === "number")
      expect(Math.abs(o[key]), `${here}.${key}`).toBeLessThanOrEqual(90);
  }
  for (const key of ["lon", "gridLon"]) {
    if (typeof o[key] === "number") {
      expect(Math.abs(o[key]), `${here}.${key}`).toBeLessThanOrEqual(180);
    }
  }
  if (typeof o.format === "string" && typeof o.hour === "number") {
    const inRange = (v: unknown, lo: number, hi: number): boolean =>
      v === undefined || (typeof v === "number" && v >= lo && v <= hi);
    expect(inRange(o.month, 1, 12), `${here} month`).toBe(true);
    expect(inRange(o.day, 1, 31), `${here} day`).toBe(true);
    expect(inRange(o.hour, 0, 23), `${here} hour`).toBe(true);
    expect(inRange(o.minute, 0, 59), `${here} minute`).toBe(true);
    expect(inRange(o.second, 0, 59), `${here} second`).toBe(true);
  }
  for (const [k, v] of Object.entries(o)) checkInvariants(line, v, `${path}.${k}`);
}

function checkLine(line: string): void {
  const p = parseAprs(line);
  expect(typeof p.data.type, line).toBe("string");
  if (p.error !== undefined) expect(p.error.startsWith("internal parser error"), line).toBe(false);
  checkInvariants(line, p);
}

describe("robustness", () => {
  it("keeps the invariants on any prefix of the sample packets", () => {
    for (const line of SAMPLES) {
      for (let n = 0; n <= line.length; n++) checkLine(line.slice(0, n));
    }
  });

  it("keeps the invariants on 2000 random lines (fixed seed)", () => {
    const rnd = mulberry32(20261118);
    const types = "!=/@;)`':>_T}$<?{#*&\x1c\x1d";
    const pick = (s: string): string => s[Math.floor(rnd() * s.length)]!;
    const int = (n: number): number => Math.floor(rnd() * n);
    let printable = "";
    for (let c = 0x20; c < 0x7f; c++) printable += String.fromCharCode(c);
    const hex = (): string => `<0x${int(256).toString(16).toUpperCase().padStart(2, "0")}>`;
    const digits = (n: number): string =>
      Array.from({ length: n }, () => pick("0123456789 ")).join("");
    const randomChar = (): string => (rnd() < 0.1 ? hex() : pick(printable));

    for (let i = 0; i < 2000; i++) {
      let line: string;
      const kind = i % 4;
      if (kind === 0) {
        // random text after a random data type
        let info = pick(types);
        const len = int(120);
        for (let k = 0; k < len; k++) info += randomChar();
        line = `Q1AAA-9>${rnd() < 0.5 ? "APRS" : "SU4PX0"},WIDE1-1*:${info}`;
      } else if (kind === 1) {
        // a sample with a few characters replaced: reaches deep into the field parsers
        const base = SAMPLES[int(SAMPLES.length)]!;
        let out = base;
        for (let k = 0; k < 1 + int(4); k++) {
          const at = int(out.length);
          out = out.slice(0, at) + randomChar() + out.slice(at + 1);
        }
        line = out;
      } else if (kind === 2) {
        // uncompressed position or object with random digits: ranges are the point here
        const pos = `${digits(4)}.${digits(2)}${pick("NSXn")}${pick("/\\0A")}${digits(5)}.${digits(2)}${pick("EWXe")}${pick(printable)}`;
        const stamp = `${digits(6)}${pick("zh/")}`;
        line =
          rnd() < 0.5
            ? `Q1AAA>APRS:${pick("!=")}${pos}${randomChar()}`
            : `Q1AAA>APRS:${pick("/@")}${stamp}${pos}`;
      } else {
        // Mic-E with a random destination and random information bytes
        let dst = "";
        for (let k = 0; k < 6; k++) dst += pick("0123456789ABCDEFGHIJKLPQRSTUVWXYZ");
        let info = pick("`'");
        for (let k = 0; k < 8; k++) info += rnd() < 0.5 ? hex() : pick(printable);
        const tail = int(20);
        for (let k = 0; k < tail; k++) info += randomChar();
        line = `Q1AAA>${dst}:${info}`;
      }
      checkLine(line);
    }
  });

  it("keeps the invariants on lines without a proper header", () => {
    for (const line of ["", ":", ">", ">:", ",,,:", "A>B,C*,D*:x", "<0xFF>>x:y", "あ>い:う"]) {
      checkLine(line);
    }
  });

  it("does reach the position parsers (the random lines are not all rejected early)", () => {
    // Guard against a vacuous test: the samples themselves must parse into real packets.
    const kinds = new Set(SAMPLES.map((l) => parseAprs(l).data.type));
    for (const t of ["mice", "position", "object", "item", "message", "weather", "telemetry"]) {
      expect(kinds.has(t as never), t).toBe(true);
    }
  });
});
