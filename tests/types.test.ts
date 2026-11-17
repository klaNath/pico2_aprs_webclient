import { describe, expect, it } from "vitest";
import { isParseError, parseMessage, rxKind } from "../src/protocol/types.ts";

describe("parseMessage", () => {
  it("keeps unknown keys", () => {
    const m = parseMessage('{"t":"status","fix":3,"future_key":[1,2]}');
    expect(isParseError(m)).toBe(false);
    expect(m).toMatchObject({ t: "status", fix: 3, future_key: [1, 2] });
  });

  it("passes an unknown t through", () => {
    expect(parseMessage('{"t":"newthing","x":1}')).toEqual({ t: "newthing", x: 1 });
  });

  it("reports unreadable lines", () => {
    for (const line of ["{", "not json", "[1,2]", "5", "null", '{"no_t":1}', '{"t":5}']) {
      expect(isParseError(parseMessage(line)), line).toBe(true);
    }
  });

  it("treats a non-integer id as absent", () => {
    expect(parseMessage('{"t":"hello","id":1.5}')).not.toHaveProperty("id");
    expect(parseMessage('{"t":"hello","id":"1"}')).not.toHaveProperty("id");
    expect(parseMessage('{"t":"hello","id":7}')).toHaveProperty("id", 7);
  });
});

describe("parseMessage: types of known messages (§8)", () => {
  const bad: [string, string][] = [
    ["rx without tnc2", '{"t":"rx"}'],
    ["rx with numeric tnc2", '{"t":"rx","tnc2":5}'],
    ["rx with string lat", '{"t":"rx","tnc2":"A>B:x","lat":"35"}'],
    ["rx with non-boolean clip", '{"t":"rx","tnc2":"A>B:x","clip":"true"}'],
    ["tx without tnc2", '{"t":"tx","dry":true}'],
    ["tx with string dry", '{"t":"tx","tnc2":"A>B:x","dry":"false"}'],
    ["status with string tx_ready (would be truthy)", '{"t":"status","tx_ready":"false"}'],
    ["status with null tx_ready", '{"t":"status","tx_ready":null}'],
    ["status with numeric call", '{"t":"status","call":5}'],
    ["status with string fix", '{"t":"status","fix":"3"}'],
    ["status with a number too large for a double", '{"t":"status","lvl_db":1e999}'],
    ["hello without proto", '{"t":"hello","id":1}'],
    ["hello with string proto", '{"t":"hello","proto":"1"}'],
    ["station without src", '{"t":"station","id":1}'],
    ["station with bad own", '{"t":"station","src":"Q1AAA","own":1}'],
    ["settings without values", '{"t":"settings","id":3}'],
    ["settings with list values", '{"t":"settings","values":[1]}'],
    ["settings with bad changed", '{"t":"settings","values":{},"changed":"ssid"}'],
    ["schema without items", '{"t":"schema"}'],
    ["schema with a broken item", '{"t":"schema","items":[{"key":"a"}]}'],
    ["err without code", '{"t":"err","id":1}'],
    ["err with numeric code", '{"t":"err","code":5}'],
  ];
  for (const [name, line] of bad) {
    it(`rejects ${name}`, () => {
      expect(isParseError(parseMessage(line)), line).toBe(true);
    });
  }

  it("keeps the id of a malformed reply, so the request can be failed at once", () => {
    expect(parseMessage('{"t":"settings","id":3}')).toMatchObject({
      error: expect.any(String),
      id: 3,
    });
    expect(parseMessage('{"t":"rx"}')).not.toHaveProperty("id");
  });

  it("accepts the documented examples and tolerates unknown keys and kinds", () => {
    const ok = [
      '{"t":"status","utc":"2026-11-16T03:04:05Z","fix":3,"sats":9,"lat":35.68124,"lon":139.76712,"sw":true,"tx_enabled":true,"tx_ready":true,"call":"Q1TEST-7","last_tx_s":42,"next_beacon_s":48,"rx_count":17,"tx_count":3,"lvl_db":-18.5,"sd":"log 0012","dropped":0}',
      '{"t":"status"}',
      '{"t":"rx","tnc2":"Q1AAA-9>APRS:!x","kind":"future_kind","future":1,"clip":true}',
      '{"t":"tx","tnc2":"Q1TEST-7>APRS:x","dry":false}',
      '{"t":"hello","id":1,"proto":1,"name":"pico2_aprs","mode":"tnc"}',
      '{"t":"station","id":4,"src":"Q1AAA-9","last_s":120,"count":3,"own":true}',
      '{"t":"stations.end","id":4,"n":2}',
      '{"t":"settings","id":5,"values":{"callsign":null},"changed":["comment"]}',
      '{"t":"schema","id":2,"items":[{"key":"ssid","type":"int","min":0,"max":15}]}',
      '{"t":"err","id":5,"code":"invalid","key":"ssid","msg":"integer 0-15"}',
      '{"t":"err","code":"some_new_code"}',
    ];
    for (const line of ok) expect(isParseError(parseMessage(line)), line).toBe(false);
  });
});

describe("rxKind", () => {
  it("returns known kinds", () => {
    expect(rxKind({ kind: "mice" })).toBe("mice");
    expect(rxKind({ kind: "position" })).toBe("position");
  });

  it("maps unknown or missing kinds to other", () => {
    expect(rxKind({ kind: "telemetry" })).toBe("other");
    expect(rxKind({})).toBe("other");
    expect(rxKind({ kind: 5 })).toBe("other");
  });
});
