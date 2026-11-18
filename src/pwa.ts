// Service worker registration (PWA). Only in a production build: the dev server serves no worker.
//
// The app never updates by itself. A reload ends the Bluetooth connection and empties the feed
// held in memory, so a new version waits until the user presses "Update" (registerType "prompt").

import { registerSW } from "virtual:pwa-register";

export interface PwaHandlers {
  /** A new version is installed and waiting. */
  onNeedRefresh(): void;
  /** The app is cached and starts without a network. Called once, after the first install. */
  onOfflineReady(): void;
}

/** Registers the worker. Returns the function that applies the waiting version and reloads. */
export function registerPwa(handlers: PwaHandlers): () => Promise<void> {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return () => Promise.resolve();
  return registerSW({
    onNeedRefresh: handlers.onNeedRefresh,
    onOfflineReady: handlers.onOfflineReady,
    onRegisterError: (e: unknown) => console.error("service worker registration failed", e),
  });
}
