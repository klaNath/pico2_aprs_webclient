/**
 * The BLE link as the device client sees it. Implementations: `MockTransport` (tests, demo) and,
 * later, a Web Bluetooth one.
 *
 * Contract:
 * - `connect()` resolves only when the link is usable: connected, paired (the passkey dialog of
 *   §4 is done, so this may take as long as the user needs), and TX notifications are started.
 *   After that, `write()` may be called and `onData` delivers notifications. It rejects if any of
 *   that fails.
 * - `disconnect()` closes the link. It must also make a pending `connect()` reject, and a pending
 *   `write()` reject, so that nothing hangs. It may be called when not connected.
 * - `onDisconnect` fires when the link goes away for any reason, including after the app's own
 *   `disconnect()`. The callback must not assume the app is the cause.
 * - `write()` must reject (not resolve) when the write did not complete.
 */
export interface Transport {
  /**
   * Identifies the remote device across connections (for Web Bluetooth: `BluetoothDevice.id`).
   * Optional. The app keeps the feed when it connects to the same device again and clears it for
   * another one; without an id it falls back to what `hello` says.
   */
  readonly deviceId?: string;
  /** Connect, pair and start notifications. See the contract above. */
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** One BLE write. `chunk` is at most MAX_WRITE_BYTES long (§5.2). Resolves when it completed. */
  write(chunk: Uint8Array): Promise<void>;
  /** Register the notification callback. Returns a function that removes it. */
  onData(cb: (chunk: Uint8Array) => void): () => void;
  /** Register the disconnect callback. Returns a function that removes it. */
  onDisconnect(cb: (reason?: string) => void): () => void;
}
