// The Stations tab: every station the tracker has heard, with distance and bearing from this
// tracker, sorted and filtered. Tapping a row opens its details. The row elements are created
// once per station and updated in place (render() runs every second, so ages stay fresh).

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
import type { View } from "./view.ts";

interface RowEls {
  li: HTMLLIElement;
  main: HTMLButtonElement;
  call: HTMLElement;
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
        render();
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
          render();
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
  const empty = h("p", { class: "muted", hidden: true });
  const list = h("ul", { class: "list st-list" });
  const el = h("section", { class: "view" }, controls, noFix, summary, empty, list);

  function makeRow(src: string): RowEls {
    const call = h("span", { class: "st-call mono", text: src });
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
            selected = selected === src ? undefined : src;
            render();
          },
        },
      },
      h("span", { class: "st-top" }, call, own, age),
      h("span", { class: "st-meta" }, dist, brg, count, lvl),
      sym,
    );
    const detailList = createDetailList();
    const detail = h("div", { class: "st-detail", hidden: true }, detailList.el);
    const li = h("li", { class: "list-item" }, main, detail);
    return { li, main, call, own, age, dist, brg, count, lvl, sym, detail, detailList };
  }

  function updateRow(r: RowEls, item: StationItem, now: number): void {
    const t = rowText(item, now);
    r.own.hidden = !item.own;
    setText(r.age, t.age);
    r.dist.hidden = item.own;
    r.brg.hidden = item.own;
    setText(r.dist, t.distance);
    setText(r.brg, t.bearing);
    setText(r.count, `×${t.count}`);
    setText(r.lvl, t.level);
    setText(r.sym, t.symbol);
    const label = ariaText(item);
    if (r.main.getAttribute("aria-label") !== label) r.main.setAttribute("aria-label", label);
    const open = selected === item.src;
    r.main.setAttribute("aria-expanded", String(open));
    r.detail.hidden = !open;
    if (open) {
      const latest = latestPacket(app.feed, item.src);
      r.detailList.update(detailRows(item, latest, now, app.ownPosition()));
    }
  }

  function render(): void {
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

    // Drop rows of stations that are gone or filtered out, then put the rest in order.
    const wanted = new Set(shown.map((i) => i.src));
    for (const [src, r] of rows) {
      if (wanted.has(src)) continue;
      r.li.remove();
      if (!app.stations.has(src)) rows.delete(src);
    }
    if (selected !== undefined && !app.stations.has(selected)) selected = undefined;
    let ref: Element | null = list.firstElementChild;
    for (const item of shown) {
      let r = rows.get(item.src);
      if (!r) {
        r = makeRow(item.src);
        rows.set(item.src, r);
      }
      updateRow(r, item, now);
      if (ref === r.li) ref = ref.nextElementSibling;
      else list.insertBefore(r.li, ref);
    }
  }

  return { el, render };
}
