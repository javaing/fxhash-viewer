import { discoverViaGraphQL } from "./fxhash-api";
import { discoverOnchain } from "./onchain";
import type { DiscoveryResult } from "./types";

export type { ArtworkItem, DiscoveryResult } from "./types";

/**
 * Discover artworks owned by a wallet using a hybrid strategy.
 *
 * Strategy:
 *   1. Try fxhash's GraphQL API first. It's fast, knows about every project,
 *      and returns full metadata including thumbnails and fxhash seeds.
 *
 *   2. If that succeeds with at least one item, return those. We assume
 *      fxhash is the authoritative source of truth while it's online.
 *
 *   3. If GraphQL fails (network down, schema mismatch, fxhash gone), or
 *      returns zero items (could be a wallet on a chain the API doesn't
 *      know yet), fall back to enumerating our hardcoded list of known
 *      NFT contracts via on-chain ERC-721 enumeration. This is the
 *      survivability path.
 *
 *   4. Both diagnostics are returned so the UI can show what happened
 *      (e.g. "GraphQL unreachable, fell back to on-chain — limited to N
 *      curated projects").
 */
export async function discoverWallet(walletAddress: string): Promise<DiscoveryResult> {
  const diagnostics: string[] = [];

  // Tier 1: GraphQL.
  const graphqlResult = await discoverViaGraphQL(walletAddress);
  if (graphqlResult) {
    diagnostics.push(`[GraphQL] ${graphqlResult.diagnostic}`);
    if (graphqlResult.items.length > 0) {
      return {
        items: graphqlResult.items,
        source: "graphql",
        diagnostics,
      };
    }
  } else {
    diagnostics.push("[GraphQL] unreachable.");
  }

  // Tier 2: on-chain fallback.
  const onchainResult = await discoverOnchain(walletAddress);
  diagnostics.push(`[On-chain] ${onchainResult.diagnostic}`);

  return {
    items: onchainResult.items,
    source: "onchain",
    diagnostics,
  };
}
