// Regression tests for the defects found by the adversarial review of src/aprs/.
// Each describe block carries the review ID (P-H1, M2, ...). Expected values come from
// APRS101 or from hand calculation, not from the parser's own output.

import { describe, expect, it } from "vitest";
import { cardinal, formatLatLon } from "../../src/aprs/geo.ts";
import { parseAprs } from "../../src/aprs/parse.ts";
import { symbolInfo } from "../../src/aprs/symbols.ts";
import { parseTnc2, isTnc2Error, splitCall } from "../../src/aprs/tnc2.ts";
import { resolveTimestamp } from "../../src/aprs/timestamp.ts";
import { applyEqns, parseTelemetryDefinition } from "../../src/aprs/telemetry.ts";
import {
  packetLatLon,
  packetPosition,
  packetProblem,
  packetWeather,
  type AprsSymbol,
} from "../../src/aprs/types.ts";
import { expectType } from "./util.ts";

/** Independent base-91 encoder for building test input: `len` characters, '!' = 0. */
function b91(n: number, len: number): string {
  let out = "";
  let v = n;
  for (let i = 0; i < len; i++) {
    out = String.fromCharCode(33 + (v % 91)) + out;
    v = Math.floor(v / 91);
  }
  return out;
}

function unknownReason(line: string): string {
  const d = parseAprs(line).data;
  if (d.type !== "unknown") throw new Error(`expected unknown, got ${d.type}: ${line}`);
  expect(d.reason, line).toBeTruthy();
  return d.reason!;
}

describe("P-H1: ranges of uncompressed positions (APRS101 ch.6)", () => {
  it("rejects latitudes and longitudes beyond 90 / 180 degrees", () => {
    // 99°99.99' and 100°... : degrees above the limit
    expect(unknownReason("Q1A>APRS:!9999.99N/99999.99E>x")).toMatch(/range/);
    // longitude 972 degrees (the symbol table '/' and the code 'A' follow)
    expect(unknownReason("Q1A>APRS:!4903.50N/97201.75WA")).toMatch(/range/);
    expect(unknownReason("Q1A>APRS:!9100.00N/07201.75W>")).toMatch(/range/);
    expect(unknownReason("Q1A>APRS:!4903.50N/18100.00W>")).toMatch(/range/);
  });

  it("rejects minutes of 60 or more", () => {
    expect(unknownReason("Q1A>APRS:!4960.00N/07201.75W>")).toMatch(/range/);
    expect(unknownReason("Q1A>APRS:!4903.50N/07260.00W>")).toMatch(/range/);
  });

  it("accepts the exact limits 90 and 180 degrees, but nothing beyond them", () => {
    const n = expectType("Q1A>APRS:!9000.00N/18000.00E>x", "position").position;
    expect(n.lat).toBe(90);
    expect(n.lon).toBe(180);
    const s = expectType("Q1A>APRS:!9000.00S/18000.00W>x", "position").position;
    expect(s.lat).toBe(-90);
    expect(s.lon).toBe(-180);
    // 90°00.01' is past the pole; so is 180°00.01'
    expect(unknownReason("Q1A>APRS:!9000.01N/07201.75W>")).toMatch(/range/);
    expect(unknownReason("Q1A>APRS:!4903.50N/18000.01E>")).toMatch(/range/);
  });

  it("applies the same limits to objects and items", () => {
    expect(unknownReason("Q1A>APRS:;LEADER   *092345z9999.99N/99999.99E>")).toMatch(/range/);
    expect(unknownReason("Q1A>APRS:)AID #2!9999.99N/99999.99EA")).toMatch(/range/);
  });
});

describe("P-H1 / L1: ranges of compressed positions (APRS101 ch.9)", () => {
  // Decoding: lat = 90 - y/380926, lon = -180 + x/190463. 380926 * 180 = 190463 * 360 =
  // 68,566,680, so y and x above that number leave the globe. We make such packets unknown
  // instead of clamping: a clamped value would put a bogus marker on the pole or the
  // antimeridian and hide that the packet is damaged.
  const line = (y: number, x: number): string => `Q1A>APRS:!/${b91(y, 4)}${b91(x, 4)}>  !`;

  it("rejects the all-'{' block of the review", () => {
    expect(unknownReason("Q1A>APRS:!/{{{{{{{{>  !")).toMatch(/range/);
  });

  it("accepts y = x = 68,566,680 (lat -90, lon 180) and y = x = 0 (lat 90, lon -180)", () => {
    const far = expectType(line(68566680, 68566680), "position").position;
    expect(far.lat).toBeCloseTo(-90, 9);
    expect(far.lon).toBeCloseTo(180, 9);
    const near = expectType(line(0, 0), "position").position;
    expect(near.lat).toBe(90);
    expect(near.lon).toBe(-180);
  });

  it("rejects one step further", () => {
    expect(unknownReason(line(68566681, 0))).toMatch(/range/);
    expect(unknownReason(line(0, 68566681))).toMatch(/range/);
  });
});

