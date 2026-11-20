import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { badTextChars, checkMsgText, checkMsgTo, msgStateKind } from "../src/protocol/messages.ts";
import type { MsgMsg } from "../src/protocol/types.ts";
import { MessageStore, messageKey } from "../src/store/messages.ts";
import { App } from "../src/store/state.ts";
import { MockDevice } from "../src/transport/mock/mockDevice.ts";
import { MockTransport } from "../src/transport/mock/mockTransport.ts";
import type { MockTransportOptions } from "../src/transport/mock/mockTransport.ts";
import {
  describeMessageError,
  messageConfirmation,
  messageSendState,
  messageStateText,
  runMessageSend,
} from "../src/ui/messages.ts";

const out = (no: string, extra: Partial<MsgMsg> = {}): MsgMsg => ({
  t: "msg",
  dir: "out",
  no,
  to: "Q1AAA-9",
  text: `out ${no}`,
  state: "pending",
  tries: 0,
  utc: "2026-11-20T01:00:00Z",
  ...extra,
});
const inc = (src: string, text: string, extra: Partial<MsgMsg> = {}): MsgMsg => ({
  t: "msg",
  dir: "in",
  src,
  text,
  utc: "2026-11-20T01:05:00Z",
  ...extra,
});

describe("checks (§7.6)", () => {
  it("to: 1-9 of letters, digits and -, not this tracker", () => {
    expect(checkMsgTo("q1aaa-9")).toBeUndefined();
    expect(checkMsgTo("")).toMatch(/Enter/);
    expect(checkMsgTo("Q1AAAAA-15")).toMatch(/9/);
    expect(checkMsgTo("Q1 AA")).toMatch(/letters/);
    expect(checkMsgTo("q1test-7", "Q1TEST-7")).toMatch(/own/);
  });
  it("text: 1-67 printable ASCII without | ~ {", () => {
    expect(checkMsgText("Hello, world!")).toBeUndefined();
    expect(checkMsgText("")).toMatch(/Enter/);
    expect(checkMsgText("x".repeat(67))).toBeUndefined();
    expect(checkMsgText("x".repeat(68))).toMatch(/67/);
    expect(checkMsgText("a|b~c{d")).toMatch(/“\|”, “~”, “\{”/);
    expect(checkMsgText("こんにちは")).toMatch(/ASCII/);
    expect(badTextChars("a\tb")).toEqual(["\t"]);
  });
  it("an unknown state is treated as ended (§8.8)", () => {
    expect(msgStateKind("acked")).toBe("acked");
    expect(msgStateKind("future")).toBe("ended");
    expect(msgStateKind(undefined)).toBe("ended");
  });
});

describe("MessageStore", () => {
  it("keys sent messages by number and received ones by sender and number (or text)", () => {
    expect(messageKey(out("12"))).toBe("out:12");
    expect(messageKey(inc("q1bbb", "Hi", { no: "7" }))).toBe("in:Q1BBB:7");
    expect(messageKey(inc("Q1BBB", "Hi"))).not.toBe(messageKey(inc("Q1BBB", "Ho")));
  });
  it("groups by the other station, newest conversation first, oldest message first", () => {
    const s = new MessageStore();
    s.upsert(out("12"), 1);
    s.upsert(inc("Q1AAA-9", "reply", { no: "3", utc: "2026-11-20T01:01:00Z" }), 2, true);
    s.upsert(inc("Q1BBB", "other", { utc: "2026-11-20T00:00:00Z" }), 3, true);
    const convs = s.conversations();
    expect(convs.map((c) => c.peer)).toEqual(["Q1AAA-9", "Q1BBB"]);
    expect(convs[0]!.rows.map((r) => r.msg.text)).toEqual(["out 12", "reply"]);
    expect(convs[0]).toMatchObject({ unread: 1, pending: 1 });
    expect(s.unreadCount).toBe(2);
    expect(s.markRead("Q1AAA-9")).toBe(true);
    expect(s.unreadCount).toBe(1);
  });
  it("an update keeps what a later row leaves out, and never makes a read row unread", () => {
    const s = new MessageStore();
    s.upsert(inc("Q1BBB", "Hi", { no: "7" }), 1, true);
    s.markRead("Q1BBB");
    s.upsert(inc("Q1BBB", "Hi", { no: "7" }), 2, true);
    expect(s.unreadCount).toBe(0);
    s.upsert(out("12"), 1);
    const cancelled: MsgMsg = {
      t: "msg",
      id: 4,
      dir: "out",
      no: "12",
      to: "Q1AAA-9",
      text: "out 12",
      state: "cancelled",
      tries: 2,
    };
    const r = s.upsert(cancelled, 5);
    expect(r.msg).toMatchObject({ state: "cancelled", utc: "2026-11-20T01:00:00Z" });
    expect(r.msg).not.toHaveProperty("id");
    expect(s.size).toBe(2);
  });
  it("msg.list marks the device's unread ones that the app had not seen", () => {
    const s = new MessageStore();
    s.upsert(inc("Q1BBB", "seen", { no: "1", utc: "2026-11-20T00:00:00Z" }), 1, false);
    s.applyList(
      [
        inc("Q1CCC", "new", { no: "2" }),
        out("12"),
        inc("Q1BBB", "seen", { no: "1", utc: "2026-11-20T00:00:00Z" }),
        inc("Q1DDD", "old", { no: "9" }),
      ],
      2,
      2,
    );
    // The 2 newest received: "new" (unknown -> unread) and "seen" (already known -> stays read).
    expect(s.conversation("Q1CCC")!.unread).toBe(1);
    expect(s.conversation("Q1BBB")!.unread).toBe(0);
    expect(s.conversation("Q1DDD")!.unread).toBe(0);
  });
});

describe("UI decisions", () => {
  const ready = { sw: true, tx_ready: true, msg_pending: 0 };
  it("Send needs a link, a fresh status, the switch, tx_ready and room in the queue", () => {
    expect(messageSendState("ready", false, ready, false)).toEqual({ enabled: true, reason: "" });
    expect(messageSendState("disconnected", false, ready, false).enabled).toBe(false);
    expect(messageSendState("ready", true, ready, false).reason).toMatch(/recent/);
    expect(messageSendState("ready", false, { ...ready, sw: false }, false).reason).toMatch(
      /switch/,
    );
    expect(
      messageSendState(
        "ready",
        false,
        { ...ready, tx_ready: false, tx_refuse: "TX not enabled" },
        false,
      ).reason,
    ).toMatch(/TX not enabled.*never sent as a dry run/);
    expect(messageSendState("ready", false, { ...ready, msg_pending: 4 }, false).reason).toMatch(
      /4/,
    );
  });
  it("the dialog says it goes on the air, is repeated, and as whom", () => {
    const o = messageConfirmation("Q1TEST-7");
    expect(o.danger).toBe(true);
    expect(o.body.join(" ")).toMatch(/on the air.*5 times/);
    expect(o.facts).toEqual(["On the air as: Q1TEST-7"]);
  });
  it("words for states and errors", () => {
    expect(messageStateText({ state: "pending", tries: 0 })).toBe("Waiting to send");
    expect(messageStateText({ state: "pending", tries: 2 })).toMatch(/2 of 5/);
    expect(messageStateText({ state: "acked" })).toBe("Delivered");
    expect(messageStateText({ state: "zzz" })).toMatch(/Ended \(zzz\)/);
    for (const code of [
      "invalid",
      "switch_off",
      "tx_not_ready",
      "queue_full",
      "unknown_msg",
      "timeout",
    ]) {
      expect(describeMessageError({ code }).length).toBeGreaterThan(15);
    }
    expect(describeMessageError({ code: "invalid", key: "to", msg: "bad" })).toMatch(
      /callsign.*bad/,
    );
  });
});

describe("runMessageSend", () => {
  function deps(opts: { confirmed?: boolean; answer?: boolean; txAfter?: boolean } = {}) {
    const calls: string[] = [];
    let confirmed = opts.confirmed ?? false;
    let n = 0;
    return {
      calls,
      d: {
        confirmation: () => (confirmed ? { connectionId: 1 } : undefined),
        confirmConnection: () => {
          calls.push("remember");
          confirmed = true;
          return { connectionId: 1 };
        },
        confirm: () => {
          calls.push("confirm");
          return Promise.resolve(opts.answer ?? true);
        },
        send: (to: string, text: string) => {
          calls.push(`send ${to} ${text}`);
          return Promise.resolve(out("12", { to, text }));
        },
        current: () => ({
          usable: true,
          status: { sw: true, tx_ready: n++ === 0 ? true : (opts.txAfter ?? true) },
        }),
      },
    };
  }
  it("asks once, remembers it for the connection, then sends", async () => {
    const { d, calls } = deps();
    expect(await runMessageSend(d, "Q1AAA", "Hi")).toMatchObject({ ok: true });
    expect(await runMessageSend(d, "Q1AAA", "Again")).toMatchObject({ ok: true });
    expect(calls).toEqual(["confirm", "remember", "send Q1AAA Hi", "send Q1AAA Again"]);
  });
  it("sends nothing when the user says no", async () => {
    const { d, calls } = deps({ answer: false });
    expect(await runMessageSend(d, "Q1AAA", "Hi")).toEqual({ ok: false, cancelled: true });
    expect(calls).toEqual(["confirm"]);
  });
  it("sends nothing when tx_ready went away during the dialog", async () => {
    const { d, calls } = deps({ txAfter: false });
    expect(await runMessageSend(d, "Q1AAA", "Hi")).toMatchObject({ ok: false, text: /changed/ });
    expect(calls).toEqual(["confirm"]);
  });
});

describe("App: msg.list only while the Messages screen is shown", () => {
  let transports: MockTransport[];
  let app: App;
  beforeEach(() => {
    vi.useFakeTimers();
    transports = [];
    app = new App({
      createMockTransport: (o: MockTransportOptions) => {
        const device = new MockDevice();
        device.settings.tx_enabled = true;
        const t = new MockTransport({ ...o, autoRx: false, autoMsgMs: 0, device });
        transports.push(t);
        return t;
      },
    });
  });
  afterEach(async () => {
    await app.disconnect();
    vi.useRealTimers();
  });
  async function connect(): Promise<MockTransport> {
    const p = app.connectMock();
    await vi.advanceTimersByTimeAsync(2000);
    await p;
    return transports.at(-1)!;
  }

  it("does not read the list on connect (it would clear the device's unread count)", async () => {
    const t = await connect();
    const spy = vi.spyOn(t.device, "handleLine");
    t.receiveMessage("Q1BBB", "Hi", "7");
    await vi.advanceTimersByTimeAsync(100);
    expect(spy.mock.calls.some(([l]) => l.includes("msg.list"))).toBe(false);
    expect(app.messages.unreadCount).toBe(1); // the event is kept anyway
    expect(t.device.msgUnread).toBe(1);
    app.setMessagesOpen(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(spy.mock.calls.some(([l]) => l.includes("msg.list"))).toBe(true);
    expect(t.device.msgUnread).toBe(0);
    expect(app.messages.unreadCount).toBe(1); // still unread in the app until the user opens it
  });

  it("asks for confirmation again on a new connection", async () => {
    const t = await connect();
    expect(app.messageConfirmation()).toBeUndefined();
    const c = app.confirmMessages()!;
    expect(app.messageConfirmation()).toEqual(c);
    await app.sendMessage("Q1AAA", "Hi", c);
    expect(app.messages.size).toBe(1);
    t.simulateDisconnect();
    await vi.advanceTimersByTimeAsync(1500); // the automatic reconnect
    expect(app.state).toBe("ready");
    expect(app.messageConfirmation()).toBeUndefined();
    await expect(app.sendMessage("Q1AAA", "Hi", c)).rejects.toMatchObject({
      code: "confirmation_required",
    });
  });

  it("reads the list again when status.dropped rises while the screen is shown", async () => {
    const t = await connect();
    app.setMessagesOpen(true);
    await vi.advanceTimersByTimeAsync(100);
    const spy = vi.spyOn(t.device, "handleLine");
    t.device.dropped = 1;
    await vi.advanceTimersByTimeAsync(5100); // the next periodic status
    expect(spy.mock.calls.some(([l]) => l.includes("msg.list"))).toBe(true);
  });
});

describe("App: a message that arrives while the screen is shown", () => {
  it("is listed at once, so the device's unread count clears", async () => {
    vi.useFakeTimers();
    const ts: MockTransport[] = [];
    const a = new App({
      createMockTransport: (o: MockTransportOptions) => {
        const t = new MockTransport({ ...o, autoRx: false, autoMsgMs: 0 });
        ts.push(t);
        return t;
      },
    });
    const p = a.connectMock();
    await vi.advanceTimersByTimeAsync(2000);
    await p;
    a.setMessagesOpen(true);
    await vi.advanceTimersByTimeAsync(100);
    ts[0]!.receiveMessage("Q1BBB", "Hi", "7");
    await vi.advanceTimersByTimeAsync(100);
    expect(ts[0]!.device.msgUnread).toBe(0);
    expect(a.messages.unreadCount).toBe(1);
    await a.disconnect();
    vi.useRealTimers();
  });
});
