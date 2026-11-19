// A choice among the values a `str` item accepts (`choices`, §9.2), such as `beacon_mode`.
// If the device reports a value that is not on the list it is shown but cannot be picked.

import type { SchemaItem } from "../../protocol/types.ts";
import { h } from "../dom.ts";
import { choiceOptions } from "../settingsForm.ts";
import type { Control, OnValue } from "./types.ts";

export function createChoiceControl(item: SchemaItem, id: string, onValue: OnValue): Control {
  const options = choiceOptions(item);
  const select = h("select", { id, class: "sf-input" });
  for (const o of options) {
    select.append(h("option", { text: o.label, attrs: { value: o.value } }));
  }
  const odd = h("option", { attrs: { value: "" }, disabled: true });
  select.addEventListener("change", () => {
    // Only listed values can be chosen (the extra option is disabled).
    if (options.some((o) => o.value === select.value)) onValue(select.value);
  });
  return {
    el: h("div", { class: "sf-select" }, select),
    inputId: id,
    set(v): void {
      if (typeof v === "string" && options.some((o) => o.value === v)) {
        odd.remove();
        select.value = v;
      } else {
        odd.textContent =
          v === undefined || v === null ? "not set" : `${String(v)} (not a valid choice)`;
        select.prepend(odd);
        select.value = "";
      }
    },
    raw: () => select.value,
    setDisabled: (d) => {
      select.disabled = d;
    },
    focus: () => select.focus(),
  };
}
