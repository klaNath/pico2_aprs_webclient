import { describe, expect, it } from "vitest";
import { NO_VALUE } from "../src/aprs/geo.ts";
import type { FeedItem, StationRow } from "../src/store/state.ts";
import {
  ageText,
  ariaText,
  bearingText,
  buildItems,
  detailRows,
  filterItems,
  isAtPosition,
  latestPacket,
  parseSymbolChars,
  rowText,
  sortItems,
} from "../src/ui/stationList.ts";
import { parseAprs } from "../src/aprs/parse.ts";

const me = { lat: 35.68124, lon: 139.76712 };
const NOW = 1_000_000_000;

function row(src: string, extra: Partial<StationRow> = {}): StationRow {
  return { src, lastAt: NOW - 60_000, count: 1, own: false, ...extra };
}

const rows: StationRow[] = [
  row("Q1AAA-9", { lat: 35.66867, lon: 139.76117, lastAt: NOW - 120_000, count: 3, sym: "/>" }),
  row("Q1BBB", { lat: 35.7, lon: 139.8, lastAt: NOW - 240_000, count: 1, lvlDb: -27.5 }),
  row("Q1NOPOS", { lastAt: NOW - 10_000, count: 9 }),
  row("Q1TEST-7", { own: true, lastAt: NOW - 300_000, count: 1 }),
  row("Q1FAR", { lat: 40, lon: 140, lastAt: NOW - 5000, count: 2 }),
];

describe("parseSymbolChars", () => {
  it("reads table and code", () => {
    expect(parseSymbolChars("/>")).toEqual({ table: "/", code: ">" });
    expect(parseSymbolChars("\\#")).toEqual({ table: "\\", code: "#" });
  });
  it("treats a digit or capital as an alternate-table overlay", () => {
    expect(parseSymbolChars("1#")).toEqual({ table: "\\", code: "#", overlay: "1" });
    expect(parseSymbolChars("Ar")).toEqual({ table: "\\", code: "r", overlay: "A" });
  });
  it("rejects anything else", () => {
    for (const bad of [undefined, "", "/", "/>>", "a>", "/ ", " >", "/é"]) {
      expect(parseSymbolChars(bad)).toBeUndefined();
    }
  });
});

describe("buildItems", () => {
  it("computes distance and bearing from this tracker", () => {
    const items = buildItems(rows, me);
    const a = items.find((i) => i.src === "Q1AAA-9")!;
    expect(a.distanceM).toBeGreaterThan(1000);
    expect(a.distanceM).toBeLessThan(2000);
    expect(a.bearing).toBeGreaterThan(180); // south-west of the tracker
    expect(a.bearing).toBeLessThan(270);
    expect(a.symbolName).toBe("Car");
    expect(a.category).toBe("vehicle");
  });
  it("has no distance without a GPS fix, for a station without a position, or for the own entry", () => {
    expect(buildItems(rows, undefined).every((i) => i.distanceM === undefined)).toBe(true);
    const items = buildItems(rows, me);
    expect(items.find((i) => i.src === "Q1NOPOS")!.distanceM).toBeUndefined();
    expect(items.find((i) => i.own)!.distanceM).toBeUndefined();
  });
  it("ignores impossible coordinates", () => {
    const [i] = buildItems([row("Q1BAD", { lat: 200, lon: 0 })], me);
    expect(i!.pos).toBeUndefined();
    expect(i!.distanceM).toBeUndefined();
  });
  it("shows no symbol as the no-value mark and category other", () => {
    const [i] = buildItems([row("Q1X")], me);
    expect(i!.symbolName).toBe(NO_VALUE);
    expect(i!.category).toBe("other");
  });
  it("the own entry gets no distance, bearing or radar dot even when it has a position", () => {
    const [i] = buildItems([row("Q1TEST-7", { own: true, lat: 35.7, lon: 139.8 })], me);
    expect(i!.pos).toEqual({ lat: 35.7, lon: 139.8 });
    expect(i!.distanceM).toBeUndefined();
    expect(i!.bearing).toBeUndefined();
    expect(rowText(i!, NOW).distance).toBe(NO_VALUE);
  });
  it("coordinates out of range are ignored: latitude and longitude, both signs, edges are fine", () => {
    const pos = (lat: number, lon: number) => buildItems([row("Q1X", { lat, lon })], me)[0]!.pos;
    expect(pos(0, 180.001)).toBeUndefined();
    expect(pos(0, -180.001)).toBeUndefined();
    expect(pos(90.001, 0)).toBeUndefined();
    expect(pos(-90.001, 0)).toBeUndefined();
    expect(pos(0, 181)).toBeUndefined();
    expect(pos(90, 180)).toEqual({ lat: 90, lon: 180 });
    expect(pos(-90, -180)).toEqual({ lat: -90, lon: -180 });
    expect(pos(NaN, 0)).toBeUndefined();
    expect(pos(0, Infinity)).toBeUndefined();
    const [half] = buildItems([row("Q1HALF", { lat: 10 })], me);
    expect(half!.pos).toBeUndefined();
  });
  it("a distance of 0 is kept (not treated as missing)", () => {
    const [i] = buildItems([row("Q1HERE", { lat: me.lat, lon: me.lon })], me);
    expect(i!.distanceM).toBe(0);
  });
});

