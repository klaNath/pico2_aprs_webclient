// What every screen implements. main.ts builds each view once and calls `render()`:
//  - when the app state changes (throttled to one call per animation frame),
//  - once a second (so ages such as "2 min ago" stay fresh), and
//  - when the user switches to the screen.
// `render()` is only called while the view is visible, so it may be cheap to skip work.
// A view builds its elements once in its factory and then updates them; it does not rebuild the
// whole tree on every call, because that would lose scroll position, focus and half-typed input.

import type { App } from "../store/state.ts";

export interface View {
  readonly el: HTMLElement;
  render(): void;
}

export type ViewFactory = (app: App) => View;
