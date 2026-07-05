import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Stamp a per-build version into the service worker's `__VERSION__` placeholder
// so each deploy ships a byte-different sw.js. That's what makes the browser run
// the install/activate lifecycle: the versioned caches roll over, every stale
// build's chunks get purged (instead of piling up forever and slowing the PWA
// down), and the page's native SW-update listener can raise the reload toast.
// The version is derived from the hashed entry chunk, so it only changes when
// the build's actual output changes.
function stampServiceWorkerVersion(): Plugin {
  let version = "dev";
  return {
    name: "lfg-sw-version",
    apply: "build",
    writeBundle(_options, bundle) {
      const entry = Object.values(bundle).find(
        (chunk) => chunk.type === "chunk" && chunk.isEntry,
      );
      const basis = entry?.fileName ?? Object.keys(bundle).sort().join("|");
      version = createHash("sha256").update(basis).digest("hex").slice(0, 12);
    },
    closeBundle() {
      const swPath = path.resolve(__dirname, "dist/sw.js");
      if (!fs.existsSync(swPath)) return;
      const src = fs.readFileSync(swPath, "utf8");
      fs.writeFileSync(swPath, src.replaceAll("__VERSION__", version));
    },
  };
}

// lfg's Bun server (serve.ts) owns process-control + streams under /api/*.
// In dev the Vite server proxies them through so the SPA stays single-origin.
const API_TARGET = process.env.LFG_API_TARGET ?? "http://localhost:8766";

export default defineConfig({
  plugins: [react(), tailwindcss(), stampServiceWorkerVersion()],
  // Emit source maps so the auto-fix agent can map a minified production stack
  // frame back to the original source in web/src. "hidden" keeps the .map files
  // out of the served bundle's sourceMappingURL (no end-user devtools exposure),
  // while still writing web/dist/assets/*.js.map for server-side / agent use.
  build: {
    sourcemap: "hidden",
    rollupOptions: {
      output: {
        // Pin React + ReactDOM into their own chunk. They change only on a React
        // upgrade, so the hash stays stable across app deploys — returning users
        // reuse the cached copy instead of re-downloading it inside the entry.
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) {
            return "react-vendor";
          }
        },
      },
    },
  },
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
