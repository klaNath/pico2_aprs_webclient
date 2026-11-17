import { describe, expect, it } from "vitest";
import { parseAprs } from "../../src/aprs/parse.ts";
import { expectType } from "./util.ts";

describe("message", () => {
  it("parses addressee, text and message number", () => {
    const d = expectType("Q1AAA>APRS::Q1BBB-7  :Hello there{123", "message");
    expect(d.addressee).toBe("Q1BBB-7");
    expect(d.text).toBe("Hello there");
    expect(d.msgNo).toBe("123");
    expect(d.reply).toBeUndefined();
    expect(d.bulletin).toBe(false);
  });

  it("parses a message without a number", () => {
    const d = expectType("Q1AAA>APRS::Q1BBB    :Hi", "message");
    expect(d.text).toBe("Hi");
    expect(d.msgNo).toBeUndefined();
  });

  it("allows a colon in the text and reads UTF-8", () => {
    const d = expectType("Q1AAA>APRS::Q1BBB    :a: <0xE3><0x81><0x82>{7", "message");
    expect(d.text).toBe("a: あ");
    expect(d.msgNo).toBe("7");
  });

  it("recognizes ack and rej", () => {
    const a = expectType("Q1BBB>APRS::Q1AAA    :ack123", "message");
    expect(a).toMatchObject({ reply: "ack", msgNo: "123", text: "" });
    const r = expectType("Q1BBB>APRS::Q1AAA    :rej9", "message");
    expect(r).toMatchObject({ reply: "rej", msgNo: "9" });
  });

  it("marks bulletins", () => {
    const d = expectType("Q1AAA>APRS::BLN1     :Meeting tonight", "message");
    expect(d.bulletin).toBe(true);
    expect(d.text).toBe("Meeting tonight");
    expect(expectType("Q1AAA>APRS::NWS-TEST :Storm", "message").bulletin).toBe(true);
  });

  it("is unknown when the addressee field is malformed", () => {
    expect(parseAprs("Q1AAA>APRS::short").data.type).toBe("unknown");
    expect(parseAprs("Q1AAA>APRS::Q1BBB     hello").data.type).toBe("unknown");
  });
});

describe("telemetry definitions", () => {
  it("parses PARM and UNIT", () => {
    const p = expectType("Q1AAA>APRS::Q1AAA    :PARM.Vin,Temp,Rx", "telemetry-def");
    expect(p).toMatchObject({ kind: "PARM", addressee: "Q1AAA", names: ["Vin", "Temp", "Rx"] });
    const u = expectType("Q1AAA>APRS::Q1AAA    :UNIT.v,deg.C,pkts", "telemetry-def");
    expect(u.names).toEqual(["v", "deg.C", "pkts"]);
  });

  it("parses EQNS as five a, b, c triples", () => {
    const d = expectType(
      "Q1AAA>APRS::Q1AAA    :EQNS.0,5.2,0,0,.53,-32,3,4.39,49,-32,3,18,1,2,3",
      "telemetry-def",
    );
    expect(d.eqns).toEqual([
      { a: 0, b: 5.2, c: 0 },
      { a: 0, b: 0.53, c: -32 },
      { a: 3, b: 4.39, c: 49 },
      { a: -32, b: 3, c: 18 },
      { a: 1, b: 2, c: 3 },
    ]);
  });

  it("parses BITS", () => {
    const d = expectType("Q1AAA>APRS::Q1AAA    :BITS.10110000,Balloon project", "telemetry-def");
    expect(d.bits).toBe("10110000");
    expect(d.title).toBe("Balloon project");
  });
});
