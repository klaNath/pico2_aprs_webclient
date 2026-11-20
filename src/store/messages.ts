// The APRS messages the app knows about (ble-protocol.md §7.6-§7.8, §8.8), grouped by the other
// station. Rows come from `msg` events, from the answers to msg.send / msg.cancel, and from
// msg.list. Pure: no DOM and no client, so it can be tested on its own.

import type { MsgMsg } from "../protocol/types.ts";

export interface MessageRow {
  key: string;
  /** The other station: the addressee of a sent message, the sender of a received one. */
  peer: string;
  msg: MsgMsg;
  /** Date.now() when the app first saw it. */
  seenAt: number;
  /** Time used for ordering: the device's `utc`, or `seenAt` when it has none. */
  sortAt: number;
  /** A received message the user has not looked at in its conversation yet. */
  unread: boolean;
}

export interface Conversation {
  peer: string;
  /** Oldest first. */
  rows: MessageRow[];
  last: MessageRow;
  unread: number;
  pending: number;
}

/** Most rows kept. The device keeps 16 (§7.7); the app keeps more for the session. */
export const MAX_MESSAGES = 200;

/**
 * The identity of a message. A sent one is known by its number. A received one by sender and
 * number, or (without a number) by sender, text and time, as the device tells repeats apart (§8.8).
 */
export function messageKey(m: MsgMsg): string {
  if (m.dir === "out") return `out:${m.no ?? `${m.to ?? ""}:${m.text ?? ""}:${m.utc ?? ""}`}`;
  const src = (m.src ?? "").toUpperCase();
  return m.no !== undefined ? `in:${src}:${m.no}` : `in:${src}:-:${m.text ?? ""}:${m.utc ?? ""}`;
}

export function messagePeer(m: MsgMsg): string {
  return ((m.dir === "out" ? m.to : m.src) ?? "?").toUpperCase();
}

function utcMs(utc: string | undefined): number | undefined {
  if (utc === undefined) return undefined;
  const t = Date.parse(utc);
  return Number.isFinite(t) ? t : undefined;
}

export class MessageStore {
  private rows = new Map<string, MessageRow>();

  get size(): number {
    return this.rows.size;
  }

  clear(): void {
    this.rows.clear();
  }

  get(key: string): MessageRow | undefined {
    return this.rows.get(key);
  }

  /**
   * Add or update one message. `unread` marks a newly received one (a live event). An update never
   * turns a read message back to unread. Returns the row.
   */
  upsert(m: MsgMsg, now: number, unread = false): MessageRow {
    const key = messageKey(m);
    const prev = this.rows.get(key);
    // A row without the id: the store's copy is not a reply to anything.
    const msg: MsgMsg = { ...m };
    delete msg.id;
    // A later row may leave out what an earlier one said (msg.cancel's answer has no utc).
    if (prev) {
      for (const k of ["utc", "no", "text", "to", "src"] as const) {
        if (msg[k] === undefined && prev.msg[k] !== undefined) msg[k] = prev.msg[k];
      }
    }
    const seenAt = prev?.seenAt ?? now;
    const row: MessageRow = {
      key,
      peer: messagePeer(msg),
      msg,
      seenAt,
      sortAt: utcMs(msg.utc) ?? prev?.sortAt ?? seenAt,
      unread: prev ? prev.unread : unread && msg.dir === "in",
    };
    this.rows.set(key, row);
    this.trim();
    return row;
  }

  /**
   * The result of msg.list (newest first). `deviceUnread` is `status.msg_unread` from just before
   * the list: that many of the newest received messages had not been read on the device, and the
   * list has now cleared that count, so they are marked unread here unless the app showed them.
   */
  applyList(list: readonly MsgMsg[], now: number, deviceUnread: number): void {
    let left = Math.max(0, Math.floor(deviceUnread));
    for (const m of list) {
      const known = this.rows.has(messageKey(m));
      const markUnread = m.dir === "in" && left > 0 && !known;
      if (m.dir === "in" && left > 0) left--;
      this.upsert(m, now, markUnread);
    }
  }

  /** The user opened the conversation with `peer`. */
  markRead(peer: string): boolean {
    let changed = false;
    for (const r of this.rows.values()) {
      if (r.peer === peer && r.unread) {
        r.unread = false;
        changed = true;
      }
    }
    return changed;
  }

  get unreadCount(): number {
    let n = 0;
    for (const r of this.rows.values()) if (r.unread) n++;
    return n;
  }

  /** Conversations, the most recent first. */
  conversations(): Conversation[] {
    const by = new Map<string, MessageRow[]>();
    for (const r of this.rows.values()) {
      const list = by.get(r.peer);
      if (list) list.push(r);
      else by.set(r.peer, [r]);
    }
    const out: Conversation[] = [];
    for (const [peer, rows] of by) {
      rows.sort(byTime);
      out.push({
        peer,
        rows,
        last: rows[rows.length - 1]!,
        unread: rows.filter((r) => r.unread).length,
        pending: rows.filter((r) => r.msg.dir === "out" && r.msg.state === "pending").length,
      });
    }
    return out.sort((a, b) => byTime(b.last, a.last));
  }

  conversation(peer: string): Conversation | undefined {
    return this.conversations().find((c) => c.peer === peer);
  }

  private trim(): void {
    if (this.rows.size <= MAX_MESSAGES) return;
    const oldest = [...this.rows.values()]
      .filter((r) => !(r.msg.dir === "out" && r.msg.state === "pending"))
      .sort(byTime)
      .slice(0, this.rows.size - MAX_MESSAGES);
    for (const r of oldest) this.rows.delete(r.key);
  }
}

function byTime(a: MessageRow, b: MessageRow): number {
  return a.sortAt - b.sortAt || a.seenAt - b.seenAt;
}
