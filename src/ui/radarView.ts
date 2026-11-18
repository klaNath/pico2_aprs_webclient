// The Radar tab: an offline SVG radar centred on this tracker, north up. Stations are placed by
// distance and bearing (linear or logarithmic scale). The SVG is built once; render() only
// changes what moved. The Stations tab has the same information as text.

import type { SymbolCategory } from "../aprs/symbols.ts";
import type { App } from "../store/state.ts";
import "./radar.css";
import { h, setText } from "./dom.ts";
import {
  CENTER,
  COMPASS,
  formatRingLabel,
  OUTER_R,
  placeStation,
  polarToXY,
  radiusFraction,
  RANGE_OPTIONS_KM,
  ringValues,
  VIEW_SIZE,
} from "./radarGeometry.ts";
import { createDetailList } from "./stationDetail.ts";
import { ariaText, buildItems, detailRows, latestPacket, type StationItem } from "./stationList.ts";
import type { View } from "./view.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Labels are drawn next to every dot only while there are this few; a tap shows one label. */
export const MAX_LABELLED = 8;

type Attrs = Record<string, string | number>;

function s<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string)[]
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  el.append(...children);
  return el;
}

const CATEGORY_NAMES: Record<SymbolCategory, string> = {
  vehicle: "Vehicle",
  person: "Person",
  fixed: "Fixed station",
  digi: "Digipeater / gateway",
  weather: "Weather",
  other: "Other",
};

/** One mark per category, drawn around (0, 0). The shape differs so color is never the only cue. */
const SHAPES: Record<SymbolCategory, string> = {
  vehicle: "M0 -6.5L6 4.5L-6 4.5Z",
  person: "M-5 0a5 5 0 1 0 10 0a5 5 0 1 0 -10 0Z",
  fixed: "M-4.5 -4.5h9v9h-9Z",
  digi: "M0 -6.8L6.8 0L0 6.8L-6.8 0Z",
  weather: "M-3.2 -5.5L3.2 -5.5L6.4 0L3.2 5.5L-3.2 5.5L-6.4 0Z",
  other: "M-4.5 -4.5L4.5 4.5M-4.5 4.5L4.5 -4.5",
};

const CATEGORIES = Object.keys(SHAPES) as SymbolCategory[];

interface Dot {
  g: SVGGElement;
  transform: string;
  text: SVGTextElement;
  left: boolean;
  category: SymbolCategory;
  label: string;
}

