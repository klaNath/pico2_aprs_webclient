import { defineConfig, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// The dev server injects CSS as inline <style> elements and talks over a WebSocket, which the
// strict Content-Security-Policy of index.html forbids. Drop the policy for `npm run dev` only;
// builds keep it.
const noCspInDev: Plugin = {
  name: "no-csp-in-dev",
  apply: "serve",
  transformIndexHtml(html) {
    return html.replace(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>/, "");
  },
};

export default defineConfig({
  // Relative URLs: the app works from any path (GitHub Pages serves it under /<repo>/) and from
  // file:// for a quick look.
  base: "./",
  plugins: [
    noCspInDev,
    VitePWA({
      // The app asks the user before it updates (src/pwa.ts): a reload ends the Bluetooth
      // connection, so it must never happen by itself.
      registerType: "prompt",
      injectRegister: false,
      manifest: {
        name: "pico2 APRS",
        short_name: "pico2 APRS",
        description: "Control a pico2_aprs tracker over Bluetooth Low Energy.",
        lang: "en",
        id: "./",
        start_url: "./",
        scope: "./",
        display: "standalone",
        orientation: "portrait",
        background_color: "#0f141b",
        theme_color: "#0f141b",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // Everything the app needs is in the build: nothing is fetched at run time, so the whole
        // app is cached (precache) and starts offline.
        globPatterns: ["**/*.{js,css,html,svg,png,webmanifest}"],
        navigateFallback: "index.html",
        cleanupOutdatedCaches: true,
      },
    }),
  ],
});
