// The picture of an APRS symbol, from the aprs.fi symbol set (public/aprs-symbols/, see its
// README.md for the source and the licenses). Each sheet has 16 x 6 cells; code `c` is cell c - 33.
// An overlay character (0-9, A-Z on the alternate table) is a second cell drawn on top.

import { symbolInfo } from "../aprs/symbols.ts";
import { h } from "./dom.ts";

export const SYMBOL_SET_URL = "https://github.com/hessu/aprs-symbols";

const SHEET_COLS = 16;
const SHEET_ROWS = 6;
/** Relative to the page, so that it works under any base path (vite `base: "./"`). */
const SHEETS = [
  "aprs-symbols/aprs-symbols-64-0.png",
  "aprs-symbols/aprs-symbols-64-1.png",
  "aprs-symbols/aprs-symbols-64-2.png",
] as const;

export interface SpriteCell {
  sheet: string;
  col: number;
  row: number;
}

export interface SymbolSprite {
  base: SpriteCell;
  overlay?: SpriteCell;
}

function cell(sheet: string, ch: string): SpriteCell | undefined {
  const i = ch.length === 1 ? ch.charCodeAt(0) - 0x21 : -1;
  if (i < 0 || i >= SHEET_COLS * SHEET_ROWS - 1) return undefined; // the last cell is a credit
  return { sheet, col: i % SHEET_COLS, row: Math.floor(i / SHEET_COLS) };
}

/**
 * The cells to draw for a 2-character symbol ("/>" , "\\k", "A#" for overlay A on alternate #),
 * or undefined when there is nothing meaningful to draw: a bad table, a code out of range, or a
 * code that is not assigned (the sheets have a placeholder there, which would look like a symbol).
 */
export function symbolSprite(sym: string): SymbolSprite | undefined {
  if (sym.length !== 2) return undefined;
  const t = sym[0]!;
  const code = sym[1]!;
  const overlay = /^[0-9A-Z]$/.test(t) ? t : undefined;
  if (t !== "/" && t !== "\\" && overlay === undefined) return undefined;
  const table = t === "/" ? "/" : "\\";
  if (!symbolInfo({ table, code }).known) return undefined;
  const base = cell(SHEETS[table === "/" ? 0 : 1], code);
  if (!base) return undefined;
  if (overlay === undefined) return { base };
  const over = cell(SHEETS[2], overlay);
  return over ? { base, overlay: over } : { base };
}

function paint(el: HTMLElement, c: SpriteCell, sizePx: number): void {
  el.style.backgroundImage = `url("${c.sheet}")`;
  el.style.backgroundSize = `${SHEET_COLS * sizePx}px ${SHEET_ROWS * sizePx}px`;
  el.style.backgroundPosition = `${-c.col * sizePx}px ${-c.row * sizePx}px`;
}

/** An element that shows a symbol. `show("/>")` changes it; nothing to draw hides it. */
export function createSymbolIcon(sizePx: number): {
  el: HTMLElement;
  show(sym: string | undefined): void;
} {
  const base = h("span", { class: "sym-icon-layer" });
  const over = h("span", { class: "sym-icon-layer" });
  const el = h("span", { class: "sym-icon", attrs: { "aria-hidden": "true" } }, base, over);
  el.style.width = el.style.height = `${sizePx}px`;
  return {
    el,
    show(sym): void {
      const s = sym === undefined ? undefined : symbolSprite(sym);
      el.hidden = s === undefined;
      if (!s) return;
      paint(base, s.base, sizePx);
      over.hidden = s.overlay === undefined;
      if (s.overlay) paint(over, s.overlay, sizePx);
    },
  };
}
