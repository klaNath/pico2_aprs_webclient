// The always-visible header: connection state and the TX badge.
// CLAUDE.md: `tx_ready` must always be visible. When it cannot be trusted (not connected, or no
// recent status) the badge says so instead of showing an old "ready".

import type { ClientState } from "../client/deviceClient.ts";
import type { App } from "../store/state.ts";
import { h, setText } from "./dom.ts";
import type { View } from "./view.ts";

const STATE_LABEL: Record<ClientState, string> = {
  disconnected: "Disconnected",
  connecting: "Connecting…",
  handshaking: "Starting…",
  ready: "Connected",
  proto_mismatch: "Incompatible",
  error: "Error",
};

export interface TxBadge {
  /** CSS modifier: tx-ready, tx-dry, tx-unknown, tx-sim (Demo: never looks like a real ready). */
  cls: "tx-ready" | "tx-dry" | "tx-unknown" | "tx-sim";
  label: string;
  detail: string;
}

/**
 * What the TX badge shows. Pure, so it can be tested.
 * Order matters: not connected / stale / unreported always win ("TX ?"), then Demo, then the
 * device's own answer. `mock` is the Demo (simulated device): it must never look like a real
 * "TX READY".
 */
export function txBadge(
  state: ClientState,
  stale: boolean,
  status: { tx_ready?: boolean; tx_refuse?: string; sw?: boolean } | undefined,
  mock = false,
): TxBadge {
  if (state !== "ready" || status === undefined) {
    return { cls: "tx-unknown", label: "TX ?", detail: "Not connected" };
  }
  if (stale) {
    return { cls: "tx-unknown", label: "TX ?", detail: "No recent status from the device" };
  }
  if (mock) {
    return {
      cls: "tx-sim",
      label: "SIMULATED",
      detail: "Nothing is sent on the air",
    };
  }
  // A status without a boolean tx_ready says nothing about transmitting: do not call it a dry run.
  if (typeof status.tx_ready !== "boolean") {
    return {
      cls: "tx-unknown",
      label: "TX ?",
      detail: "The device did not report whether it will transmit",
    };
  }
  if (status.tx_ready === true) {
    return { cls: "tx-ready", label: "TX READY", detail: "The next beacon goes on the air" };
  }
  const why =
    status.tx_refuse ??
    (status.sw === false ? "Beacon switch is off" : "Transmit conditions are not met");
  return { cls: "tx-dry", label: "TX OFF", detail: `${why} (beacons are a dry run)` };
}

export function createHeader(app: App): View {
  const title = h("h1", { class: "app-title", text: "pico2 APRS" });
  const conn = h("span", { class: "conn" });
  const demo = h("span", {
    class: "demo-badge",
    text: "DEMO",
    title: "Simulated device. Nothing is sent on the air",
  });
  const badge = h("span", { class: "tx-badge", attrs: { role: "status", "aria-live": "polite" } });
  const detail = h("div", { class: "tx-detail" });
  const el = h(
    "header",
    { class: "app-header" },
    h("div", { class: "app-header-row" }, title, conn, demo, badge),
    detail,
  );

  return {
    el,
    render(): void {
      const st = app.state;
      const b = txBadge(st, app.statusStale, app.status, app.mock);
      demo.hidden = !app.mock;
      badge.className = `tx-badge ${b.cls}`;
      setText(badge, b.label);
      setText(detail, b.detail);
      const call = app.status?.call;
      const label = app.reconnect && st !== "ready" ? "Reconnecting…" : STATE_LABEL[st];
      setText(conn, st === "ready" && call ? `${label} · ${call}` : label);
      conn.className = `conn conn-${st}`;
    },
  };
}
