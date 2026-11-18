// The Status tab: what the tracker is doing right now (from `status`, §8.1).
// Values come from the last status and are shown as "—" when the status is stale.

import { formatLatLon, NO_VALUE } from "../aprs/geo.ts";
import type { App } from "../store/state.ts";
import { h, setChildren, setText } from "./dom.ts";
import { fmtAge } from "./format.ts";
import { txBadge } from "./header.ts";
import type { View } from "./view.ts";

/** Seconds until the next beacon, counted down from the last status. Pure for testing. */
export function nextBeaconIn(
  nextBeaconS: number | undefined,
  statusAt: number | undefined,
  now: number,
): number | undefined {
  if (nextBeaconS === undefined || statusAt === undefined) return undefined;
  return Math.max(0, Math.round(nextBeaconS - (now - statusAt) / 1000));
}

/** Level meter position 0..1 for lvl_db (about -60 dB quiet ... 0 dB full scale). */
export function levelFraction(db: number | undefined): number {
  if (db === undefined || !Number.isFinite(db)) return 0;
  return Math.min(1, Math.max(0, (db + 60) / 60));
}

export function createStatusView(app: App): View {
  const big = h("div", { class: "tx-big" });
  const bigDetail = h("div", { class: "muted" });
  const meterFill = h("div", { class: "meter-fill" });
  const meter = h(
    "div",
    { class: "meter", attrs: { role: "img", "aria-label": "Receive level" } },
    meterFill,
  );
  const dl = h("dl", { class: "kv" });
  const warn = h("p", { class: "problem", attrs: { role: "alert" } });
  const disconnect = h("button", {
    class: "btn",
    text: "Disconnect",
    attrs: { type: "button" },
    on: { click: () => void app.disconnect() },
  });
  const el = h(
    "section",
    { class: "view" },
    h("div", { class: "card" }, big, bigDetail),
    warn,
    h(
      "div",
      { class: "card" },
      dl,
      h("div", { class: "meter-row" }, h("span", { text: "Level" }), meter),
    ),
    h("div", { class: "row" }, disconnect),
  );

  const row = (k: string, v: string): HTMLElement[] => [h("dt", { text: k }), h("dd", { text: v })];

  return {
    el,
    render(): void {
      const s = app.status;
      const stale = app.statusStale;
      const b = txBadge(app.state, stale, s);
      big.className = `tx-big ${b.cls}`;
      setText(big, b.label);
      setText(bigDetail, b.detail);
      const v = (x: string | number | undefined): string =>
        stale || x === undefined ? NO_VALUE : String(x);
      const pos =
        !stale && s && s.lat !== undefined && s.lon !== undefined
          ? formatLatLon({ lat: s.lat, lon: s.lon })
          : NO_VALUE;
      const next = stale
        ? undefined
        : nextBeaconIn(s?.next_beacon_s, app.client?.lastStatusAt, Date.now());
      const onOff = (x: boolean | undefined): string =>
        stale || x === undefined ? NO_VALUE : x ? "On" : "Off";
      setChildren(
        dl,
        ...row("Callsign", v(s?.call)),
        ...row("Beacon switch", onOff(s?.sw)),
        ...row("Transmit enabled", onOff(s?.tx_enabled)),
        ...row(
          "GPS fix",
          stale
            ? NO_VALUE
            : `${s?.fix === 0 ? "none" : (s?.fix ?? NO_VALUE)}${s?.sats !== undefined ? ` · ${s.sats} sats` : ""}`,
        ),
        ...row("Position", pos),
        ...row("Next beacon", next === undefined ? NO_VALUE : fmtAge(next)),
        ...row(
          "Last transmit",
          stale ? NO_VALUE : s?.last_tx_s === undefined ? "never" : `${fmtAge(s.last_tx_s)} ago`,
        ),
        ...row(
          "Received / sent",
          stale ? NO_VALUE : `${s?.rx_count ?? NO_VALUE} / ${s?.tx_count ?? NO_VALUE}`,
        ),
        ...row("SD card", v(s?.sd)),
        ...row("Dropped rx", v(s?.dropped)),
      );
      meterFill.style.width = `${Math.round(levelFraction(stale ? undefined : s?.lvl_db) * 100)}%`;
      const dropped = !stale && (s?.dropped ?? 0) > 0;
      warn.hidden = !dropped;
      setText(
        warn,
        dropped
          ? `${s?.dropped} received packets were dropped because Bluetooth could not keep up.`
          : "",
      );
    },
  };
}
