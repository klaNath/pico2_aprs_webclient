// The detail block shared by the Stations and Radar tabs: a definition list that is updated in
// place. It is rebuilt only when the set of rows changes (a comment appears, ...).

import { h, setText } from "./dom.ts";
import type { DetailRow } from "./stationList.ts";

export interface DetailList {
  readonly el: HTMLElement;
  update(rows: DetailRow[]): void;
}

export function createDetailList(): DetailList {
  const el = h("dl", { class: "kv st-kv" });
  let signature = "";
  let values: HTMLElement[] = [];
  return {
    el,
    update(rows: DetailRow[]): void {
      const sig = rows.map((r) => `${r.label}${r.mono ? "!" : ""}`).join("|");
      if (sig !== signature) {
        signature = sig;
        values = [];
        el.replaceChildren();
        for (const r of rows) {
          const dd = h("dd", { class: r.mono ? "mono" : "" });
          values.push(dd);
          el.append(h("dt", { text: r.label }), dd);
        }
      }
      rows.forEach((r, i) => {
        const dd = values[i];
        if (dd) setText(dd, r.value);
      });
    },
  };
}
