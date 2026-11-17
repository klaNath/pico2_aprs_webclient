/**
 * Minimal typed event emitter. A listener that throws (or returns a rejected promise) is reported
 * with console.error and does not stop the other listeners or the caller.
 */
export class Emitter<Events extends Record<string, unknown>> {
  private handlers: { [K in keyof Events]?: Set<{ cb: (v: Events[K]) => unknown }> } = {};

  /** Each call is its own registration: the same callback twice is called twice. */
  on<K extends keyof Events>(event: K, cb: (v: Events[K]) => unknown): () => void {
    const entry = { cb };
    (this.handlers[event] ??= new Set()).add(entry);
    return () => {
      this.handlers[event]?.delete(entry);
    };
  }

  protected emit<K extends keyof Events>(event: K, value: Events[K]): void {
    for (const { cb } of [...(this.handlers[event] ?? [])]) {
      try {
        const r = cb(value);
        if (r instanceof Promise) r.catch((e: unknown) => report(event, e));
      } catch (e) {
        report(event, e);
      }
    }
  }

  /** Remove every listener. */
  protected clearListeners(): void {
    this.handlers = {};
  }
}

function report(event: PropertyKey, e: unknown): void {
  console.error(`listener for "${String(event)}" failed:`, e);
}
