import { describe, expect, it } from "vitest";
import { parseAprs } from "../src/aprs/parse.ts";
import type { AprsPacket } from "../src/aprs/types.ts";
import type { FeedItem } from "../src/store/state.ts";
import {
  buildFeedJson,
  buildTnc2Log,
  CATEGORY_OPTIONS,
  detailRows,
  directionLabel,
  exportFileName,
  feedCategory,
  feedSource,
  fmtPath,
  fmtTimestamp,
  isFiltering,
  kindLabel,
  matchesFilter,
  NO_FILTER,
  num,
  oneLine,
  packetRows,
  selectItems,
  summarize,
  weatherSummary,
  type FeedFilter,
} from "../src/ui/feedFormat.ts";

let seq = 0;
function item(
  tnc2: string,
  over: {
    kind?: "rx" | "tx";
    at?: number;
    dry?: boolean;
    lvl?: number;
    clip?: boolean;
    src?: string;
  } = {},
): FeedItem {
  const kind = over.kind ?? "rx";
  const parsed: AprsPacket = parseAprs(tnc2);
  const msg =
    kind === "rx"
      ? {
          t: "rx" as const,
          tnc2,
          ...(over.src !== undefined ? { src: over.src } : {}),
          ...(over.lvl !== undefined ? { lvl_db: over.lvl } : {}),
          ...(over.clip !== undefined ? { clip: over.clip } : {}),
        }
      : { t: "tx" as const, tnc2, ...(over.dry !== undefined ? { dry: over.dry } : {}) };
  return { seq: ++seq, kind, at: over.at ?? Date.UTC(2026, 10, 18, 3, 4, 5), msg, parsed };
}

const SAMPLES: Record<string, string> = {
  position: "Q1AAA-9>APRS,WIDE1-1*:!3540.12N/13945.67E>Hello there",
  moving: "Q1AAA-9>APRS:!3540.12N/13945.67E>088/036/A=000100Moving",
  mice: 'Q1AAA>T2SP0W,WIDE1-1*:`(_fn"Oj/]Mic-E comment',
  object: "Q1AAA>APRS:;LEADER   *092345z4903.50N/07201.75W>088/036Convoy",
  killed: "Q1AAA>APRS:;LEADER   _092345z4903.50N/07201.75W>",
  item: "Q1AAA>APRS:)AID #2!4903.50N/07201.75WA",
  message: "Q1AAA>APRS::Q1BBB-7  :Hello there{123",
  ack: "Q1BBB>APRS::Q1AAA    :ack123",
  bulletin: "Q1AAA>APRS::BLN1     :Meeting tonight",
  status: "Q1AAA>APRS:>On the air PM95",
  weather: "Q1WX>APRS:_10090556c220s004g005t077r000p000P000h50b09900wRSW",
  weatherPos: "Q1WX>APRS:!4903.50N/07201.75W_220/004g005t077r000p000P000h50b09900",
  telemetry: "Q1AAA>APRS:T#005,199,000,255,073,123,01101001",
  parm: "Q1AAA>APRS::Q1AAA    :PARM.Vin,Temp,Rx",
  eqns: "Q1AAA>APRS::Q1AAA    :EQNS.0,5.2,0,0,.53,-32,3,4.39,49,-32,3,18,1,2,3",
  third: "Q1AAA>APRS:}Q1BBB>APRS,TCPIP,Q1AAA*:!4903.50N/07201.75W>",
  unknown: "Q1AAA>APRS:~junk",
  garbage: "this is not tnc2",
  empty: "",
};

describe("every sample gets a name, a summary and detail rows without throwing", () => {
  for (const [name, line] of Object.entries(SAMPLES)) {
    it(name, () => {
      const it_ = item(line);
      expect(kindLabel(it_.parsed)).toMatch(/\S/);
      expect(typeof summarize(it_.parsed)).toBe("string");
      expect(CATEGORY_OPTIONS.map((c) => c.value)).toContain(feedCategory(it_.parsed));
      const rows = detailRows(it_);
      expect(rows.length).toBeGreaterThanOrEqual(2);
      for (const r of rows) {
        expect(r.label).toMatch(/\S/);
        expect(typeof r.value).toBe("string");
      }
    });
  }

  it("survives a hand-made packet of a type it does not know", () => {
    const p = { tnc2: null, data: { type: "future-type" } } as unknown as AprsPacket;
    expect(() => kindLabel(p)).not.toThrow();
    expect(() => summarize(p)).not.toThrow();
    expect(() => packetRows(p)).not.toThrow();
    expect(feedCategory(p)).toBe("other");
  });

  it("survives a third-party packet with no inner packet", () => {
    const p: AprsPacket = {
      tnc2: { src: "Q1AAA", dst: "APRS", path: [], info: "}" },
      data: { type: "thirdparty", inner: null },
    };
    expect(summarize(p)).toContain("unreadable");
    expect(packetRows(p).some((r) => r.value === "unreadable")).toBe(true);
  });
});

