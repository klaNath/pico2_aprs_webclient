// One settings item: label, description, the control for its type, the "Not set" checkbox of a
// nullable item, and the error line. `createField(item, emit)` picks the control (see
// widgetKindFor) and returns a FieldWidget that the settings view updates in place.

import { h, setText } from "../dom.ts";
import { fieldLabel, fieldUnit, getOwn, itemDesc, widgetKindFor } from "../settingsForm.ts";
import { settingEquals } from "../../protocol/settings.ts";
import type { SchemaItem } from "../../protocol/types.ts";
import { createListControl } from "./list.ts";
import { createMiceControl } from "./mice.ts";
import { createNumberControl } from "./number.ts";
import { createReadonlyControl } from "./readonly.ts";
import { createSymbolControl } from "./symbol.ts";
import { createTextControl } from "./text.ts";
import { createToggleControl } from "./toggle.ts";
import type { Control, FieldState, FieldWidget, OnValue } from "./types.ts";

/** Extra help for known items, shown under the description. */
const HINTS: Readonly<Record<string, string>> = {
  callsign:
    "3-6 upper case letters and digits with at least one digit, without the SSID. Example: Q1TEST.",
  path: "Up to 2 entries such as WIDE1-1. Lower case is converted to upper case by the device.",
  comment: "Printable ASCII only, up to 40 characters.",
  tx_enabled: "Turning this on asks for confirmation when you save.",
};

const UNSET_TEXT: Readonly<Record<string, string>> = {
  callsign: "Not set (the tracker never transmits)",
};

function makeControl(item: SchemaItem, id: string, onValue: OnValue): Control {
  switch (widgetKindFor(item)) {
    case "callsign":
      return createTextControl(item, id, onValue, { code: true, placeholder: "Q1TEST" });
    case "symbol":
      return createSymbolControl(id, onValue);
    case "path":
      return createListControl(item, id, onValue, { placeholder: "WIDE1-1" });
    case "mice":
      return createMiceControl(id, onValue);
    case "text":
      return createTextControl(item, id, onValue);
    case "number":
      return createNumberControl(item, id, onValue, fieldUnit(item));
    case "toggle":
      return createToggleControl(id, onValue);
    case "list":
      return createListControl(item, id, onValue);
    case "readonly":
      return createReadonlyControl(id);
  }
}

export function createField(
  item: SchemaItem,
  emit: (key: string, value: unknown) => void,
): FieldWidget {
  const key = item.key;
  const id = `sf-${key.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  const kind = widgetKindFor(item);
  // What the widget last showed or reported. A render with this value is the user's own edit
  // coming back, so the inputs must not be rewritten (that would move the cursor).
  let last: unknown;
  let hasLast = false;
  const onValue: OnValue = (v) => {
    last = v;
    hasLast = true;
    emit(key, v);
  };
  const control = makeControl(item, id, onValue);

  const labelEl = h("label", {
    class: "sf-label",
    text: fieldLabel(item),
    attrs: { for: control.inputId },
  });
  const keyText = h("code", {
    class: "sf-key muted",
    text: key,
    hidden: fieldLabel(item) === key,
  });
  const devNote = h("span", { class: "sf-devnote", text: "Changed on the device", hidden: true });
  const unset =
    item.nullable === true && kind !== "readonly"
      ? h("input", { attrs: { type: "checkbox", id: `${id}-unset` } })
      : null;
  unset?.addEventListener("change", () => {
    if (unset.checked) {
      onValue(null);
    } else {
      onValue(control.raw());
      control.focus();
    }
  });
  // Everything from the device's schema is checked before use: `desc` may not be a string, and
  // `pattern` is never run, only shown (a regular expression from the device could hang the page).
  const rawDesc = itemDesc(item);
  const desc = rawDesc && rawDesc.toLowerCase() !== fieldLabel(item).toLowerCase() ? rawDesc : "";
  const pattern =
    kind === "text" && typeof item.pattern === "string" && item.pattern !== ""
      ? `Expected format (from the device): ${item.pattern.slice(0, 80)}${item.pattern.length > 80 ? "…" : ""}`
      : "";
  const hints = [
    desc,
    getOwn(HINTS, key) ?? "",
    pattern,
    kind === "readonly" ? "This app does not know this type, so it cannot be edited here." : "",
  ].filter((t) => t !== "");
  const hint = h(
    "div",
    { class: "hint", hidden: hints.length === 0 },
    ...hints.map((t) => h("div", { text: t })),
  );
  const error = h("div", { class: "error", attrs: { role: "alert" }, hidden: true });
  const el = h(
    "div",
    { class: "field sf-field", attrs: { "data-key": key } },
    h("div", { class: "sf-head" }, labelEl, keyText, devNote),
    control.el,
    unset
      ? h(
          "label",
          { class: "sf-unset" },
          unset,
          h("span", { text: getOwn(UNSET_TEXT, key) ?? "Not set" }),
        )
      : null,
    hint,
    error,
  );

  return {
    el,
    update(s: FieldState, force: boolean): void {
      const isNull = s.value === null;
      if (unset) {
        unset.checked = isNull;
        unset.disabled = s.disabled;
      }
      control.setDisabled(s.disabled || (isNull && unset !== null));
      if (isNull && unset) {
        hasLast = true;
        last = null;
      } else if (force || !hasLast || !settingEquals(s.value, last)) {
        control.set(s.value);
        last = s.value;
        hasLast = true;
      }
      el.classList.toggle("sf-dirty", s.dirty);
      el.classList.toggle("sf-invalid", s.error !== undefined);
      devNote.hidden = !s.changedOnDevice;
      error.hidden = s.error === undefined;
      setText(error, s.error ?? "");
    },
  };
}
