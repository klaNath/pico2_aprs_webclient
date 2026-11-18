// Feed tab (placeholder until it is implemented).

import { h } from "./dom.ts";
import type { View } from "./view.ts";

export function createFeedView(): View {
  return {
    el: h("section", { class: "view" }, h("p", { class: "muted", text: "Feed: coming soon." })),
    render(): void {},
  };
}
