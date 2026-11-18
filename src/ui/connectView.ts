// Shown instead of the tabs while there is no usable connection.
// Pairing guidance (§4, provisional until U3 is confirmed in Chrome): on the first connection
// Android shows a pairing dialog and the unit's LCD shows a 6-digit passkey.

import type { ClientState } from "../client/deviceClient.ts";
import type { App } from "../store/state.ts";
import { h, setText } from "./dom.ts";
import type { View } from "./view.ts";

/** Whether the connect screen (not the tabs) should be shown. */
export function needsConnect(state: ClientState): boolean {
  return state !== "ready";
}

export function createConnectView(app: App): View {
  const heading = h("h2", { text: "Connect to your tracker" });
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
    text: "Demo (simulated device)",
    attrs: { type: "button" },
    on: { click: () => void app.connectMock() },
  });
  const cancelBtn = h("button", {
    class: "btn",
    text: "Cancel",
    attrs: { type: "button" },
    on: { click: () => void app.disconnect() },
  });
  const buttons = h("div", { class: "row" }, btBtn, demoBtn, cancelBtn);
  const progress = h("p", { class: "progress" });
  const pairing = h(
    "div",
    { class: "card note" },
    h("strong", { text: "First time?" }),
    h("p", {
      text: "Your phone will ask to pair. Enter the 6-digit passkey shown on the tracker's LCD. Later connections reuse the pairing and need no passkey.",
    }),
  );
  const problem = h("p", { class: "problem", attrs: { role: "alert" } });
  const noBt = h("p", { class: "muted" });
  const el = h(
    "section",
    { class: "view connect-view" },
    heading,
    intro,
    pairing,
    progress,
    problem,
    buttons,
    noBt,
  );

  return {
    el,
    render(): void {
      const st = app.state;
      const busy = st === "connecting" || st === "handshaking";
      btBtn.disabled = busy;
      demoBtn.disabled = busy;
      cancelBtn.hidden = !busy;
      progress.hidden = !busy;
      setText(
        progress,
        st === "connecting"
          ? "Connecting… If a pairing dialog appears, enter the passkey from the tracker's LCD."
          : st === "handshaking"
            ? "Connected. Reading the tracker's state…"
            : "",
      );
      let msg = app.notice;
      if (!msg && st === "proto_mismatch") {
        msg = "This tracker speaks a protocol version this app does not know. Update the app.";
      }
      if (!msg && app.client?.lastDisconnectReason) {
        msg = `Disconnected: ${app.client.lastDisconnectReason}`;
      }
      problem.hidden = !msg;
      setText(problem, msg ?? "");
      const hasBt = typeof navigator !== "undefined" && "bluetooth" in navigator;
      btBtn.title = hasBt ? "" : "Web Bluetooth is not available in this browser";
      noBt.hidden = hasBt;
      setText(
        noBt,
        "Web Bluetooth is not available in this browser. Use Chrome on Android. You can still try the demo.",
      );
    },
  };
}
