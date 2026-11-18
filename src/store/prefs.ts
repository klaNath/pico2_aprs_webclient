// UI preferences kept on this device (localStorage). Every access is guarded: storage can be
// blocked or empty (private window, cleared site data) and the app must work without it.

export type Theme = "auto" | "light" | "dark";
export type RadarScale = "log" | "linear";

export interface PrefsData {
  theme: Theme;
  /** Max rx/tx entries kept in memory (the feed). */
  logLimit: number;
  radarScale: RadarScale;
  /** Outer ring of the radar, in km (linear), or the log scale's maximum. */
  radarRangeKm: number;
}

export const LOG_LIMIT_MIN = 50;
export const LOG_LIMIT_MAX = 5000;

export const DEFAULT_PREFS: PrefsData = {
  theme: "auto",
  logLimit: 500,
  radarScale: "log",
  radarRangeKm: 50,
};

const KEY = "pico2aprs.prefs";

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v)
    ? Math.min(max, Math.max(min, Math.round(v)))
    : fallback;
}

/** Fill in defaults and drop anything invalid, so stored junk can never reach the UI. */
export function sanitizePrefs(raw: unknown): PrefsData {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    theme: r.theme === "light" || r.theme === "dark" ? r.theme : "auto",
    logLimit: clampInt(r.logLimit, LOG_LIMIT_MIN, LOG_LIMIT_MAX, DEFAULT_PREFS.logLimit),
    radarScale: r.radarScale === "linear" ? "linear" : "log",
    radarRangeKm: clampInt(r.radarRangeKm, 1, 20000, DEFAULT_PREFS.radarRangeKm),
  };
}

export class Prefs {
  private data: PrefsData;
  private readonly listeners = new Set<() => void>();

  constructor() {
    this.data = this.load();
  }

  get<K extends keyof PrefsData>(key: K): PrefsData[K] {
    return this.data[key];
  }

  set<K extends keyof PrefsData>(key: K, value: PrefsData[K]): void {
    this.data = sanitizePrefs({ ...this.data, [key]: value });
    this.save();
    for (const l of this.listeners) l();
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private load(): PrefsData {
    try {
      const text = localStorage.getItem(KEY);
      return sanitizePrefs(text ? JSON.parse(text) : undefined);
    } catch {
      return { ...DEFAULT_PREFS };
    }
  }

  private save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      // Storage unavailable: keep the value in memory only.
    }
  }
}
