import { describe, expect, it } from "vitest";
import { sanitizePrefs, DEFAULT_PREFS, LOG_LIMIT_MAX, LOG_LIMIT_MIN } from "../src/store/prefs.ts";
import { txBadge } from "../src/ui/header.ts";
import { levelFraction, nextBeaconIn } from "../src/ui/statusView.ts";
import { fmtAge, fmtDistance } from "../src/ui/format.ts";

describe("txBadge (tx_ready must never look ready when it cannot be trusted)", () => {
  const ready = { tx_ready: true };
  it("shows READY only when connected, fresh and tx_ready", () => {
    expect(txBadge("ready", false, ready).cls).toBe("tx-ready");
  });
  it("is unknown when the status is stale, even if the old status said ready", () => {
    const b = txBadge("ready", true, ready);
    expect(b.cls).toBe("tx-unknown");
    expect(b.label).toBe("TX ?");
  });
  it.each(["disconnected", "connecting", "handshaking", "error", "proto_mismatch"] as const)(
    "is unknown in state %s",
    (st) => {
      expect(txBadge(st, false, ready).cls).toBe("tx-unknown");
    },
  );
  it("is unknown without a status", () => {
    expect(txBadge("ready", false, undefined).cls).toBe("tx-unknown");
  });
  it("says why it is not transmitting", () => {
    const b = txBadge("ready", false, { tx_ready: false, tx_refuse: "TX not enabled" });
    expect(b.cls).toBe("tx-dry");
    expect(b.detail).toContain("TX not enabled");
    expect(txBadge("ready", false, { tx_ready: false, sw: false }).detail).toContain("switch");
  });
  it("treats a missing tx_ready as not ready", () => {
    expect(txBadge("ready", false, {}).cls).toBe("tx-dry");
  });
});

describe("nextBeaconIn", () => {
  it("counts down from the status time and stops at 0", () => {
    expect(nextBeaconIn(60, 1_000_000, 1_000_000 + 10_000)).toBe(50);
    expect(nextBeaconIn(60, 1_000_000, 1_000_000 + 90_000)).toBe(0);
  });
  it("is undefined without data", () => {
    expect(nextBeaconIn(undefined, 1, 2)).toBeUndefined();
    expect(nextBeaconIn(5, undefined, 2)).toBeUndefined();
  });
});

describe("levelFraction", () => {
  it("maps about -60..0 dB to 0..1 and clamps", () => {
    expect(levelFraction(-60)).toBe(0);
    expect(levelFraction(-30)).toBeCloseTo(0.5);
    expect(levelFraction(0)).toBe(1);
    expect(levelFraction(20)).toBe(1);
    expect(levelFraction(-200)).toBe(0);
    expect(levelFraction(undefined)).toBe(0);
    expect(levelFraction(NaN)).toBe(0);
  });
});

describe("sanitizePrefs", () => {
  it("returns defaults for junk", () => {
    expect(sanitizePrefs(undefined)).toEqual(DEFAULT_PREFS);
    expect(sanitizePrefs("x")).toEqual(DEFAULT_PREFS);
    expect(sanitizePrefs({ theme: "pink", logLimit: "9", radarScale: 3 })).toEqual(DEFAULT_PREFS);
  });
  it("clamps numbers and keeps valid values", () => {
    expect(sanitizePrefs({ logLimit: 1 }).logLimit).toBe(LOG_LIMIT_MIN);
    expect(sanitizePrefs({ logLimit: 1e9 }).logLimit).toBe(LOG_LIMIT_MAX);
    expect(sanitizePrefs({ logLimit: NaN }).logLimit).toBe(DEFAULT_PREFS.logLimit);
    expect(sanitizePrefs({ theme: "dark", radarScale: "linear", radarRangeKm: 120 })).toMatchObject(
      {
        theme: "dark",
        radarScale: "linear",
        radarRangeKm: 120,
      },
    );
  });
});

describe("format", () => {
  it("fmtAge", () => {
    expect(fmtAge(45)).toBe("45 s");
    expect(fmtAge(125)).toBe("2 min");
    expect(fmtAge(7300)).toBe("2 h");
    expect(fmtAge(undefined)).toBe("—");
    expect(fmtAge(-1)).toBe("—");
  });
  it("fmtDistance", () => {
    expect(fmtDistance(850)).toBe("850 m");
    expect(fmtDistance(12_345)).toBe("12.3 km");
    expect(fmtDistance(245_000)).toBe("245 km");
    expect(fmtDistance(NaN)).toBe("—");
  });
});
