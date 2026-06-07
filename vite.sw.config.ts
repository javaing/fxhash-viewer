import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { resolve } from "node:path";

// Service Worker build: produces a single self-contained sw.js with ALL
// dynamic imports inlined. This is critical because browsers reject
// dynamic import() inside Service Workers, causing "script evaluation
// failed" errors.
//
// Run AFTER the main build: `vite build && vite build --config vite.sw.config.ts`
// The `emptyOutDir: false` prevents this build from clearing the main
// build's output.
export default defineConfig({
  plugins: [
    nodePolyfills({
      include: ["path", "buffer", "stream", "util", "events"],
      globals: { Buffer: true, global: true, process: true },
    }),
  ],
  build: {
    emptyOutDir: false,
    rollupOptions: {
      input: resolve(__dirname, "src/sw/worker.ts"),
      output: {
        entryFileNames: "sw.js",
        inlineDynamicImports: true,
        format: "es",
      },
    },
  },
});
