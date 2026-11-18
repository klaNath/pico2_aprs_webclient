import { describe, expect, it } from "vitest";
import {
  isOrderHeld,
  orderPending,
  POINTER_RELEASE_HOLD_MS,
  type OrderHoldInput,
} from "../src/ui/stationOrder.ts";

const NOW = 1_000_000;
const idle: OrderHoldInput = {
  detailOpen: false,
  focusInRow: false,
  pointerDown: false,
  pointerReleasedAt: undefined,
  now: NOW,
};
const held = (over: Partial<OrderHoldInput>): boolean => isOrderHeld({ ...idle, ...over });

describe("isOrderHeld (the Stations list must not re-sort under the user)", () => {
  it("is free when nothing is going on", () => {
    expect(held({})).toBe(false);
  });
  it("is held while a detail panel is open", () => {
    expect(held({ detailOpen: true })).toBe(true);
  });
  it("is held while a row has keyboard focus", () => {
    expect(held({ focusInRow: true })).toBe(true);
  });
  it("is held while the pointer is down", () => {
    expect(held({ pointerDown: true })).toBe(true);
    // Even if an older release time is still recorded.
    expect(held({ pointerDown: true, pointerReleasedAt: NOW - 10_000 })).toBe(true);
  });
  it("stays held for 300 ms after the pointer is released, then is free", () => {
    expect(POINTER_RELEASE_HOLD_MS).toBe(300);
    expect(held({ pointerReleasedAt: NOW })).toBe(true);
    expect(held({ pointerReleasedAt: NOW - 299 })).toBe(true);
    expect(held({ pointerReleasedAt: NOW - 300 })).toBe(false);
    expect(held({ pointerReleasedAt: NOW - 5000 })).toBe(false);
  });
  it("a release time in the future (the clock moved back) does not hold the list for ever", () => {
    expect(held({ pointerReleasedAt: NOW + 60_000 })).toBe(false);
  });
  it("any one condition is enough, and several together are held too", () => {
    expect(held({ detailOpen: true, focusInRow: true, pointerDown: true })).toBe(true);
    expect(held({ detailOpen: true, pointerReleasedAt: NOW - 5000 })).toBe(true);
  });
});

describe("orderPending", () => {
  it("is false for the same order", () => {
    expect(orderPending(["a", "b"], ["a", "b"])).toBe(false);
    expect(orderPending([], [])).toBe(false);
  });
  it("is true for a different order, a new station or a station that went", () => {
    expect(orderPending(["a", "b"], ["b", "a"])).toBe(true);
    expect(orderPending(["a", "b"], ["c", "a", "b"])).toBe(true);
    expect(orderPending(["a", "b"], ["a"])).toBe(true);
    expect(orderPending(["a", "b"], ["a", "c"])).toBe(true);
    // A new station that would go last: the rows on screen are a prefix of the wanted order.
    expect(orderPending(["a"], ["a", "b"])).toBe(true);
    expect(orderPending([], ["a"])).toBe(true);
  });
});
