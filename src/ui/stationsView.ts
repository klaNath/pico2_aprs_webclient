// The Stations tab: every station the tracker has heard, with distance and bearing from this
// tracker, sorted and filtered. Tapping a row opens its details. The row elements are created
// once per station and updated in place (render() runs every second, so ages stay fresh).
//
// The order is held (see stationOrder.ts) while a detail is open, a row has keyboard focus, or a
// pointer is down (and for a moment after), so a row never moves under the user's finger. Text
// keeps updating; the held changes are applied once, when the hold ends or on "Update order".

import type { App } from "../store/state.ts";
import "./stations.css";
import { h, setText } from "./dom.ts";
import { createDetailList } from "./stationDetail.ts";
import {
  ariaText,
  buildItems,
  detailRows,
  filterItems,
  latestPacket,
  rowText,
  SORT_LABELS,
  sortItems,
  type SortKey,
  type StationItem,
} from "./stationList.ts";
import { isOrderHeld, orderPending, POINTER_RELEASE_HOLD_MS } from "./stationOrder.ts";
import type { View } from "./view.ts";

interface RowEls {
  li: HTMLLIElement;
  main: HTMLButtonElement;
  call: HTMLElement;
  objTag: HTMLElement;
  own: HTMLElement;
  age: HTMLElement;
  dist: HTMLElement;
  brg: HTMLElement;
  count: HTMLElement;
  lvl: HTMLElement;
  sym: HTMLElement;
  detail: HTMLElement;
  detailList: ReturnType<typeof createDetailList>;
}

