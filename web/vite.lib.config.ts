import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import prefixSelector from "postcss-prefix-selector";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  css: {
    postcss: {
      plugins: [
        prefixSelector({
          prefix: "html[data-lfg-app-surface]",
          transform(prefix, selector, prefixedSelector) {
            if (selector === ":root" || selector === "html") return prefix;
            if (selector.startsWith("html")) {
              return selector.replace(/^html/, prefix);
            }
            if (selector === ".dark") return `${prefix}.dark`;
            if (selector.startsWith(".dark ")) {
              return `${prefix}.dark${selector.slice(".dark".length)}`;
            }
            return prefixedSelector;
          },
        }),
      ],
    },
  },
  build: {
    outDir: "dist-lib",
    sourcemap: false,
    lib: {
      entry: path.resolve(dirname, "src/embedded.tsx"),
      formats: ["es"],
      fileName: "index",
      cssFileName: "styles",
    },
    rollupOptions: {
      external: [
        "react",
        "react-dom",
        "react-dom/client",
        "react/jsx-runtime",
      ],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(dirname, "./src"),
    },
    dedupe: ["react", "react-dom"],
  },
});
