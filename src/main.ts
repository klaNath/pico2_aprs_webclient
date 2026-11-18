// Entry point: builds the header, the tab bar and the views, and drives rendering.
// Not connected: the tabs stay usable (read-only) while there is data to read; the connection
// card sits on top of the Status tab and every tab carries a "Not connected" banner.

import "./style.css";
import { App } from "./store/state.ts";
import { createConnectView } from "./ui/connectView.ts";
import { h } from "./ui/dom.ts";
import { createFeedView } from "./ui/feedView.ts";
import { createHeader } from "./ui/header.ts";
import { createRadarView } from "./ui/radarView.ts";
import { createSettingsView } from "./ui/settingsView.ts";
import {
  hasLastKnownData,
  shellLayout,
  shouldWarnOnUnload,
  tabForKey,
  tabFromHash,
} from "./ui/shell.ts";
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
const TAB_IDS: readonly TabId[] = TABS.map((t) => t.id);

const views = new Map<TabId, View>(TABS.map((t) => [t.id, t.make(app)]));
const header = createHeader(app);
const connect = createConnectView(app);

// ---- chrome: tabs, banners ---------------------------------------------------------------

let current: TabId = tabFromHash(location.hash, TAB_IDS) ?? "status";
const tabButtons = new Map<TabId, HTMLButtonElement>();
const PANEL_ID = "tabpanel";
const main = h("main", { class: "app-main", id: PANEL_ID, attrs: { role: "tabpanel" } });
const nav = h("nav", { class: "tabs", attrs: { role: "tablist", "aria-label": "Screens" } });
for (const t of TABS) {
  const b = h("button", {
    class: "tab",
    text: t.label,
    id: `tab-${t.id}`,
    attrs: { type: "button", role: "tab", "aria-controls": PANEL_ID },
    on: {
      click: () => select(t.id),
      keydown: (ev) => {
        const to = tabForKey(TAB_IDS, t.id, ev.key);
        if (to === undefined) return;
        ev.preventDefault();
        select(to);
        tabButtons.get(to)?.focus();
      },
    },
  });
  tabButtons.set(t.id, b);
  nav.append(b);
}

const offline = h(
  "div",
  { class: "banner", attrs: { role: "status" } },
  h("span", { text: "Not connected. Showing the last known data." }),
);
const reconnect = h("button", {
  class: "btn btn-small",
  text: "Connect",
  attrs: { type: "button" },
  on: { click: () => select("status") },
});
offline.append(reconnect);
const failed = h("div", {
  class: "banner banner-problem",
  text: "This screen failed to update. The other screens still work.",
  attrs: { role: "alert" },
});
const notices = h("div", { class: "shell-notices" }, offline, failed);

function applyTheme(): void {
  const theme = app.prefs.get("theme");
  if (theme === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

/** Switch tab. User actions add a history entry so that the Android back button returns here. */
function select(id: TabId, push = true): void {
  if (id !== current && push) {
    try {
      history.pushState({ tab: id }, "", `${location.pathname}${location.search}#${id}`);
    } catch {
      // History can be unavailable (sandboxed frame); the tabs still work.
    }
  }
  current = id;
  renderAll();
}

window.addEventListener("popstate", () => {
  select(tabFromHash(location.hash, TAB_IDS) ?? "status", false);
});

// ---- rendering ---------------------------------------------------------------------------

const loggedErrors = new Map<string, string>();
/** Runs one view's render; a failure is logged (once per message) and reported, never thrown. */
function safeRender(name: string, fn: () => void): boolean {
  try {
    fn();
    loggedErrors.delete(name);
    return true;
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    if (loggedErrors.get(name) !== msg) {
      loggedErrors.set(name, msg);
      console.error(`render of "${name}" failed`, e);
    }
    return false;
  }
}

let shownTab: TabId | undefined;
function renderAll(): void {
  const layout = shellLayout(app.state, hasLastKnownData(app));
  nav.hidden = layout.fullConnect;

  // Tabs first: they must follow the selection even if a view throws below.
  for (const [id, b] of tabButtons) {
    const on = id === current;
    b.setAttribute("aria-selected", String(on));
    b.tabIndex = on ? 0 : -1;
    b.classList.toggle("tab-active", on);
  }
  main.setAttribute("aria-labelledby", `tab-${current}`);
  if (!layout.fullConnect && shownTab !== current) {
    shownTab = current;
    tabButtons.get(current)?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }

  let ok = safeRender("header", () => header.render());
  const parts: HTMLElement[] = [notices];
  if (layout.fullConnect) {
    ok = safeRender("connect", () => connect.render()) && ok;
    parts.push(connect.el);
  } else {
    if (layout.connectCard && current === "status") {
      ok = safeRender("connect", () => connect.render()) && ok;
      parts.push(connect.el);
    }
    const view = views.get(current);
    if (view) {
      ok = safeRender(current, () => view.render()) && ok;
      parts.push(view.el);
    }
  }
  const same =
    main.children.length === parts.length && parts.every((p, i) => main.children[i] === p);
  if (!same) main.replaceChildren(...parts);

  offline.hidden = !layout.offlineBanner;
  reconnect.hidden = current === "status";
  failed.hidden = ok;
  notices.hidden = offline.hidden && failed.hidden;
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

// A reload or a pull-to-refresh would drop the connection and the feed held in memory.
window.addEventListener("beforeunload", (ev) => {
  if (!shouldWarnOnUnload(app.state, app.feed.length)) return;
  ev.preventDefault();
  ev.returnValue = "";
});

applyTheme();
try {
  history.replaceState({ tab: current }, "", `${location.pathname}${location.search}#${current}`);
} catch {
  // see select()
}
document.querySelector<HTMLDivElement>("#app")!.append(header.el, nav, main);
renderAll();

const params = new URLSearchParams(location.search);
// ?debug=1 exposes the whole app on window for browser checks. Only in the dev server or in a
// build made with VITE_ENABLE_DEBUG=1; a normal build never exposes it.
if (
  (import.meta.env.DEV || import.meta.env.VITE_ENABLE_DEBUG === "1") &&
  params.get("debug") === "1"
) {
  (window as unknown as { __app: App }).__app = app;
}
// ?mock=1 starts the Demo; ?fast=1 makes the demo device chatty.
if (params.get("mock") === "1") void app.connectMock({ fast: params.get("fast") === "1" });
// Trackers this site was allowed to use before can be reconnected without the chooser.
else void app.loadKnownDevices();
