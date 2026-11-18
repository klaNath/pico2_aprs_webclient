// Entry point: builds the header, the tab bar and the views, and drives rendering.

import "./style.css";
import { App } from "./store/state.ts";
import { createConnectView, needsConnect } from "./ui/connectView.ts";
import { h } from "./ui/dom.ts";
import { createFeedView } from "./ui/feedView.ts";
import { createHeader } from "./ui/header.ts";
import { createRadarView } from "./ui/radarView.ts";
import { createSettingsView } from "./ui/settingsView.ts";
import { createStationsView } from "./ui/stationsView.ts";
import { createStatusView } from "./ui/statusView.ts";
import type { View } from "./ui/view.ts";

const app = new App();

const TABS = [
  { id: "status", label: "Status", make: createStatusView },
  { id: "feed", label: "Feed", make: createFeedView },
  { id: "stations", label: "Stations", make: createStationsView },
  { id: "radar", label: "Radar", make: createRadarView },
  { id: "settings", label: "Settings", make: createSettingsView },
] as const;
type TabId = (typeof TABS)[number]["id"];

const views = new Map<TabId, View>(TABS.map((t) => [t.id, t.make(app)]));
const header = createHeader(app);
const connect = createConnectView(app);

let current: TabId = "status";
const tabButtons = new Map<TabId, HTMLButtonElement>();
const main = h("main", { class: "app-main" });
const nav = h("nav", { class: "tabs", attrs: { role: "tablist" } });
for (const t of TABS) {
  const b = h("button", {
    class: "tab",
    text: t.label,
    attrs: { type: "button", role: "tab" },
    on: { click: () => select(t.id) },
  });
  tabButtons.set(t.id, b);
  nav.append(b);
}

function applyTheme(): void {
  const theme = app.prefs.get("theme");
  if (theme === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

function select(id: TabId): void {
  current = id;
  renderAll();
}

function renderAll(): void {
  header.render();
  const showConnect = needsConnect(app.state);
  nav.hidden = showConnect;
  const want = showConnect ? connect : views.get(current);
  if (want && main.firstElementChild !== want.el) main.replaceChildren(want.el);
  want?.render();
  for (const [id, b] of tabButtons) {
    b.setAttribute("aria-selected", String(id === current));
    b.classList.toggle("tab-active", id === current);
  }
}

let frame = 0;
function schedule(): void {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    renderAll();
  });
}

app.onChange(schedule);
app.prefs.onChange(() => {
  applyTheme();
  schedule();
});
// Ages ("2 min ago") and the beacon countdown change without any event.
setInterval(schedule, 1000);

applyTheme();
document.querySelector<HTMLDivElement>("#app")!.append(header.el, nav, main);
renderAll();

const params = new URLSearchParams(location.search);
// ?debug=1 exposes the app on window (for browser checks); ?fast=1 makes the demo device chatty.
if (params.get("debug") === "1") (window as unknown as { __app: App }).__app = app;
if (params.get("mock") === "1") void app.connectMock({ fast: params.get("fast") === "1" });
