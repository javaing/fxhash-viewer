/**
 * Registers the Service Worker that intercepts /view/* requests and resolves
 * them via onchfs / IPFS. Without the SW, the iframe inside the viewer
 * couldn't load relative-path assets correctly.
 *
 * If SW isn't available (e.g. file:// or a privacy mode), the page can still
 * function in a more limited way using blob: URLs — but SW is the canonical
 * path.
 */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) {
    console.warn("[sw] Service Workers not supported in this environment");
    return null;
  }

  try {
    const reg = await navigator.serviceWorker.register("/sw.js", {
      scope: "/",
      type: "module",
    });
    await navigator.serviceWorker.ready;
    return reg;
  } catch (err) {
    console.error("[sw] registration failed", err);
    return null;
  }
}
