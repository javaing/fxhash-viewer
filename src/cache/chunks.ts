import { get, set, del, keys } from "idb-keyval";

/**
 * Persistent cache for resolved bytes.
 *
 * Both onchfs chunks and IPFS responses are content-addressed and effectively
 * immutable, so we can cache them indefinitely. The cache key includes the
 * scheme so onchfs and IPFS namespaces never collide.
 *
 * The cache lives in IndexedDB via idb-keyval, which means it survives page
 * reloads and works fully offline once content has been seen once. This is
 * the second leg of the fxhash-independence story: even if all RPCs and
 * gateways disappear, previously-viewed art still loads from local storage.
 */

interface CachedEntry {
  body: Uint8Array;
  // Serialized headers so we don't lose Content-Type etc.
  headers: Record<string, string>;
  cachedAt: number;
}

function key(scheme: string, addr: string): string {
  return `resource:${scheme}:${addr}`;
}

export async function getCached(scheme: string, addr: string): Promise<CachedEntry | null> {
  try {
    const v = await get<CachedEntry>(key(scheme, addr));
    return v ?? null;
  } catch {
    return null;
  }
}

export async function setCached(
  scheme: string,
  addr: string,
  body: Uint8Array,
  headers: Headers,
): Promise<void> {
  const headersObj: Record<string, string> = {};
  headers.forEach((v, k) => {
    headersObj[k] = v;
  });
  try {
    await set(key(scheme, addr), {
      body,
      headers: headersObj,
      cachedAt: Date.now(),
    } satisfies CachedEntry);
  } catch (err) {
    // Quota errors etc. are non-fatal — caching is best-effort.
    console.warn("[cache] failed to persist", scheme, addr, err);
  }
}

export async function clearCached(scheme: string, addr: string): Promise<void> {
  await del(key(scheme, addr));
}

/**
 * List all cached entries whose key starts with the given scheme + CID prefix.
 *
 * Used by the archive feature to enumerate all files belonging to a single
 * artwork directory. Returns pairs of [relativePath, CachedEntry].
 */
export async function listByPrefix(
  scheme: string,
  cidPrefix: string,
): Promise<Array<{ path: string; body: Uint8Array; headers: Record<string, string> }>> {
  const prefix = `resource:${scheme}:${cidPrefix}`;
  const allKeys = await keys<string>();
  const matching = allKeys.filter((k) => typeof k === "string" && k.startsWith(prefix));

  const results: Array<{ path: string; body: Uint8Array; headers: Record<string, string> }> = [];
  for (const k of matching) {
    try {
      const entry = await get<CachedEntry>(k);
      if (!entry) continue;
      // Strip the prefix to get the relative path within the directory.
      // e.g. "resource:onchfs:046f4712.../index.js" → "index.js"
      let relativePath = k.slice(prefix.length);
      // Trim leading slash; root directory "/" becomes ""
      if (relativePath.startsWith("/")) relativePath = relativePath.slice(1);
      if (!relativePath) relativePath = "index.html"; // root = index.html
      results.push({ path: relativePath, body: entry.body, headers: entry.headers });
    } catch {
      // Skip entries that can't be read.
    }
  }
  return results;
}
