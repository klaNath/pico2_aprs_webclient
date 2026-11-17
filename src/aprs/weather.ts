// Weather data (APRS101 chapter 12), as a position-less report or after a weather symbol.

import type { WeatherData } from "./types.ts";

const MPH_TO_MS = 0.44704;
const HUNDREDTHS_INCH_TO_MM = 0.254;
const INCH_TO_MM = 25.4;

/** Field letter -> number of characters that follow it. */
const WIDTH: Record<string, number> = {
  c: 3, // wind direction
  s: 3, // wind speed (or snowfall, see below)
  g: 3, // gust
  t: 3, // temperature, °F
  r: 3, // rain, last hour
  p: 3, // rain, last 24 hours
  P: 3, // rain, since midnight
  h: 2, // humidity
  b: 5, // pressure
  L: 3, // luminosity 0-999
  l: 3, // luminosity 1000-1999
  "#": 3, // raw rain counter (ignored)
};

/** A number, undefined for a missing value ("..." or spaces), null if it is not a field value. */
function value(chars: string): number | undefined | null {
  if (/^[. ]+$/.test(chars)) return undefined;
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(chars)) return Number(chars);
  return null;
}

export interface WeatherResult {
  weather: WeatherData;
  /** What follows the weather fields. */
  rest: string;
  /** Number of fields read, counting blank ones ("c..."): 0 means this is not weather text. */
  fieldCount: number;
}

/**
 * @param windPrefix  true for the `ccc/sss` prefix of a weather report after a position
 *                    (then `s` later in the text is snowfall, not wind speed).
 * @param windGiven   true when the wind is carried somewhere else (the cs bytes of a compressed
 *                    position), so `s` in the text is snowfall here too.
 */
export function parseWeatherFields(
  s: string,
  opts: { windPrefix: boolean; windGiven?: boolean },
): WeatherResult {
  const w: WeatherData = {};
  let i = 0;
  let fieldCount = 0;
  let windSpeedSeen = opts.windPrefix || opts.windGiven === true;

  if (opts.windPrefix) {
    const m = /^([0-9. ]{3})\/([0-9. ]{3})/.exec(s);
    if (m) {
      const dir = value(m[1]!);
      const spd = value(m[2]!);
      if (dir !== undefined && dir !== null) w.windDirDeg = dir;
      if (spd !== undefined && spd !== null) w.windSpeedMs = spd * MPH_TO_MS;
      i = 7;
      fieldCount += 2;
    }
  }

  while (i < s.length) {
    const key = s[i]!;
    const width = WIDTH[key];
    if (width === undefined) break;
    const chars = s.slice(i + 1, i + 1 + width);
    if (chars.length < width) break;
    const v = value(chars);
    if (v === null) break;
    i += 1 + width;
    fieldCount++;
    if (v === undefined) {
      if (key === "s") windSpeedSeen = true;
      continue;
    }
    switch (key) {
      case "c":
        w.windDirDeg = v;
        break;
      case "s":
        if (windSpeedSeen) w.snowMm = v * INCH_TO_MM;
        else {
          w.windSpeedMs = v * MPH_TO_MS;
          windSpeedSeen = true;
        }
        break;
      case "g":
        w.gustMs = v * MPH_TO_MS;
        break;
      case "t":
        w.tempC = ((v - 32) * 5) / 9;
        break;
      case "r":
        w.rain1hMm = v * HUNDREDTHS_INCH_TO_MM;
        break;
      case "p":
        w.rain24hMm = v * HUNDREDTHS_INCH_TO_MM;
        break;
      case "P":
        w.rainMidnightMm = v * HUNDREDTHS_INCH_TO_MM;
        break;
      case "h":
        w.humidity = v === 0 ? 100 : v; // h00 means 100%
        break;
      case "b":
        w.pressureHpa = v / 10;
        break;
      case "L":
        w.luminosityWm2 = v;
        break;
      case "l":
        w.luminosityWm2 = v + 1000;
        break;
      default:
        break; // '#': raw counter, not kept
    }
  }
  return { weather: w, rest: s.slice(i), fieldCount };
}