describe("kinds and categories", () => {
  it.each([
    ["position", "position", "position"],
    ["mice", "mic-e", "mice"],
    ["object", "object", "object"],
    ["item", "item", "object"],
    ["message", "message", "message"],
    ["ack", "ack", "message"],
    ["bulletin", "bulletin", "message"],
    ["status", "status", "status"],
    ["weather", "weather", "weather"],
    ["weatherPos", "weather", "weather"],
    ["telemetry", "telemetry", "telemetry"],
    ["parm", "telemetry parm", "telemetry"],
    ["third", "3rd party", "other"],
    ["unknown", "unknown", "unknown"],
    ["garbage", "invalid", "unknown"],
  ])("%s", (name, label, category) => {
    const p = item(SAMPLES[name]!).parsed;
    expect(kindLabel(p)).toBe(label);
    expect(feedCategory(p)).toBe(category);
  });
});

describe("summaries", () => {
  it("position: coordinates, speed and comment", () => {
    expect(summarize(item(SAMPLES.position!).parsed)).toBe("35.6687, 139.7612 · Hello there");
    const s = summarize(item(SAMPLES.moving!).parsed);
    expect(s).toContain("67 km/h");
    expect(s).toContain("Moving");
  });
  it("object: name, state and position", () => {
    expect(summarize(item(SAMPLES.object!).parsed)).toMatch(/^LEADER · 49\.0583, -72\.0292/);
    expect(summarize(item(SAMPLES.killed!).parsed)).toContain("(killed)");
  });
  it("message: addressee and text; ack shows the number", () => {
    expect(summarize(item(SAMPLES.message!).parsed)).toBe("to Q1BBB-7: Hello there");
    expect(summarize(item(SAMPLES.ack!).parsed)).toBe("to Q1AAA: ack 123");
  });
  it("status shows the text", () => {
    expect(summarize(item(SAMPLES.status!).parsed)).toContain("On the air");
  });
  it("weather shows the key values (metric)", () => {
    const s = summarize(item(SAMPLES.weather!).parsed);
    expect(s).toContain("25 °C");
    expect(s).toContain("50 %");
    expect(s).toContain("wind 220°");
    expect(summarize(item(SAMPLES.weatherPos!).parsed)).toContain("25 °C");
  });
  it("weatherSummary copes with an empty report", () => {
    expect(weatherSummary({})).toBe("no values");
  });
  it("telemetry shows the sequence and channels", () => {
    expect(summarize(item(SAMPLES.telemetry!).parsed)).toBe("#5: 199, 0, 255, 73, 123");
  });
  it("a third-party packet shows the inner packet", () => {
    expect(summarize(item(SAMPLES.third!).parsed)).toMatch(/^via 49\.0583/);
  });
  it("unreadable packets say why", () => {
    expect(summarize(item(SAMPLES.unknown!).parsed).length).toBeGreaterThan(0);
    expect(summarize(item(SAMPLES.garbage!).parsed)).toMatch(/\S/);
  });
  it("keeps <0xHH> text readable and strips newlines from the text", () => {
    expect(oneLine("a\r\nb\t c")).toBe("a b c");
    expect(oneLine("x".repeat(500), 10)).toBe(`${"x".repeat(9)}…`);
  });
});

