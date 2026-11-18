// Symbol: the symbol table (primary "/", alternate "\", or an overlay 0-9 / A-Z on the alternate
// table) and the symbol code, picked from a list with names, plus the name of what is chosen.

import { symbolInfo, symbolName } from "../../aprs/symbols.ts";
import { h, setText } from "../dom.ts";
import type { Control, OnValue } from "./types.ts";

const OVERLAYS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function tableOf(ch: string): "/" | "\\" {
  return ch === "/" ? "/" : "\\";
}

export function createSymbolControl(id: string, onValue: OnValue): Control {
  const table = h("select", { id, class: "sf-input", attrs: { "aria-label": "Symbol table" } });
  const code = h("select", { class: "sf-input", attrs: { "aria-label": "Symbol code" } });
  const name = h("div", { class: "sf-symname muted" });
  const none = (): HTMLOptionElement =>
    h("option", { text: "—", attrs: { value: "" }, disabled: true });
  table.append(
    none(),
    h("option", { text: "/  Primary table", attrs: { value: "/" } }),
    h("option", { text: "\\  Alternate table", attrs: { value: "\\" } }),
    ...[...OVERLAYS].map((c) =>
      h("option", { text: `${c}  Alternate with overlay ${c}`, attrs: { value: c } }),
    ),
  );

  let builtFor: "/" | "\\" | "" = "";
  const buildCodes = (t: "/" | "\\"): void => {
    if (builtFor === t) return;
    builtFor = t;
    code.replaceChildren(none());
    for (let c = 0x21; c <= 0x7e; c++) {
      const ch = String.fromCharCode(c);
      const info = symbolInfo({ table: t, code: ch });
      code.append(
        h("option", {
          text: `${ch}  ${info.known ? info.name : "(not assigned)"}`,
          attrs: { value: ch },
        }),
      );
    }
  };
  const current = (): string => table.value + code.value;
  const showName = (): void => {
    if (table.value === "" || code.value === "") {
      setText(name, "Choose a table and a code.");
      return;
    }
    const overlay = /[0-9A-Z]/.test(table.value) ? table.value : undefined;
    setText(
      name,
      symbolName({
        table: tableOf(table.value),
        code: code.value,
        ...(overlay ? { overlay } : {}),
      }),
    );
  };
  table.addEventListener("change", () => {
    const keep = code.value;
    buildCodes(tableOf(table.value));
    code.value = keep;
    showName();
    onValue(current());
  });
  code.addEventListener("change", () => {
    showName();
    onValue(current());
  });
  buildCodes("/");
  showName();

  return {
    el: h("div", { class: "sf-symbol" }, table, code, name),
    inputId: id,
    set(v): void {
      const s = typeof v === "string" && v.length === 2 ? v : "";
      const t = s[0] ?? "";
      const known = t !== "" && table.querySelector(`option[value="${CSS.escape(t)}"]`) !== null;
      table.value = known ? t : "";
      buildCodes(known ? tableOf(t) : "/");
      code.value = known ? (s[1] ?? "") : "";
      if (code.value !== (s[1] ?? "")) code.value = "";
      showName();
    },
    raw: current,
    setDisabled: (d) => {
      table.disabled = d;
      code.disabled = d;
    },
    focus: () => table.focus(),
  };
}
