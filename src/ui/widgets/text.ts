// Text input (str items): comment, callsign, and unknown string items.

import { h } from "../dom.ts";
import type { SchemaItem } from "../../protocol/types.ts";
import type { Control, OnValue } from "./types.ts";

export interface TextOptions {
  /** Upper case keyboard, no autocorrect (callsign). */
  code?: boolean;
  placeholder?: string;
}

export function createTextControl(
  item: SchemaItem,
  id: string,
  onValue: OnValue,
  opts: TextOptions = {},
): Control {
  const attrs: Record<string, string> = {
    type: "text",
    autocomplete: "off",
    autocapitalize: opts.code ? "characters" : "off",
    autocorrect: "off",
    spellcheck: "false",
  };
  if (opts.placeholder) attrs.placeholder = opts.placeholder;
  const input = h("input", { id, class: opts.code ? "sf-input mono" : "sf-input", attrs });
  const max = item.len ?? item.max_len;
  const counter = max !== undefined ? h("span", { class: "sf-counter muted" }) : null;
  const showCount = (): void => {
    if (!counter || max === undefined) return;
    counter.textContent = `${input.value.length}/${max}`;
    counter.classList.toggle("sf-over", input.value.length > max);
  };
  input.addEventListener("input", () => {
    showCount();
    onValue(input.value);
  });
  return {
    el: h("div", { class: "sf-text" }, input, counter),
    inputId: id,
    set(v): void {
      input.value = typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
      showCount();
    },
    raw: () => input.value,
    setDisabled: (d) => {
      input.disabled = d;
    },
    focus: () => input.focus(),
  };
}