describe("detail rows", () => {
  const get = (rows: { label: string; value: string }[], label: string): string | undefined =>
    rows.find((r) => r.label === label)?.value;

  it("position: path, position, symbol, speed, course, altitude, comment", () => {
    const rows = detailRows(item(SAMPLES.moving!, { lvl: -31.25, clip: true }));
    expect(get(rows, "From")).toBe("Q1AAA-9");
    expect(get(rows, "Path")).toBe("direct");
    expect(get(rows, "Position")).toContain("35.66867");
    expect(get(rows, "Symbol")).toBe("Car (/>)");
    expect(get(rows, "Speed")).toBe("66.7 km/h");
    expect(get(rows, "Course")).toBe("88° E");
    expect(get(rows, "Altitude")).toBe("30 m");
    expect(get(rows, "Comment")).toBe("Moving");
    expect(get(rows, "Level")).toBe("-31.3 dB");
    expect(get(rows, "Clipping")).toBeDefined();
  });
  it("shows which path entry was used", () => {
    const p = item(SAMPLES.position!).parsed;
    expect(get(packetRows(p), "Path")).toBe("WIDE1-1*");
    expect(fmtPath([])).toBe("direct");
    expect(
      fmtPath([
        { call: "WIDE1-1", used: true },
        { call: "WIDE2-1", used: false },
        { call: "qAR", used: false, qConstruct: true },
        { call: "Q1X", used: false },
      ]),
    ).toBe("WIDE1-1*,WIDE2-1,qAR,Q1X");
  });
  it("message: addressee, text and number", () => {
    const rows = detailRows(item(SAMPLES.message!));
    expect(get(rows, "To")).toBe("Q1BBB-7");
    expect(get(rows, "Text")).toBe("Hello there");
    expect(get(rows, "Message no.")).toBe("123");
  });
  it("weather: every value with its unit", () => {
    const rows = detailRows(item(SAMPLES.weather!));
    expect(get(rows, "Temperature")).toBe("25 °C");
    expect(get(rows, "Humidity")).toBe("50 %");
    expect(get(rows, "Pressure")).toBe("990 hPa");
    expect(get(rows, "Wind direction")).toBe("220 °");
  });
  it("telemetry and telemetry definitions", () => {
    expect(get(detailRows(item(SAMPLES.telemetry!)), "Digital")).toBe("01101001");
    expect(get(detailRows(item(SAMPLES.parm!)), "Values")).toBe("Vin, Temp, Rx");
    expect(get(detailRows(item(SAMPLES.eqns!)), "Channel 1")).toContain("b=5.2");
  });
  it("third-party: the inner packet's rows are labelled", () => {
    const rows = detailRows(item(SAMPLES.third!));
    expect(get(rows, "Inner From")).toBe("Q1BBB");
    expect(get(rows, "Inner Symbol")).toBe("Car (/>)");
  });
  it("tx: dry run and no level", () => {
    const rows = detailRows(item(SAMPLES.position!, { kind: "tx", dry: true }));
    expect(get(rows, "Direction")).toBe("tx dry");
    expect(get(rows, "Level")).toBeUndefined();
  });
  it("timestamps", () => {
    expect(fmtTimestamp({ format: "dhm-z", day: 9, hour: 23, minute: 45 })).toBe(
      "day 09 23:45 UTC",
    );
    expect(fmtTimestamp({ format: "hms", hour: 1, minute: 2, second: 3 })).toBe("01:02:03 UTC");
    expect(fmtTimestamp({ format: "mdhm", month: 10, day: 9, hour: 8, minute: 7 })).toBe(
      "10-09 08:07",
    );
  });
});

describe("direction and source", () => {
  it("labels rx, tx and dry-run tx", () => {
    expect(directionLabel(item(SAMPLES.position!))).toBe("rx");
    expect(directionLabel(item(SAMPLES.position!, { kind: "tx" }))).toBe("tx");
    expect(directionLabel(item(SAMPLES.position!, { kind: "tx", dry: true }))).toBe("tx dry");
    expect(directionLabel(item(SAMPLES.position!, { kind: "tx", dry: false }))).toBe("tx");
  });
  it("the source is the device's, else the line's, else a dash", () => {
    expect(feedSource(item(SAMPLES.position!))).toBe("Q1AAA-9");
    expect(feedSource(item(SAMPLES.position!, { src: "Q1ZZZ" }))).toBe("Q1ZZZ");
    expect(feedSource(item(SAMPLES.garbage!))).toBe("—");
  });
});

describe("filter", () => {
  const rx1 = item(SAMPLES.position!);
  const rx2 = item(SAMPLES.message!);
  const tx1 = item(SAMPLES.status!, { kind: "tx" });
  const bad = item(SAMPLES.garbage!);
  const all = [rx1, rx2, tx1, bad];
  const f = (o: Partial<FeedFilter>): FeedFilter => ({ ...NO_FILTER, ...o });

  it("no filter matches everything", () => {
    expect(isFiltering(NO_FILTER)).toBe(false);
    expect(all.every((i) => matchesFilter(i, NO_FILTER))).toBe(true);
  });
  it("by direction", () => {
    expect(all.filter((i) => matchesFilter(i, f({ dir: "tx" })))).toEqual([tx1]);
    expect(all.filter((i) => matchesFilter(i, f({ dir: "rx" })))).toEqual([rx1, rx2, bad]);
  });
  it("by type", () => {
    expect(all.filter((i) => matchesFilter(i, f({ category: "message" })))).toEqual([rx2]);
    expect(all.filter((i) => matchesFilter(i, f({ category: "unknown" })))).toEqual([bad]);
  });
  it("by source, as a case-insensitive substring", () => {
    expect(all.filter((i) => matchesFilter(i, f({ source: "aaa-9" })))).toEqual([rx1]);
    expect(all.filter((i) => matchesFilter(i, f({ source: " q1aaa " })))).toEqual([rx1, rx2, tx1]);
    expect(isFiltering(f({ source: "  " }))).toBe(false);
  });
  it("combines the conditions", () => {
    expect(all.filter((i) => matchesFilter(i, f({ dir: "rx", source: "q1aaa" })))).toEqual([
      rx1,
      rx2,
    ]);
    expect(all.filter((i) => matchesFilter(i, f({ dir: "tx", category: "message" })))).toEqual([]);
  });
});

