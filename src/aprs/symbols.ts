// Names of the common APRS symbols. No images: the UI draws a character and a color per category.
//
// Source of truth: WB4APR's master list, http://www.aprs.org/symbols/symbolsX.txt (25 Nov 2015).
// The chart at https://blog.thelifeofkenneth.com/2017/01/aprs-symbol-look-up-table.html (Rev 2, an
// image) was used to cross-check. Codes the master list marks AVAIL / TBD / reserved or leaves blank
// are unassigned and are left out on purpose (primary " D J Q z { } and alternate " 1-7 = Z ] q } and
// so on); symbolInfo() reports them as known:false.
// Legacy weather codes that the list now calls AVAIL (moved to overlays on ` and similar: alternate
// * : B F G J b p {) are kept with their old names because older equipment still sends them.
// Alternate D was reassigned to Depots. Primary 1-9 are TBD in the list but were numbered circles and
// are used as mobile symbols, so they stay as "Numbered circle". Names follow the list, shortened.

import type { AprsSymbol } from "./types.ts";

export type SymbolCategory = "vehicle" | "person" | "fixed" | "digi" | "weather" | "other";

type Row = [code: string, name: string, category: SymbolCategory];

const PRIMARY: Row[] = [
  ["!", "Police, sheriff", "fixed"],
  ["#", "Digipeater", "digi"],
  ["$", "Phone", "other"],
  ["%", "DX cluster", "other"],
  ["&", "HF gateway", "digi"],
  ["'", "Small aircraft", "vehicle"],
  ["(", "Mobile satellite station", "vehicle"],
  [")", "Wheelchair", "person"],
  ["*", "Snowmobile", "vehicle"],
  ["+", "Red cross", "fixed"],
  [",", "Boy scouts", "person"],
  ["-", "House", "fixed"],
  [".", "X", "other"],
  ["/", "Red dot", "other"],
  [":", "Fire", "other"],
  [";", "Campground", "fixed"],
  ["<", "Motorcycle", "vehicle"],
  ["=", "Railroad engine", "vehicle"],
  [">", "Car", "vehicle"],
  ["?", "File server", "other"],
  ["@", "Hurricane (future prediction dot)", "weather"],
  ["A", "Aid station", "fixed"],
  ["B", "BBS", "digi"],
  ["C", "Canoe", "vehicle"],
  ["E", "Eyeball", "other"],
  ["F", "Farm vehicle", "vehicle"],
  ["G", "Grid square", "other"],
  ["H", "Hotel", "fixed"],
  ["I", "TCP/IP", "digi"],
  ["K", "School", "fixed"],
  ["L", "PC user", "fixed"],
  ["M", "MacAPRS", "fixed"],
  ["N", "NTS station", "fixed"],
  ["O", "Balloon", "vehicle"],
  ["P", "Police", "vehicle"],
  ["R", "Recreational vehicle", "vehicle"],
  ["S", "Space shuttle", "vehicle"],
  ["T", "SSTV", "other"],
  ["U", "Bus", "vehicle"],
  ["V", "ATV", "other"],
  ["W", "National Weather Service site", "weather"],
  ["X", "Helicopter", "vehicle"],
  ["Y", "Yacht", "vehicle"],
  ["Z", "WinAPRS", "fixed"],
  ["[", "Person", "person"],
  ["\\", "Triangle (DF station)", "other"],
  ["]", "Mail / post office", "digi"],
  ["^", "Large aircraft", "vehicle"],
  ["_", "Weather station", "weather"],
  ["`", "Dish antenna", "fixed"],
  ["a", "Ambulance", "vehicle"],
  ["b", "Bicycle", "vehicle"],
  ["c", "Incident command post", "fixed"],
  ["d", "Fire department", "fixed"],
  ["e", "Horse", "person"],
  ["f", "Fire truck", "vehicle"],
  ["g", "Glider", "vehicle"],
  ["h", "Hospital", "fixed"],
  ["i", "IOTA (islands on the air)", "fixed"],
  ["j", "Jeep", "vehicle"],
  ["k", "Truck", "vehicle"],
  ["l", "Laptop", "fixed"],
  ["m", "Mic-E repeater", "digi"],
  ["n", "Node", "digi"],
  ["o", "Emergency operations center", "fixed"],
  ["p", "Rover (dog)", "person"],
  ["q", "Grid square", "other"],
  ["r", "Repeater", "digi"],
  ["s", "Power boat", "vehicle"],
  ["t", "Truck stop", "fixed"],
  ["u", "Truck (18 wheeler)", "vehicle"],
  ["v", "Van", "vehicle"],
  ["w", "Water station", "fixed"],
  ["x", "X-APRS", "other"],
  ["y", "Yagi antenna", "fixed"],
  ["|", "TNC stream switch", "other"],
  ["~", "TNC stream switch", "other"],
  ...[..."0123456789"].map((d): Row => [d, "Numbered circle", "other"]),
];