describe("P-H1: ranges of Mic-E positions", () => {
  it("rejects the destination YYYYYY (99°99.99')", () => {
    expect(unknownReason("Q1TEST>YYYYYY:`CIXl <0x1C>[/")).toMatch(/range/);
  });

  it("rejects minutes of 60 or more in the destination", () => {
    // destination digits 3 5 6 0 ...: 35°60.xx'
    expect(unknownReason("Q1TEST>356080:`CIXl <0x1C>[/")).toMatch(/range/);
  });

  it("accepts exactly 90°00.00' but not 90°00.01'", () => {
    // digits 9 0 0 0 0 0, all message bits 0 (digits): north needs char 4 >= 'P'.
    const ok = expectType("Q1TEST>900P00:`CIXl <0x1C>[/", "mice");
    expect(ok.position.lat).toBe(90);
    expect(unknownReason("Q1TEST>900P01:`CIXl <0x1C>[/")).toMatch(/range/);
  });
});

describe("P-H2: Mic-E altitude sits right after the type code", () => {
  // APRS101 ch.10 (Mic-E altitude): `ccc}` follows the symbol (and the type code, if any)
  // directly: three base-91 characters, then '}'. A '}' later in the comment is just text.
  it("does not take altitude from a '}' later in the comment", () => {
    const d = expectType("Q1TEST>SU4PX0:`CIXl <0x1C>[/Test}", "mice");
    expect(d.position.altitudeM).toBeUndefined();
    expect(d.position.comment).toBe("Test}");
    const h = expectType("Q1TEST>SU4PX0:`CIXl <0x1C>[/hello world}", "mice");
    expect(h.position.altitudeM).toBeUndefined();
    expect(h.position.comment).toBe("hello world}");
  });

  it("does not take altitude that is not at the start", () => {
    const d = expectType('Q1TEST>SU4PX0:`CIXl <0x1C>[/Hi "4!}', "mice");
    expect(d.position.altitudeM).toBeUndefined();
    expect(d.position.comment).toBe('Hi "4!}');
  });

  it("reads altitude after a type code", () => {
    // '"4!' = 1*8281 + 19*91 + 0 = 10010 -> 10 m (see mice.test.ts)
    const d = expectType('Q1TEST>SU4PX0:`CIXl <0x1C>[/>"4!}Hi', "mice");
    expect(d.typeCode).toBe(">");
    expect(d.position.altitudeM).toBe(10);
    expect(d.position.comment).toBe("Hi");
  });

  it("treats a first character that looks like a type code as altitude when the type code reading fails", () => {
    // "'" (0x27) is both a type code and a base-91 digit: 6 * 8281 = 49686, minus 10000 =
    // 39686 m. "!!}" cannot be an altitude (the '}' is not a base-91 digit), so the text is
    // read as "'" + altitude only when the three characters after it make an altitude.
    // Here they do not, so "'!!" + "}" is the altitude with no type code.
    const d = expectType("Q1TEST>SU4PX0:`CIXl <0x1C>[/'!!}x", "mice");
    expect(d.position.altitudeM).toBe(39686);
    expect(d.typeCode).toBeUndefined();
    expect(d.position.comment).toBe("x");
  });

  it("accepts -10000 m up to 100000 m and leaves anything above in the comment", () => {
    // value 0 -> -10000 m
    const low = expectType(`Q1TEST>SU4PX0:\`CIXl <0x1C>[/${b91(0, 3)}}`, "mice");
    expect(low.position.altitudeM).toBe(-10000);
    // value 110000 -> 100000 m
    const high = expectType(`Q1TEST>SU4PX0:\`CIXl <0x1C>[/${b91(110000, 3)}}`, "mice");
    expect(high.position.altitudeM).toBe(100000);
    // 100001 m is not plausible: kept as text (3 characters + '}')
    const text = `${b91(110001, 3)}}`;
    const over = expectType(`Q1TEST>SU4PX0:\`CIXl <0x1C>[/${text}`, "mice");
    expect(over.position.altitudeM).toBeUndefined();
    expect(over.position.comment).toBe(text);
  });
});

