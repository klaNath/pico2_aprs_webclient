// The Status tab: what the tracker is doing right now (from `status`, §8.1).
// Values come from the last status and are shown as "—" when the status is stale.

import { formatLatLon, NO_VALUE } from "../aprs/geo.ts";
import type { App } from "../store/state.ts";
import { beaconButtonState, runBeaconSend } from "./beaconSend.ts";
import { confirmDialog } from "./dialog.ts";
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

/** GPS fix as words (§8.1: 0 = no fix, 2 = 2D, 3 = 3D). */
export function fixLabel(fix: number | undefined): string {
  if (fix === undefined) return NO_VALUE;
  if (fix === 0) return "no fix";
  if (fix === 2) return "2D fix";
  if (fix === 3) return "3D fix";
  return `fix ${fix}`;
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
  const demo = h("div", {
    class: "card note demo-note",
    text: "Demo: simulated device. Nothing is sent on the air.",
  });
  const beaconHint = h("p", {
    class: "muted hint",
    text: "Beacon counts include dry runs (beacons built while the tracker could not transmit).",
  });
  // "Send beacon now": only on a deliberate press, never automatic (CLAUDE.md, transmit safety).
  let sending = false;
  let result = "";
  const sendBtn = h("button", {
    class: "btn btn-danger",
    text: "Send beacon now",
    attrs: { type: "button" },
  });
  const sendNote = h("p", { class: "muted hint", attrs: { role: "status" } });
  const buttonNow = (): ReturnType<typeof beaconButtonState> =>
    beaconButtonState(
      app.state,
      app.statusStale,
      app.status,
      app.client?.lastStatusAt,
      Date.now(),
      sending,
    );
  sendBtn.addEventListener("click", () => {
    const client = app.client;
    if (sending || !client || !buttonNow().enabled) return;
    sending = true;
    result = "";
    app.notify();
    void runBeaconSend({
      sendBeacon: (c) => client.sendBeacon(c),
      getStatus: () => client.getStatus(),
      confirm: (o) => confirmDialog(o),
      current: () => ({
        usable: app.client === client && app.state === "ready" && !app.statusStale,
        status: app.status,
      }),
    }).then((text) => {
      sending = false;
      result = text ?? "";
      app.notify();
    });
  });
  const disconnect = h("button", {
    class: "btn",
    text: "Disconnect",
    attrs: { type: "button" },
    on: { click: () => void app.disconnect() },
  });
  const el = h(
    "section",
    { class: "view" },
    demo,
    h("div", { class: "card" }, big, bigDetail),
    warn,
    h(
      "div",
      { class: "card" },
      dl,
      beaconHint,
      h("div", { class: "meter-row" }, h("span", { text: "Level" }), meter),
    ),
    h("div", { class: "card" }, h("div", { class: "row" }, sendBtn), sendNote),
    h("div", { class: "row" }, disconnect),
  );

  const row = (k: string, v: string): HTMLElement[] => [h("dt", { text: k }), h("dd", { text: v })];

  return {
    el,
    render(): void {
      const s = app.status;
      const stale = app.statusStale;
      const b = txBadge(app.state, stale, s, app.mock);
      demo.hidden = !app.mock;
      disconnect.hidden =
        app.state !== "ready" && app.state !== "connecting" && app.state !== "handshaking";
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
      const dryRun = !stale && s?.tx_ready === false ? " (dry run)" : "";
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
            : `${fixLabel(s?.fix)}${s?.sats !== undefined ? ` · ${s.sats} sats` : ""}`,
        ),
        ...row("Position", pos),
        ...row(
          "Beacon mode",
          stale
            ? NO_VALUE
            : s?.beacon_mode === "auto"
              ? "Auto"
              : s?.beacon_mode === "manual"
                ? "Manual"
                : (s?.beacon_mode ?? NO_VALUE),
        ),
        ...row(
          "Next beacon",
          !stale && s?.beacon_mode === "manual"
            ? "manual (only when sent)"
            : next === undefined
              ? NO_VALUE
              : fmtAge(next),
        ),
        // §8.1: last_tx_s counts beacons only, dry runs included.
        ...row(
          "Last beacon",
          stale
            ? NO_VALUE
            : s?.last_tx_s === undefined
              ? "never"
              : `${fmtAge(s.last_tx_s)} ago${dryRun}`,
        ),
        // tx_count counts every packet built to send, dry runs included (§8.1, §8.3).
        ...row(
          "Received / Sent",
          stale ? NO_VALUE : `${s?.rx_count ?? NO_VALUE} / ${s?.tx_count ?? NO_VALUE}${dryRun}`,
        ),
        // §7.9: judged from the received audio; automatic beacons and messages wait while busy.
        ...row(
          "Channel",
          stale || s?.ch_busy === undefined ? NO_VALUE : s.ch_busy ? "Busy" : "Clear",
        ),
        ...row(
          "Messages",
          stale || (s?.msg_unread === undefined && s?.msg_pending === undefined)
            ? NO_VALUE
            : `${s?.msg_unread ?? 0} unread · ${s?.msg_pending ?? 0} sending`,
        ),
        ...row("SD card", v(s?.sd)),
        ...row("Dropped rx", v(s?.dropped)),
      );
      const btn = buttonNow();
      sendBtn.disabled = !btn.enabled;
      setText(sendNote, result || btn.reason);
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
