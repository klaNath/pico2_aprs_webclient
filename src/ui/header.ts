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
  /** CSS modifier: tx-ready, tx-dry, tx-unknown. */
  cls: "tx-ready" | "tx-dry" | "tx-unknown";
  label: string;
  detail: string;
}

/** What the TX badge shows. Pure, so it can be tested. */
export function txBadge(
  state: ClientState,
  stale: boolean,
  status: { tx_ready?: boolean; tx_refuse?: string; sw?: boolean } | undefined,
): TxBadge {
  if (state !== "ready" || status === undefined) {
    return { cls: "tx-unknown", label: "TX ?", detail: "Not connected" };
  }
  if (stale) {
    return { cls: "tx-unknown", label: "TX ?", detail: "No recent status from the device" };
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
  const badge = h("span", { class: "tx-badge", attrs: { role: "status", "aria-live": "polite" } });
  const detail = h("div", { class: "tx-detail" });
  const el = h(
    "header",
    { class: "app-header" },
    h("div", { class: "app-header-row" }, title, conn, badge),
    detail,
  );

  return {
    el,
    render(): void {
      const st = app.state;
      const b = txBadge(st, app.statusStale, app.status);
      badge.className = `tx-badge ${b.cls}`;
      setText(badge, b.label);
      setText(detail, b.detail);
      const call = app.status?.call;
      setText(conn, st === "ready" && call ? `${STATE_LABEL[st]} · ${call}` : STATE_LABEL[st]);
      conn.className = `conn conn-${st}`;
    },
  };
}
