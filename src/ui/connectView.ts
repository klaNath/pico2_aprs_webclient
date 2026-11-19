// The connection card / screen. Shown full-page before anything has been connected, and as a
// card on top of the Status tab while the link is down but the tabs still have data to read.
// Pairing guidance (§4, provisional until U3 is confirmed in Chrome): Android may show a pairing
// dialog on the first connection, and the unit's LCD shows a 6-digit passkey.

import type { ClientState } from "../client/deviceClient.ts";
import { PROTO_VERSION } from "../protocol/types.ts";
import { RECONNECT_MAX_ATTEMPTS, type App } from "../store/state.ts";
import { h, setChildren, setText } from "./dom.ts";
import { hasLastKnownData } from "./shell.ts";
import type { View } from "./view.ts";

/** The explanation for a protocol mismatch (§6.1). Needs the device's `hello.proto`, if known. */
export function protoMismatchText(deviceProto: unknown): string {
  const theirs = typeof deviceProto === "number" ? `version ${deviceProto}` : "a different version";
  return `This tracker speaks protocol ${theirs}; this app supports ${PROTO_VERSION}. Update the app.`;
}

/**
 * The one message to show above the buttons. A protocol mismatch always gets its own text (the
 * app's `notice` is empty then); otherwise the app's notice; otherwise why the link dropped.
 */
export function connectMessage(info: {
  state: ClientState;
  notice: string | undefined;
  deviceProto: unknown;
  disconnectReason: string | undefined;
}): string | undefined {
  if (info.state === "proto_mismatch") return protoMismatchText(info.deviceProto);
  if (info.notice) return info.notice;
  if (info.disconnectReason) return `Disconnected: ${info.disconnectReason}`;
  return undefined;
}

/** Why Web Bluetooth is missing, when it is: the browser, or a page that is not HTTPS. */
export function webBluetoothHelp(hasBluetooth: boolean, isSecure: boolean): string | undefined {
  if (hasBluetooth) return undefined;
  return isSecure
    ? "Web Bluetooth is not available in this browser. Use Chrome on Android."
    : "Web Bluetooth is not available. This page is not on HTTPS (or localhost), which Web Bluetooth requires, and the browser may not support it either. Open the https:// address in Chrome on Android.";
}

/** The line about the automatic reconnect, or undefined when there is none. */
export function reconnectText(
  info: { attempt: number; at: number | undefined } | undefined,
  now: number,
  maxAttempts: number,
): string | undefined {
  if (!info) return undefined;
  const of = `attempt ${info.attempt} of ${maxAttempts}`;
  if (info.at === undefined) return `Link lost. Reconnecting… (${of})`;
  const s = Math.max(0, Math.ceil((info.at - now) / 1000));
  return `Link lost. Reconnecting in ${s} s (${of}).`;
}

export const PAIRING_HINT =
  "The first time, your phone may ask you to pair. On Android this can appear only as a notification (“Pairing request”): open it, then enter the 6-digit passkey shown on the tracker's LCD. Type it within 30 seconds of it appearing. If it goes out, or the connection drops after about a minute, connect again for a new passkey.";

/**
 * `demo` is set only when the page was opened with `?mock=1`: the Demo starts from the URL, never
 * from a button on a normal page. In that case a "Restart demo" button brings it back after a
 * disconnect without reloading.
 */
