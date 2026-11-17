import { describe, expect, it } from "vitest";
import {
  binaryToBytes,
  decodeEscapes,
  isTnc2Error,
  parseTnc2,
  readText,
  splitCall,
} from "../../src/aprs/tnc2.ts";

describe("parseTnc2", () => {
  it("splits source, destination, path and information", () => {
    const t = parseTnc2("Q1AAA-9>APRS,WIDE1-1*,WIDE2-1:!3540.12N/13945.67E>Hello");
    if (isTnc2Error(t)) throw new Error(t.error);
    expect(t.src).toBe("Q1AAA-9");
    expect(t.dst).toBe("APRS");
    expect(t.path).toEqual([
      { call: "WIDE1-1", used: true },
      { call: "WIDE2-1", used: false },
    ]);
    expect(t.info).toBe("!3540.12N/13945.67E>Hello");
  });

  it("marks every entry up to the last * as used", () => {
    const t = parseTnc2("Q1AAA>APRS,WIDE1-1,WIDE2-1*,qAR,Q1IGT:>x");
    if (isTnc2Error(t)) throw new Error(t.error);
    expect(t.path.map((p) => p.used)).toEqual([true, true, false, false]);
    expect(t.path[1]!.call).toBe("WIDE2-1");
  });

  it("allows an empty path and a colon inside the information", () => {
    const t = parseTnc2("Q1AAA>APRS::Q1BBB    :hi: there");
    if (isTnc2Error(t)) throw new Error(t.error);
    expect(t.path).toEqual([]);
    expect(t.info).toBe(":Q1BBB    :hi: there");
  });

  it("reports malformed lines", () => {
    for (const line of ["", "hello", "Q1AAA>APRS", "Q1AAA:abc", ">APRS:x", "Q1AAA>:x"]) {
      expect(isTnc2Error(parseTnc2(line)), line).toBe(true);
    }
  });
});

describe("escapes", () => {
  it("turns <0xHH> back into bytes and reads them as UTF-8", () => {
    const bin = decodeEscapes("<0xE3><0x81><0x82>");
    expect(bin).toBe("\xe3\x81\x82");
    expect(readText(bin)).toBe("あ");
    expect(readText(decodeEscapes("Hi <0xE3><0x81><0x82><0xE3><0x81><0x84>!"))).toBe("Hi あい!");
  });

  it("encodes characters outside ASCII as UTF-8", () => {
    expect(decodeEscapes("あ")).toBe("\xe3\x81\x82");
  });

  it("falls back to Latin-1 when the bytes are not valid UTF-8 (see review.test.ts for M2)", () => {
    // E9 at the end of "café" in Latin-1 looks like a cut 3-byte lead, but the text before it
    // does not show that it is UTF-8
    expect(readText(decodeEscapes("caf<0xE9>"))).toBe("café");
    expect(readText(decodeEscapes("<0xFF><0xFE>"))).toBe("ÿþ");
  });

  it("drops a UTF-8 sequence that was cut off at the end", () => {
    expect(readText(decodeEscapes("<0xE3><0x81>"))).toBe("");
  });

  it("only handles uppercase hex digits", () => {
    expect(decodeEscapes("<0xe3>")).toBe("<0xe3>");
    expect(decodeEscapes("<0xZZ>")).toBe("<0xZZ>");
  });

  it("cannot tell a printable <0x41> from an escaped 'A' (limit of the device format)", () => {
    expect(decodeEscapes("<0x41>")).toBe("A");
  });

  it("keeps control bytes in the information field", () => {
    const t = parseTnc2("Q1AAA>APRS:a<0x1C>b<0x7F>");
    if (isTnc2Error(t)) throw new Error(t.error);
    expect([...binaryToBytes(t.info)]).toEqual([0x61, 0x1c, 0x62, 0x7f]);
  });
});

describe("splitCall", () => {
  it("splits the SSID", () => {
    expect(splitCall("Q1AAA-9")).toEqual({ call: "Q1AAA", ssid: 9 });
    expect(splitCall("Q1AAA")).toEqual({ call: "Q1AAA", ssid: 0 });
    expect(splitCall("Q1AAA-15")).toEqual({ call: "Q1AAA", ssid: 15 });
  });
});
