// TNC2 line parsing. `<0xHH>` escapes (§8.2 of ble-protocol.md) are turned back into bytes.
//
// The information field is kept as a "binary string" (one char per byte), because Mic-E and
// telemetry use control bytes. Only human-readable parts are decoded as UTF-8 at the end.
//
// Limitation of the device format: only `<0xHH>` with two UPPERCASE hex digits is turned back.
// A printable `<0x41>` in the original packet cannot be told apart from an escaped 'A'.

import type { PathEntry, Tnc2 } from "./types.ts";

const ESCAPE = /<0x([0-9A-F]{2})>/g;

/** Turn `<0xHH>` back into bytes; other characters are encoded as UTF-8. Returns a binary string. */
export function decodeEscapes(s: string): string {
  const enc = new TextEncoder();
  let out = "";
  let last = 0;
  for (const m of s.matchAll(ESCAPE)) {
    out += bytesToBinary(enc.encode(s.slice(last, m.index)));
    out += String.fromCharCode(parseInt(m[1]!, 16));
    last = m.index + m[0].length;
  }
  return out + bytesToBinary(enc.encode(s.slice(last)));
}

export function bytesToBinary(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

export function binaryToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

// ---- text decoding ---------------------------------------------------------------------------
//
// Policy for `readText`, in this order (a text that is plain ASCII is returned at once):
//  1. Strict UTF-8.
//  2. UTF-8 with an incomplete sequence at the very end: that tail is dropped. A BLE notification
//     is at most 244 bytes, so a long comment can be cut in the middle of a character. The tail
//     is dropped when it is a lead byte plus at least one continuation byte, or a lone lead byte
//     after text that already contains a complete multi-byte character. A lone lead byte after
//     plain ASCII ("caf\xE9") is more likely Latin-1 and is left for step 4.
//  3. Shift_JIS, only when the strict decode works and the text is clearly Japanese: it has a
//     kana/symbol character (lead byte 0x81-0x84) or at least two double-byte characters whose
//     lead byte is 0x81-0x9F. Lead bytes 0x81-0x9F are C1 control characters in Latin-1, so
//     sane Latin-1 text cannot contain them; "été" (E9 74 E9) therefore is not taken for
//     Shift_JIS. A cut-off lead byte at the end is dropped here as well. Limit: Windows-1252
//     text with two or more smart quotes can still look like Shift_JIS.
//  4. Latin-1 (every byte as one character), which never fails and keeps garbage visible.

function strictDecode(label: string, bytes: Uint8Array): string | null {
  try {
    return new TextDecoder(label, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Length of the incomplete UTF-8 sequence at the end of `b` (0 if there is none). */
function incompleteUtf8Tail(b: Uint8Array): number {
  for (let k = 1; k <= 3 && k <= b.length; k++) {
    const byte = b[b.length - k]!;
    if (byte >= 0x80 && byte <= 0xbf) continue; // continuation byte: look further back
    const need = byte >= 0xf0 && byte <= 0xf4 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc2 ? 2 : 0;
    return need > k && byte <= 0xf4 ? k : 0;
  }
  return 0;
}

function isClearlyJapanese(bytes: Uint8Array, text: string): boolean {
  if (/[\uE000-\uF8FF\uFFFD]/.test(text)) return false; // private use / replacement characters
  let kana = false;
  let doubleByte = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if ((b >= 0x81 && b <= 0x9f) || (b >= 0xe0 && b <= 0xfc)) {
      i++; // the trail byte
      if (b <= 0x9f) {
        doubleByte++;
        if (b <= 0x84) kana = true;
      }
    }
  }
  return kana || doubleByte >= 2;
}

function latin1(bytes: Uint8Array): string {
  return bytesToBinary(bytes);
}

/** Read a binary string (one char per byte) as text. See the policy above. */
export function readText(binary: string): string {
  if (!/[\x80-\xff]/.test(binary)) return binary;
  const bytes = binaryToBytes(binary);

  const utf8 = strictDecode("utf-8", bytes);
  if (utf8 !== null) return utf8;

  const tail = incompleteUtf8Tail(bytes);
  if (tail > 0) {
    const head = bytes.subarray(0, bytes.length - tail);
    const text = strictDecode("utf-8", head);
    if (text !== null && (tail >= 2 || /[\u0080-\uffff]/.test(text))) return text;
  }

  for (const end of [bytes.length, bytes.length - 1]) {
    const part = bytes.subarray(0, end);
    // The second try only applies when the last byte may be a cut-off Shift_JIS lead byte.
    if (end !== bytes.length && bytes[end]! < 0x81) break;
    const text = strictDecode("shift_jis", part);
    if (text !== null && isClearlyJapanese(part, text)) return text;
  }

  return latin1(bytes);
}

export interface Call {
  call: string;
  ssid: number;
}

/**
 * "Q1AAA-9" -> { call: "Q1AAA", ssid: 9 }. The SSID is 0-15 (AX.25); anything else, such as
 * "Q1AAA-16" or "Q1AAA-123", is not split and the whole string is the call. Case is kept.
 */
export function splitCall(s: string): Call {
  const m = /^(.+?)-(\d{1,2})$/.exec(s);
  if (!m || Number(m[2]) > 15) return { call: s, ssid: 0 };
  return { call: m[1]!, ssid: Number(m[2]) };
}

/** `qAR`, `qAC`, `qAo`, ...: the APRS-IS q constructs. */
const Q_CONSTRUCT = /^q[A-Za-z]{2}$/;

/** Parse a header plus information field that is already a binary string. */
export function parseTnc2Binary(binary: string): Tnc2 | { error: string } {
  const colon = binary.indexOf(":");
  if (colon < 0) return { error: "no ':' between header and information" };
  const header = binary.slice(0, colon);
  const gt = header.indexOf(">");
  if (gt <= 0) return { error: "no source before '>'" };
  const src = header.slice(0, gt).trim();
  if (src === "") return { error: "no source before '>'" };
  const parts = header.slice(gt + 1).split(",");
  const dst = (parts[0] ?? "").trim();
  if (dst === "") return { error: "no destination" };

  const rest = parts
    .slice(1)
    .map((p) => p.trim())
    .filter((p) => p !== "");
  let lastUsed = -1;
  rest.forEach((p, i) => {
    if (p.endsWith("*")) lastUsed = i;
  });
  const path: PathEntry[] = [];
  rest.forEach((p, i) => {
    const call = p.endsWith("*") ? p.slice(0, -1) : p;
    // A lone `*` has no call; it only marks the entries before it as used (see lastUsed).
    if (call === "") return;
    const entry: PathEntry = { call, used: i <= lastUsed };
    if (Q_CONSTRUCT.test(call)) entry.qConstruct = true;
    path.push(entry);
  });
  return { src, dst, path, info: binary.slice(colon + 1) };
}

/** Parse a TNC2 line as sent in `rx.tnc2` / `tx.tnc2`. */
export function parseTnc2(line: string): Tnc2 | { error: string } {
  return parseTnc2Binary(decodeEscapes(line));
}

export function isTnc2Error(v: Tnc2 | { error: string }): v is { error: string } {
  return "error" in v;
}