const ALTERNATE: Row[] = [
  ["!", "Emergency", "other"],
  ["#", "Digipeater", "digi"],
  ["$", "Bank / ATM", "fixed"],
  ["%", "Power plant", "fixed"],
  ["&", "Gateway", "digi"],
  ["'", "Crash site / incident", "other"],
  ["(", "Cloudy", "weather"],
  [")", "Firenet MEO / MODIS Earth Observation", "other"],
  ["*", "Snow", "weather"],
  ["+", "Church", "fixed"],
  [",", "Girl scouts", "person"],
  ["-", "House (HF)", "fixed"],
  [".", "Unknown position", "other"],
  ["/", "Destination", "other"],
  ["0", "Circle", "other"],
  ["8", "802.11 / network node", "digi"],
  ["9", "Gas station", "fixed"],
  [":", "Hail", "weather"],
  [";", "Park", "fixed"],
  ["<", "Advisory (weather flag)", "weather"],
  [">", "Car / vehicle", "vehicle"],
  ["?", "Info kiosk", "fixed"],
  ["@", "Hurricane", "weather"],
  ["A", "Box", "other"],
  ["B", "Blowing snow", "weather"],
  ["C", "Coast guard", "fixed"],
  ["D", "Depot (formerly Drizzle)", "fixed"],
  ["E", "Smoke", "weather"],
  ["F", "Freezing rain", "weather"],
  ["G", "Snow shower", "weather"],
  ["H", "Haze", "weather"],
  ["I", "Rain shower", "weather"],
  ["J", "Lightning", "weather"],
  ["K", "Kenwood", "other"],
  ["L", "Lighthouse", "fixed"],
  ["M", "MARS", "fixed"],
  ["N", "Navigation buoy", "other"],
  ["O", "Rocket / balloon", "vehicle"],
  ["P", "Parking", "fixed"],
  ["Q", "Earthquake", "other"],
  ["R", "Restaurant", "fixed"],
  ["S", "Satellite", "vehicle"],
  ["T", "Thunderstorm", "weather"],
  ["U", "Sunny", "weather"],
  ["V", "VORTAC", "fixed"],
  ["W", "National Weather Service site", "weather"],
  ["X", "Pharmacy", "fixed"],
  ["Y", "Radio / device", "other"],
  ["[", "Wall cloud", "weather"],
  ["\\", "Overlayable GPS symbol", "other"],
  ["^", "Aircraft", "vehicle"],
  ["_", "Weather station", "weather"],
  ["`", "Rain", "weather"],
  ["a", "ARRL / ARES", "fixed"],
  ["b", "Blowing dust / sand", "weather"],
  ["c", "Civil defense", "fixed"],
  ["d", "DX spot", "other"],
  ["e", "Sleet", "weather"],
  ["f", "Funnel cloud", "weather"],
  ["g", "Gale flags", "weather"],
  ["h", "Store", "fixed"],
  ["i", "Box / point of interest", "fixed"],
  ["j", "Work zone", "other"],
  ["k", "Special vehicle (SUV)", "vehicle"],
  ["l", "Area", "other"],
  ["m", "Value sign (milepost)", "other"],
  ["n", "Triangle", "other"],
  ["o", "Small circle", "other"],
  ["p", "Partly cloudy", "weather"],
  ["r", "Restrooms", "fixed"],
  ["s", "Ship", "vehicle"],
  ["t", "Tornado", "weather"],
  ["u", "Truck", "vehicle"],
  ["v", "Van", "vehicle"],
  ["w", "Flooding", "weather"],
  ["x", "Wreck / obstruction", "other"],
  ["y", "Skywarn", "weather"],
  ["z", "Shelter", "fixed"],
  ["{", "Fog", "weather"],
  ["|", "TNC stream switch", "other"],
  ["~", "TNC stream switch", "other"],
];

const TABLES = {
  "/": new Map(PRIMARY.map((r) => [r[0], r] as const)),
  "\\": new Map(ALTERNATE.map((r) => [r[0], r] as const)),
};

export interface SymbolInfo {
  name: string;
  category: SymbolCategory;
  known: boolean;
}

export function symbolInfo(s: AprsSymbol): SymbolInfo {
  const row = TABLES[s.table].get(s.code);
  if (!row) return { name: `Symbol ${s.table}${s.code}`, category: "other", known: false };
  return { name: row[1], category: row[2], known: true };
}

/** "Car", "Digipeater (overlay 1)", or "Symbol /?" for codes that are not in the table. */
export function symbolName(s: AprsSymbol): string {
  const info = symbolInfo(s);
  return s.overlay ? `${info.name} (overlay ${s.overlay})` : info.name;
}
