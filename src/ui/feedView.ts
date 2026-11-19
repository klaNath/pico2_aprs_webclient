// The Feed tab: what the tracker received (rx) and sent (tx), newest first.
//
// Rendering rules (the feed can hold 5000 items and render() runs every second):
//  - rows are keyed by `FeedItem.seq`; render() puts new rows at the top and removes the ones
//    that were trimmed from the feed (at the bottom), and never rebuilds the others (an open row
//    stays open),
//  - the list is rebuilt only when the filter changes,
//  - at most MAX_ROWS rows are in the DOM ("Showing latest N"),
//  - new rows simply appear at the top while the top of the list is visible and no row is open;
//    otherwise the rows being read are kept in place and "N new ↑" is shown.

import "./feed.css";
import type { App, FeedItem } from "../store/state.ts";
import { packetProblem } from "../aprs/types.ts";
import { confirmDialog } from "./dialog.ts";
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
  matchesFilter,
  selectItems,
  summarize,
  tnc2Items,
  type FeedFilter,
} from "./feedFormat.ts";
import { fmtClock, fmtDb } from "./format.ts";
import type { View } from "./view.ts";

/** Most rows kept in the DOM. */
export const MAX_ROWS = 300;
/** How far (px) the list top may be scrolled under the header and still count as "at the top". */
const TOP_SLACK_PX = 48;

interface Row {
  seq: number;
  item: FeedItem;
  el: HTMLLIElement;
  head: HTMLButtonElement;
  detail?: HTMLElement;
}

/** The bottom edge of the sticky app header (0 without one). */
function headerBottom(): number {
  return document.querySelector(".app-header")?.getBoundingClientRect().bottom ?? 0;
}

/** Whether the top of `list` (its newest row) is visible. */
function isAtTop(list: HTMLElement): boolean {
  return list.getBoundingClientRect().top >= headerBottom() - TOP_SLACK_PX;
}

