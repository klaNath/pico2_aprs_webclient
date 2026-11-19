import { describe, expect, it } from "vitest";
import { symbolSprite } from "../src/ui/symbolIcon.ts";

const P = "aprs-symbols/aprs-symbols-64-0.png";
const A = "aprs-symbols/aprs-symbols-64-1.png";
const O = "aprs-symbols/aprs-symbols-64-2.png";

describe("symbolSprite (cell = code - 33, 16 columns)", () => {
  it("finds primary and alternate cells", () => {
    expect(symbolSprite("/!")).toEqual({ base: { sheet: P, col: 0, row: 0 } });
    expect(symbolSprite("/>")).toEqual({ base: { sheet: P, col: 13, row: 1 } }); // car
    expect(symbolSprite("/0")).toEqual({ base: { sheet: P, col: 15, row: 0 } });
    expect(symbolSprite("\\k")).toEqual({ base: { sheet: A, col: 10, row: 4 } }); // SUV
  });
  it("draws an overlay character on top of the alternate symbol", () => {
    expect(symbolSprite("A#")).toEqual({
      base: { sheet: A, col: 2, row: 0 },
      overlay: { sheet: O, col: 0, row: 2 }, // "A" is code 65 -> cell 32
    });
    expect(symbolSprite("5#")?.overlay).toEqual({ sheet: O, col: 4, row: 1 });
  });
  it("draws nothing for unassigned codes, bad tables and bad lengths", () => {
    expect(symbolSprite("/D")).toBeUndefined(); // unassigned in the primary table
    expect(symbolSprite("a>")).toBeUndefined();
    expect(symbolSprite("/")).toBeUndefined();
    expect(symbolSprite("/> ")).toBeUndefined();
    expect(symbolSprite("/ ")).toBeUndefined();
    expect(symbolSprite("/\u007f")).toBeUndefined();
  });
});
