import { describe, expect, it } from "vitest";
import { parseAprs } from "../../src/aprs/parse.ts";
import { expectType } from "./util.ts";

// The packet the device itself sends (ble-protocol.md §8.3), after the JSON string is decoded.
// Hand-decoded:
//   destination SU4PX0 -> digits 3 5 4 0 8 0 = 35°40.80'; char 4 'P' (bit 1) = North;
//     char 5 'X' (bit 1) = longitude +100; char 6 '0' (bit 0) = East;
//     chars 1-3 S U 4 = bits 1 1 0 (standard) -> message 7 - 6 = 1 "En Route"
//   info after the data type "`": C I X l ' ' 0x1C [ /
//     lon: 'C'(67)-28 = 39, +100 = 139; 'I'(73)-28 = 45 min; 'X'(88)-28 = 60 hundredths -> 139°45.60'
//     speed: 'l'(108)-28 = 80 -> 800, minus 800 = 0 kn; course: ' '(32)-28 = 4 -> 400, minus 400 = 0
//     symbol code '[', table '/'
//   comment starts with "4!} : '"'(34)-33 = 1, '4'(52)-33 = 19, '!' = 0
//     -> 1*8281 + 19*91 + 0 = 10010; minus 10000 = 10 m
const DEVICE = 'Q1TEST-7>SU4PX0,WIDE1-1:`CIXl <0x1C>[/"4!}Pico2 APRS';

describe("Mic-E, the packet the device sends", () => {
  const d = expectType(DEVICE, "mice");

  it("decodes position, speed and course", () => {
    expect(d.position.lat).toBeCloseTo(35 + 40.8 / 60, 8);
    expect(d.position.lon).toBeCloseTo(139 + 45.6 / 60, 8);
    expect(d.position.speedKmh).toBe(0);
    expect(d.position.courseDeg).toBeUndefined();
    expect(d.position.ambiguity).toBe(0);
    expect(d.position.compressed).toBe(false);
  });

  it("decodes symbol, altitude and comment", () => {
    expect(d.position.symbol).toEqual({ table: "/", code: "[" });
    expect(d.position.altitudeM).toBe(10);
    expect(d.position.comment).toBe("Pico2 APRS");
    expect(d.typeCode).toBeUndefined();
  });

  it("decodes the message from the destination", () => {
    expect(d.message).toEqual({ kind: "standard", index: 1, name: "En Route" });
  });
});

describe("Mic-E, south and west", () => {
  // destination SSU6SR -> 3 3 5 6 3 2 = 33°56.32'; 'S','S','U' = 111 -> message 0 Off Duty;
  //   '6' bit 0 = South; 'S' bit 1 = +100; 'R' bit 1 = West
  // info: '.'(46)-28 = 18 -> 118; '5'(53)-28 = 25; 'G'(71)-28 = 43 -> 118°25.43'
  //   speed: '!'(33)-28 = 5 -> 50, 'P'(80)-28 = 52 -> +5 = 55 kn; course: 52 % 10 = 2 -> 200, 'b'(98)-28 = 70 -> 270
  const d = expectType("Q1TEST>SSU6SR:`.5G!Pb>/Test", "mice");

  it("decodes the position", () => {
    expect(d.position.lat).toBeCloseTo(-(33 + 56.32 / 60), 8);
    expect(d.position.lon).toBeCloseTo(-(118 + 25.43 / 60), 8);
  });

  it("decodes speed, course and symbol", () => {
    expect(d.position.speedKmh).toBeCloseTo(55 * 1.852, 6);
    expect(d.position.courseDeg).toBe(270);
    expect(d.position.symbol).toEqual({ table: "/", code: ">" });
    expect(d.position.comment).toBe("Test");
  });

  it("decodes message 0", () => {
    expect(d.message).toEqual({ kind: "standard", index: 0, name: "Off Duty" });
  });
});

describe("Mic-E longitude and speed corrections", () => {
  it("maps 190-199 back to 0-9 degrees", () => {
    // destination SSU6S0: 33°56.30' S, offset, East. '{'(123)-28 = 95, +100 = 195 -> 5 degrees.
    // minutes 7 -> 67 -> '_'(95); hundredths 50 -> 78 'N'
    const d = expectType("Q1TEST>SSU6S0:`{_N<0x1C><0x1C><0x1C>>/", "mice");
    expect(d.position.lon).toBeCloseTo(5 + 7.5 / 60, 8);
    expect(d.position.lat).toBeCloseTo(-(33 + 56.3 / 60), 8);
  });

  it("maps 180-189 back to 100-109 degrees", () => {
    // 'q'(113)-28 = 85, +100 = 185 -> 105; minutes 0 -> 60 -> 'X'
    const d = expectType("Q1TEST>SSU6S0:`qX<0x1C><0x1C><0x1C><0x1C>>/", "mice");
    expect(d.position.lon).toBeCloseTo(105, 8);
  });

  it("decodes speeds over 99 knots and courses over 299", () => {
    // '('(40)-28 = 12 -> 120 kn; 0x1F-28 = 3 -> speed +0, course 300; 'W'(87)-28 = 59 -> 359
    const d = expectType("Q1TEST>SSU6SR:`.5G(<0x1F>W>/", "mice");
    expect(d.position.speedKmh).toBeCloseTo(120 * 1.852, 6);
    expect(d.position.courseDeg).toBe(359);
  });
});