describe("filterItems", () => {
  const items = buildItems(rows, me);
  it("matches a substring, ignoring case", () => {
    expect(filterItems(items, "q1aa").map((i) => i.src)).toEqual(["Q1AAA-9"]);
    expect(filterItems(items, "-9").map((i) => i.src)).toEqual(["Q1AAA-9"]);
    expect(filterItems(items, "Q1").length).toBe(items.length);
  });
  it("an empty or blank query keeps everything; no match gives nothing", () => {
    expect(filterItems(items, "")).toBe(items);
    expect(filterItems(items, "   ")).toBe(items);
    expect(filterItems(items, "zzz")).toEqual([]);
  });
});

describe("sortItems", () => {
  const items = buildItems(rows, me);
  const names = (k: Parameters<typeof sortItems>[1]) => sortItems(items, k).map((i) => i.src);
  it("recent: newest first, own entry first", () => {
    expect(names("recent")).toEqual(["Q1TEST-7", "Q1FAR", "Q1NOPOS", "Q1AAA-9", "Q1BBB"]);
  });
  it("distance: nearest first, stations without a position last", () => {
    expect(names("distance")).toEqual(["Q1TEST-7", "Q1AAA-9", "Q1BBB", "Q1FAR", "Q1NOPOS"]);
  });
  it("distance without a fix falls back to recency", () => {
    const noFix = buildItems(rows, undefined);
    expect(sortItems(noFix, "distance").map((i) => i.src)).toEqual([
      "Q1TEST-7",
      "Q1FAR",
      "Q1NOPOS",
      "Q1AAA-9",
      "Q1BBB",
    ]);
  });
  it("call: alphabetical", () => {
    expect(names("call")).toEqual(["Q1TEST-7", "Q1AAA-9", "Q1BBB", "Q1FAR", "Q1NOPOS"]);
  });
  it("count: most packets first", () => {
    expect(names("count")).toEqual(["Q1TEST-7", "Q1NOPOS", "Q1AAA-9", "Q1FAR", "Q1BBB"]);
  });
  it("ties are broken by callsign (recent and count), whatever the input order", () => {
    const tie = (src: string, over: Partial<StationRow> = {}): StationRow =>
      row(src, { lastAt: NOW - 1000, count: 4, ...over });
    const shuffled = buildItems([tie("Q1CCC"), tie("Q1AAA"), tie("Q1BBB")], me);
    expect(sortItems(shuffled, "recent").map((i) => i.src)).toEqual(["Q1AAA", "Q1BBB", "Q1CCC"]);
    expect(sortItems([...shuffled].reverse(), "recent").map((i) => i.src)).toEqual([
      "Q1AAA",
      "Q1BBB",
      "Q1CCC",
    ]);
    expect(sortItems(shuffled, "count").map((i) => i.src)).toEqual(["Q1AAA", "Q1BBB", "Q1CCC"]);
    expect(sortItems([...shuffled].reverse(), "count").map((i) => i.src)).toEqual([
      "Q1AAA",
      "Q1BBB",
      "Q1CCC",
    ]);
  });
  it("count: the same count falls back to recency before the callsign", () => {
    const items = buildItems(
      [
        row("Q1AAA", { count: 2, lastAt: NOW - 5000 }),
        row("Q1BBB", { count: 2, lastAt: NOW - 1000 }),
        row("Q1CCC", { count: 3, lastAt: NOW - 9000 }),
      ],
      me,
    );
    expect(sortItems(items, "count").map((i) => i.src)).toEqual(["Q1CCC", "Q1BBB", "Q1AAA"]);
  });
  it("distance ties are broken by callsign too", () => {
    const at = { lat: 35.7, lon: 139.8 };
    const items = buildItems([row("Q1ZZZ", at), row("Q1AAA", at)], me);
    expect(sortItems(items, "distance").map((i) => i.src)).toEqual(["Q1AAA", "Q1ZZZ"]);
  });
  it("does not modify the input", () => {
    const copy = [...items];
    sortItems(items, "call");
    expect(items).toEqual(copy);
  });
});