export function createRadarView(app: App): View {
  /** The station whose details are open. Survives render(); cleared only when it disappears. */
  let selected: string | undefined;
  const dots = new Map<string, Dot>();
  let ringKey = "";

  // ---- SVG skeleton (built once) ---------------------------------------------------------
  const ringsG = s("g");
  const dotsG = s("g");
  const svg = s(
    "svg",
    {
      class: "radar",
      viewBox: `0 0 ${VIEW_SIZE} ${VIEW_SIZE}`,
      role: "img",
      "aria-label": "Radar",
    },
    s("circle", { class: "radar-disc", cx: CENTER, cy: CENTER, r: OUTER_R }),
    s("line", {
      class: "radar-axis",
      x1: CENTER,
      y1: CENTER - OUTER_R,
      x2: CENTER,
      y2: CENTER + OUTER_R,
    }),
    s("line", {
      class: "radar-axis",
      x1: CENTER - OUTER_R,
      y1: CENTER,
      x2: CENTER + OUTER_R,
      y2: CENTER,
    }),
    ringsG,
    ...COMPASS.map((c) => {
      const p = polarToXY(1, c.bearing, CENTER, CENTER, OUTER_R + 11);
      return s("text", { class: "radar-compass", x: p.x, y: p.y }, c.label);
    }),
    dotsG,
    s("circle", { class: "radar-own-ring", cx: CENTER, cy: CENTER, r: 4.5 }),
    s("circle", { class: "radar-own-dot", cx: CENTER, cy: CENTER, r: 1.8 }),
  );
  function makeDot(item: StationItem): Dot {
    const mark = s("path", { class: `radar-mark cat-${item.category}`, d: SHAPES[item.category] });
    const label = s("text", { class: "radar-lbl", x: 9, y: 3 }, item.src);
    const g = s(
      "g",
      { class: "radar-st", tabindex: 0, role: "button", "data-src": item.src },
      s("circle", { class: "radar-sel", r: 10 }),
      mark,
      label,
      // A big transparent target so a fingertip can hit a small dot.
      s("circle", { class: "radar-hit", r: 13 }),
    );
    const choose = (): void => {
      selected = selected === item.src ? undefined : item.src;
      render();
    };
    g.addEventListener("click", choose);
    g.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        choose();
      }
    });
    dotsG.append(g);
    return { g, transform: "", text: label, left: false, category: item.category, label: "" };
  }

  // ---- the rest of the screen -------------------------------------------------------------
  const wait = h("p", { class: "muted radar-wait", hidden: true, attrs: { role: "status" } });
  const note = h("p", { class: "muted radar-note", attrs: { "aria-live": "polite" } });
  const card = h("div", { class: "card radar-card" }, wait, svg, note);

  const rangeButtons = RANGE_OPTIONS_KM.map((km) =>
    h("button", {
      class: "btn",
      text: `${km} km`,
      attrs: { type: "button", "aria-pressed": "false" },
      on: { click: () => app.prefs.set("radarRangeKm", km) },
    }),
  );
  const scaleButtons = (
    [
      ["log", "Log"],
      ["linear", "Linear"],
    ] as const
  ).map(([value, text]) => ({
    value,
    el: h("button", {
      class: "btn",
      text,
      attrs: { type: "button", "aria-pressed": "false" },
      on: { click: () => app.prefs.set("radarScale", value) },
    }),
  }));
  const controls = h(
    "div",
    { class: "card radar-controls" },
    h(
      "div",
      { class: "radar-group", attrs: { role: "group", "aria-label": "Range" } },
      h("span", { class: "radar-group-label", text: "Range" }),
      ...rangeButtons,
    ),
    h(
      "div",
      { class: "radar-group radar-group-2", attrs: { role: "group", "aria-label": "Scale" } },
      h("span", { class: "radar-group-label", text: "Scale" }),
      ...scaleButtons.map((b) => b.el),
    ),
  );

  const legend = h(
    "ul",
    { class: "card radar-legend", attrs: { "aria-label": "Legend" } },
    ...CATEGORIES.map((c) => {
      const icon = s(
        "svg",
        { viewBox: "-9 -9 18 18", "aria-hidden": "true" },
        s("path", { class: `radar-mark cat-${c}`, d: SHAPES[c] }),
      );
      return h("li", {}, icon, CATEGORY_NAMES[c]);
    }),
  );

  const detailTitle = h("h2");
  const detailList = createDetailList();
  const detail = h(
    "div",
    { class: "card radar-detail", hidden: true },
    h(
      "div",
      { class: "radar-detail-head" },
      detailTitle,
      h("button", {
        class: "btn",
        text: "Close",
        attrs: { type: "button" },
        on: {
          click: () => {
            selected = undefined;
            render();
          },
        },
      }),
    ),
    detailList.el,
  );

  const el = h("section", { class: "view" }, card, detail, controls, legend);

  // ---- rendering --------------------------------------------------------------------------

  function syncRings(maxM: number, scale: "log" | "linear"): void {
    const key = `${scale}:${maxM}`;
    if (key === ringKey) return;
    ringKey = key;
    ringsG.replaceChildren();
    const rings = ringValues(maxM, scale);
    rings.forEach((m, i) => {
      const f = radiusFraction(m, maxM, scale);
      const outer = i === rings.length - 1;
      ringsG.append(
        s("circle", {
          class: outer ? "radar-ring radar-ring-outer" : "radar-ring",
          cx: CENTER,
          cy: CENTER,
          r: OUTER_R * f,
        }),
        s(
          "text",
          {
            class: "radar-text radar-ring-label",
            x: CENTER + 2.5,
            y: CENTER - OUTER_R * f - 1.5,
          },
          formatRingLabel(m),
        ),
      );
    });
  }

  function setClass(d: Dot, name: string, on: boolean): void {
    if (d.g.classList.contains(name) !== on) d.g.classList.toggle(name, on);
  }

  function render(): void {
    const me = app.ownPosition();
    const maxM = app.prefs.get("radarRangeKm") * 1000;
    const scale = app.prefs.get("radarScale");

    // Controls.
    const km = app.prefs.get("radarRangeKm");
    RANGE_OPTIONS_KM.forEach((v, i) =>
      rangeButtons[i]?.setAttribute("aria-pressed", String(v === km)),
    );
    for (const b of scaleButtons) b.el.setAttribute("aria-pressed", String(b.value === scale));

    const all = buildItems(app.stations.values(), me);
    const known = new Set(all.map((i) => i.src));
    if (selected !== undefined && !known.has(selected)) selected = undefined;

    // No fix: nothing to centre the radar on.
    wait.hidden = me !== undefined;
    svg.style.display = me === undefined ? "none" : "";
    legend.hidden = me === undefined;
    setText(
      wait,
      me === undefined
        ? "Waiting for GPS fix. The radar is centred on this tracker, so it needs to know its own position."
        : "",
    );

    const placeable = me === undefined ? [] : all.filter((i) => i.distanceM !== undefined);
    if (me !== undefined) {
      syncRings(maxM, scale);
      const live = new Set<string>();
      for (const item of placeable) {
        live.add(item.src);
        let d = dots.get(item.src);
        if (!d) {
          d = makeDot(item);
          dots.set(item.src, d);
        }
        const p = placeStation(item.distanceM ?? 0, item.bearing ?? 0, maxM, scale);
        const tf = `translate(${p.x.toFixed(2)} ${p.y.toFixed(2)})`;
        if (tf !== d.transform) {
          d.transform = tf;
          d.g.setAttribute("transform", tf);
        }
        // Keep the label inside the viewBox: dots on the right put it on their left.
        const left = p.x > CENTER + 45;
        if (left !== d.left) {
          d.left = left;
          d.text.setAttribute("x", left ? "-9" : "9");
          d.text.setAttribute("text-anchor", left ? "end" : "start");
        }
        if (item.category !== d.category) {
          d.category = item.category;
          d.g
            .querySelector(".radar-mark")
            ?.setAttribute("class", `radar-mark cat-${item.category}`);
        }
        const label = `${ariaText(item)}${p.outOfRange ? ", out of range" : ""}`;
        if (label !== d.label) {
          d.label = label;
          d.g.setAttribute("aria-label", label);
        }
        const isSel = item.src === selected;
        setClass(d, "out", p.outOfRange);
        setClass(d, "is-selected", isSel);
        d.g.setAttribute("aria-pressed", String(isSel));
      }
      for (const [src, d] of dots) {
        if (live.has(src)) continue;
        d.g.remove();
        dots.delete(src);
      }
      svg.classList.toggle("radar-labels", placeable.length <= MAX_LABELLED);
    }

    const outCount = placeable.filter((i) => (i.distanceM ?? 0) > maxM).length;
    const noPos = all.filter((i) => !i.own && i.pos === undefined).length;
    const parts: string[] = [];
    if (me !== undefined) {
      parts.push(
        `${placeable.length - outCount} station${placeable.length - outCount === 1 ? "" : "s"} in range`,
      );
      if (outCount > 0) {
        parts.push(
          `${outCount} station${outCount === 1 ? "" : "s"} out of range (shown faded on the edge)`,
        );
      }
      if (noPos > 0) parts.push(`${noPos} without a position`);
    }
    setText(note, parts.join(" · "));
    const aria =
      me === undefined
        ? "Radar, waiting for GPS fix"
        : `Radar centred on this tracker, north up, range ${formatRingLabel(maxM)}, ${placeable.length - outCount} stations in range${outCount > 0 ? `, ${outCount} out of range` : ""}. The Stations tab lists the same information.`;
    if (svg.getAttribute("aria-label") !== aria) svg.setAttribute("aria-label", aria);

    // Details of the selected station.
    const sel = selected === undefined ? undefined : all.find((i) => i.src === selected);
    detail.hidden = sel === undefined;
    if (sel) {
      setText(detailTitle, sel.src);
      const latest = latestPacket(app.feed, sel.src);
      const rows = detailRows(sel, latest, Date.now(), me);
      if (sel.distanceM !== undefined && sel.distanceM > maxM) {
        rows.splice(3, 0, { label: "Range", value: "Out of range" });
      }
      detailList.update(rows);
    }
  }

  return { el, render };
}
