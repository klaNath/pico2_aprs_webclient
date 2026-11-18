// Mic-E message: a choice of 0 to 6 with names. 7 (Emergency) is not offered (CLAUDE.md: the
// app can only set 0-6). If the device reports another value it is shown but cannot be picked.

import { h } from "../dom.ts";
import { miceLabel, miceOptions } from "../settingsForm.ts";
import type { Control, OnValue } from "./types.ts";

export function createMiceControl(id: string, onValue: OnValue): Control {
  const select = h("select", { id, class: "sf-input" });
  for (const o of miceOptions()) {
    select.append(h("option", { text: o.label, attrs: { value: String(o.value) } }));
  }
  const odd = h("option", { attrs: { value: "" }, disabled: true });
  select.addEventListener("change", () => {
    const n = Number(select.value);
    // Only 0-6 can be chosen; ignore anything else (the extra option is disabled).
    if (Number.isInteger(n) && n >= 0 && n <= 6 && select.value !== "") onValue(n);
  });
  return {
    el: h("div", { class: "sf-select" }, select),
    inputId: id,
    set(v): void {
      const ok = typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 6;
      if (ok) {
        odd.remove();
        select.value = String(v);
      } else {
        odd.textContent = miceLabel(v);
        select.prepend(odd);
        select.value = "";
      }
    },
    raw: () => {
      const n = Number(select.value);
      return select.value === "" ? "" : n;
    },
    setDisabled: (d) => {
      select.disabled = d;
    },
    focus: () => select.focus(),
  };
}
