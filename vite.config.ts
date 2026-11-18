import { defineConfig, type Plugin } from "vite";

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

export default defineConfig({ plugins: [noCspInDev] });
