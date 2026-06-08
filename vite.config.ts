import { defineConfig, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { fileURLToPath } from "node:url";
import { dirname, basename, resolve } from "node:path";
// @ts-expect-error -- plain .mjs helper, no type declarations needed
import { writeIndex, PROJECTS_DIR } from "./scripts/build-index.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Keeps public/projects/_index.json in sync with the project JSON files.
 *
 * - Regenerates once on build/dev start (so production builds are always fresh).
 * - During `vite dev`, watches public/projects/*.json and regenerates + reloads
 *   the page whenever a project JSON is added, edited, or removed. This is what
 *   makes "edit a project JSON → gallery thumbnail updates" automatic.
 */
function projectIndex(): PluginOption {
  const projectsDir = resolve(__dirname, "public", "projects");
  const isProjectJson = (file: string) =>
    resolve(file).startsWith(projectsDir) &&
    file.endsWith(".json") &&
    !basename(file).startsWith("_"); // ignore _index.json itself → no loop

  return {
    name: "project-index",
    buildStart() {
      writeIndex(PROJECTS_DIR);
    },
    configureServer(server) {
      server.watcher.add(projectsDir);
      const regen = (file: string) => {
        if (!isProjectJson(file)) return;
        const n = writeIndex(PROJECTS_DIR);
        server.config.logger.info(`[project-index] regenerated (${n} projects)`);
        server.ws.send({ type: "full-reload" });
      };
      server.watcher.on("add", regen);
      server.watcher.on("change", regen);
      server.watcher.on("unlink", regen);
    },
  };
}

// Main app build only. The Service Worker is built separately by
// vite.sw.config.ts to ensure it produces a single self-contained file
// with no dynamic imports (which browsers reject in SW context).
export default defineConfig({
  plugins: [
    projectIndex(),
    react(),
    nodePolyfills({
      include: ["path", "buffer", "stream", "util", "events"],
      globals: { Buffer: true, global: true, process: true },
    }),
  ],
});