describe("M1: Mic-E information bytes are checked", () => {
  // Each of the six position bytes is value + 28 with the value 0-99, i.e. 0x1C-0x7F.
  it("rejects bytes above 0x7F (damaged in transit)", () => {
    // minutes byte 0xFF: used to give lon 141.79
    expect(unknownReason("Q1TEST>SU4PX0:`C<0xFF>Xl <0x1C>[/")).toMatch(/Mic-E/);
    // hundredths byte 0xFF: used to give lon 139.787
    expect(unknownReason("Q1TEST>SU4PX0:`CI<0xFF>l <0x1C>[/")).toMatch(/Mic-E/);
    expect(unknownReason("Q1TEST>SU4PX0:`CIX<0x80> <0x1C>[/")).toMatch(/Mic-E/);
  });

  it("rejects longitude minutes above 59 (encoded value above 69)", () => {
    // 'b' = 98 - 28 = 70: minutes 70 - 60 = 10 would be a wrong reading of an invalid byte
    expect(unknownReason("Q1TEST>SU4PX0:`CbXl <0x1C>[/")).toMatch(/range|Mic-E/);
    // 'a' = 97 - 28 = 69 -> 9 minutes (the encoding of 0-9 minutes is 60-69)
    const d = expectType("Q1TEST>SU4PX0:`CaXl <0x1C>[/", "mice");
    expect(d.position.lon).toBeCloseTo(139 + (9 + 0.6) / 60, 8);
  });

  it("rejects a course above 360 (all 0x7F bytes gave a course that cannot exist)", () => {
    // v5 = v6 = 99: course (99 % 10) * 100 + 99 = 999 -> 599 after -400
    expect(unknownReason("Q1TEST>SU4PX0:`CIX<0x7F><0x7F><0x7F>[/")).toMatch(/Mic-E/);
  });

  it("accepts course 360 and rejects 361", () => {
    // v5 = 3 (0x1F): speed units 0, course hundreds 3; v6 = 60 -> 'X' (88 - 28): 360
    const ok = expectType("Q1TEST>SU4PX0:`CIXl<0x1F>X[/", "mice");
    expect(ok.position.courseDeg).toBe(360);
    // v6 = 61 -> 'Y': 361
    expect(unknownReason("Q1TEST>SU4PX0:`CIXl<0x1F>Y[/")).toMatch(/Mic-E/);
  });

  it("rejects a control character as symbol code or table", () => {
    expect(unknownReason("Q1TEST>SU4PX0:`CIXl <0x1C><0x01>/")).toMatch(/Mic-E/);
    expect(unknownReason("Q1TEST>SU4PX0:`CIXl <0x1C>[<0xFF>")).toMatch(/Mic-E/);
  });
});

describe("L3 / M1: the overlay letters a-j are a compressed-format rule only", () => {
  it("does not turn a table 'a' into overlay 0 in Mic-E", () => {
    const d = expectType("Q1TEST>SU4PX0:`CIXl <0x1C>[a", "mice");
    expect(d.position.symbol).toEqual({ table: "\\", code: "[" });
    // overlay digits and letters stay valid
    const o = expectType("Q1TEST>SU4PX0:`CIXl <0x1C>[1", "mice");
    expect(o.position.symbol).toEqual({ table: "\\", code: "[", overlay: "1" });
  });

  it("does not turn a table 'a' into overlay 0 in uncompressed positions", () => {
    const d = expectType("Q1A>APRS:!4903.50Na07201.75W>", "position");
    expect(d.position.symbol).toEqual({ table: "\\", code: ">" });
  });

  it("does not turn a table 'a' into overlay 0 in a status locator", () => {
    const d = expectType("Q1A>APRS:>IO91SXa> Hi", "status");
    expect(d.symbol).toEqual({ table: "\\", code: ">" });
  });
});

describe("L5: custom and standard Mic-E message bits mixed", () => {
  // The position is still good; only the message cannot be told. AP4P80: 'A' is a custom
  // bit, 'P' a standard one (APRS101 forbids the mix).
  it("keeps the position and reports no message", () => {
    const d = expectType('Q1TEST>AP4P80:`CIXl <0x1C>[/"', "mice");
    expect(d.message).toBeNull();
    // AP4P80: digits 0 0 4 0 8 0 = 0°40.80'N (char 3 'P' = North, char 4 '8' = no offset);
    // 'C' = 67 - 28 = 39 degrees, 45.60' East
    expect(d.position.lat).toBeCloseTo(40.8 / 60, 8);
    expect(d.position.lon).toBeCloseTo(39 + 45.6 / 60, 8);
  });
});

