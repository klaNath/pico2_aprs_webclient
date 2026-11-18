// Pure logic for the Stations and Radar tabs: turning the station table into rows (distance,
// bearing, age, symbol), filtering, sorting and the text shown for each row. No DOM here, so it
// can be tested under Node.

import {
  bearingDeg,
  cardinal,
  distanceM,
  formatLatLon,
  NO_VALUE,
  type LatLon,
} from "../aprs/geo.ts";
import { symbolInfo, symbolName, type SymbolCategory } from "../aprs/symbols.ts";
import { packetPosition, type AprsSymbol } from "../aprs/types.ts";
import type { FeedItem, StationRow } from "../store/state.ts";
import { fmtAge, fmtDb, fmtDistance } from "./format.ts";

export type SortKey = "recent" | "distance" | "call" | "count";

export const SORT_LABELS: Record<SortKey, string> = {
  recent: "Most recent",
  distance: "Nearest",
  call: "Callsign",
  count: "Most packets",
};

export interface StationItem {
  src: string;
  own: boolean;
  /** Position of the station, when known. */
  pos?: LatLon;
  lastAt: number;
  count: number;
  lvlDb?: number;
  symbol?: AprsSymbol;
  /** "Car", or "—" when the station has not sent a symbol. */
  symbolName: string;
  category: SymbolCategory;
  /** Great-circle distance from this tracker, in meters. Needs both positions; not for `own`. */
  distanceM?: number;
  /** Bearing from this tracker, degrees [0, 360). */
  bearing?: number;
}

/**
 * "/>" -> primary table, code ">". An overlay character (0-9, A-Z) as the first character means
 * the alternate table with that overlay. Anything else (the device sent something odd) is
 * undefined, so the UI shows "—" and never throws.
 */
export function parseSymbolChars(sym: string | undefined): AprsSymbol | undefined {
  if (sym === undefined || sym.length !== 2) return undefined;
  const table = sym[0]!;
  const code = sym[1]!;
  if (code < "!" || code > "~") return undefined;
  if (table === "/" || table === "\\") return { table, code };
  if (/^[0-9A-Z]$/.test(table)) return { table: "\\", code, overlay: table };
  return undefined;
}

function validPos(lat: number | undefined, lon: number | undefined): LatLon | undefined {
  if (lat === undefined || lon === undefined) return undefined;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return undefined;
  return { lat, lon };
}

/** One item per station. `me` is this tracker's position (undefined without a GPS fix). */
export function buildItems(rows: Iterable<StationRow>, me: LatLon | undefined): StationItem[] {
  const out: StationItem[] = [];
  for (const r of rows) {
    const symbol = parseSymbolChars(r.sym);
    const info = symbol ? symbolInfo(symbol) : undefined;
    const item: StationItem = {
      src: r.src,
      own: r.own,
      lastAt: r.lastAt,
      count: r.count,
      symbolName: symbol ? symbolName(symbol) : NO_VALUE,
      category: info?.category ?? "other",
    };
    const pos = validPos(r.lat, r.lon);
    if (pos) item.pos = pos;
    if (r.lvlDb !== undefined) item.lvlDb = r.lvlDb;
    if (symbol) item.symbol = symbol;
    if (!r.own && me && pos) {
      item.distanceM = distanceM(me, pos);
      item.bearing = bearingDeg(me, pos);
    }
    out.push(item);
  }
  return out;
}

/** Case-insensitive substring match on the callsign. An empty (or blank) query keeps everything. */
export function filterItems(items: StationItem[], query: string): StationItem[] {
  const q = query.trim().toUpperCase();
  if (q === "") return items;
  return items.filter((i) => i.src.toUpperCase().includes(q));
}

/**
 * Sorted copy. This tracker's own entry always comes first. For "distance", stations without a
 * distance go last (ordered by recency). Ties break by callsign so the order is stable.
 */
export function sortItems(items: StationItem[], key: SortKey): StationItem[] {
  const byCall = (a: StationItem, b: StationItem): number =>
    a.src < b.src ? -1 : a.src > b.src ? 1 : 0;
  const cmp = (a: StationItem, b: StationItem): number => {
    if (a.own !== b.own) return a.own ? -1 : 1;
    switch (key) {
      case "recent":
        return b.lastAt - a.lastAt || byCall(a, b);
      case "distance": {
        const da = a.distanceM;
        const db = b.distanceM;
        if (da === undefined && db === undefined) return b.lastAt - a.lastAt || byCall(a, b);
        if (da === undefined) return 1;
        if (db === undefined) return -1;
        return da - db || byCall(a, b);
      }
      case "call":
        return byCall(a, b);
      case "count":
        return b.count - a.count || b.lastAt - a.lastAt || byCall(a, b);
    }
  };
  return [...items].sort(cmp);
}

