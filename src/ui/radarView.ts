// The Radar tab: an offline SVG radar centred on this tracker, north up. Stations are placed by
// distance and bearing (linear or logarithmic scale). The SVG is built once; render() only
// changes what moved. The Stations tab has the same information as text.
//
// Taps: one pointer handler for the whole SVG picks the station nearest to the tap (within about
// 24 screen pixels). Per-station hit areas would overlap when there are many stations. Keyboard:
// the nearest few stations (and the selected one) are Tab stops; the rest are pointer-only.

import type { SymbolCategory } from "../aprs/symbols.ts";
import type { App } from "../store/state.ts";
import "./radar.css";
import { h, setText } from "./dom.ts";
import {
  CENTER,
  COMPASS,
  COMPASS_R,
  fallbackBearing,
  formatRingLabel,
  MAX_TAB_STOPS,
  MIN_HIT_PX,
  MIN_LABEL_PX,
  nearestStation,
  OUTER_R,
  OWN_MARK_R,
  placeStation,
  polarToXY,
  radiusFraction,
  RANGE_OPTIONS_KM,
  ringValues,
  shortLabel,
  tabStops,
  unitsForPx,
  VIEW_SIZE,
  type HitPoint,
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
  x: number;
  y: number;
  text: SVGTextElement;
  title: SVGTitleElement;
  /** The text drawn next to the dot (cut short; the full name is in the title). */
  shown: string;
  left: boolean;
  category: SymbolCategory;
  label: string;
  /** True while the dot is a Tab stop (a button for the keyboard and screen readers). */
  stop: boolean | undefined;
}

/** Roughly how wide a label is, in viewBox units, at the current font size. */
function labelWidth(text: string, unitsPerPx: number): number {
  return text.length * 0.62 * MIN_LABEL_PX * unitsPerPx;
}

