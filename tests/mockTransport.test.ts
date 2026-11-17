import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockTransport } from "../src/transport/mock/mockTransport.ts";

// The mock must behave like the real link where the app can get it wrong (§5.2, Transport contract).

const enc = new TextEncoder();
let t: MockTransport;

beforeEach(() => {
  vi.useFakeTimers();
  t = new MockTransport({ autoRx: false });
});
afterEach(async () => {
  await t.disconnect();
  vi.useRealTimers();
});

describe("write size (§5.2)", () => {
  it("accepts 20 bytes and rejects 21, like the real link", async () => {
    await t.connect();
    await expect(t.write(new Uint8Array(20).fill(0x20))).resolves.toBeUndefined();
    await expect(t.write(new Uint8Array(21).fill(0x20))).rejects.toThrow(/exceeds 20/);
  });

  it("rejects writes when not connected", async () => {
    await expect(t.write(enc.encode("x"))).rejects.toThrow(/not connected/);
  });
});

describe("disconnect", () => {
  it("fires onDisconnect when the app disconnects, as a real link does", async () => {
    const cb = vi.fn();
    t.onDisconnect(cb);
    await t.connect();
    await t.disconnect();
    await Promise.resolve();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("does not fire onDisconnect when it was not connected", async () => {
    const cb = vi.fn();
    t.onDisconnect(cb);
    await t.disconnect();
    await Promise.resolve();
    expect(cb).not.toHaveBeenCalled();
  });

  it("returns a function that removes the callbacks", async () => {
    const data = vi.fn();
    const disc = vi.fn();
    const offData = t.onData(data);
    const offDisc = t.onDisconnect(disc);
    offData();
    offDisc();
    await t.connect(); // sends the first status
    t.simulateDisconnect();
    expect(data).not.toHaveBeenCalled();
    expect(disc).not.toHaveBeenCalled();
  });

  it("makes a pending connect() reject", async () => {
    const slow = new MockTransport({ autoRx: false, connectDelayMs: 1000 });
    const p = slow.connect();
    const assertion = expect(p).rejects.toThrow(/aborted/);
    await slow.disconnect();
    await assertion;
    await vi.advanceTimersByTimeAsync(2000);
    await expect(slow.write(enc.encode("x"))).rejects.toThrow(/not connected/); // never came up
  });

  it("fails a write that is in flight when the link drops", async () => {
    t.writeDelayMs = 100;
    await t.connect();
    const w = expect(t.write(enc.encode("x"))).rejects.toThrow(/disconnected/);
    t.simulateDisconnect();
    await vi.advanceTimersByTimeAsync(100);
    await w;
  });
});