/** "2 min ago". `now` and `lastAt` are Date.now() values; a future time counts as now. */
export function ageText(lastAt: number, now: number): string {
  if (!Number.isFinite(lastAt) || !Number.isFinite(now)) return NO_VALUE;
  const s = fmtAge(Math.max(0, (now - lastAt) / 1000));
  return s === NO_VALUE ? s : `${s} ago`;
}

/** "NE (45°)", or "—" without a bearing. */
export function bearingText(bearing: number | undefined): string {
  if (bearing === undefined || !Number.isFinite(bearing)) return NO_VALUE;
  const d = Math.round(((bearing % 360) + 360) % 360) % 360;
  return `${cardinal(bearing)} (${d}°)`;
}

export interface RowText {
  call: string;
  distance: string;
  bearing: string;
  age: string;
  count: string;
  level: string;
  symbol: string;
}

/** Everything a list row or a detail panel shows, as text. */
export function rowText(item: StationItem, now: number): RowText {
  return {
    call: item.src,
    distance: item.own ? NO_VALUE : fmtDistance(item.distanceM),
    bearing: item.own ? NO_VALUE : bearingText(item.bearing),
    age: ageText(item.lastAt, now),
    count: `${item.count}`,
    level: fmtDb(item.lvlDb),
    symbol: item.symbolName,
  };
}

/** Short spoken/ARIA description: "Q1AAA-9, 1.2 km, SW (225°)". */
export function ariaText(item: StationItem): string {
  if (item.own) return `${item.src}, this tracker`;
  if (item.distanceM === undefined) return `${item.src}, position unknown`;
  return `${item.src}, ${fmtDistance(item.distanceM)}, ${bearingText(item.bearing)}`;
}

export interface LatestPacket {
  tnc2: string;
  /** The comment of a position packet; empty when there is none. */
  comment: string;
  at: number;
}

/** The newest received packet of `src` in the feed (oldest first), or undefined. */
export function latestPacket(feed: readonly FeedItem[], src: string): LatestPacket | undefined {
  for (let i = feed.length - 1; i >= 0; i--) {
    const f = feed[i]!;
    if (f.kind !== "rx") continue;
    const from = (f.msg as { src?: string }).src ?? f.parsed.tnc2?.src;
    if (from !== src) continue;
    return {
      tnc2: f.msg.tnc2,
      comment: packetPosition(f.parsed)?.comment.trim() ?? "",
      at: f.at,
    };
  }
  return undefined;
}

export interface DetailRow {
  label: string;
  value: string;
  /** Shown in a monospace font (raw packet text). */
  mono?: boolean;
}

/**
 * Rows of the detail panel. `me` is this tracker's position: it stands in for the position of the
 * own entry, which the device lists without coordinates. The row set depends only on `item.own`
 * and on whether there is a comment, so a view can update its elements in place.
 */
export function detailRows(
  item: StationItem,
  latest: LatestPacket | undefined,
  now: number,
  me: LatLon | undefined,
): DetailRow[] {
  const t = rowText(item, now);
  const pos = item.pos ?? (item.own ? me : undefined);
  const rows: DetailRow[] = [
    { label: "Callsign", value: item.own ? `${t.call} (this tracker)` : t.call },
  ];
  if (!item.own) {
    rows.push({ label: "Distance", value: t.distance }, { label: "Bearing", value: t.bearing });
  }
  rows.push(
    { label: "Last heard", value: t.age },
    { label: "Packets", value: t.count },
    { label: "Level", value: t.level },
    { label: "Symbol", value: t.symbol },
    { label: "Position", value: pos ? formatLatLon(pos) : NO_VALUE },
  );
  if (latest?.comment) rows.push({ label: "Comment", value: latest.comment });
  rows.push({
    label: "Latest packet",
    value: latest ? latest.tnc2 : "Not in the feed (older than the kept log).",
    mono: latest !== undefined,
  });
  return rows;
}