describe("M2: readText for broken or non-UTF-8 text", () => {
  // The policy (see tnc2.ts): strict UTF-8; else drop an incomplete tail (BLE cuts at 244
  // bytes) and retry; else Shift_JIS if the result is clearly Japanese; else Latin-1.
  const read = (escaped: string): string => {
    const p = parseAprs(`Q1AAA>APRS:>${escaped}`);
    if (p.data.type !== "status") throw new Error(p.data.type);
    return p.data.text;
  };

  it("drops a UTF-8 sequence cut off at the end (Mic-E comment from the review)", () => {
    const d = expectType("Q1TEST>SU4PX0:`CIXl <0x1C>[/<0xE3><0x81><0x82><0xE3>", "mice");
    expect(d.position.comment).toBe("あ");
  });

  it("drops a cut-off after the first or second byte", () => {
    expect(read("Hi <0xE3><0x81>")).toBe("Hi ");
    expect(read("<0xE3><0x81><0x82><0xE3><0x81>")).toBe("あ");
    // 4-byte emoji U+1F600 = F0 9F 98 80, cut after three bytes
    expect(read("ok<0xF0><0x9F><0x98>")).toBe("ok");
  });

  it("reads Shift_JIS", () => {
    // 82 A0 = あ, 82 A2 = い; 93 8C 8B 9E = 東京 (JIS X 0208 table)
    expect(read("<0x82><0xA0><0x82><0xA2>")).toBe("あい");
    expect(read("<0x93><0x8C><0x8B><0x9E> Net")).toBe("東京 Net");
    // cut after the lead byte of the next character
    expect(read("<0x82><0xA0><0x82>")).toBe("あ");
  });

  it("keeps Latin-1 text that is not UTF-8 and not clearly Shift_JIS", () => {
    // "café": a lone E9 at the end looks like a cut 3-byte lead, but nothing before it shows
    // that the text is UTF-8, so it is read as Latin-1.
    expect(read("caf<0xE9>")).toBe("café");
    // "été": E9 74 would be a valid Shift_JIS pair, but its lead byte is not 81-9F, which no
    // Latin-1 text can contain, so it is not taken for Shift_JIS.
    expect(read("<0xE9>t<0xE9>")).toBe("été");
    expect(read("Gr<0xFC><0xDF>e")).toBe("Grüße");
    expect(read("<0xC4>rger")).toBe("Ärger");
  });

  it("keeps garbage visible as Latin-1 rather than dropping it", () => {
    expect(read("<0xFF><0xFE>")).toBe("ÿþ");
    // a single Windows-1252 apostrophe (92 74 would be one Shift_JIS kanji) is not enough
    // evidence of Shift_JIS: the text needs kana or at least two double-byte characters
    expect(read("don<0x92>t")).toBe("don\x92t");
  });

  it("leaves valid UTF-8 and ASCII alone", () => {
    expect(read("Hello")).toBe("Hello");
    expect(read("Hi <0xE3><0x81><0x82>!")).toBe("Hi あ!");
    // a lone lead byte at the end is dropped when the text before it is clearly UTF-8
    expect(read("<0xE3><0x81><0x82><0xE3>")).toBe("あ");
  });
});

describe("M3: timestamp ranges", () => {
  // APRS101 ch.6: DD 01-31, HH 00-23, MM 00-59, SS 00-59, month 01-12. We accept SS up to
  // 59 only (no leap second 60).
  it("rejects impossible values in / and @ reports", () => {
    expect(unknownReason("Q1A>APRS:@999999h4903.50N/07201.75W>hi")).toMatch(/timestamp/);
    expect(unknownReason("Q1A>APRS:/320000z4903.50N/07201.75W>")).toMatch(/timestamp/);
    expect(unknownReason("Q1A>APRS:/000000z4903.50N/07201.75W>")).toMatch(/timestamp/);
    expect(unknownReason("Q1A>APRS:/092400z4903.50N/07201.75W>")).toMatch(/timestamp/);
    expect(unknownReason("Q1A>APRS:/092360z4903.50N/07201.75W>")).toMatch(/timestamp/);
    expect(unknownReason("Q1A>APRS:@240000h4903.50N/07201.75W>")).toMatch(/timestamp/);
    expect(unknownReason("Q1A>APRS:@000060h4903.50N/07201.75W>")).toMatch(/timestamp/);
    expect(unknownReason("Q1A>APRS:;LEADER   *999999z4903.50N/07201.75W>")).toMatch(/timestamp/);
  });

  it("accepts the limits", () => {
    expect(expectType("Q1A>APRS:@235959h4903.50N/07201.75W>", "position").timestamp).toEqual({
      format: "hms",
      hour: 23,
      minute: 59,
      second: 59,
    });
    expect(expectType("Q1A>APRS:/312359z4903.50N/07201.75W>", "position").timestamp).toEqual({
      format: "dhm-z",
      day: 31,
      hour: 23,
      minute: 59,
    });
    expect(expectType("Q1A>APRS:/010000z4903.50N/07201.75W>", "position").timestamp?.day).toBe(1);
  });

  it("rejects impossible values in the weather timestamp MMDDHHMM", () => {
    expect(unknownReason("Q1WX>APRS:_13090556c220s004")).toMatch(/timestamp/);
    expect(unknownReason("Q1WX>APRS:_00090556c220s004")).toMatch(/timestamp/);
    expect(unknownReason("Q1WX>APRS:_10990556c220s004")).toMatch(/timestamp/);
    expect(unknownReason("Q1WX>APRS:_10092456c220s004")).toMatch(/timestamp/);
    expect(unknownReason("Q1WX>APRS:_10090560c220s004")).toMatch(/timestamp/);
  });

  it("is unknown for a weather report without any weather field", () => {
    expect(unknownReason("Q1WX>APRS:_hello")).toMatch(/weather/);
    expect(unknownReason("Q1WX>APRS:_10090556")).toMatch(/weather/);
    // fields that are present but blank ("...") still count as a weather report
    expect(expectType("Q1WX>APRS:_10090556c...s...", "weather").weather).toEqual({});
  });

  describe("resolveTimestamp", () => {
    const ref = new Date(Date.UTC(2026, 10, 18, 12, 0, 0));
    it("does not resolve out-of-range values", () => {
      // used to give 2026-11-21T04:40:39Z and 2026-11-18T13:39Z
      expect(
        resolveTimestamp({ format: "hms", hour: 99, minute: 99, second: 99 }, ref),
      ).toBeUndefined();
      expect(
        resolveTimestamp({ format: "dhm-z", day: 18, hour: 12, minute: 99 }, ref),
      ).toBeUndefined();
      expect(
        resolveTimestamp({ format: "dhm-z", day: 0, hour: 12, minute: 0 }, ref),
      ).toBeUndefined();
      expect(
        resolveTimestamp({ format: "dhm-z", day: 32, hour: 12, minute: 0 }, ref),
      ).toBeUndefined();
      expect(
        resolveTimestamp({ format: "dhm-z", day: 18, hour: 24, minute: 0 }, ref),
      ).toBeUndefined();
      expect(
        resolveTimestamp({ format: "hms", hour: 1, minute: 1, second: 60 }, ref),
      ).toBeUndefined();
      expect(
        resolveTimestamp({ format: "mdhm", month: 13, day: 1, hour: 0, minute: 0 }, ref),
      ).toBeUndefined();
      expect(
        resolveTimestamp({ format: "mdhm", month: 0, day: 1, hour: 0, minute: 0 }, ref),
      ).toBeUndefined();
    });

    it("still resolves the limits", () => {
      const justAfterMidnight = new Date(Date.UTC(2026, 10, 18, 0, 0, 10));
      expect(
        resolveTimestamp(
          { format: "hms", hour: 23, minute: 59, second: 59 },
          justAfterMidnight,
        )?.toISOString(),
      ).toBe("2026-11-17T23:59:59.000Z");
    });
  });
});

