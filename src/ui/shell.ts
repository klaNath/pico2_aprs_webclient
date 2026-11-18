// Pure decisions of the app shell (main.ts): which screen layout to show, tab navigation, and when
// to warn before the page is closed. No DOM here, so all of it can be tested.

import type { ClientState } from "../client/deviceClient.ts";

export interface ShellLayout {
  /** The connect screen takes the whole page (no tabs): nothing usable to show yet. */
  fullConnect: boolean;
  /** The connection card is shown on top of the Status tab. */
  connectCard: boolean;
  /** Every tab carries the "Not connected" banner. */
  offlineBanner: boolean;
}

/**
 * Not connected -> the tabs stay usable (read-only) as long as there is something to look at: the
 * feed, the stations, or a last status. Before the first connection there is nothing, so the
 * connect screen takes over. `ready` is the only state with a live link.
 */
export function shellLayout(state: ClientState, hasLastKnownData: boolean): ShellLayout {
  if (state === "ready") return { fullConnect: false, connectCard: false, offlineBanner: false };
  if (!hasLastKnownData) return { fullConnect: true, connectCard: false, offlineBanner: false };
  return { fullConnect: false, connectCard: true, offlineBanner: true };
}

/** Whether there is anything left to read from an earlier connection. */
export function hasLastKnownData(app: {
  feed: readonly unknown[];
  stations: { size: number };
  client?: { lastStatus?: unknown } | undefined;
}): boolean {
  return app.feed.length > 0 || app.stations.size > 0 || app.client?.lastStatus !== undefined;
}

/** Warn before reload/close while a link is open or the in-memory history would be lost. */
export function shouldWarnOnUnload(state: ClientState, feedLength: number): boolean {
  return state === "ready" || feedLength > 0;
}

/** The tab named by a URL hash ("#feed"), or undefined. */
export function tabFromHash<T extends string>(hash: string, ids: readonly T[]): T | undefined {
  const name = hash.startsWith("#") ? hash.slice(1) : hash;
  return ids.find((id) => id === name);
}

/** The tab a key moves to (WAI-ARIA tabs: left/right wrap around, Home/End), or undefined. */
export function tabForKey<T extends string>(
  ids: readonly T[],
  current: T,
  key: string,
): T | undefined {
  const i = ids.indexOf(current);
  if (i < 0 || ids.length === 0) return undefined;
  switch (key) {
    case "ArrowRight":
      return ids[(i + 1) % ids.length];
    case "ArrowLeft":
      return ids[(i - 1 + ids.length) % ids.length];
    case "Home":
      return ids[0];
    case "End":
      return ids[ids.length - 1];
    default:
      return undefined;
  }
}
