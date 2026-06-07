import { parseUri } from "./uri";
import { resolveIpfs, type ResolvedResource } from "./ipfs";
import { resolveOnchfs } from "./onchfs";
import type { ChainKey } from "../chains";

export type { ResolvedResource } from "./ipfs";

/**
 * Resolves any supported generative URI to its bytes + headers.
 *
 * The chain preference is only consulted for onchfs URIs whose authority
 * doesn't pin a specific chain. IPFS resolution is chain-independent.
 */
export async function resolve(uri: string, chainPreference: ChainKey): Promise<ResolvedResource> {
  const parsed = parseUri(uri);
  switch (parsed.scheme) {
    case "ipfs":
      return resolveIpfs(parsed);
    case "onchfs":
      return resolveOnchfs(parsed, chainPreference);
  }
}
