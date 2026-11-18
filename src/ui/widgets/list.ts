// A list of strings with Add and Remove (list items). `path` is the same widget with a hint.
// Blank rows are not part of the value: a new empty row is only a place to type.

import { h, setText } from "../dom.ts";
import type { SchemaItem } from "../../protocol/types.ts";
import type { Control, OnValue } from "./types.ts";

export function createListControl(
  item: SchemaItem,
  id: string,
  onValue: OnValue,
  opts: { placeholder?: string } = {},
): Control {
  const rows = h("div", { class: "sf-list" });
  const count = h("span", { class: "sf-counter muted" });
  const add = h("button", {
    class: "btn sf-add",
    text: "Add",
    attrs: { type: "button" },
  });
  let disabled = false;

  const inputs = (): HTMLInputElement[] => [...rows.querySelectorAll<HTMLInputElement>("input")];
  const value = (): string[] =>
    inputs()
      .map((i) => i.value)
      .filter((v) => v.trim() !== "");
  const refresh = (): void => {
    const n = inputs().length;
    const max = item.max_items;
    add.disabled = disabled || (max !== undefined && n >= max);
    setText(count, max !== undefined ? `${n}/${max}` : `${n}`);
  };
  const addRow = (text: string, focus: boolean): void => {
    const input = h("input", {
      class: "sf-input mono",
      attrs: {
        type: "text",
        autocomplete: "off",
        autocapitalize: "characters",
        autocorrect: "off",
        spellcheck: "false",
        "aria-label": `${item.key} entry`,
        ...(opts.placeholder ? { placeholder: opts.placeholder } : {}),
      },
    });
    input.value = text;
    input.disabled = disabled;
    input.addEventListener("input", () => onValue(value()));
    const remove = h("button", {
      class: "btn sf-remove",
      text: "Remove",
      attrs: { type: "button", "aria-label": "Remove entry" },
      on: {
        click: () => {
          row.remove();
          refresh();
          onValue(value());
        },
      },
    });
    remove.disabled = disabled;
    const row = h("div", { class: "sf-list-row" }, input, remove);
    rows.append(row);
    if (focus) input.focus();
  };
  add.addEventListener("click", () => {
    addRow("", true);
    refresh();
    // A blank row does not change the value, so there is nothing to report yet.
  });

  return {
    el: h(
      "div",
      { class: "sf-listwrap", attrs: { id } },
      rows,
      h("div", { class: "row sf-list-actions" }, add, count),
    ),
    inputId: id,
    set(v): void {
      rows.replaceChildren();
      for (const e of Array.isArray(v) ? v : []) addRow(String(e), false);
      refresh();
    },
    raw: value,
    setDisabled(d): void {
      disabled = d;
      for (const el of rows.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
        "input,button",
      )) {
        el.disabled = d;
      }
      refresh();
    },
    focus: () => inputs()[0]?.focus(),
  };
}
