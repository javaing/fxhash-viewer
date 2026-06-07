import { zipSync, strToU8 } from "fflate";
import { listByPrefix } from "../cache/chunks";
import { parseUri } from "../resolver/uri";

/**
 * Archive parameters — everything needed to reconstruct the artwork offline.
 */
export interface ArchiveParams {
  /** The generative URI (`onchfs://...` or `ipfs://...`). */
  uri: string;
  /** fxhash RNG seed. */
  fxhash: string;
  /** Iteration number. */
  iteration: number;
  /** Minter address. */
  minter: string;
  /** Human-readable name for the archive filename. */
  name?: string;
}

/**
 * Build a ZIP archive of a previously-viewed artwork from the local cache
 * and trigger a browser download.
 *
 * The archive contains:
 *   - All files that were resolved when the artwork was viewed (HTML, JS,
 *     CSS, images, model weights, etc.)
 *   - `_metadata.json` with fxhash parameters and provenance info
 *   - `_start.html` — a standalone launcher that opens the artwork with
 *     the correct parameters in any local HTTP server
 *   - `_README.txt` — instructions for offline viewing
 *
 * Returns the number of files archived (0 means nothing was in cache).
 */
export async function createArchive(params: ArchiveParams): Promise<number> {
  const parsed = parseUri(params.uri);
  const entries = await listByPrefix(parsed.scheme, parsed.cid);

  if (entries.length === 0) {
    throw new Error(
      "No cached files found for this artwork. Please load the artwork first, " +
        "then try archiving again. The archive is built from your local cache.",
    );
  }

  // Build the ZIP file structure.
  const zipData: Record<string, Uint8Array> = {};

  // 1. All artwork files.
  for (const entry of entries) {
    zipData[entry.path] = entry.body;
  }

  // 2. Metadata JSON.
  const metadata = {
    uri: params.uri,
    scheme: parsed.scheme,
    cid: parsed.cid,
    fxhash: params.fxhash,
    iteration: params.iteration,
    minter: params.minter,
    archivedAt: new Date().toISOString(),
    archivedBy: "onchfs-viewer",
    fileCount: entries.length,
    files: entries.map((e) => ({
      path: e.path,
      size: e.body.length,
      contentType: e.headers["content-type"] ?? "unknown",
    })),
  };
  zipData["_metadata.json"] = strToU8(JSON.stringify(metadata, null, 2));

  // 3. Standalone launcher HTML.
  zipData["_start.html"] = strToU8(buildStartHtml(params));

  // 4. README.
  zipData["_README.txt"] = strToU8(buildReadme(params, entries.length));

  // Create the ZIP and trigger download.
  const zipped = zipSync(zipData);
  const blob = new Blob([zipped], { type: "application/zip" });
  const url = URL.createObjectURL(blob);

  const safeName = (params.name ?? "artwork")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 60);
  const filename = `archive-${safeName}.zip`;

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  return entries.length;
}

function buildStartHtml(params: ArchiveParams): string {
  const qs = new URLSearchParams();
  qs.set("fxhash", params.fxhash);
  qs.set("fxiteration", String(params.iteration));
  qs.set("fxcontext", "standalone");
  if (params.minter) qs.set("fxminter", params.minter);

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Archived: ${escapeHtml(params.name ?? "fxhash artwork")}</title>
  <style>
    body { margin: 0; background: #000; color: #ccc; font-family: monospace; }
    .info { padding: 20px; font-size: 13px; line-height: 1.6; max-width: 600px; }
    a { color: #d4ff00; }
    code { background: #222; padding: 2px 6px; }
  </style>
</head>
<body>
  <div class="info">
    <h2>Archived Artwork</h2>
    <p><strong>URI:</strong> <code>${escapeHtml(params.uri)}</code></p>
    <p><strong>fxhash:</strong> <code>${escapeHtml(params.fxhash)}</code></p>
    <p><strong>Iteration:</strong> ${params.iteration}</p>
    <p><strong>Minter:</strong> <code>${escapeHtml(params.minter || "unknown")}</code></p>
    <hr>
    <p>This archive was created by <strong>onchfs-viewer</strong>.</p>
    <p>To view the artwork, serve this folder with a local HTTP server:</p>
    <pre>npx serve .
# or
python -m http.server 8080</pre>
    <p>Then open: <a href="index.html?${escapeHtml(qs.toString())}">index.html?${escapeHtml(qs.toString())}</a></p>
    <p><em>Note: Opening index.html directly via file:// may not work because
    generative artworks often use JavaScript features that require HTTP.</em></p>
    <script>
      // Auto-redirect if we're already on HTTP
      if (location.protocol === "http:" || location.protocol === "https:") {
        location.href = "index.html?${qs.toString().replace(/"/g, '\\"')}";
      }
    </script>
  </div>
</body>
</html>`;
}

function buildReadme(params: ArchiveParams, fileCount: number): string {
  return `onchfs-viewer Archive
=====================

Artwork: ${params.name ?? "Unknown"}
URI:     ${params.uri}
fxhash:  ${params.fxhash}
Iter:    ${params.iteration}
Minter:  ${params.minter || "unknown"}
Files:   ${fileCount}
Date:    ${new Date().toISOString()}

How to view
-----------
1. Extract this ZIP into a folder.
2. Open a terminal in that folder.
3. Run a local HTTP server:

   npx serve .
   # or
   python -m http.server 8080

4. Open _start.html in your browser.
   It will redirect to index.html with the correct parameters.

Why not just open index.html directly?
--------------------------------------
Generative artworks use JavaScript features (ES modules, fetch, canvas)
that require HTTP protocol. Opening via file:// will likely fail.

About this archive
------------------
Created by onchfs-viewer, a fxhash-independent viewer for on-chain
generative art. The bytes in this archive were read directly from the
Ethereum blockchain (onchfs) or IPFS, without using fxhash servers.

Even if fxhash.xyz, this viewer, and all IPFS gateways disappear,
these bytes are the artwork. As long as you have them and a browser,
the art lives.
`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
