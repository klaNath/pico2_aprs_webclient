// Line framing (ble-protocol.md §5).

/** Max bytes per app -> device write (§5.2: 20 or fewer; Web Bluetooth does not expose the MTU). */
export const MAX_WRITE_BYTES = 20;
/** Max bytes per line the device accepts, excluding the newline (§5.1). */
export const MAX_LINE_BYTES = 512;

const encoder = new TextEncoder();

/** Encode one message as UTF-8 JSON + "\n". */
export function encodeLine(msg: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(msg) + "\n");
}

/** Split bytes into chunks of at most `max` bytes (a line may be split anywhere). */
export function splitBytes(bytes: Uint8Array, max: number = MAX_WRITE_BYTES): Uint8Array[] {
  if (max < 1) throw new RangeError("max must be >= 1");
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += max) out.push(bytes.subarray(i, i + max));
  return out;
}

/**
 * Reassembles notification chunks into lines. A chunk boundary may fall inside
 * a UTF-8 character, so decoding uses `stream: true`.
 */
export class LineAssembler {
  private decoder = new TextDecoder();
  private buf = "";

  push(chunk: Uint8Array): string[] {
    this.buf += this.decoder.decode(chunk, { stream: true });
    const lines: string[] = [];
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (line) lines.push(line);
    }
    return lines;
  }

  reset(): void {
    this.decoder = new TextDecoder();
    this.buf = "";
  }
}