describe("Mic-E messages", () => {
  it("reads custom messages (A-K in the first three characters)", () => {
    const d = expectType('Q1TEST>AB4P80:`CIXl <0x1C>[/"', "mice");
    expect(d.message).toEqual({ kind: "custom", index: 1, name: "Custom 1" });
  });

  it("reads emergency (all message bits clear)", () => {
    const d = expectType('Q1TEST>354080:`CIXl <0x1C>[/"', "mice");
    expect(d.message).toEqual({ kind: "emergency", name: "Emergency" });
  });

  it("covers the standard messages 0 to 6", () => {
    const names = [
      "Off Duty",
      "En Route",
      "In Service",
      "Returning",
      "Committed",
      "Special",
      "Priority",
    ];
    // first three destination characters: 1 -> 'P'+digit (standard), 0 -> digit
    const bits = [
      ["P", "P", "P"], // 111 -> 0
      ["P", "P", "0"], // 110 -> 1
      ["P", "0", "P"], // 101 -> 2
      ["P", "0", "0"], // 100 -> 3
      ["0", "P", "P"], // 011 -> 4
      ["0", "P", "0"], // 010 -> 5
      ["0", "0", "P"], // 001 -> 6
    ];
    bits.forEach((b, i) => {
      const d = expectType(`Q1TEST>${b.join("")}P00:\`CIXl <0x1C>[/`, "mice");
      expect(d.message).toEqual({ kind: "standard", index: i, name: names[i] });
    });
  });

  it("reports no message when custom and standard bits are mixed (position is kept)", () => {
    // APRS101 forbids the mix, but it says nothing against the position, so only the message
    // is dropped (L5 of the review; see also review.test.ts).
    const d = expectType('Q1TEST>AP4P80:`CIXl <0x1C>[/"', "mice");
    expect(d.message).toBeNull();
    // digits 0 0 4 0 8 0 -> 0°40.80'N
    expect(d.position.lat).toBeCloseTo(40.8 / 60, 8);
  });
});

describe("Mic-E details", () => {
  it("counts blank digits (K, L, Z) as ambiguity", () => {
    // SU4PXL: last digit blank -> hundredths 80 stays 80 (the blank counts as 0)
    const one = expectType('Q1TEST>SU4PXL:`CIXl <0x1C>[/"', "mice");
    expect(one.position.ambiguity).toBe(1);
    expect(one.position.lat).toBeCloseTo(35 + 40.8 / 60, 8);
    const two = expectType('Q1TEST>SU4PLL:`CIXl <0x1C>[/"', "mice");
    expect(two.position.ambiguity).toBe(2);
    expect(two.position.lat).toBeCloseTo(35 + 40 / 60, 8);
  });

  it("removes the type character from the comment", () => {
    const d = expectType("Q1TEST-7>SU4PX0:`CIXl <0x1C>[/>Hello", "mice");
    expect(d.typeCode).toBe(">");
    expect(d.position.comment).toBe("Hello");
  });

  it("accepts the old data types 0x1C and 0x1D", () => {
    expect(expectType("Q1TEST-7>SU4PX0:<0x1C>CIXl <0x1C>[/", "mice").position.lon).toBeCloseTo(
      139.76,
      6,
    );
    expect(expectType("Q1TEST-7>SU4PX0:<0x1D>CIXl <0x1C>[/", "mice").position.lat).toBeCloseTo(
      35.68,
      6,
    );
  });

  it("ignores the SSID of the destination", () => {
    expect(expectType("Q1TEST-7>SU4PX0-3:`CIXl <0x1C>[/", "mice").position.lat).toBeCloseTo(
      35.68,
      6,
    );
  });

  it("is unknown when the destination or the information is wrong", () => {
    for (const line of [
      "Q1TEST>ABC:`CIXl <0x1C>[/",
      "Q1TEST>SU4PX0:`CIXl",
      "Q1TEST>SU4PXa:`CIXl <0x1C>[/",
      "Q1TEST>SU4PXA:`CIXl <0x1C>[/", // A is only valid in the first three characters
    ]) {
      expect(parseAprs(line).data.type, line).toBe("unknown");
    }
  });
});