export function createRadarView(app: App): View {
  /** The station whose details are open. Survives render(); cleared only when it disappears. */
  let selected: string | undefined;
  const dots = new Map<string, Dot>();
  let ringKey = "";
  /** viewBox units per screen pixel (changes with the width of the screen). Fonts follow it. */
  let unitsPerPx = 1;
  let press: { id: number; x: number; y: number } | undefined;

  // ---- SVG skeleton (built once) ---------------------------------------------------------
  const ringsG = s("g");
  const dotsG = s("g");
  // Above the dots: a ring label is the scale, and a dot on top of it would hide it.
  const ringLabelsG = s("g");
  const svg = s(
    "svg",
    {
      class: "radar",
      viewBox: `0 0 ${VIEW_SIZE} ${VIEW_SIZE}`,
      // A group, not an image: the stations inside are buttons.
      role: "group",
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
      const p = polarToXY(1, c.bearing, CENTER, CENTER, COMPASS_R);
      return s("text", { class: "radar-compass", x: p.x, y: p.y }, c.label);
    }),
    dotsG,
    ringLabelsG,
    s("circle", { class: "radar-own-ring", cx: CENTER, cy: CENTER, r: OWN_MARK_R }),
    s("circle", { class: "radar-own-dot", cx: CENTER, cy: CENTER, r: 1.8 }),
  );
  function makeDot(item: StationItem): Dot {
    const mark = s("path", { class: `radar-mark cat-${item.category}`, d: SHAPES[item.category] });
    const label = s("text", { class: "radar-lbl", x: 9, y: 0 }, item.src);
    const title = s("title");
    const g = s(
      "g",
      { class: "radar-st", "data-src": item.src },
      title,
      s("circle", { class: "radar-sel", r: 10 }),
      mark,
      label,
    );
    g.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        toggle(item.src);
      }
    });
    dotsG.append(g);
    return {
      g,
      transform: "",
      x: CENTER,
      y: CENTER,
      text: label,
      title,
      shown: item.src,
      left: false,
      category: item.category,
      label: "",
      stop: undefined,
    };
  }

  function toggle(src: string): void {
    selected = selected === src ? undefined : src;
    render();
  }

  // Taps. pointerdown/pointerup instead of click: the same code serves mouse, touch and pen, and
  // a drag (scrolling the page) is told apart from a tap.
  svg.addEventListener("pointerdown", (ev) => {
    press =
      ev.isPrimary && (ev.pointerType !== "mouse" || ev.button === 0)
        ? {
            id: ev.pointerId,
            x: ev.clientX,
            y: ev.clientY,
          }
        : undefined;
  });
  svg.addEventListener("pointercancel", () => {
    press = undefined;
  });
  svg.addEventListener("pointerup", (ev) => {
    const p = press;
    press = undefined;
    if (!p || p.id !== ev.pointerId) return;
    if (Math.hypot(ev.clientX - p.x, ev.clientY - p.y) > 10) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0) return;
    const x = ((ev.clientX - rect.left) * VIEW_SIZE) / rect.width;
    const y = ((ev.clientY - rect.top) * VIEW_SIZE) / rect.height;
    const points: HitPoint[] = [];
    for (const [id, d] of dots) points.push({ id, x: d.x, y: d.y });
    const hit = nearestStation(points, x, y, unitsForPx(MIN_HIT_PX, rect.width));
    if (hit) toggle(hit.id);
  });

  // Fonts are sized in screen pixels: keep the viewBox-units-per-pixel factor in a CSS variable.
  function measure(): void {
    const w = svg.getBoundingClientRect().width;
    if (w <= 0) return;
    const u = unitsForPx(1, w);
    if (Math.abs(u - unitsPerPx) < 0.001) return;
    unitsPerPx = u;
    svg.style.setProperty("--u", u.toFixed(4));
    render();
  }
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(measure).observe(svg);

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
    ringLabelsG.replaceChildren();
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
      );
      ringLabelsG.append(
        s(
          "text",
          {
            class: "radar-text radar-ring-label",
            x: CENTER + 3,
            y: CENTER - OUTER_R * f - 2,
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
      const stops = tabStops(
        [...placeable]
          .sort((a, b) => (a.distanceM ?? 0) - (b.distanceM ?? 0) || (a.src < b.src ? -1 : 1))
          .map((i) => i.src),
        selected,
      );
      const live = new Set<string>();
      for (const item of placeable) {
        live.add(item.src);
        let d = dots.get(item.src);
        if (!d) {
          d = makeDot(item);
          dots.set(item.src, d);
        }
        // A station at your position has no bearing: it gets a made-up direction, off the centre.
        const p = placeStation(
          item.distanceM ?? 0,
          item.bearing ?? fallbackBearing(item.src),
          maxM,
          scale,
        );
        d.x = p.x;
        d.y = p.y;
        const tf = `translate(${p.x.toFixed(2)} ${p.y.toFixed(2)})`;
        if (tf !== d.transform) {
          d.transform = tf;
          d.g.setAttribute("transform", tf);
        }
        // The label goes on the side that has room inside the viewBox.
        const shown = shortLabel(item.src);
        if (shown !== d.shown) {
          d.shown = shown;
          setText(d.text, shown);
        }
        const w = labelWidth(shown, unitsPerPx) + 9;
        const roomRight = VIEW_SIZE - 2 - p.x;
        const left = roomRight < w && p.x - 2 > roomRight;
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
          setText(d.title, label);
        }
        const stop = stops.has(item.src);
        if (stop !== d.stop || (stop && d.g.getAttribute("aria-label") !== label)) {
          d.stop = stop;
          if (stop) {
            d.g.setAttribute("tabindex", "0");
            d.g.setAttribute("role", "button");
            d.g.setAttribute("aria-label", label);
            d.g.removeAttribute("aria-hidden");
          } else {
            // Pointer only. Hidden from the accessibility tree: a button nobody can reach with
            // the keyboard would be a trap. The Stations tab lists every station.
            d.g.removeAttribute("tabindex");
            d.g.removeAttribute("role");
            d.g.removeAttribute("aria-label");
            d.g.setAttribute("aria-hidden", "true");
          }
        }
        const isSel = item.src === selected;
        setClass(d, "out", p.outOfRange);
        setClass(d, "is-selected", isSel);
        if (stop) d.g.setAttribute("aria-pressed", String(isSel));
        else d.g.removeAttribute("aria-pressed");
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
          `${outCount} station${outCount === 1 ? "" : "s"} out of range (faded, outside the ring)`,
        );
      }
      if (noPos > 0) parts.push(`${noPos} without a position`);
      if (placeable.length > MAX_TAB_STOPS) {
        parts.push("Many stations: tap a dot, or use the Stations tab to browse with the keyboard");
      }
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
