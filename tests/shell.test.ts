import { describe, expect, it } from "vitest";
import {
  PAIRING_HINT,
  connectMessage,
  protoMismatchText,
  webBluetoothHelp,
} from "../src/ui/connectView.ts";
import {
  hasLastKnownData,
  shellLayout,
  shouldWarnOnUnload,
  tabForKey,
  tabFromHash,
} from "../src/ui/shell.ts";
import { PROTO_VERSION } from "../src/protocol/types.ts";
import { DEFAULT_PREFS, PREFS_KEY, Prefs, type PrefsStorage } from "../src/store/prefs.ts";
import type { ClientState } from "../src/client/deviceClient.ts";

describe("shellLayout", () => {
  it("shows the full connect screen only when not ready and nothing is left to read", () => {
    expect(shellLayout("disconnected", false)).toEqual({
      fullConnect: true,
      connectCard: false,
      offlineBanner: false,
    });
  });
  it.each(["disconnected", "connecting", "handshaking", "error", "proto_mismatch"] as const)(
    "keeps the tabs usable in state %s when there is last known data",
    (st: ClientState) => {
      expect(shellLayout(st, true)).toEqual({
        fullConnect: false,
        connectCard: true,
        offlineBanner: true,
      });
    },
  );
  it("shows plain tabs when ready", () => {
    expect(shellLayout("ready", true)).toEqual({
      fullConnect: false,
      connectCard: false,
      offlineBanner: false,
    });
    expect(shellLayout("ready", false).fullConnect).toBe(false);
  });
});

describe("hasLastKnownData", () => {
  const none = { feed: [], stations: new Map(), client: undefined };
  it("is false without anything", () => {
    expect(hasLastKnownData(none)).toBe(false);
    expect(hasLastKnownData({ ...none, client: {} })).toBe(false);
  });
  it("is true with feed, stations or a last status", () => {
    expect(hasLastKnownData({ ...none, feed: [1] })).toBe(true);
    expect(hasLastKnownData({ ...none, stations: new Map([["Q1TEST", 1]]) })).toBe(true);
    expect(hasLastKnownData({ ...none, client: { lastStatus: {} } })).toBe(true);
  });
});

describe("shouldWarnOnUnload", () => {
  it("warns while connected or when the feed would be lost", () => {
    expect(shouldWarnOnUnload("ready", 0)).toBe(true);
    expect(shouldWarnOnUnload("disconnected", 3)).toBe(true);
    expect(shouldWarnOnUnload("disconnected", 0)).toBe(false);
  });
});

describe("tab navigation", () => {
  const ids = ["status", "feed", "stations"] as const;
  it("reads the tab from the hash", () => {
    expect(tabFromHash("#feed", ids)).toBe("feed");
    expect(tabFromHash("feed", ids)).toBe("feed");
    expect(tabFromHash("#nope", ids)).toBeUndefined();
    expect(tabFromHash("", ids)).toBeUndefined();
  });
  it("moves with the arrow keys (wrapping), Home and End", () => {
    expect(tabForKey(ids, "status", "ArrowRight")).toBe("feed");
    expect(tabForKey(ids, "stations", "ArrowRight")).toBe("status");
    expect(tabForKey(ids, "status", "ArrowLeft")).toBe("stations");
    expect(tabForKey(ids, "feed", "Home")).toBe("status");
    expect(tabForKey(ids, "feed", "End")).toBe("stations");
    expect(tabForKey(ids, "feed", "a")).toBeUndefined();
  });
});

describe("connect messages", () => {
  const base = {
    state: "disconnected" as ClientState,
    notice: undefined,
    deviceProto: undefined,
    disconnectReason: undefined,
  };
  it("explains a protocol mismatch with both versions, over any notice", () => {
    const text = protoMismatchText(2);
    expect(text).toContain("version 2");
    expect(text).toContain(`supports ${PROTO_VERSION}`);
    expect(text).toContain("Update the app");
    expect(connectMessage({ ...base, state: "proto_mismatch", notice: "x", deviceProto: 2 })).toBe(
      text,
    );
    // Unknown device version: still a usable sentence.
    expect(protoMismatchText(undefined)).toContain("a different version");
  });
  it("prefers the notice, then the disconnect reason", () => {
    expect(connectMessage({ ...base, notice: "Cancelled" })).toBe("Cancelled");
    expect(connectMessage({ ...base, disconnectReason: "GATT closed" })).toBe(
      "Disconnected: GATT closed",
    );
    expect(connectMessage({ ...base, notice: "n", disconnectReason: "r" })).toBe("n");
    expect(connectMessage(base)).toBeUndefined();
  });
  it("says pairing may happen (U3 is unconfirmed)", () => {
    expect(PAIRING_HINT).toContain("may ask you to pair");
  });
  it("tells a missing browser from a page that is not HTTPS", () => {
    expect(webBluetoothHelp(true, true)).toBeUndefined();
    expect(webBluetoothHelp(true, false)).toBeUndefined();
    expect(webBluetoothHelp(false, true)).toContain("this browser");
    expect(webBluetoothHelp(false, true)).not.toContain("HTTPS");
    const insecure = webBluetoothHelp(false, false) ?? "";
    expect(insecure).toContain("HTTPS");
    expect(insecure).toContain("browser");
  });
});

describe("Prefs across tabs", () => {
  function fakeStorage(): PrefsStorage & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => void data.set(k, v),
    };
  }
  it("keeps another tab's changes to other keys when saving", () => {
    const storage = fakeStorage();
    const a = new Prefs(storage);
    const b = new Prefs(storage); // a second tab
    b.set("radarScale", "linear");
    a.set("theme", "dark"); // a never saw radarScale
    const stored = JSON.parse(storage.data.get(PREFS_KEY) ?? "{}");
    expect(stored.theme).toBe("dark");
    expect(stored.radarScale).toBe("linear");
    expect(a.get("radarScale")).toBe("linear");
  });
  it("still works when storage is missing or throws", () => {
    const none = new Prefs(null);
    none.set("theme", "light");
    expect(none.get("theme")).toBe("light");
    const broken = new Prefs({
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    broken.set("logLimit", 100);
    expect(broken.get("logLimit")).toBe(100);
    expect(broken.get("theme")).toBe(DEFAULT_PREFS.theme);
  });
  it("keeps in-memory values when the stored copy was wiped", () => {
    const storage = fakeStorage();
    const p = new Prefs(storage);
    p.set("theme", "dark");
    storage.data.clear();
    p.set("logLimit", 100);
    expect(p.get("theme")).toBe("dark");
  });
  it("sanitizes junk in storage", () => {
    const storage = fakeStorage();
    storage.data.set(PREFS_KEY, "{not json");
    expect(new Prefs(storage).get("theme")).toBe("auto");
  });
});
