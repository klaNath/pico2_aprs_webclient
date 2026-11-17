// Telemetry (APRS101 chapter 13): T# reports, PARM/UNIT/EQNS/BITS messages, and the compressed
// telemetry block `|ss1122..|` that can end a comment.

import { base91 } from "./compressed.ts";
import type { CompressedTelemetry, Eqn } from "./types.ts";

export type { Eqn };

/**
 * A plain decimal number: optional sign, digits, optional fraction ("5", "-1.5", ".53", "3.").
 * Hex ("0x10"), exponents ("1e3") and "Infinity", which `Number()` would take, give undefined.
 */
export function parseDecimal(s: string): number | undefined {
  const t = s.trim();
  return /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(t) ? Number(t) : undefined;
}

export interface TelemetryReport {
  seq: number | "MIC";
  analog: (number | undefined)[];
  digital?: boolean[];
  comment: string;
}

/** `T#sss,a1,a2,a3,a4,a5,bbbbbbbb` (the binary part and trailing text are optional). */
export function parseTelemetryReport(info: string): TelemetryReport | null {
  const m = /^T#(\d{1,3}|MIC),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*)(?:,([01]{8}))?(.*)$/s.exec(
    info,
  );
  if (!m) return null;
  const analog = [m[2]!, m[3]!, m[4]!, m[5]!, m[6]!].map(parseDecimal);
  const out: TelemetryReport = {
    seq: m[1] === "MIC" ? "MIC" : Number(m[1]),
    analog,
    comment: m[8] ?? "",
  };
  if (m[7]) out.digital = [...m[7]].map((c) => c === "1");
  return out;
}

export interface TelemetryDefinition {
  kind: "PARM" | "UNIT" | "EQNS" | "BITS";
  names?: string[];
  /** One entry per analog channel; undefined where one of the three numbers is not readable. */
  eqns?: (Eqn | undefined)[];
  bits?: string;
  title?: string;
}

/** Parse the text of a `PARM.`, `UNIT.`, `EQNS.` or `BITS.` message. */
export function parseTelemetryDefinition(text: string): TelemetryDefinition | null {
  const m = /^(PARM|UNIT|EQNS|BITS)\.(.*)$/s.exec(text);
  if (!m) return null;
  const kind = m[1] as TelemetryDefinition["kind"];
  const body = m[2]!;
  switch (kind) {
    case "PARM":
    case "UNIT":
      return { kind, names: body.split(",") };
    case "EQNS": {
      // A triple with a number that is not plain decimal (or is empty) is left out as
      // undefined. It used to be read as 0, which made applyEqns return 0 for every value.
      const nums = body.split(",").map(parseDecimal);
      const eqns: (Eqn | undefined)[] = [];
      for (let i = 0; i + 2 < nums.length && eqns.length < 5; i += 3) {
        const [a, b, c] = [nums[i], nums[i + 1], nums[i + 2]];
        eqns.push(a === undefined || b === undefined || c === undefined ? undefined : { a, b, c });
      }
      return { kind, eqns };
    }
    default: {
      // Exactly eight 0/1 characters, then an optional ",title" (APRS101 ch.13).
      const bm = /^([01]{8})(?:,(.*))?$/s.exec(body);
      if (!bm) return { kind };
      return { kind, bits: bm[1]!, title: bm[2] ?? "" };
    }
  }
}

/** value = a·x² + b·x + c for each analog channel that has an equation; others pass through. */
export function applyEqns(
  values: readonly (number | undefined)[],
  eqns: readonly (Eqn | undefined)[],
): (number | undefined)[] {
  return values.map((x, i) => {
    const q = eqns[i];
    if (x === undefined || !q) return x;
    return q.a * x * x + q.b * x + q.c;
  });
}

/**
 * The text between the pipes of `|ss11223344..|`: a sequence number, then 1-5 analog values,
 * then (only when all 5 analog values are present) a digital value. Two base-91 characters each.
 */
export function parseCompressedTelemetry(block: string): CompressedTelemetry | null {
  if (block.length % 2 !== 0 || block.length < 4 || block.length > 14) return null;
  const vals: number[] = [];
  for (let i = 0; i < block.length; i += 2) {
    const v = base91(block.slice(i, i + 2));
    if (!Number.isFinite(v)) return null;
    vals.push(v);
  }
  const rest = vals.slice(1);
  const out: CompressedTelemetry = { seq: vals[0]!, analog: rest };
  if (rest.length === 6) {
    out.analog = rest.slice(0, 5);
    out.digital = rest[5];
  }
  return out;
}