function scrollToTop(): void {
  window.scrollTo(0, 0);
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
  /** Whether the user was at the top the last time we looked (kept while the tab is hidden). */
  let stickTop = true;
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
        const n = app.feed.length;
        if (n === 0) return;
        void confirmDialog({
          title: "Clear the feed?",
          body: [
            `Clear all ${n} item${n === 1 ? "" : "s"}? Export first if you want to keep them.`,
          ],
          confirmLabel: "Clear",
          danger: true,
        }).then((ok) => {
          if (!ok) return;
          open.clear();
          unseen = 0;
          app.clearFeed();
        });
      },
    },
  });

  const includeTx = h("input", { id: "feed-tx", attrs: { type: "checkbox" } });
  const exportButton = (onClick: () => void): HTMLButtonElement =>
    h("button", { class: "btn", attrs: { type: "button" }, on: { click: onClick } });
  /** What is written to a file: everything kept, or only what matches the filter. */
  const exportItems = (onlyFiltered: boolean): readonly FeedItem[] =>
    onlyFiltered ? app.feed.filter((i) => matchesFilter(i, filter)) : app.feed;
  const exportJson = (onlyFiltered: boolean): void => {
    const now = new Date();
    download(
      exportFileName(now, "json"),
      "application/json",
      buildFeedJson(exportItems(onlyFiltered), now),
    );
  };
  const exportTnc2 = (onlyFiltered: boolean): void => {
    download(
      exportFileName(new Date(), "txt"),
      "text/plain;charset=utf-8",
      buildTnc2Log(exportItems(onlyFiltered), { includeTx: includeTx.checked }),
    );
  };
  const allJsonBtn = exportButton(() => exportJson(false));
  const allTxtBtn = exportButton(() => exportTnc2(false));
  const filteredJsonBtn = exportButton(() => exportJson(true));
  const filteredTxtBtn = exportButton(() => exportTnc2(true));
  const filteredRow = h(
    "div",
    { class: "row feed-actions", hidden: true },
    filteredJsonBtn,
    filteredTxtBtn,
  );
  // Not a live region: it changes with every packet, and a screen reader would read each change.
  const count = h("p", { class: "feed-count muted" });
  const empty = h("p", { class: "card muted feed-empty" });
  const list = h("ul", { class: "list feed-list" });
  const newBtn = h("button", {
    class: "btn btn-primary feed-new",
    attrs: { type: "button" },
    hidden: true,
    on: {
      click: () => {
        unseen = 0;
        stickTop = true;
        scrollToTop();
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
      h("div", { class: "row feed-actions" }, allJsonBtn, allTxtBtn),
      filteredRow,
      h(
        "div",
        { class: "feed-tx-opt" },
        includeTx,
        h("label", {
          text: "Include own transmissions in TNC2 files (after a “# tx” line)",
          attrs: { for: "feed-tx" },
        }),
      ),
      h("div", { class: "row feed-actions" }, clearBtn),
    ),
    count,
    empty,
    list,
    newBtn,
  );

  function updateNewBtn(): void {
    newBtn.hidden = unseen === 0;
    setText(newBtn, `${unseen} new ↑`);
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
  includeTx.addEventListener("change", render);

  window.addEventListener(
    "scroll",
    () => {
      if (!el.isConnected) return; // the browser clamps the scroll while another tab is shown
      stickTop = isAtTop(list);
      savedY = window.scrollY;
      if (stickTop && unseen > 0) {
        unseen = 0;
        updateNewBtn();
      }
    },
    { passive: true },
  );

  function render(): void {
    const reattached = !attached;
    attached = true;
    const wasAtTop = reattached ? stickTop : isAtTop(list);

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

    // `rows` is oldest first like the feed; in the DOM the newest row is at the top.
    // Remove rows that left the feed (trimmed, cleared) or the window of MAX_ROWS (the bottom) ...
    const firstSeq = shown[0]?.seq ?? Number.POSITIVE_INFINITY;
    let drop = 0;
    while (drop < rows.length && rows[drop]!.seq < firstSeq) dropRow(rows[drop++]!);
    if (drop > 0) rows = rows.slice(drop);
    // ... and put the new ones at the top, newest first.
    const topRow = rows.length > 0 ? rows[rows.length - 1]! : undefined;
    const lastSeq = topRow?.seq ?? -1;
    const fresh: Row[] = [];
    for (const item of shown) {
      if (item.seq <= lastSeq) continue;
      fresh.push(makeRow(item));
    }
    const added = fresh.length;
    const follow = !filterChanged && wasAtTop && open.size === 0;
    // Back from another tab: main.ts calls render() *before* it puts the view back into <main>,
    // so the page cannot be scrolled yet. Scroll once the list is attached (a microtask later).
    const returning = reattached && !filterChanged;
    // Keep the rows being read in place (the list has `overflow-anchor: none`, so this is ours).
    const keep =
      !returning && !follow && !filterChanged && topRow
        ? topRow.el.getBoundingClientRect().top
        : null;
    if (added > 0) {
      const frag = document.createDocumentFragment();
      for (let i = fresh.length - 1; i >= 0; i--) frag.append(fresh[i]!.el);
      list.prepend(frag);
      rows.push(...fresh);
    }
    if (keep !== null && topRow && added > 0) {
      window.scrollBy(0, topRow.el.getBoundingClientRect().top - keep);
    }
    if (returning) {
      const y = savedY;
      queueMicrotask(() => {
        if (follow) {
          scrollToTop();
          return;
        }
        window.scrollTo(0, y);
        // Rows added while away pushed what was being read down by their height.
        const newest = list.firstElementChild;
        if (added > 0 && topRow && newest) {
          const pushed = topRow.el.getBoundingClientRect().top - newest.getBoundingClientRect().top;
          window.scrollBy(0, pushed);
        }
      });
    }

    // Texts.
    const limit = app.prefs.get("logLimit");
    let line = `${app.feed.length} of ${limit}`;
    if (isFiltering(filter)) line += ` · ${matched} match`;
    if (matched > rows.length) {
      line += ` · Showing latest ${rows.length}. Older items are only in the export.`;
    }
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
    const total = app.feed.length;
    const withTx = includeTx.checked;
    setText(allJsonBtn, `Export all ${total} as JSON`);
    setText(allTxtBtn, `Export all ${total} as TNC2`);
    allJsonBtn.disabled = total === 0;
    allTxtBtn.disabled = tnc2Items(app.feed, { includeTx: withTx }).length === 0;
    const filtering = isFiltering(filter);
    filteredRow.hidden = !filtering;
    if (filtering) {
      setText(filteredJsonBtn, `Export filtered ${matched} as JSON`);
      setText(filteredTxtBtn, `Export filtered ${matched} as TNC2`);
      filteredJsonBtn.disabled = matched === 0;
      filteredTxtBtn.disabled = tnc2Items(exportItems(true), { includeTx: withTx }).length === 0;
    }

    // Scrolling: new rows show up at the top only while it is visible and no row is open.
    if (filterChanged) {
      unseen = 0;
    } else if (follow) {
      stickTop = true;
      unseen = 0;
    } else {
      unseen += added; // the scroll position was kept (or is restored above)
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
