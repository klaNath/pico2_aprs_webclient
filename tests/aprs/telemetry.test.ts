import { describe, expect, it } from "vitest";
import { parseAprs } from "../../src/aprs/parse.ts";
import {
  applyEqns,
  parseCompressedTelemetry,
  parseTelemetryDefinition,
} from "../../src/aprs/telemetry.ts";
import { expectType } from "./util.ts";

describe("T# report", () => {
  it("parses analog and digital values", () => {
    const d = expectType("Q1AAA>APRS:T#005,199,000,255,073,123,01101001", "telemetry");
    expect(d.seq).toBe(5);
    expect(d.analog).toEqual([199, 0, 255, 73, 123]);
    expect(d.digital).toEqual([false, true, true, false, true, false, false, true]);
    expect(d.comment).toBe("");
  });

  it("accepts decimals, missing values and the MIC sequence", () => {
    const d = expectType("Q1AAA>APRS:T#MIC,1.5,,3,4,5", "telemetry");
    expect(d.seq).toBe("MIC");
    expect(d.analog).toEqual([1.5, undefined, 3, 4, 5]);
    expect(d.digital).toBeUndefined();
  });

  it("keeps trailing text as a comment", () => {
    const d = expectType("Q1AAA>APRS:T#001,1,2,3,4,5,00000000 test", "telemetry");
    expect(d.comment).toBe(" test");
  });

  it("is unknown when it is not a report", () => {
    expect(parseAprs("Q1AAA>APRS:T#abc").data.type).toBe("unknown");
    expect(parseAprs("Q1AAA>APRS:Txyz").data.type).toBe("unknown");
    expect(parseAprs("Q1AAA>APRS:T#001,1,2").data.type).toBe("unknown");
  });
});

describe("applyEqns", () => {
  it("computes a*x^2 + b*x + c", () => {
    const out = applyEqns(
      [10, 20, 2],
      [
        { a: 0, b: 5.2, c: 0 },
        { a: 0, b: 0.53, c: -32 },
        { a: 1, b: 2, c: 3 },
      ],
    );
    expect(out[0]).toBeCloseTo(52, 8);
    expect(out[1]).toBeCloseTo(-21.4, 8);
    expect(out[2]).toBe(11);
  });

  it("passes missing values and channels without an equation through", () => {
    expect(applyEqns([undefined, 7], [{ a: 1, b: 1, c: 1 }])).toEqual([undefined, 7]);
  });
});

describe("parseTelemetryDefinition", () => {
  it("returns null for other text", () => {
    expect(parseTelemetryDefinition("hello")).toBeNull();
    expect(parseTelemetryDefinition("PARM")).toBeNull();
  });

  it("leaves out a channel whose EQNS numbers are unreadable", () => {
    // Used to be read as a = 0, which made applyEqns return 0 for every value (review M6).
    const d = parseTelemetryDefinition("EQNS.x,1,2");
    expect(d?.eqns).toEqual([undefined]);
  });
});

describe("parseCompressedTelemetry", () => {
  it("reads a sequence number and analog values", () => {
    expect(parseCompressedTelemetry("!#!$!%")).toEqual({ seq: 2, analog: [3, 4] });
  });

  it("reads the digital value when all five analog values are present", () => {
    expect(parseCompressedTelemetry("!#!$!%!&!'!(!)")).toEqual({
      seq: 2,
      analog: [3, 4, 5, 6, 7],
      digital: 8,
    });
  });

  it("rejects odd lengths, too short or too long blocks and bad characters", () => {
    expect(parseCompressedTelemetry("!#!")).toBeNull();
    expect(parseCompressedTelemetry("!#")).toBeNull();
    expect(parseCompressedTelemetry("!#!#!#!#!#!#!#!#")).toBeNull();
    expect(parseCompressedTelemetry("!# $")).toBeNull();
  });
});
