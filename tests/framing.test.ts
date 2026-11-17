import { describe, expect, it } from "vitest";
import {
  LineAssembler,
  MAX_LINE_BYTES,
  MAX_RX_LINE_CHARS,
  MAX_WRITE_BYTES,
  encodeLine,
  splitBytes,
} from "../src/protocol/framing.ts";

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

describe("limits (§5)", () => {
  it("writes are at most 20 bytes: §5.2 fixes it, and 23 (min MTU) - 3 = 20", () => {
    expect(MAX_WRITE_BYTES).toBe(20);
  });

  it("a line is at most 512 bytes without the newline: §5.1", () => {
    expect(MAX_LINE_BYTES).toBe(512);
  });

  it("encodeLine accepts exactly 512 bytes and refuses 513 (the device would answer too_long without an id)", () => {
    const withPad = (n: number): unknown => ({ op: "status", pad: "x".repeat(n) });
    const base = JSON.stringify(withPad(0)).length;
    const ok = encodeLine(withPad(512 - base));
    expect(ok.length).toBe(513); // 512 + "\n"
    expect(() => encodeLine(withPad(512 - base + 1))).toThrow(RangeError);
  });

  it("encodeLine counts bytes, not characters", () => {
    // 200 x 3-byte characters = 600 bytes
    expect(() => encodeLine({ comment: "あ".repeat(200) })).toThrow(RangeError);
    // 150 x 3-byte characters = 450 bytes + overhead: fits although 150 + overhead is far below too
    expect(encodeLine({ comment: "あ".repeat(150) }).length).toBeLessThanOrEqual(513);
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

describe("LineAssembler robustness", () => {
  it("accepts a long line (settings.schema is about 1.1 KB, so 512 is not a limit for incoming)", () => {
    const a = new LineAssembler();
    const long = JSON.stringify({ t: "schema", pad: "x".repeat(3000) });
    expect(a.push(enc.encode(long + "\n"))).toEqual([long]);
  });

  it("drops a line over the limit once, reads on to its newline, then continues", () => {
    const over: string[] = [];
    const a = new LineAssembler({ maxLineChars: 20, onOverflow: (h) => over.push(h) });
    expect(a.push(enc.encode("x".repeat(15)))).toEqual([]);
    expect(over).toHaveLength(0);
    expect(a.push(enc.encode("y".repeat(10)))).toEqual([]); // now 25 > 20
    expect(over).toHaveLength(1);
    expect(a.push(enc.encode("z".repeat(100)))).toEqual([]); // still the same line
    expect(over).toHaveLength(1); // reported once
    expect(a.push(enc.encode('tail\n{"ok":1}\n'))).toEqual(['{"ok":1}']);
    expect(over).toHaveLength(1);
  });

  it("drops a complete line over the limit that arrives in one chunk, and keeps its neighbours", () => {
    const over: string[] = [];
    const a = new LineAssembler({ maxLineChars: 10, onOverflow: (h) => over.push(h) });
    expect(a.push(enc.encode('{"a":1}\n' + "x".repeat(30) + '\n{"b":2}\n'))).toEqual([
      '{"a":1}',
      '{"b":2}',
    ]);
    expect(over).toHaveLength(1);
  });

  it("accepts a line of exactly the limit", () => {
    const over: string[] = [];
    const a = new LineAssembler({ maxLineChars: 10, onOverflow: (h) => over.push(h) });
    expect(a.push(enc.encode("x".repeat(10) + "\n"))).toEqual(["x".repeat(10)]);
    expect(over).toHaveLength(0);
  });

  it("uses 16 KB by default, far above 512", () => {
    expect(MAX_RX_LINE_CHARS).toBe(16 * 1024);
    const over: string[] = [];
    const a = new LineAssembler({ onOverflow: (h) => over.push(h) });
    a.push(enc.encode("x".repeat(MAX_RX_LINE_CHARS)));
    expect(over).toHaveLength(0);
    a.push(enc.encode("x"));
    expect(over).toHaveLength(1);
  });

  it("forgets an unfinished overlong line on reset", () => {
    const a = new LineAssembler({ maxLineChars: 8 });
    a.push(enc.encode("x".repeat(9)));
    a.reset();
    expect(a.push(enc.encode('{"a":1}\n'))).toEqual(['{"a":1}']);
  });

  it("treats CRLF as a line end and a lone CR line as empty", () => {
    const a = new LineAssembler();
    expect(a.push(enc.encode('{"a":1}\r\n\r\n\r\n{"b":2}\r\n'))).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("handles CR and LF split across chunks", () => {
    const a = new LineAssembler();
    expect(a.push(enc.encode('{"a":1}\r'))).toEqual([]);
    expect(a.push(enc.encode("\n"))).toEqual(['{"a":1}']);
  });
});