describe("M4: ack / rej", () => {
  // A reply is `ack` or `rej` followed by a message number and nothing else. The number is
  // 1-5 letters or digits (APRS101 ch.14) and must contain a digit: that keeps ordinary words
  // that merely start with "ack" or "rej" ("reject", "acked") from being replies.
  it("does not take ordinary words for replies", () => {
    for (const [text, line] of [
      ["reject", "Q1A>APRS::Q1B      :reject"],
      ["acked", "Q1A>APRS::Q1B      :acked"],
      ["ack.", "Q1A>APRS::Q1B      :ack."],
      ["ack", "Q1A>APRS::Q1B      :ack"],
      ["ack123456", "Q1A>APRS::Q1B      :ack123456"],
      ["rej 1", "Q1A>APRS::Q1B      :rej 1"],
    ] as const) {
      const d = expectType(line, "message");
      expect(d.reply, text).toBeUndefined();
      expect(d.text, text).toBe(text);
      expect(d.msgNo, text).toBeUndefined();
    }
  });

  it("still takes ack and rej with 1-5 alphanumerics including a digit", () => {
    expect(expectType("Q1A>APRS::Q1B      :ack1", "message")).toMatchObject({
      reply: "ack",
      msgNo: "1",
      text: "",
    });
    expect(expectType("Q1A>APRS::Q1B      :rejA1b2C", "message")).toMatchObject({
      reply: "rej",
      msgNo: "A1b2C",
    });
  });

  it("keeps the acknowledgement of the reply-ack form {mm}aa (APRS 1.2)", () => {
    const d = expectType("Q1A>APRS::Q1B      :Hi{12}34", "message");
    expect(d.text).toBe("Hi");
    expect(d.msgNo).toBe("12");
    expect(d.replyAck).toBe("34");
    // `{12}` alone only says that the sender can use reply-ack
    const e = expectType("Q1A>APRS::Q1B      :Hi{12}", "message");
    expect(e.msgNo).toBe("12");
    expect(e.replyAck).toBeUndefined();
  });

  it("does not take {...} with other characters for a message number", () => {
    const d = expectType("Q1A>APRS::Q1B      :Meet at {1.5km", "message");
    expect(d.msgNo).toBeUndefined();
    expect(d.text).toBe("Meet at {1.5km");
  });
});

describe("bulletin flag (API)", () => {
  it("is a boolean", () => {
    expect(expectType("Q1A>APRS::BLN1     :Meeting", "message").bulletin).toBe(true);
    expect(expectType("Q1A>APRS::BLNA     :Announcement", "message").bulletin).toBe(true);
    expect(expectType("Q1A>APRS::NWS-TEST :Storm", "message").bulletin).toBe(true);
    expect(expectType("Q1A>APRS::Q1B      :Hi", "message").bulletin).toBe(false);
  });

  it("is not set by an addressee that merely starts with NWS or BLN", () => {
    // NWS1AB, NWS-1 (a station "NWS" with SSID 1) and BLNK are not bulletin names
    expect(expectType("Q1A>APRS::NWS1AB   :Hi", "message").bulletin).toBe(false);
    expect(expectType("Q1A>APRS::NWS-1    :Hi", "message").bulletin).toBe(false);
    expect(expectType("Q1A>APRS::BLN      :Hi", "message").bulletin).toBe(false);
  });
});

describe("M5: BITS", () => {
  it("needs exactly eight 0/1 characters", () => {
    const bad = parseTelemetryDefinition("BITS.1011,title");
    expect(bad).toEqual({ kind: "BITS" });
    expect(parseTelemetryDefinition("BITS.1011000x,t")).toEqual({ kind: "BITS" });
    expect(parseTelemetryDefinition("BITS.101100001,t")).toEqual({ kind: "BITS" });
  });

  it("reads the title with or without the comma", () => {
    expect(parseTelemetryDefinition("BITS.10110000,Balloon")).toEqual({
      kind: "BITS",
      bits: "10110000",
      title: "Balloon",
    });
    expect(parseTelemetryDefinition("BITS.10110000")).toEqual({
      kind: "BITS",
      bits: "10110000",
      title: "",
    });
  });
});

