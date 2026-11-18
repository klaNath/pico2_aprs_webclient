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

export const PREFS_KEY = "pico2aprs.prefs";

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

/** The part of localStorage that Prefs uses (a fake in tests). */
export interface PrefsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** localStorage, or undefined when even touching it throws (blocked site data). */
function defaultStorage(): PrefsStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export class Prefs {
  private data: PrefsData;
  private readonly listeners = new Set<() => void>();
  private readonly storage: PrefsStorage | null;

  /** `storage` is localStorage unless a test passes a fake (null = no storage at all). */
  constructor(storage: PrefsStorage | null = defaultStorage()) {
    this.storage = storage;
    this.data = this.load() ?? { ...DEFAULT_PREFS };
    // Another tab of the app changed a preference: take it in instead of overwriting it later.
    if (typeof window !== "undefined") {
      window.addEventListener("storage", (ev) => {
        if (ev.key !== null && ev.key !== PREFS_KEY) return;
        this.data = this.load() ?? this.data;
        for (const l of this.listeners) l();
      });
    }
  }

  get<K extends keyof PrefsData>(key: K): PrefsData[K] {
    return this.data[key];
  }

  /**
   * Changes one value. The stored copy is read again first, so changes another tab made to other
   * keys are kept (last write wins per key, not for the whole object).
   */
  set<K extends keyof PrefsData>(key: K, value: PrefsData[K]): void {
    this.data = sanitizePrefs({ ...(this.load() ?? this.data), [key]: value });
    this.save();
    for (const l of this.listeners) l();
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** The stored preferences, or undefined when storage is missing or unreadable. */
  private load(): PrefsData | undefined {
    try {
      const text = this.storage?.getItem(PREFS_KEY);
      if (text === undefined || text === null) return undefined;
      return sanitizePrefs(text ? JSON.parse(text) : undefined);
    } catch {
      return undefined;
    }
  }

  private save(): void {
    try {
      this.storage?.setItem(PREFS_KEY, JSON.stringify(this.data));
    } catch {
      // Storage unavailable: keep the value in memory only.
    }
  }
}
