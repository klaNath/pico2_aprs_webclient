// Number input (int and float items) with an optional unit. For seconds it also shows the
// same time in minutes and hours, so "900" reads as "15 min".

import { h } from "../dom.ts";
import { humanSeconds, parseNumberInput } from "../settingsForm.ts";
import type { SchemaItem } from "../../protocol/types.ts";
import type { Control, OnValue } from "./types.ts";

export function createNumberControl(
  item: SchemaItem,
  id: string,
  onValue: OnValue,
  unit: string | undefined,
): Control {
  const input = h("input", {
    id,
    class: "sf-input",
    attrs: {
      type: "number",
      inputmode: item.type === "int" ? "numeric" : "decimal",
      step: item.type === "int" ? "1" : "any",
      autocomplete: "off",
    },
  });
  const human = unit === "s" ? h("span", { class: "sf-human muted" }) : null;
  const showHuman = (): void => {
    if (!human) return;
    const n = parseNumberInput(input.value);
    human.textContent = typeof n === "number" && n >= 60 ? `= ${humanSeconds(n)}` : "";
  };
  input.addEventListener("input", () => {
    showHuman();
    // Text the browser cannot read as a number arrives as "" and is reported as invalid.
    onValue(parseNumberInput(input.value));
  });
  return {
    el: h(
      "div",
      { class: "sf-number" },
      input,
      unit ? h("span", { class: "sf-unit muted", text: unit }) : null,
      human,
    ),
    inputId: id,
    set(v): void {
      input.value = typeof v === "number" || typeof v === "string" ? String(v) : "";
      showHuman();
    },
    raw: () => parseNumberInput(input.value),
    setDisabled: (d) => {
      input.disabled = d;
    },
    focus: () => input.focus(),
  };
}
