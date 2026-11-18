// On/off switch (bool items).

import { h } from "../dom.ts";
import type { Control, OnValue } from "./types.ts";

export function createToggleControl(id: string, onValue: OnValue): Control {
  const input = h("input", { id, attrs: { type: "checkbox", role: "switch" } });
  const text = h("span", { class: "sf-switch-text" });
  const show = (): void => {
    text.textContent = input.checked ? "On" : "Off";
  };
  input.addEventListener("change", () => {
    show();
    onValue(input.checked);
  });
  show();
  return {
    el: h("label", { class: "sf-switch" }, input, h("span", { class: "sf-switch-track" }), text),
    inputId: id,
    set(v): void {
      input.checked = v === true;
      show();
    },
    raw: () => input.checked,
    setDisabled: (d) => {
      input.disabled = d;
    },
    focus: () => input.focus(),
  };
}
