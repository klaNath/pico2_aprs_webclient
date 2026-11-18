// Confirmation dialog. Used for the transmit-safety confirmations (CLAUDE.md): turning
// tx_enabled on, changing the callsign, and reset. Resolves true only when the user presses the
// confirm button; Escape, the backdrop and Cancel all resolve false.

import { append, h } from "./dom.ts";

export interface ConfirmOptions {
  title: string;
  /** Paragraphs of explanation. */
  body: string[];
  confirmLabel: string;
  cancelLabel?: string;
  /** Style the confirm button as a warning (transmit or destructive actions). */
  danger?: boolean;
  /** Optional lines shown in a highlighted box (for example "Callsign: Q1TEST-7"). */
  facts?: string[];
}

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    let result = false;
    const dlg = h("dialog", { class: "dialog", attrs: { "aria-labelledby": "dlg-title" } });
    const cancel = h("button", {
      class: "btn",
      text: opts.cancelLabel ?? "Cancel",
      attrs: { type: "button" },
      on: { click: () => dlg.close() },
    });
    const ok = h("button", {
      class: opts.danger ? "btn btn-danger" : "btn btn-primary",
      text: opts.confirmLabel,
      attrs: { type: "button" },
      on: {
        click: () => {
          result = true;
          dlg.close();
        },
      },
    });
    append(dlg, [
      h("h2", { id: "dlg-title", text: opts.title }),
      ...opts.body.map((p) => h("p", { text: p })),
      opts.facts && opts.facts.length > 0
        ? h("div", { class: "dialog-facts" }, ...opts.facts.map((f) => h("div", { text: f })))
        : null,
      h("div", { class: "dialog-actions" }, cancel, ok),
    ]);
    dlg.addEventListener("close", () => {
      dlg.remove();
      resolve(result);
    });
    // Clicking the backdrop (the dialog element itself, outside its content box) cancels.
    dlg.addEventListener("click", (ev) => {
      if (ev.target === dlg) dlg.close();
    });
    document.body.append(dlg);
    dlg.showModal();
    // Focus the safe choice, never the confirm button.
    cancel.focus();
  });
}
