import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// lfg's Bun server (serve.ts) owns process-control + streams under /api/*.
// In dev the Vite server proxies them through so the SPA stays single-origin.
const API_TARGET = process.env.LFG_API_TARGET ?? "http://localhost:8766";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Emit source maps so the auto-fix agent can map a minified production stack
  // frame back to the original source in web/src. "hidden" keeps the .map files
  // out of the served bundle's sourceMappingURL (no end-user devtools exposure),
  // while still writing web/dist/assets/*.js.map for server-side / agent use.
  build: { sourcemap: "hidden" },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    // Keep a single React instance across the app — duplicate React = hook errors.
    dedupe: ["react", "react-dom"],
  },
  server: {
    host: true, // bind 0.0.0.0 so the dev server is reachable over the network
    port: 5174,
    // Served to the tailnet via `tailscale serve` (HTTPS on dev.<tailnet>.ts.net
    // → 127.0.0.1:5174). Allow that Host header, and point the HMR socket at the
    // 443 proxy so live-reload survives the hop. A trusted TLS origin is also
    // what makes getUserMedia (voice) and the service worker available on phones.
    allowedHosts: true,
    hmr: { clientPort: 443 },
    proxy: {
      "/api": { target: API_TARGET, changeOrigin: true },
    },
  },
  // `vite preview` serves the built app (dist) with NO hot-reload — this is what
  // we expose over tailscale so the phone view stays put while we keep editing
  // source. Same host/proxy story as dev; rebuild to publish an update.
  preview: {
    host: true,
    port: 5174,
    allowedHosts: true,
    proxy: {
      "/api": { target: API_TARGET, changeOrigin: true },
    },
  },
});
