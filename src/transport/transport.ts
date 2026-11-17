export interface Transport {
  /** Connect (and pair) and start notifications. */
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** One BLE write. `chunk` is at most MAX_WRITE_BYTES long. */
  write(chunk: Uint8Array): Promise<void>;
  onData(cb: (chunk: Uint8Array) => void): void;
  onDisconnect(cb: (reason?: string) => void): void;
}
