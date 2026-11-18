// Notices about the installed app (PWA): a new version is waiting, or the app works offline now.

import { h, setText } from "./dom.ts";

/** What the "new version" notice says. Updating reloads the page, which ends the connection. */
export function updateNoticeText(connected: boolean): string {
  return connected
    ? "A new version is available. Updating reloads the app and ends the connection to the tracker."
    : "A new version is available.";
}

export const OFFLINE_READY_TEXT = "The app is saved on this device and works without a network.";

export interface UpdateBanner {
  /** Two banners for the shell's notice area. Hidden until `setUpdateReady` / `setOfflineReady`. */
  els: [HTMLElement, HTMLElement];
  setUpdateReady(): void;
  setOfflineReady(): void;
  /** Keep the wording right while the connection changes. */
  render(connected: boolean): void;
  /** True while either banner is showing. */
  readonly visible: boolean;
}

export function createUpdateBanner(applyUpdate: () => Promise<void>): UpdateBanner {
  let updateReady = false;
  let offlineReady = false;

  const updateText = h("span");
  const updateBtn = h("button", {
    class: "btn btn-small",
    text: "Update",
    attrs: { type: "button" },
    on: { click: () => void applyUpdate() },
  });
  const update = h(
    "div",
    { class: "banner banner-info", hidden: true, attrs: { role: "status" } },
    updateText,
    updateBtn,
  );

  const offline = h(
    "div",
    { class: "banner banner-info", hidden: true, attrs: { role: "status" } },
    h("span", { text: OFFLINE_READY_TEXT }),
    h("button", {
      class: "btn btn-small",
      text: "Dismiss",
      attrs: { type: "button" },
      on: {
        click: () => {
          offlineReady = false;
          offline.hidden = true;
        },
      },
    }),
  );

  return {
    els: [update, offline],
    setUpdateReady() {
      updateReady = true;
      update.hidden = false;
    },
    setOfflineReady() {
      offlineReady = true;
      offline.hidden = false;
    },
    render(connected) {
      setText(updateText, updateNoticeText(connected));
    },
    get visible() {
      return updateReady || offlineReady;
    },
  };
}
