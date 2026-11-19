import { describe, expect, it } from "vitest";
import {
  beaconButtonState,
  beaconCase,
  beaconConfirmation,
  beaconResultText,
  describeBeaconError,
  runBeaconSend,
} from "../src/ui/beaconSend.ts";

const OK = { sw: true, fix: 3, utc: "2026-11-19T00:00:00Z" };
const NOW = 1_000_000;

describe("beaconButtonState", () => {
  const state = (
    s: Parameters<typeof beaconButtonState>[2],
    opts: { at?: number; sending?: boolean; stale?: boolean; st?: "ready" | "error" } = {},
  ) =>
    beaconButtonState(
      opts.st ?? "ready",
      opts.stale ?? false,
      s,
      opts.at ?? NOW,
      NOW,
      opts.sending ?? false,
    );

  it("is enabled with the switch on and a fix", () => {
    expect(state(OK)).toEqual({ enabled: true, reason: "" });
  });
  it("is disabled when not connected, stale, or sending", () => {
    expect(state(OK, { st: "error" }).enabled).toBe(false);
    expect(state(undefined).enabled).toBe(false);
    expect(state(OK, { stale: true }).enabled).toBe(false);
    expect(state(OK, { sending: true }).enabled).toBe(false);
  });
  it("is disabled with the switch off, without a fix, or without the time", () => {
    expect(state({ ...OK, sw: false }).reason).toMatch(/switch/);
    expect(state({ ...OK, sw: undefined }).enabled).toBe(false);
    expect(state({ ...OK, fix: 0 }).reason).toMatch(/fix/);
    expect(state({ ...OK, fix: 1 }).enabled).toBe(false);
    expect(state({ ...OK, utc: undefined }).reason).toMatch(/fix/);
  });
  it("counts the 10 s since the last beacon from when the status arrived", () => {
    expect(state({ ...OK, last_tx_s: 3 }).reason).toMatch(/Wait 7 s/);
    expect(state({ ...OK, last_tx_s: 3 }, { at: NOW - 4000 }).reason).toMatch(/Wait 3 s/);
    expect(state({ ...OK, last_tx_s: 3 }, { at: NOW - 7000 }).enabled).toBe(true);
    expect(state({ ...OK, last_tx_s: 600 }).enabled).toBe(true);
  });
});

describe("beaconCase", () => {
  it("is onAir only when tx_ready is true, dryRun only when it is false", () => {
    expect(beaconCase({ tx_ready: true })).toBe("onAir");
    expect(beaconCase({ tx_ready: false })).toBe("dryRun");
    expect(beaconCase({})).toBeUndefined();
    expect(beaconCase(undefined)).toBeUndefined();
  });
});

describe("texts", () => {
  it("the dialog says it goes on the air and as whom", () => {
    const o = beaconConfirmation("Q1TEST-7");
    expect(o.danger).toBe(true);
    expect(o.body.join(" ")).toMatch(/on the air/);
    expect(o.facts).toEqual(["On the air as: Q1TEST-7"]);
  });
  it("a result never claims a transmission the device did not report", () => {
    expect(beaconResultText({ t: "beacon", dry: false }, undefined)).toBe("Beacon sent.");
    expect(beaconResultText({ t: "beacon", dry: true }, { tx_refuse: "TX not enabled" })).toMatch(
      /not transmitted \(TX not enabled\)/,
    );
    expect(beaconResultText({ t: "beacon" }, undefined)).not.toMatch(/Beacon sent/);
  });
  it("every error code has words", () => {
    for (const code of [
      "switch_off",
      "no_fix",
      "too_soon",
      "frame_too_long",
      "internal",
      "busy",
      "timeout",
      "disconnected",
    ]) {
      expect(describeBeaconError({ code }).length).toBeGreaterThan(15);
    }
    expect(describeBeaconError({ code: "too_soon", waitS: 4 })).toMatch(/4 s/);
    expect(describeBeaconError({ code: "timeout" })).toMatch(/not known/);
    expect(describeBeaconError({ code: "zzz", msg: "x" })).toMatch(/x/);
  });
});

describe("runBeaconSend (the press of the button)", () => {
  function setup(opts: {
    statuses: { tx_ready?: boolean }[];
    answer?: boolean;
    usable?: boolean[];
  }) {
    const calls: string[] = [];
    let i = 0;
    const deps = {
      sendBeacon: (c: unknown) => {
        calls.push(`send ${JSON.stringify(c)}`);
        return Promise.resolve({ t: "beacon" as const, dry: !("onAir" in (c as object)) });
      },
      confirm: () => {
        calls.push("confirm");
        return Promise.resolve(opts.answer ?? true);
      },
      current: () => {
        const n = i++;
        return {
          usable: opts.usable?.[Math.min(n, opts.usable.length - 1)] ?? true,
          status: { t: "status" as const, ...opts.statuses[Math.min(n, opts.statuses.length - 1)] },
        };
      },
    };
    return { deps, calls };
  }

  it("on the air: asks first, then sends with the onAir confirmation", async () => {
    const { deps, calls } = setup({ statuses: [{ tx_ready: true }] });
    expect(await runBeaconSend(deps)).toBe("Beacon sent.");
    expect(calls).toEqual(["confirm", 'send {"onAir":true}']);
  });
  it("on the air: nothing is sent when the user cancels", async () => {
    const { deps, calls } = setup({ statuses: [{ tx_ready: true }], answer: false });
    expect(await runBeaconSend(deps)).toBeUndefined();
    expect(calls).toEqual(["confirm"]);
  });
  it("dry run: no dialog", async () => {
    const { deps, calls } = setup({ statuses: [{ tx_ready: false }] });
    expect(await runBeaconSend(deps)).toMatch(/Dry run/);
    expect(calls).toEqual(['send {"dryRun":true}']);
  });
  it("an unknown tx_ready is treated as on the air: it asks", async () => {
    const { deps, calls } = setup({ statuses: [{}] });
    await runBeaconSend(deps);
    expect(calls[0]).toBe("confirm");
  });
  it("sends nothing when tx_ready turns true after a dry-run decision", async () => {
    const { deps, calls } = setup({ statuses: [{ tx_ready: false }, { tx_ready: true }] });
    expect(await runBeaconSend(deps)).toMatch(/Nothing was sent/);
    expect(calls).toEqual([]);
  });
  it("sends nothing when the connection is gone after the dialog", async () => {
    const { deps, calls } = setup({ statuses: [{ tx_ready: true }], usable: [true, false] });
    expect(await runBeaconSend(deps)).toMatch(/Nothing was sent/);
    expect(calls).toEqual(["confirm"]);
  });
  it("turns an error into words", async () => {
    const { deps } = setup({ statuses: [{ tx_ready: false }] });
    deps.sendBeacon = () =>
      Promise.reject(Object.assign(new Error("x"), { code: "too_soon", waitS: 3 }));
    expect(await runBeaconSend(deps)).toMatch(/Wait 3 s/);
  });
});