describe("M6 / L10: EQNS and plain decimal numbers", () => {
  it("leaves out a channel with an unreadable number instead of making it 0", () => {
    const d = parseTelemetryDefinition("EQNS.a,b,c,1,2,3");
    expect(d?.eqns).toEqual([undefined, { a: 1, b: 2, c: 3 }]);
    expect(parseTelemetryDefinition("EQNS.x,1,2")?.eqns).toEqual([undefined]);
    // an empty field is not a number either
    expect(parseTelemetryDefinition("EQNS.0,,0,1,2,3")?.eqns).toEqual([
      undefined,
      { a: 1, b: 2, c: 3 },
    ]);
  });

  it("gives the value through for a channel without a usable equation", () => {
    const eq = parseTelemetryDefinition("EQNS.a,b,c,0,2,0")!.eqns!;
    expect(applyEqns([7, 10], eq)).toEqual([7, 20]);
  });

  it("accepts only plain decimal numbers (no hex, no exponent)", () => {
    expect(parseTelemetryDefinition("EQNS.0x10,1,2")?.eqns).toEqual([undefined]);
    expect(parseTelemetryDefinition("EQNS.1e3,1,2")?.eqns).toEqual([undefined]);
    expect(parseTelemetryDefinition("EQNS.-1.5,+2,.5")?.eqns).toEqual([{ a: -1.5, b: 2, c: 0.5 }]);
    const t = expectType("Q1A>APRS:T#001,0x10,1e3,Infinity,4,5", "telemetry");
    expect(t.analog).toEqual([undefined, undefined, undefined, 4, 5]);
  });
});

describe("L2: no negative zero", () => {
  it("normalizes -0 in uncompressed positions", () => {
    const p = expectType("Q1A>APRS:!0000.00S/00000.00W>x", "position").position;
    expect(Object.is(p.lat, 0)).toBe(true);
    expect(Object.is(p.lon, 0)).toBe(true);
  });

  it("normalizes -0 in Mic-E", () => {
    // destination 0000PP: lat 00°00.00', char 4 'P' = longitude offset +100 and char 5 'P' =
    // West, char 3 '0' = South. Longitude 0°: 190 -> value 90 -> 'v'; minutes 0 -> 60 -> 'X';
    // hundredths 0 -> 0x1C.
    const p = expectType("Q1TEST>0000PP:`vX<0x1C><0x1C><0x1C><0x1C>>/", "mice").position;
    expect(Object.is(p.lat, 0)).toBe(true);
    expect(Object.is(p.lon, 0)).toBe(true);
  });
});

describe("M8 / L8: DAO", () => {
  it("adds precision to a Mic-E position (human readable !W12!)", () => {
    // 35°40.80'N + 0.001' = lat, 139°45.60'E + 0.002' = lon (away from the equator and the
    // prime meridian; '1' and '2' are thousandths of a minute).
    const d = expectType("Q1TEST>SU4PX0:`CIXl <0x1C>[/Hi !W12!", "mice");
    expect(d.position.dao).toBe(true);
    expect(d.position.lat).toBeCloseTo(35 + 40.801 / 60, 9);
    expect(d.position.lon).toBeCloseTo(139 + 45.602 / 60, 9);
    expect(d.position.comment).toBe("Hi ");
  });

  it("adds precision to a Mic-E position in the south and west (base 91 !wZZ!)", () => {
    // 33°56.32'S 118°25.43'W; 'Z' = 57 -> 57/91 hundredths of a minute, more south and west
    const d = expectType("Q1TEST>SSU6SR:`.5G!Pb>/!wZZ!", "mice");
    const extra = (57 / 91) * 0.01;
    expect(d.position.lat).toBeCloseTo(-(33 + (56.32 + extra) / 60), 9);
    expect(d.position.lon).toBeCloseTo(-(118 + (25.43 + extra) / 60), 9);
    expect(d.position.comment).toBe("");
  });

  it("ignores a DAO on an ambiguous Mic-E position", () => {
    const d = expectType("Q1TEST>SU4PXL:`CIXl <0x1C>[/!W12!", "mice");
    expect(d.position.dao).toBeUndefined();
    expect(d.position.comment).toBe("!W12!");
  });

  it("goes south and west of the equator / prime meridian from exactly 0", () => {
    // lat 0°00.00'S: the hemisphere decides the direction, not the sign of 0
    const d = expectType("Q1A>APRS:!0000.00S/00000.00W>!W55!", "position");
    expect(d.position.lat).toBeCloseTo(-0.005 / 60, 12);
    expect(d.position.lon).toBeCloseTo(-0.005 / 60, 12);
  });

  it("only takes the defined datum characters W, R, w, r", () => {
    // "!Q12!" is not a DAO (Q is no datum): the text stays in the comment
    const q = expectType("Q1A>APRS:!3540.12N/13945.67E>Hello !Q12!", "position");
    expect(q.position.dao).toBeUndefined();
    expect(q.position.comment).toBe("Hello !Q12!");
    // "!aXY!" is not a base-91 DAO either
    const a = expectType("Q1A>APRS:!3540.12N/13945.67E>Hello !aXY!", "position");
    expect(a.position.dao).toBeUndefined();
    // R (human readable) is defined
    const r = expectType("Q1A>APRS:!3540.12N/13945.67E>Hello !R12!", "position");
    expect(r.position.dao).toBe(true);
  });

  it("only takes the DAO at the end of the comment", () => {
    const d = expectType("Q1A>APRS:!3540.12N/13945.67E>Hi !W12! there", "position");
    expect(d.position.dao).toBeUndefined();
    expect(d.position.comment).toBe("Hi !W12! there");
  });

  it("does not move a position past the pole", () => {
    // 90°00.00'N + 0.009' would be 90.00015 degrees: the DAO is ignored
    const d = expectType("Q1A>APRS:!9000.00N/07201.75W>!W99!", "position");
    expect(d.position.lat).toBe(90);
    expect(d.position.dao).toBeUndefined();
  });
});

