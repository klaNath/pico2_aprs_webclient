// An item whose type this app does not know: shown as text, never edited.

import { h } from "../dom.ts";
import { valueText } from "../settingsForm.ts";
import type { SettingValue } from "../../protocol/types.ts";
import type { Control } from "./types.ts";

export function createReadonlyControl(id: string): Control {
  const code = h("code", { class: "mono sf-readonly", attrs: { id } });
  return {
    el: h("div", {}, code),
    inputId: id,
    set(v): void {
      code.textContent = valueText(v as SettingValue | undefined);
    },
    raw: () => code.textContent,
    setDisabled: () => undefined,
    focus: () => undefined,
  };
}
