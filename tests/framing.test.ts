import { describe, expect, it } from "vitest";
import { LineAssembler, MAX_WRITE_BYTES, encodeLine, splitBytes } from "../src/protocol/framing.ts";

const enc = new TextEncoder();

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let i = 0;
  for (const c of chunks) {
    out.set(c, i);
    i += c.length;
  }
  return out;
}

describe("encodeLine", () => {
  it("is UTF-8 JSON followed by a single newline", () => {
    const bytes = encodeLine({ op: "settings.set", values: { comment: "日本語" } });
    const text = new TextDecoder().decode(bytes);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.slice(0, -1)).not.toContain("\n");
    expect(JSON.parse(text)).toEqual({ op: "settings.set", values: { comment: "日本語" } });
  });
});

describe("splitBytes", () => {
  it("splits into chunks of at most the limit and restores the original", () => {
    const bytes = encodeLine({ op: "settings.set", id: 5, values: { comment: "Hello, world" } });
    const chunks = splitBytes(bytes, MAX_WRITE_BYTES);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(MAX_WRITE_BYTES);
    expect(concat(chunks)).toEqual(bytes);
  });

  it("returns no chunks for empty input and rejects a zero limit", () => {
    expect(splitBytes(new Uint8Array(0))).toEqual([]);
    expect(() => splitBytes(new Uint8Array(3), 0)).toThrow(RangeError);
  });

  it("uses a limit that can be changed", () => {
    const chunks = splitBytes(new Uint8Array(100), 64);
    expect(chunks.map((c) => c.length)).toEqual([64, 36]);
  });
});

describe("LineAssembler", () => {
  it("cuts a line spread over several chunks", () => {
    const a = new LineAssembler();
    expect(a.push(enc.encode('{"t":"sta'))).toEqual([]);
    expect(a.push(enc.encode('tus"}\n'))).toEqual(['{"t":"status"}']);
  });

  it("handles several lines in one chunk and a partial line after them", () => {
    const a = new LineAssembler();
    expect(a.push(enc.encode('{"a":1}\n{"b":2}\n{"c"'))).toEqual(['{"a":1}', '{"b":2}']);
    expect(a.push(enc.encode(":3}\n"))).toEqual(['{"c":3}']);
  });

  it("skips empty lines", () => {
    const a = new LineAssembler();
    expect(a.push(enc.encode('\n\n{"a":1}\n\n'))).toEqual(['{"a":1}']);
  });

  it("survives a chunk boundary inside a UTF-8 character (every split size)", () => {
    const bytes = enc.encode('{"comment":"あいう€😀"}\n');
    for (let size = 1; size <= 7; size++) {
      const a = new LineAssembler();
      const lines: string[] = [];
      for (const c of splitBytes(bytes, size)) lines.push(...a.push(c));
      expect(lines).toEqual(['{"comment":"あいう€😀"}']);
    }
  });

  it("drops buffered input on reset", () => {
    const a = new LineAssembler();
    a.push(enc.encode('{"par'));
    a.reset();
    expect(a.push(enc.encode('{"a":1}\n'))).toEqual(['{"a":1}']);
  });
});
