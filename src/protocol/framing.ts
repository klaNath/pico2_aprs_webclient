// Line framing (ble-protocol.md §5).

/**
 * Max bytes per app -> device write. Fixed by §5.2: "20 bytes or fewer" (the minimum MTU of 23
 * minus 3; Web Bluetooth does not expose the negotiated MTU). Do not raise it.
 */
export const MAX_WRITE_BYTES = 20;
/** Max bytes per line the device accepts, excluding the newline (§5.1). */
export const MAX_LINE_BYTES = 512;
/**
 * Max length of one device -> app line that the app buffers. The device sends lines longer than
 * 512 bytes (`settings.schema` is about 1.1 KB, §10.1), so this is far above that; it only stops an
 * unterminated line from growing without limit. Counted in UTF-16 code units of the decoded text.
 */
export const MAX_RX_LINE_CHARS = 16 * 1024;

const encoder = new TextEncoder();

/**
 * Encode one message as UTF-8 JSON + "\n". Throws RangeError if the line (without the newline)
 * is longer than MAX_LINE_BYTES: the device would discard it and answer `too_long` without an id.
 */
export function encodeLine(msg: unknown): Uint8Array {
  const bytes = encoder.encode(JSON.stringify(msg) + "\n");
  if (bytes.length - 1 > MAX_LINE_BYTES) {
    throw new RangeError(`line too long: ${bytes.length - 1} bytes (max ${MAX_LINE_BYTES})`);
  }
  return bytes;
}

/** Split bytes into chunks of at most `max` bytes (a line may be split anywhere). */
export function splitBytes(bytes: Uint8Array, max: number = MAX_WRITE_BYTES): Uint8Array[] {
  if (max < 1) throw new RangeError("max must be >= 1");
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += max) out.push(bytes.subarray(i, i + max));
  return out;
}

export interface LineAssemblerOptions {
  /** Longer lines are dropped (up to the next newline). Default MAX_RX_LINE_CHARS. */
  maxLineChars?: number;
  /** Called once per dropped line, with its first characters. */
  onOverflow?: (head: string) => void;
}

/**
 * Reassembles notification chunks into lines. A chunk boundary may fall inside
 * a UTF-8 character, so decoding uses `stream: true`. Empty lines are skipped, a trailing
 * "\r" is removed (CRLF), and a line that exceeds the limit is dropped and reported once.
 */
export class LineAssembler {
  private decoder = new TextDecoder();
  private buf = "";
  /** Dropping the rest of an over-long line, until its newline. */
  private discarding = false;
  private readonly maxChars: number;
  private readonly onOverflow: ((head: string) => void) | undefined;

  constructor(options: LineAssemblerOptions = {}) {
    this.maxChars = options.maxLineChars ?? MAX_RX_LINE_CHARS;
    this.onOverflow = options.onOverflow;
  }

  push(chunk: Uint8Array): string[] {
    const text = this.decoder.decode(chunk, { stream: true });
    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const nl = text.indexOf("\n", start);
      if (nl < 0) break;
      const piece = text.slice(start, nl);
      start = nl + 1;
      if (this.discarding) {
        this.discarding = false; // the end of the dropped line
        continue;
      }
      let line = this.buf + piece;
      this.buf = "";
      if (line.length > this.maxChars) {
        this.onOverflow?.(line.slice(0, 80));
        continue;
      }
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line) lines.push(line);
    }
    if (!this.discarding) {
      this.buf += text.slice(start);
      if (this.buf.length > this.maxChars) {
        this.onOverflow?.(this.buf.slice(0, 80));
        this.buf = "";
        this.discarding = true;
      }
    }
    return lines;
  }

  reset(): void {
    this.decoder = new TextDecoder();
    this.buf = "";
    this.discarding = false;
  }
}