describe("texts", () => {
  it("ageText", () => {
    expect(ageText(NOW - 120_000, NOW)).toBe("2 min ago");
    expect(ageText(NOW - 5000, NOW)).toBe("5 s ago");
    expect(ageText(NOW + 5000, NOW)).toBe("0 s ago");
    expect(ageText(NaN, NOW)).toBe(NO_VALUE);
  });
  it("bearingText", () => {
    expect(bearingText(0)).toBe("N (0°)");
    expect(bearingText(90)).toBe("E (90°)");
    expect(bearingText(180)).toBe("S (180°)");
    expect(bearingText(270)).toBe("W (270°)");
    expect(bearingText(359.7)).toBe("N (0°)");
    expect(bearingText(225)).toBe("SW (225°)");
    expect(bearingText(undefined)).toBe(NO_VALUE);
  });
  it("rowText and ariaText", () => {
    const items = buildItems(rows, me);
    const a = rowText(
      items.find((i) => i.src === "Q1AAA-9")!,
      NOW,
    );
    expect(a).toMatchObject({ call: "Q1AAA-9", age: "2 min ago", count: "3", symbol: "Car" });
    expect(a.distance).toMatch(/km$/);
    const own = rowText(
      items.find((i) => i.own)!,
      NOW,
    );
    expect(own.distance).toBe(NO_VALUE);
    expect(
      rowText(
        items.find((i) => i.src === "Q1NOPOS")!,
        NOW,
      ).distance,
    ).toBe("No position");
    expect(ariaText(items.find((i) => i.own)!)).toContain("this tracker");
    expect(ariaText(items.find((i) => i.src === "Q1NOPOS")!)).toContain("no position");
  });
  it("a station without a position says so, and has no bearing text", () => {
    const t = rowText(buildItems([row("Q1NOPOS")], me)[0]!, NOW);
    expect(t.distance).toBe("No position");
    expect(t.bearing).toBe("");
  });
  it("without a GPS fix a station that has a position is not 'No position'", () => {
    const [i] = buildItems([row("Q1BBB", { lat: 35.7, lon: 139.8 })], undefined);
    const t = rowText(i!, NOW);
    expect(t.distance).toBe(NO_VALUE);
    expect(t.bearing).toBe("");
    expect(ariaText(i!)).toContain("distance unknown");
  });
  it("ariaText replaces the visible row, so it carries age, count, level and symbol", () => {
    const items = buildItems(rows, me);
    const a = items.find((i) => i.src === "Q1AAA-9")!;
    const text = ariaText(a, NOW);
    expect(text).toMatch(/^Q1AAA-9, 1\.\d km, SSW \(\d+°\)/);
    expect(text).toContain("Car");
    expect(text).toContain("heard 2 min ago");
    expect(text).toContain("3 packets");
    const b = items.find((i) => i.src === "Q1BBB")!;
    expect(ariaText(b, NOW)).toContain("level -27.5 dB");
    expect(ariaText(b, NOW)).toContain("1 packet,");
    expect(ariaText(b, NOW)).not.toContain("1 packets");
    expect(ariaText(b, NOW)).not.toContain("Car");
    // Without `now` (the radar, whose label should not change every second) there is no age.
    expect(ariaText(a)).not.toContain("heard");
    expect(ariaText(a)).toContain("Car");
  });
  it("the own entry's description says this tracker and includes its age and count", () => {
    const own = buildItems(rows, me).find((i) => i.own)!;
    expect(ariaText(own, NOW)).toBe("Q1TEST-7, this tracker, heard 5 min ago, 1 packet");
  });
  it("a station at your position: no bearing, said in words", () => {
    const [i] = buildItems([row("Q1HERE", { lat: me.lat, lon: me.lon })], me);
    expect(i!.distanceM).toBe(0);
    expect(i!.bearing).toBeUndefined(); // the bearing of two identical points is meaningless
    expect(isAtPosition(i!)).toBe(true);
    const t = rowText(i!, NOW);
    expect(t.distance).toBe("At your position");
    expect(t.bearing).toBe("");
    expect(t.distance).not.toContain("0 m");
    expect(ariaText(i!)).toContain("at your position");
    expect(ariaText(i!)).not.toContain("N (0°)");
    const detail = detailRows(i!, undefined, NOW, me);
    expect(detail.find((r) => r.label === "Distance")!.value).toBe("At your position");
    expect(detail.find((r) => r.label === "Bearing")!.value).toBe(NO_VALUE);
  });
  it("one metre away still has a bearing", () => {
    const [i] = buildItems([row("Q1NEAR", { lat: me.lat + 0.00003, lon: me.lon })], me);
    expect(i!.distanceM).toBeGreaterThan(1);
    expect(isAtPosition(i!)).toBe(false);
    expect(i!.bearing).toBeCloseTo(0, 3);
  });
});

