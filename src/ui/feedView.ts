// The Feed tab: what the tracker received (rx) and sent (tx), oldest first like a log.
//
// Rendering rules (the feed can hold 5000 items and render() runs every second):
//  - rows are keyed by `FeedItem.seq`; render() appends new rows and removes the ones that were
//    trimmed from the feed, and never rebuilds the others (an open row stays open),
//  - the list is rebuilt only when the filter changes,
//  - at most MAX_ROWS rows are in the DOM ("Showing latest N"),
//  - the page follows new items only while it is scrolled to the bottom and no row is open.

import "./feed.css";
import type { App, FeedItem } from "../store/state.ts";
import { packetProblem } from "../aprs/types.ts";
import { h, setText } from "./dom.ts";
import {
  buildFeedJson,
  buildTnc2Log,
  CATEGORY_OPTIONS,
  detailRows,
  directionLabel,
  exportFileName,
  feedSource,
  isFiltering,
  kindLabel,
  selectItems,
  summarize,
  type FeedFilter,
} from "./feedFormat.ts";
import { fmtClock, fmtDb } from "./format.ts";
import type { View } from "./view.ts";

/** Most rows kept in the DOM. */
export const MAX_ROWS = 300;
/** How close to the bottom (px) still counts as "at the bottom". */
const BOTTOM_SLACK_PX = 48;

interface Row {
  seq: number;
  item: FeedItem;
  el: HTMLLIElement;
  head: HTMLButtonElement;
  detail?: HTMLElement;
}

function isAtBottom(): boolean {
  const doc = document.documentElement;
  return window.innerHeight + window.scrollY >= doc.scrollHeight - BOTTOM_SLACK_PX;
}

function scrollToBottom(): void {
  window.scrollTo(0, document.documentElement.scrollHeight);
}

