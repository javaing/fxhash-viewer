import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// Main app build only. The Service Worker is built separately by
// vite.sw.config.ts to ensure it produces a single self-contained file
// with no dynamic imports (which browsers reject in SW context).
export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      include: ["path", "buffer", "stream", "util", "events"],
      globals: { Buffer: true, global: true, process: true },
    }),
  ],
});