export function createConnectView(app: App, demo?: { fast: boolean }): View {
  const heading = h("h2");
  const intro = h("p", {
    class: "muted",
    text: "Control a pico2_aprs tracker over Bluetooth Low Energy. The app runs entirely in this browser; nothing is sent to a server.",
  });
  const btBtn = h("button", {
    class: "btn btn-primary",
    text: "Connect to device",
    attrs: { type: "button" },
    on: { click: () => void app.connectBluetooth() },
  });
  const demoBtn = h("button", {
    class: "btn",
    text: "Restart demo",
    attrs: { type: "button" },
    on: { click: () => void app.connectMock(demo) },
  });
  demoBtn.hidden = !demo;
  const cancelBtn = h("button", {
    class: "btn",
    text: "Cancel",
    attrs: { type: "button" },
    on: { click: () => void app.disconnect() },
  });
  const nowBtn = h("button", {
    class: "btn",
    text: "Reconnect now",
    attrs: { type: "button" },
    on: { click: () => app.reconnectNow() },
  });
  const reconnectLine = h("p", { class: "progress", attrs: { role: "status" } });
  const buttons = h("div", { class: "row" }, btBtn, demoBtn, nowBtn, cancelBtn);
  // Trackers allowed before: connect without the chooser (getDevices).
  const known = h("div", { class: "row known-devices" });
  let knownKey = "";
  const progress = h("p", { class: "progress", attrs: { role: "status" } });
  const pairing = h(
    "div",
    { class: "card note" },
    h("strong", { text: "Pairing" }),
    h("p", { text: PAIRING_HINT }),
    h("p", {
      class: "muted",
      text: "Later connections reuse the pairing and need no passkey.",
    }),
  );
  const problem = h("p", { class: "problem", attrs: { role: "alert" } });
  const noBt = h("p", { class: "muted" });
  const help = h(
    "details",
    { class: "card help" },
    h("summary", { text: "Trouble connecting?" }),
    h(
      "ul",
      {},
      h("li", {
        text: "The tracker accepts one connection at a time and stops advertising while connected. If another phone or app is connected to it, it will not be found. Disconnect that one first.",
      }),
      h("li", {
        text: "If pairing fails or the app cannot reconnect, delete (forget) the tracker in your phone's Bluetooth settings, then connect again and re-enter the passkey.",
      }),
      h("li", {
        text: "Web Bluetooth needs Chrome, and the page must be served over HTTPS (or be on localhost).",
      }),
    ),
  );
  const el = h(
    "section",
    { class: "view connect-view" },
    heading,
    intro,
    pairing,
    progress,
    reconnectLine,
    problem,
    known,
    buttons,
    noBt,
    help,
  );

  return {
    el,
    render(): void {
      const st = app.state;
      const busy = st === "connecting" || st === "handshaking";
      // With data from an earlier connection this is a card above the Status tab, not a screen.
      const compact = hasLastKnownData(app);
      el.classList.toggle("compact", compact);
      setText(heading, compact ? "Connection" : "Connect to your tracker");
      intro.hidden = compact;
      pairing.hidden = compact && !busy;
      const recon = reconnectText(app.reconnect, Date.now(), RECONNECT_MAX_ATTEMPTS);
      reconnectLine.hidden = !recon;
      setText(reconnectLine, recon ?? "");
      nowBtn.hidden = !app.reconnect || app.reconnect.at === undefined;
      btBtn.disabled = busy || !app.hasBluetooth;
      demoBtn.disabled = busy;
      cancelBtn.hidden = !busy && !app.reconnect;
      const key = app.knownDevices.map((d) => d.id).join("|");
      if (key !== knownKey) {
        knownKey = key;
        setChildren(
          known,
          ...app.knownDevices.map((d) =>
            h("button", {
              class: "btn",
              text: `Reconnect to ${d.name ?? "tracker"}`,
              attrs: { type: "button" },
              on: { click: () => void app.connectDevice(d.device) },
            }),
          ),
        );
      }
      known.hidden = busy || app.knownDevices.length === 0 || app.state === "ready";
      progress.hidden = !busy;
      // Chrome may delay pairing until the first write, which happens while "handshaking".
      setText(
        progress,
        st === "connecting"
          ? "Connecting…"
          : st === "handshaking"
            ? "Connected. Reading the tracker's state… If this takes a while, look for a “Pairing request” in your phone's notifications."
            : "",
      );
      const msg = connectMessage({
        state: st,
        notice: app.notice,
        deviceProto: app.client?.hello?.proto,
        disconnectReason: app.client?.lastDisconnectReason,
      });
      problem.hidden = !msg;
      setText(problem, msg ?? "");
      const hasBt = typeof navigator !== "undefined" && "bluetooth" in navigator;
      const isSecure = typeof window === "undefined" || window.isSecureContext !== false;
      const btHelp = webBluetoothHelp(hasBt, isSecure);
      btBtn.title = btHelp ? "Web Bluetooth is not available here" : "";
      noBt.hidden = !btHelp;
      setText(noBt, btHelp ?? "");
    },
  };
}
