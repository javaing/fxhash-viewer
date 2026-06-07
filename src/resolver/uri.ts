/**
 * Parses fxhash generative URIs.
 *
 * Schemes seen in the wild:
 *   onchfs://[authority/]<cid64>[/path][?query][#fragment]
 *   ipfs://<cid>[/path][?query][#fragment]
 *
 * The authority for onchfs identifies the chain/contract that holds the
 * content, e.g. onchfs://<contract-address>.eth/<cid> on Ethereum. We
 * tolerate it being absent (fall back to a configured default chain).
 */
export type ParsedUri =
  | { scheme: "onchfs"; cid: string; authority: string | null; path: string[]; query: string; hash: string }
  | { scheme: "ipfs"; cid: string; path: string[]; query: string; hash: string };

export function parseUri(uri: string): ParsedUri {
  const u = uri.trim();

  if (u.startsWith("onchfs://")) {
    const rest = u.slice("onchfs://".length);
    // Optional authority (e.g. "<addr>.eth") followed by "/", then a 64-hex CID.
    // We split off the first segment before any path/query/hash.
    const match = rest.match(
      /^(?:([^/?#]+)\/)?([0-9a-fA-F]{64})(?:\/([^?#]*))?(?:\?([^#]*))?(?:#(.*))?$/,
    );
    if (!match) throw new Error(`Invalid onchfs URI: ${uri}`);
    const [, authority, cid, path, query, hash] = match;
    return {
      scheme: "onchfs",
      cid: cid.toLowerCase(),
      authority: authority ?? null,
      path: path ? path.split("/").filter(Boolean) : [],
      query: query ?? "",
      hash: hash ?? "",
    };
  }

  if (u.startsWith("ipfs://")) {
    const rest = u.slice("ipfs://".length);
    const match = rest.match(/^([^/?#]+)(?:\/([^?#]*))?(?:\?([^#]*))?(?:#(.*))?$/);
    if (!match) throw new Error(`Invalid ipfs URI: ${uri}`);
    const [, cid, path, query, hash] = match;
    return {
      scheme: "ipfs",
      cid,
      path: path ? path.split("/").filter(Boolean) : [],
      query: query ?? "",
      hash: hash ?? "",
    };
  }

  throw new Error(`Unsupported URI scheme: ${uri}`);
}
