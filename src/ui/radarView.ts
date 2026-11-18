// Radar tab (placeholder until it is implemented).

import { h } from "./dom.ts";
import type { View } from "./view.ts";

export function createRadarView(): View {
  return {
    el: h("section", { class: "view" }, h("p", { class: "muted", text: "Radar: coming soon." })),
    render(): void {},
  };
}
