// The Messages tab: APRS messages by the other station (ble-protocol.md §7.6-§7.8, provisional).
// The list of conversations -> one conversation with the messages oldest first and a box to write.
// "New message" opens an empty conversation with a To field.
//
// msg.list clears the device's unread count (§7.7), so the app reads the list only while this
// screen is shown (main.ts tells App). Messages that arrive meanwhile come as `msg` events.

import { checkMsgText, checkMsgTo, MSG_TEXT_MAX, normalizeTo } from "../protocol/messages.ts";
import type { MessageRow } from "../store/messages.ts";
import type { App } from "../store/state.ts";
import { confirmDialog } from "./dialog.ts";
import { h, setChildren, setText } from "./dom.ts";
import { fmtClock } from "./format.ts";
import "./messages.css";
import {
  describeMessageError,
  messageSendState,
  messageStateClass,
  messageStateText,
  runMessageSend,
} from "./messages.ts";
import type { View } from "./view.ts";

/** "12:34" today, "11-19 12:34" on another day. */
function fmtWhen(at: number, now: number): string {
  const d = new Date(at);
  const today = new Date(now);
  const p = (n: number): string => String(n).padStart(2, "0");
  const time = fmtClock(at).slice(0, 5);
  return d.toDateString() === today.toDateString()
    ? time
    : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${time}`;
}

export function createMessagesView(app: App): View {
  /** undefined: the list. "": a new conversation (To not chosen yet). Else the peer. */
  let peer: string | undefined;
  let sending = false;
  let result = "";
  const cancelling = new Set<string>();
  let listSig = "";
  let threadSig = "";

  // ---- list ------------------------------------------------------------------------------
  const newBtn = h("button", {
    class: "btn btn-primary",
    text: "New message",
    attrs: { type: "button" },
    on: { click: () => open("") },
  });
  const refreshBtn = h("button", {
    class: "btn",
    text: "Refresh",
    attrs: { type: "button" },
    on: { click: () => void app.refreshMessages() },
  });
  const listNote = h("p", { class: "muted", attrs: { role: "status" } });
  const convList = h("ul", { class: "list msg-convs" });
  const listPane = h(
    "div",
    { class: "msg-pane" },
    h("div", { class: "row" }, newBtn, refreshBtn),
    listNote,
    convList,
  );

  // ---- conversation ----------------------------------------------------------------------
  const back = h("button", {
    class: "btn btn-small",
    text: "‹ All",
    attrs: { type: "button", "aria-label": "Back to all conversations" },
    on: { click: () => open(undefined) },
  });
  const title = h("h2", { class: "msg-title mono" });
  const toInput = h("input", {
    id: "msg-to",
    attrs: {
      type: "text",
      placeholder: "e.g. Q1AAA-9",
      autocomplete: "off",
      autocapitalize: "characters",
      spellcheck: "false",
      maxlength: "9",
      enterkeyhint: "next",
    },
    on: { input: () => updateForm() },
  });
  const toError = h("div", { class: "error", attrs: { role: "alert" } });
  const toField = h(
    "div",
    { class: "field" },
    h("label", { text: "To", attrs: { for: "msg-to" } }),
    toInput,
    toError,
  );
  const thread = h("ol", { class: "msg-thread", attrs: { "aria-label": "Messages" } });
  const textInput = h("input", {
    id: "msg-text",
    attrs: {
      type: "text",
      autocomplete: "off",
      maxlength: String(MSG_TEXT_MAX),
      enterkeyhint: "send",
      placeholder: "Message (plain ASCII)",
    },
    on: {
      input: () => updateForm(),
      keydown: (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          send();
        }
      },
    },
  });
  const counter = h("span", { class: "hint msg-counter" });
  const textError = h("div", { class: "error", attrs: { role: "alert" } });
  const sendBtn = h("button", {
    class: "btn btn-danger",
    text: "Send",
    attrs: { type: "button" },
    on: { click: () => send() },
  });
  const sendNote = h("p", { class: "muted hint", attrs: { role: "status" } });
  const compose = h(
    "div",
    { class: "card msg-compose" },
    h(
      "div",
      { class: "field" },
      h(
        "div",
        { class: "msg-label-row" },
        h("label", { text: "Message", attrs: { for: "msg-text" } }),
        counter,
      ),
      h("div", { class: "msg-input-row" }, textInput, sendBtn),
      textError,
    ),
    sendNote,
  );
  const convPane = h(
    "div",
    { class: "msg-pane" },
    h("div", { class: "msg-head" }, back, title),
    toField,
    thread,
    compose,
  );

  const intro = h("p", {
    class: "muted hint",
    text: "APRS messages to and from other stations. The tracker keeps the 16 newest.",
  });
  const el = h("section", { class: "view" }, intro, listPane, convPane);

  function open(p: string | undefined): void {
    peer = p;
    result = "";
    threadSig = "";
    toInput.value = "";
    textInput.value = "";
    if (p) app.markMessagesRead(p);
    render();
    if (p === "") toInput.focus();
    else if (p !== undefined) textInput.focus();
  }

  /** The addressee: the open conversation's, or what is typed in To. */
  function target(): string {
    return peer ? peer : normalizeTo(toInput.value);
  }

  function formErrors(): { to?: string; text?: string } {
    const own = app.status?.call;
    const to = peer ? undefined : toInput.value === "" ? "" : checkMsgTo(toInput.value, own);
    const text = textInput.value === "" ? "" : checkMsgText(textInput.value);
    return { to, text };
  }

  function updateForm(): void {
    const errs = formErrors();
    setText(toError, errs.to ?? "");
    setText(textError, errs.text ?? "");
    const n = textInput.value.length;
    setText(counter, `${n} / ${MSG_TEXT_MAX}`);
    counter.classList.toggle("msg-counter-full", n >= MSG_TEXT_MAX);
    const state = messageSendState(app.state, app.statusStale, app.status, sending);
    const formOk =
      errs.text === undefined && (peer ? true : errs.to === undefined) && textInput.value !== "";
    sendBtn.disabled = !state.enabled || !formOk;
    setText(sendNote, result || state.reason);
  }

  function send(): void {
    if (sendBtn.disabled || sending) return;
    const to = target();
    const text = textInput.value;
    const client = app.client;
    sending = true;
    result = "";
    updateForm();
    void runMessageSend(
      {
        confirmation: () => app.messageConfirmation(),
        confirmConnection: () => app.confirmMessages(),
        confirm: (o) => confirmDialog(o),
        send: (t, x, c) => app.sendMessage(t, x, c),
        current: () => ({
          usable: app.client === client && app.state === "ready" && !app.statusStale,
          status: app.status,
        }),
      },
      to,
      text,
    ).then((r) => {
      sending = false;
      if (r.ok) {
        textInput.value = "";
        result = "";
        if (!peer) {
          peer = r.msg.to ?? to;
          toInput.value = "";
          threadSig = "";
        }
      } else {
        result = "text" in r ? r.text : "";
      }
      render();
    });
  }

  function cancel(no: string): void {
    if (cancelling.has(no)) return;
    cancelling.add(no);
    threadSig = "";
    render();
    app.cancelMessage(no).then(
      () => {
        cancelling.delete(no);
        result = "";
        threadSig = "";
        render();
      },
      (e: unknown) => {
        cancelling.delete(no);
        result = describeMessageError(e);
        threadSig = "";
        render();
      },
    );
  }

  function bubble(r: MessageRow, now: number): HTMLElement {
    const m = r.msg;
    const out = m.dir === "out";
    const meta = h("div", { class: "msg-meta" }, h("span", { text: fmtWhen(r.sortAt, now) }));
    if (out) {
      meta.append(
        h("span", { class: `msg-state ${messageStateClass(m)}`, text: messageStateText(m) }),
      );
    } else if (m.no === undefined) {
      meta.append(h("span", { text: "no acknowledgement requested" }));
    }
    const li = h(
      "li",
      { class: `msg-bubble ${out ? "msg-out" : "msg-in"}${r.unread ? " msg-unread" : ""}` },
      h("div", { class: "msg-text", text: m.text ?? "" }),
      meta,
    );
    if (out && m.state === "pending" && m.no !== undefined) {
      const no = m.no;
      li.append(
        h("button", {
          class: "btn btn-small",
          text: cancelling.has(no) ? "Cancelling…" : "Stop sending",
          disabled: cancelling.has(no) || app.state !== "ready",
          attrs: { type: "button" },
          on: { click: () => cancel(no) },
        }),
      );
    }
    return li;
  }

  function renderList(now: number): void {
    const convs = app.messages.conversations();
    const loading = app.messagesLoading;
    setText(
      listNote,
      app.messagesError ??
        (loading
          ? "Reading the messages from the tracker…"
          : convs.length === 0
            ? app.state === "ready"
              ? "No messages yet."
              : "No messages. Connect to read the tracker's messages."
            : ""),
    );
    listNote.className = app.messagesError ? "problem" : "muted";
    refreshBtn.disabled = app.state !== "ready" || loading;
    newBtn.disabled = app.state !== "ready";
    const sig = JSON.stringify(
      convs.map((c) => [
        c.peer,
        c.last.key,
        c.last.msg.state,
        c.unread,
        c.pending,
        fmtWhen(c.last.sortAt, now),
      ]),
    );
    if (sig === listSig) return;
    listSig = sig;
    setChildren(
      convList,
      ...convs.map((c) => {
        const last = c.last.msg;
        const prefix = last.dir === "out" ? "You: " : "";
        return h(
          "li",
          { class: "list-item msg-conv-item" },
          h(
            "button",
            {
              class: "msg-conv",
              attrs: { type: "button" },
              on: { click: () => open(c.peer) },
            },
            h(
              "span",
              { class: "msg-conv-top" },
              h("span", { class: "msg-peer mono", text: c.peer }),
              c.unread > 0 ? h("span", { class: "msg-badge", text: `${c.unread} new` }) : null,
              c.pending > 0 ? h("span", { class: "msg-pending-tag", text: "sending" }) : null,
              h("span", { class: "msg-when muted", text: fmtWhen(c.last.sortAt, now) }),
            ),
            h("span", { class: "msg-preview muted", text: `${prefix}${last.text ?? ""}` }),
          ),
        );
      }),
    );
  }

  function renderThread(now: number): void {
    const conv = peer ? app.messages.conversation(peer) : undefined;
    // A message that arrives in the open conversation is read at once.
    if (peer && conv && conv.unread > 0) app.markMessagesRead(peer);
    const rows = conv?.rows ?? [];
    const sig = JSON.stringify([
      peer,
      app.state,
      [...cancelling],
      rows.map((r) => [r.key, r.msg.state, r.msg.tries, r.unread, fmtWhen(r.sortAt, now)]),
    ]);
    if (sig === threadSig) return;
    const atBottom = el.isConnected
      ? window.innerHeight + window.scrollY >= document.body.scrollHeight - 40
      : true;
    threadSig = sig;
    thread.hidden = rows.length === 0 && !peer;
    setChildren(
      thread,
      ...(rows.length === 0
        ? [h("li", { class: "muted msg-empty", text: peer ? "No messages yet." : "" })]
        : rows.map((r) => bubble(r, now))),
    );
    if (atBottom && el.isConnected) compose.scrollIntoView({ block: "nearest" });
  }

  function render(): void {
    const now = Date.now();
    const inConv = peer !== undefined;
    listPane.hidden = inConv;
    convPane.hidden = !inConv;
    intro.hidden = inConv;
    if (!inConv) {
      renderList(now);
      return;
    }
    toField.hidden = peer !== "";
    setText(title, peer ? peer : "New message");
    renderThread(now);
    updateForm();
  }

  return { el, render };
}