describe("L4: geo helpers with non-finite input", () => {
  it("cardinal and formatLatLon return a dash", () => {
    expect(cardinal(NaN)).toBe("—");
    expect(cardinal(Infinity)).toBe("—");
    expect(formatLatLon({ lat: NaN, lon: 0 })).toBe("—");
    expect(formatLatLon({ lat: 0, lon: Infinity })).toBe("—");
  });

  it("formatLatLon carries a rounded-up minute into the degree", () => {
    // 35.99999999 degrees = 35°59.9999994' -> rounds to 60.000' -> 36°00.000'
    expect(formatLatLon({ lat: 35.99999999, lon: 139.99999999 })).toBe("36°00.000'N 140°00.000'E");
    expect(formatLatLon({ lat: -35.99999999, lon: -0.99999999 })).toBe("36°00.000'S 001°00.000'W");
  });
});

describe("L5-L7: TNC2 header", () => {
  function header(line: string) {
    const t = parseTnc2(line);
    if (isTnc2Error(t)) throw new Error(t.error);
    return t;
  }

  it("splitCall limits the SSID to 0-15", () => {
    expect(splitCall("Q1A-15")).toEqual({ call: "Q1A", ssid: 15 });
    expect(splitCall("Q1A-0")).toEqual({ call: "Q1A", ssid: 0 });
    expect(splitCall("Q1A-16")).toEqual({ call: "Q1A-16", ssid: 0 });
    expect(splitCall("Q1A-123")).toEqual({ call: "Q1A-123", ssid: 0 });
  });

  it("drops a lone * in the path but keeps the earlier entries as used", () => {
    expect(header("Q1AAA>APRS,WIDE1-1,*:>x").path).toEqual([{ call: "WIDE1-1", used: true }]);
    expect(header("Q1AAA>APRS,*:>x").path).toEqual([]);
  });

  it("flags q constructs", () => {
    const t = header("Q1AAA>APRS,WIDE1-1*,qAR,Q1IGT:>x");
    expect(t.path).toEqual([
      { call: "WIDE1-1", used: true },
      { call: "qAR", used: false, qConstruct: true },
      { call: "Q1IGT", used: false },
    ]);
    expect(header("Q1AAA>APRS,qAo,Q1IGT:>x").path[0]!.qConstruct).toBe(true);
    // not a q construct: a digipeater whose name starts with q
    expect(header("Q1AAA>APRS,qABC:>x").path[0]!.qConstruct).toBeUndefined();
  });

  it("trims spaces around the destination and the source", () => {
    expect(header("Q1AAA > APRS ,WIDE1-1:>x").dst).toBe("APRS");
    expect(header("Q1AAA > APRS ,WIDE1-1:>x").src).toBe("Q1AAA");
    expect(isTnc2Error(parseTnc2("Q1AAA>  :x"))).toBe(true);
  });

  it("keeps the case of callsigns as received (policy: compare with toUpperCase())", () => {
    const t = header("q1aaa-9>aprs,wide1-1*:>x");
    expect(t.src).toBe("q1aaa-9");
    expect(t.dst).toBe("aprs");
    expect(t.path[0]!.call).toBe("wide1-1");
  });
});

