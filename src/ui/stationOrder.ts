// When the Stations list may re-sort itself. Pure logic, so it can be tested under Node.
//
// With "Most recent" a row jumps to the top whenever its station is heard. If that happens while
// a finger is on the row, the tap lands on another row or is lost, and a row that has keyboard
// focus or an open detail panel would run away from the user. So the order is held while the user
// is working with the list; the rows keep updating their text, and the list is sorted once when
// the hold ends.

/** After the pointer is released, keep the order this long so that the click still lands. */
export const POINTER_RELEASE_HOLD_MS = 300;

export interface OrderHoldInput {
  /** A detail panel is open. */
  detailOpen: boolean;
  /** A row (or something inside it) has keyboard focus. */
  focusInRow: boolean;
  /** Between pointerdown and pointerup/pointercancel. */
  pointerDown: boolean;
  /** Date.now() of the last pointerup/pointercancel, if any. */
  pointerReleasedAt: number | undefined;
  now: number;
}

/** True while the list must not be re-ordered. */
export function isOrderHeld(i: OrderHoldInput): boolean {
  if (i.detailOpen || i.focusInRow || i.pointerDown) return true;
  return (
    i.pointerReleasedAt !== undefined &&
    i.now - i.pointerReleasedAt >= 0 &&
    i.now - i.pointerReleasedAt < POINTER_RELEASE_HOLD_MS
  );
}

/** True when the rows on screen are not in the order (or not the set) that is wanted now. */
export function orderPending(onScreen: readonly string[], wanted: readonly string[]): boolean {
  if (onScreen.length !== wanted.length) return true;
  return onScreen.some((src, i) => src !== wanted[i]);
}