/** Save `text` to a file on this device (nothing is sent anywhere). */
function download(name: string, mime: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = h("a", { hidden: true, attrs: { href: url, download: name } });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function option(value: string, label: string): HTMLOptionElement {
  return h("option", { text: label, attrs: { value } });
}

function makeDetail(item: FeedItem): HTMLElement {
  const problem = packetProblem(item.parsed);
  const dl = h("dl", { class: "kv" });
  for (const r of detailRows(item))
    dl.append(h("dt", { text: r.label }), h("dd", { text: r.value }));
  return h(
    "div",
    { class: "feed-detail" },
    h("pre", { class: "feed-raw mono", text: item.msg.tnc2 }),
    problem ? h("p", { class: "problem", text: `Cannot read this packet: ${problem}` }) : null,
    dl,
  );
}

export function createFeedView(app: App): View {
  const filter: FeedFilter = { dir: "all", category: "all", source: "" };
  let appliedKey = "all|all|";
  let rows: Row[] = [];
  const open = new Set<number>();
  /** Whether the user was at the bottom the last time we looked (kept while the tab is hidden). */
  let stickBottom = true;
  let savedY = 0;
  let attached = false;
  let unseen = 0;

  // ---- toolbar ----
  const dirSel = h(
    "select",
    { attrs: { id: "feed-dir" } },
    option("all", "rx and tx"),
    option("rx", "rx only"),
    option("tx", "tx only"),
  );
  const catSel = h(
    "select",
    { attrs: { id: "feed-cat" } },
    option("all", "All types"),
    ...CATEGORY_OPTIONS.map((c) => option(c.value, c.label)),
  );
  const srcInput = h("input", {
    attrs: {
      id: "feed-src",
      type: "text",
      placeholder: "e.g. Q1AAA",
      autocomplete: "off",
      autocapitalize: "characters",
      spellcheck: "false",
    },
  });
  const field = (label: string, id: string, control: HTMLElement, wide = false): HTMLElement =>
    h(
      "div",
      { class: wide ? "field field-wide" : "field" },
      h("label", { text: label, attrs: { for: id } }),
      control,
    );

  const clearBtn = h("button", {
    class: "btn",
    text: "Clear",
    attrs: { type: "button" },
    on: {
      click: () => {
        open.clear();
        unseen = 0;
        app.clearFeed();
      },
    },
  });
  const jsonBtn = h("button", {
    class: "btn",
    text: "Export JSON",
    attrs: { type: "button" },
    on: {
      click: () => {
        const now = new Date();
        download(exportFileName(now, "json"), "application/json", buildFeedJson(app.feed, now));
      },
    },
  });
  const txtBtn = h("button", {
    class: "btn",
    text: "Export TNC2",
    attrs: { type: "button" },
    on: {
      click: () => {
        download(
          exportFileName(new Date(), "txt"),
          "text/plain;charset=utf-8",
          buildTnc2Log(app.feed),
        );
      },
    },
  });
  const count = h("p", { class: "feed-count muted", attrs: { "aria-live": "polite" } });
  const empty = h("p", { class: "card muted feed-empty" });
  const list = h("ul", { class: "list feed-list" });
  const newBtn = h("button", {
    class: "btn btn-primary feed-new",
    attrs: { type: "button" },
    hidden: true,
    on: {
      click: () => {
        unseen = 0;
        stickBottom = true;
        scrollToBottom();
        updateNewBtn();
      },
    },
  });

  const el = h(
    "section",
    { class: "view" },
    h(
      "div",
      { class: "card" },
      h(
        "div",
        { class: "feed-filters" },
        field("Direction", "feed-dir", dirSel),
        field("Type", "feed-cat", catSel),
        field("Source callsign", "feed-src", srcInput, true),
      ),
      h("div", { class: "row feed-actions" }, clearBtn, jsonBtn, txtBtn),
    ),
    count,
    empty,
    list,
    newBtn,
  );

  function updateNewBtn(): void {
    newBtn.hidden = unseen === 0;
    setText(newBtn, `${unseen} new ↓`);
  }

  function setOpen(row: Row, want: boolean): void {
    if (want) {
      if (!row.detail) {
        row.detail = makeDetail(row.item);
        row.el.append(row.detail);
      }
      open.add(row.seq);
    } else {
      row.detail?.remove();
      row.detail = undefined;
      open.delete(row.seq);
    }
    row.head.setAttribute("aria-expanded", String(want));
    row.el.classList.toggle("feed-open", want);
  }

  function makeRow(item: FeedItem): Row {
    const rx = item.msg.t === "rx" ? item.msg : undefined;
    const dir = directionLabel(item);
    const dirCls =
      item.kind === "rx" ? "feed-dir-rx" : dir === "tx dry" ? "feed-dir-dry" : "feed-dir-tx";
    const lvl = rx?.lvl_db !== undefined ? fmtDb(rx.lvl_db) : "";
    const head = h(
      "button",
      { class: "feed-head", attrs: { type: "button", "aria-expanded": "false" } },
      h(
        "span",
        { class: "feed-line1" },
        h("span", { class: "feed-time mono", text: fmtClock(item.at) }),
        h("span", { class: `feed-dir ${dirCls}`, text: dir }),
        h("span", { class: "feed-src", text: feedSource(item) }),
        lvl ? h("span", { class: "feed-meta", text: lvl }) : null,
        rx?.clip ? h("span", { class: "feed-clip", text: "clip" }) : null,
      ),
      h(
        "span",
        { class: "feed-line2" },
        h("span", { class: "feed-kind", text: kindLabel(item.parsed) }),
        h("span", { class: "feed-summary", text: summarize(item.parsed) }),
      ),
    );
    const li = h(
      "li",
      { class: "list-item feed-item", attrs: { "data-seq": String(item.seq) } },
      head,
    );
    const row: Row = { seq: item.seq, item, el: li, head };
    head.addEventListener("click", () => setOpen(row, !open.has(row.seq)));
    return row;
  }

  function dropRow(row: Row): void {
    open.delete(row.seq);
    row.el.remove();
  }

  function onFilterChange(): void {
    filter.dir = dirSel.value === "rx" || dirSel.value === "tx" ? dirSel.value : "all";
    filter.category = CATEGORY_OPTIONS.find((c) => c.value === catSel.value)?.value ?? "all";
    filter.source = srcInput.value;
    render();
  }
  dirSel.addEventListener("change", onFilterChange);
  catSel.addEventListener("change", onFilterChange);
  srcInput.addEventListener("input", onFilterChange);

  window.addEventListener(
    "scroll",
    () => {
      if (!el.isConnected) return; // the browser clamps the scroll while another tab is shown
      stickBottom = isAtBottom();
      savedY = window.scrollY;
      if (stickBottom && unseen > 0) {
        unseen = 0;
        updateNewBtn();
      }
    },
    { passive: true },
  );

  function render(): void {
    const reattached = !attached;
    attached = true;
    const wasAtBottom = reattached ? stickBottom : isAtBottom();

    // A new filter: start the list again (the only time rows are rebuilt).
    const key = `${filter.dir}|${filter.category}|${filter.source.trim().toUpperCase()}`;
    const filterChanged = key !== appliedKey;
    if (filterChanged) {
      for (const r of rows) r.el.remove();
      rows = [];
      open.clear();
      appliedKey = key;
    }

    const { shown, matched } = selectItems(app.feed, filter, MAX_ROWS);

    // Remove rows that left the feed (trimmed, cleared) or the window of MAX_ROWS ...
    const firstSeq = shown[0]?.seq ?? Number.POSITIVE_INFINITY;
    let drop = 0;
    while (drop < rows.length && rows[drop]!.seq < firstSeq) dropRow(rows[drop++]!);
    if (drop > 0) rows = rows.slice(drop);
    // ... and add the new ones at the end.
    const lastSeq = rows.length > 0 ? rows[rows.length - 1]!.seq : -1;
    const frag = document.createDocumentFragment();
    let added = 0;
    for (const item of shown) {
      if (item.seq <= lastSeq) continue;
      const row = makeRow(item);
      rows.push(row);
      frag.append(row.el);
      added++;
    }
    if (added > 0) list.append(frag);

    // Texts.
    const limit = app.prefs.get("logLimit");
    let line = `${app.feed.length} of ${limit}`;
    if (isFiltering(filter)) line += ` · ${matched} match`;
    if (matched > rows.length) line += ` · Showing latest ${rows.length}`;
    setText(count, line);
    const hasRows = rows.length > 0;
    empty.hidden = hasRows;
    if (!hasRows) {
      setText(
        empty,
        app.feed.length > 0
          ? "No items match the filter."
          : app.state === "ready"
            ? "Connected. Waiting for packets..."
            : "Nothing received yet. Connect to the tracker to see packets here.",
      );
    }
    clearBtn.disabled = app.feed.length === 0;
    jsonBtn.disabled = app.feed.length === 0;
    txtBtn.disabled = app.feed.length === 0;

    // Scrolling: follow only from the bottom, and never while a row is open.
    if (filterChanged) {
      unseen = 0;
    } else if (wasAtBottom && open.size === 0) {
      if (added > 0 || reattached) scrollToBottom();
      stickBottom = true;
      unseen = 0;
    } else if (reattached && !stickBottom) {
      window.scrollTo(0, savedY);
      unseen += added;
    } else if (added > 0) {
      unseen += added;
    }
    if (rows.length === 0) unseen = 0;
    updateNewBtn();
  }

  // main.ts swaps the whole view out of <main> when another tab is shown: notice that, so that the
  // next render() knows it has to restore the scroll position.
  let watching: Element | null = null;
  const observer = new MutationObserver(() => {
    if (!el.isConnected) attached = false;
  });

  return {
    el,
    render(): void {
      if (el.parentElement && el.parentElement !== watching) {
        watching = el.parentElement;
        observer.disconnect();
        observer.observe(watching, { childList: true });
      }
      render();
    },
  };
}