describe("latestPacket / detailRows", () => {
  const tnc2 = "Q1AAA-9>APRS,WIDE1-1:!3540.12N/13945.37E>Hello there";
  const feed: FeedItem[] = [
    {
      seq: 1,
      kind: "rx",
      at: 10,
      msg: { t: "rx", tnc2: "Q1AAA-9>APRS:>old", src: "Q1AAA-9" },
      parsed: parseAprs("Q1AAA-9>APRS:>old"),
    },
    {
      seq: 2,
      kind: "tx",
      at: 20,
      msg: { t: "tx", tnc2: "Q1TEST-7>APRS:>x" },
      parsed: parseAprs("Q1TEST-7>APRS:>x"),
    },
    { seq: 3, kind: "rx", at: 30, msg: { t: "rx", tnc2, src: "Q1AAA-9" }, parsed: parseAprs(tnc2) },
    {
      seq: 4,
      kind: "rx",
      at: 40,
      msg: { t: "rx", tnc2: "Q1BBB>APRS:>b" },
      parsed: parseAprs("Q1BBB>APRS:>b"),
    },
  ];
  it("finds the newest rx packet of the station, with its comment", () => {
    const p = latestPacket(feed, "Q1AAA-9")!;
    expect(p.tnc2).toBe(tnc2);
    expect(p.comment).toBe("Hello there");
    expect(p.at).toBe(30);
  });
  it("falls back to the TNC2 source when the device sent no src, and skips tx", () => {
    expect(latestPacket(feed, "Q1BBB")!.at).toBe(40);
    expect(latestPacket(feed, "Q1TEST-7")).toBeUndefined();
    expect(latestPacket([], "Q1AAA-9")).toBeUndefined();
  });
  it("detail rows: own entry has no distance rows; the position stands in from the GPS fix", () => {
    const items = buildItems(rows, me);
    const own = detailRows(
      items.find((i) => i.own)!,
      undefined,
      NOW,
      me,
    );
    expect(own.map((r) => r.label)).not.toContain("Distance");
    expect(own.find((r) => r.label === "Position")!.value).toContain("N");
    const a = detailRows(
      items.find((i) => i.src === "Q1AAA-9")!,
      latestPacket(feed, "Q1AAA-9"),
      NOW,
      me,
    );
    expect(a.map((r) => r.label)).toEqual([
      "Callsign",
      "Distance",
      "Bearing",
      "Last heard",
      "Packets",
      "Level",
      "Symbol",
      "Position",
      "Comment",
      "Latest packet",
    ]);
    expect(a.at(-1)).toMatchObject({ value: tnc2, mono: true });
  });
});
