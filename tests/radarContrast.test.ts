// Colors the radar and the feed rely on, checked against the tokens in the CSS files: text needs
// 4.5:1, a mark that carries information on its own (not text) needs 3:1, in both themes.

import { describe, expect, it } from "vitest";

// The CSS files are read as text. (`?raw` imports come back empty under vitest, and the project
// has no Node type definitions, so the module name is not a literal.)
const fsModule = "node:fs";
const { readFileSync } = (await import(fsModule)) as {
  readFileSync(url: URL, encoding: "utf8"): string;
};
const css = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");
const feedCss = css("../src/ui/feed.css");
const radarCss = css("../src/ui/radar.css");
const styleCss = css("../src/style.css");

function lin(c: number): number {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
type Rgb = [number, number, number];
function rgb(hex: string): Rgb {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
}
function luminance(c: Rgb): number {
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
/** `fg` at opacity `alpha` over `bg`. */
function over(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  return fg.map((v, i) => Math.round(alpha * v + (1 - alpha) * bg[i]!)) as Rgb;
}

/** Token values from the first rule that matches `selector` exactly (the block between { }). */
function tokens(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no rule ${selector}`);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)) out[m[1]!] = m[2]!;
  return out;
}

const light = {
  ...tokens(styleCss, ":root"),
  ...tokens(radarCss, ":root"),
};
const dark = {
  ...light,
  ...tokens(styleCss, ':root[data-theme="dark"]'),
  ...tokens(radarCss, ':root[data-theme="dark"]'),
};
const themes = { light, dark } as const;

/** The opacity of the stroke of an out-of-range "other" mark, from radar.css. */
function otherOutOpacity(): number {
  const m = /\.radar-st\.out \.radar-mark\.cat-other\s*\{[^}]*stroke-opacity:\s*([\d.]+)/.exec(
    radarCss,
  );
  if (!m) throw new Error("no out-of-range rule for cat-other");
  return Number(m[1]);
}

describe("tokens are read from the CSS", () => {
  it("both themes have the values used below", () => {
    for (const t of Object.values(themes)) {
      for (const k of ["bg", "surface", "ok", "ok-bg", "radar-other", "radar-vehicle"]) {
        expect(t[k], k).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
    expect(light.bg).not.toBe(dark.bg);
  });
});

describe("radar: out-of-range 'other' mark (a cross, not text: 3:1)", () => {
  for (const [name, t] of Object.entries(themes)) {
    for (const bgName of ["surface", "bg"] as const) {
      it(`${name} theme, over --${bgName}`, () => {
        const bg = rgb(t[bgName]!);
        const mark = over(rgb(t["radar-other"]!), bg, otherOutOpacity());
        expect(contrast(mark, bg)).toBeGreaterThanOrEqual(3);
      });
    }
  }
  it("the old opacity (0.6) was not enough in the light theme", () => {
    const bg = rgb(light.surface!);
    expect(contrast(over(rgb(light["radar-other"]!), bg, 0.6), bg)).toBeLessThan(3);
  });
});

describe("radar: category colors on the card and the disc (non-text: 3:1)", () => {
  for (const [name, t] of Object.entries(themes)) {
    for (const cat of ["vehicle", "person", "fixed", "digi", "weather", "other"]) {
      it(`${name}: ${cat}`, () => {
        for (const bg of [t.surface!, t.bg!]) {
          expect(contrast(rgb(t[`radar-${cat}`]!), rgb(bg))).toBeGreaterThanOrEqual(3);
        }
      });
    }
  }
});

describe("feed: the 'rx' badge text (4.5:1)", () => {
  const rx = /\.feed-dir-rx\s*\{[^}]*--feed-rx:\s*(#[0-9a-fA-F]{6})/.exec(feedCss);
  it("light theme uses its own darker green", () => {
    expect(rx).not.toBeNull();
    expect(contrast(rgb(rx![1]!), rgb(light["ok-bg"]!))).toBeGreaterThanOrEqual(4.5);
  });
  it("the shared --ok token was too light (the reason for the override)", () => {
    expect(contrast(rgb(light.ok!), rgb(light["ok-bg"]!))).toBeLessThan(4.5);
  });
  it("dark theme keeps --ok", () => {
    expect(contrast(rgb(dark.ok!), rgb(dark["ok-bg"]!))).toBeGreaterThanOrEqual(4.5);
  });
});
