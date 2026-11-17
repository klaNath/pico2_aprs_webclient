/** Minimal typed event emitter. */
export class Emitter<Events extends Record<string, unknown>> {
  private handlers: { [K in keyof Events]?: Set<(v: Events[K]) => void> } = {};

  on<K extends keyof Events>(event: K, cb: (v: Events[K]) => void): () => void {
    (this.handlers[event] ??= new Set()).add(cb);
    return () => this.handlers[event]?.delete(cb);
  }

  protected emit<K extends keyof Events>(event: K, value: Events[K]): void {
    for (const cb of [...(this.handlers[event] ?? [])]) cb(value);
  }
}