describe("L6: compressed weather", () => {
  // In the compressed format the wind is in cs, so 's' in the text is snowfall, as after the
  // ccc/sss prefix of the uncompressed form (APRS101 ch.12).
  it("reads s in the text as snowfall, not as wind speed", () => {
    const d = expectType("Q1WX>APRS:=/5L!!<*e7_  !s005g005t077", "position");
    const w = d.position.weather!;
    expect(w.windSpeedMs).toBeUndefined();
    expect(w.snowMm).toBeCloseTo(5 * 25.4, 6);
    expect(w.gustMs).toBeCloseTo(5 * 0.44704, 6);
    expect(w.tempC).toBeCloseTo(25, 6);
  });

  it("takes the wind direction from the course byte of cs", () => {
    // '7' = 55 - 33 = 22 -> 22 * 4 = 88 degrees (as in the compressed example of APRS101)
    const d = expectType("Q1WX>APRS:=/5L!!<*e7_7P[g005t077", "position");
    expect(d.position.weather?.windDirDeg).toBe(88);
    expect(d.position.courseDeg).toBeUndefined();
    expect(d.position.speedKmh).toBeUndefined();
  });
});

describe("/A=: more than one altitude", () => {
  it("takes the first /A= and leaves the second in the comment", () => {
    // APRS101 allows one /A= field; a second one is not an altitude, it is text.
    const d = expectType("Q1A>APRS:!4903.50N/07201.75W>/A=001000 x /A=002000", "position");
    expect(d.position.altitudeM).toBeCloseTo(1000 * 0.3048, 6);
    expect(d.position.comment).toBe(" x /A=002000");
  });
});

describe("symbols (L11)", () => {
  it("has the symbols that were missing", () => {
    const s = (table: "/" | "\\", code: string): AprsSymbol => ({ table, code });
    // Reference: the master list http://www.aprs.org/symbols/symbolsX.txt (cross-checked with the
    // W6KWF/OH7LZB chart image).
    expect(symbolInfo(s("\\", "9")).name).toBe("Gas station"); // A9 Gas Station
    expect(symbolInfo(s("\\", "8")).name).toBe("802.11 / network node");
    expect(symbolInfo(s("\\", "%")).name).toBe("Power plant"); // OFO Power Plant with overlay
    expect(symbolInfo(s("\\", "M")).name).toBe("MARS"); // AMO
    expect(symbolInfo(s("\\", "l")).name).toBe("Area"); // SL Areas
    expect(symbolInfo(s("\\", "x")).name).toBe("Wreck / obstruction");
    expect(symbolInfo(s("\\", ")")).known).toBe(true);
    expect(symbolInfo(s("/", "r")).name).toBe("Repeater"); // LR Repeater (Feb 07)
    // Marked reserved / AVAIL / TBD / blank in the list: no made-up names.
    for (const c of ['"', "D", "J", "Q", "z", "{", "}"])
      expect(symbolInfo(s("/", c)).known).toBe(false);
    for (const c of ['"', "1", "Z", "]", "q", "}"])
      expect(symbolInfo(s("\\", c)).known).toBe(false);
    expect(symbolInfo(s("/", "5")).name).toBe("Numbered circle");
    expect(symbolInfo(s("/", "|")).name).toBe("TNC stream switch");
    expect(symbolInfo(s("/", "~")).name).toBe("TNC stream switch");
  });
});

describe("API helpers", () => {
  it("packetPosition returns the position inside a third-party packet", () => {
    const p = parseAprs("Q1GATE>APRS:}Q1AAA-9>APRS,TCPIP,Q1GATE*:!3540.12N/13945.67E>Hi");
    expect(packetPosition(p)?.lat).toBeCloseTo(35.66867, 5);
    expect(packetPosition(p)?.lon).toBeCloseTo(139.76117, 5);
  });

  it("packetLatLon also gives the centre of a status locator, marked approximate", () => {
    const g = packetLatLon(parseAprs("Q1AAA>APRS:>IO91SX/G Hi"));
    expect(g?.approximate).toBe(true);
    expect(g?.lat).toBeCloseTo(51.9792, 3);
    expect(g?.lon).toBeCloseTo(-0.4583, 3);
    const e = packetLatLon(parseAprs("Q1AAA>APRS:!4903.50N/07201.75W>"));
    expect(e?.approximate).toBe(false);
    expect(e?.lat).toBeCloseTo(49 + 3.5 / 60, 8);
    expect(packetLatLon(parseAprs("Q1AAA>APRS:>no grid"))).toBeUndefined();
  });

  it("packetWeather unifies position.weather and weather reports", () => {
    const pos = parseAprs("Q1WX>APRS:!4903.50N/07201.75W_220/004g005t077");
    expect(packetWeather(pos)?.tempC).toBeCloseTo(25, 6);
    const rep = parseAprs("Q1WX>APRS:_10090556c220s004t077");
    expect(packetWeather(rep)?.windDirDeg).toBe(220);
    expect(packetWeather(parseAprs("Q1WX>APRS:!4903.50N/07201.75W>"))).toBeUndefined();
    const third = parseAprs("Q1GATE>APRS:}Q1WX>APRS:_10090556c220s004t077");
    expect(packetWeather(third)?.windDirDeg).toBe(220);
  });

  it("packetProblem unifies packet.error and data.reason", () => {
    expect(packetProblem(parseAprs("garbage"))).toMatch(/\S/);
    expect(packetProblem(parseAprs("Q1AAA>APRS:%foo"))).toBe("unsupported data type");
    expect(packetProblem(parseAprs("Q1AAA>APRS:>ok"))).toBeUndefined();
  });
});