describe("selectItems", () => {
  const items = Array.from({ length: 10 }, (_, i) =>
    item(i % 2 === 0 ? SAMPLES.position! : SAMPLES.message!),
  );
  it("without a filter: the last `max`, oldest first", () => {
    const r = selectItems(items, NO_FILTER, 4);
    expect(r.shown).toEqual(items.slice(-4));
    expect(r.matched).toBe(10);
  });
  it("with a filter: the last `max` matches and the total", () => {
    const r = selectItems(items, { ...NO_FILTER, category: "position" }, 3);
    expect(r.matched).toBe(5);
    expect(r.shown).toEqual([items[4], items[6], items[8]]);
  });
  it("handles an empty feed", () => {
    expect(selectItems([], NO_FILTER, 5)).toEqual({ shown: [], matched: 0 });
    expect(selectItems([], { ...NO_FILTER, dir: "tx" }, 5)).toEqual({ shown: [], matched: 0 });
  });
});

describe("export", () => {
  it("file names use local time", () => {
    const d = new Date(2026, 10, 8, 3, 4, 5);
    expect(exportFileName(d, "json")).toBe("pico2aprs-feed-20261108-030405.json");
    expect(exportFileName(d, "txt")).toBe("pico2aprs-feed-20261108-030405.txt");
  });
  it("the TNC2 log is one packet per line, `<0xHH>` untouched", () => {
    const a = item("Q1AAA>APRS::Q1BBB    :a: <0xE3><0x81><0x82>{7");
    const b = item(SAMPLES.position!, { kind: "tx", dry: true });
    expect(buildTnc2Log([a, b])).toBe(`${a.msg.tnc2}\n${b.msg.tnc2}\n`);
    expect(buildTnc2Log([a])).toContain("<0xE3><0x81><0x82>");
    expect(buildTnc2Log([])).toBe("");
  });
  it("the TNC2 log never has a line break inside a packet", () => {
    const a = item("Q1AAA>APRS:>one\r\ntwo");
    expect(buildTnc2Log([a]).trimEnd().split("\n")).toHaveLength(1);
  });
  it("JSON carries the device's fields, the time in UTC and the type", () => {
    const a = item(SAMPLES.position!, {
      lvl: -20.5,
      clip: false,
      at: Date.UTC(2026, 10, 18, 1, 2, 3),
    });
    const b = item(SAMPLES.status!, { kind: "tx", dry: true });
    const now = new Date(Date.UTC(2026, 10, 18, 5, 0, 0));
    const j = JSON.parse(buildFeedJson([a, b], now)) as {
      format: string;
      exportedAt: string;
      count: number;
      items: Record<string, unknown>[];
    };
    expect(j.format).toBe("pico2aprs-feed");
    expect(j.exportedAt).toBe("2026-11-18T05:00:00.000Z");
    expect(j.count).toBe(2);
    expect(j.items[0]).toMatchObject({
      seq: a.seq,
      dir: "rx",
      at: "2026-11-18T01:02:03.000Z",
      type: "position",
      tnc2: SAMPLES.position,
      lvl_db: -20.5,
      clip: false,
    });
    expect(j.items[0]).not.toHaveProperty("t");
    expect(j.items[1]).toMatchObject({ dir: "tx", dry: true, type: "status" });
  });
  it("JSON of an empty feed", () => {
    expect(JSON.parse(buildFeedJson([], new Date(0)))).toMatchObject({ count: 0, items: [] });
  });
});

describe("num", () => {
  it("drops trailing zeros and negative zero", () => {
    expect(num(3.2)).toBe("3.2");
    expect(num(-0.04)).toBe("0");
    expect(num(10, 2)).toBe("10");
    expect(num(Number.NaN)).toBe("—");
  });
});
