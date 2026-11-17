import { parseAprs } from "../../src/aprs/parse.ts";
import type { AprsData } from "../../src/aprs/types.ts";

/** Parse a line and require a given data type (the failure message shows what was found). */
export function expectType<T extends AprsData["type"]>(
  line: string,
  type: T,
): Extract<AprsData, { type: T }> {
  const p = parseAprs(line);
  if (p.data.type !== type) {
    throw new Error(`expected ${type}, got ${p.data.type}: ${JSON.stringify(p.data)}`);
  }
  return p.data as Extract<AprsData, { type: T }>;
}