export function createStationsView(app: App): View {
  let sort: SortKey = "recent";
  let filter = "";
  /** The station whose details are open (kept across renders). */
  let selected: string | undefined;
  const rows = new Map<string, RowEls>();
  let pointerDown = false;
  let focusByPointer = false;
  let pointerReleasedAt: number | undefined;
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;

  const filterInput = h("input", {
    id: "st-filter",
    attrs: {
      type: "search",
      placeholder: "e.g. Q1AAA",
      autocomplete: "off",
      autocapitalize: "characters",
      spellcheck: "false",
      enterkeyhint: "search",
    },
    on: {
      input: () => {
        filter = filterInput.value;
        apply(true);
      },
    },
  });
  const sortSelect = h(
    "select",
    {
      id: "st-sort",
      on: {
        change: () => {
          sort = sortSelect.value as SortKey;
          apply(true);
        },
      },
    },
    ...(Object.keys(SORT_LABELS) as SortKey[]).map((k) =>
      h("option", { text: SORT_LABELS[k], attrs: { value: k } }),
    ),
  );
  const controls = h(
    "div",
    { class: "st-controls" },
    h(
      "div",
      { class: "field" },
      h("label", { text: "Filter", attrs: { for: "st-filter" } }),
      filterInput,
    ),
    h(
      "div",
      { class: "field" },
      h("label", { text: "Sort", attrs: { for: "st-sort" } }),
      sortSelect,
    ),
  );
  const noFix = h("div", { class: "card note", hidden: true, attrs: { role: "status" } });
  const summary = h("p", { class: "muted st-summary" });
  const paused = h(
    "span",
    { class: "st-paused", hidden: true, attrs: { role: "status" } },
    h("span", { text: "New activity — order paused" }),
    h("button", {
      class: "btn",
      text: "Update order",
      attrs: { type: "button" },
      on: { click: () => apply(true) },
    }),
  );
  // One row for both, with a fixed minimum height: the pause notice appearing must not push the
  // list down (that would move the row under a finger that is already on it).
  const statusRow = h("div", { class: "st-status" }, summary, paused);
  const empty = h("p", { class: "muted", hidden: true });
  const list = h("ul", { class: "list st-list" });
  const el = h("section", { class: "view" }, controls, noFix, statusRow, empty, list);

  function makeRow(key: string, src: string): RowEls {
    const call = h("span", { class: "st-call mono", text: src });
    const objTag = h("span", { class: "st-obj", text: "OBJECT", hidden: true });
    const own = h("span", { class: "st-own", text: "THIS TRACKER", hidden: true });
    const age = h("span", { class: "st-age" });
    const dist = h("span");
    const brg = h("span");
    const count = h("span");
    const lvl = h("span");
    const sym = h("span", { class: "st-sym" });
    const main = h(
      "button",
      {
        class: "st-main",
        attrs: { type: "button", "aria-expanded": "false" },
        on: {
          click: () => {
            selected = selected === key ? undefined : key;
            // Not forced: opening a detail holds the order, closing it waits for the pointer hold.
            apply(false);
          },
        },
      },
      h("span", { class: "st-top" }, call, objTag, own, age),
      h("span", { class: "st-meta" }, dist, brg, count, lvl),
      sym,
    );
    const detailList = createDetailList();
    const detail = h("div", { class: "st-detail", hidden: true }, detailList.el);
    const li = h("li", { class: "list-item", attrs: { "data-src": key } }, main, detail);
    return { li, main, call, objTag, own, age, dist, brg, count, lvl, sym, detail, detailList };
  }

  function updateRow(r: RowEls, item: StationItem, now: number): void {
    const t = rowText(item, now);
    r.own.hidden = !item.own;
    r.objTag.hidden = !item.obj;
    setText(r.age, t.age);
    r.dist.hidden = item.own;
    r.brg.hidden = item.own || t.bearing === "";
    setText(r.dist, t.distance);
    setText(r.brg, t.bearing);
    setText(r.count, `×${t.count}`);
    setText(r.lvl, t.level);
    setText(r.sym, t.symbol);
    const label = ariaText(item, now);
    if (r.main.getAttribute("aria-label") !== label) r.main.setAttribute("aria-label", label);
    const open = selected === item.key;
    r.main.setAttribute("aria-expanded", String(open));
    r.detail.hidden = !open;
    if (open) {
      const latest = latestPacket(app.feed, item.src, item.obj);
      r.detailList.update(detailRows(item, latest, now, app.ownPosition()));
    }
  }

  /**
   * True while a row inside the list has focus. A tap also focuses the button it hit, and that
   * focus lingers after the finger is gone; it must not hold the order for ever, so a focus that
   * came from a pointer does not count (until a key is pressed in the list).
   */
  function focusInRow(): boolean {
    const a = document.activeElement;
    return a instanceof HTMLElement && list.contains(a) && !focusByPointer;
  }

  /**
   * `force`: the user just changed something (opened or closed a detail, filter, sort, "Update
   * order"), so the list is brought up to date now. Otherwise it is held while `isOrderHeld`.
   */
  function apply(force: boolean): void {
    const now = Date.now();
    const me = app.ownPosition();
    const all = buildItems(app.stations.values(), me);
    const shown = sortItems(filterItems(all, filter), sort);

    noFix.hidden = me !== undefined;
    setText(
      noFix,
      me === undefined
        ? "Waiting for a GPS fix: distance and bearing cannot be shown until this tracker knows where it is."
        : "",
    );
    const q = filter.trim();
    setText(
      summary,
      all.length === 0
        ? ""
        : q === ""
          ? `${all.length} station${all.length === 1 ? "" : "s"}`
          : `${shown.length} of ${all.length} stations`,
    );
    summary.hidden = all.length === 0;
    empty.hidden = shown.length > 0;
    setText(
      empty,
      all.length === 0
        ? "No stations heard yet. Stations show up here when the tracker receives their packets."
        : shown.length === 0
          ? `No station matches "${q}".`
          : "",
    );

    if (selected !== undefined && !app.stations.has(selected)) selected = undefined;
    const wanted = shown.map((i) => i.key);
    const held =
      !force &&
      isOrderHeld({
        detailOpen: selected !== undefined,
        focusInRow: focusInRow(),
        pointerDown,
        pointerReleasedAt,
        now,
      });

    if (held) {
      // Only what is already on screen is updated, in place. Stations that were never shown
      // (new ones) and a changed order wait for the end of the hold.
      for (const [src, r] of rows) {
        if (!app.stations.has(src)) {
          r.li.remove();
          rows.delete(src);
        }
      }
      for (const item of shown) {
        const r = rows.get(item.key);
        if (r) updateRow(r, item, now);
      }
      const onScreen = Array.from(list.children, (li) => (li as HTMLElement).dataset.src ?? "");
      paused.hidden = !orderPending(onScreen, wanted);
      return;
    }

    paused.hidden = true;
    // Drop rows of stations that are gone or filtered out, then put the rest in order.
    const keep = new Set(wanted);
    for (const [src, r] of rows) {
      if (keep.has(src)) continue;
      r.li.remove();
      if (!app.stations.has(src)) rows.delete(src);
    }
    const active = document.activeElement;
    const hadFocus = active instanceof HTMLElement && list.contains(active) ? active : undefined;
    let ref: Element | null = list.firstElementChild;
    for (const item of shown) {
      let r = rows.get(item.key);
      if (!r) {
        r = makeRow(item.key, item.src);
        rows.set(item.key, r);
      }
      updateRow(r, item, now);
      if (ref === r.li) ref = ref.nextElementSibling;
      else list.insertBefore(r.li, ref);
    }
    // Moving an element in the DOM drops its focus. Give it back.
    if (hadFocus && document.activeElement !== hadFocus && hadFocus.isConnected) {
      hadFocus.focus({ preventScroll: true });
    }
  }

  // ---- pointer tracking (for the order hold) ------------------------------------------------
  list.addEventListener("pointerdown", () => {
    pointerDown = true;
    focusByPointer = true;
    pointerReleasedAt = undefined;
    clearTimeout(releaseTimer);
  });
  function released(): void {
    if (!pointerDown) return;
    pointerDown = false;
    pointerReleasedAt = Date.now();
    clearTimeout(releaseTimer);
    // Sort once the click has had its chance (render() also runs once a second).
    releaseTimer = setTimeout(() => {
      if (el.isConnected) apply(false);
    }, POINTER_RELEASE_HOLD_MS + 20);
  }
  window.addEventListener("pointerup", released);
  window.addEventListener("pointercancel", released);
  list.addEventListener("keydown", () => {
    focusByPointer = false;
  });
  // Leaving the list ends the hold at once.
  list.addEventListener("focusout", () => {
    setTimeout(() => {
      if (!list.contains(document.activeElement)) focusByPointer = false;
      if (el.isConnected) apply(false);
    }, 0);
  });

  return { el, render: () => apply(false) };
}
