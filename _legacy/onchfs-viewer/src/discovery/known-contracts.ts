import type { ChainKey } from "../chains";

/**
 * Curated list of known fxhash NFT contracts that the on-chain fallback can
 * scan when GraphQL is unreachable. This is **not exhaustive** — each fxhash
 * project on EVM gets its own contract, and there are thousands of them.
 *
 * The principle: rather than try to enumerate everything (impossible without
 * an indexer), preserve access to a curated set of important / collected works
 * by their contract addresses. Users can extend this list with contracts they
 * personally want archival access to.
 *
 * When adding entries here:
 *   - Pull the project name from fxhash.xyz while it's still online
 *   - Verify the contract is verified on Etherscan/Basescan
 *   - Sanity-check by calling `name()` and `tokenURI(0)` to confirm it's
 *     actually an fxhash project token
 */
export interface KnownContract {
  chain: ChainKey;
  address: `0x${string}`;
  /** Human-readable project name for display. */
  projectName: string;
  /** Artist name, if known. */
  artistName?: string;
  /** Standard interface to use when calling: "GENTK" (fxhash 2.0) or "ProjectTokenV2" (FXH protocol). */
  kind: "GENTK" | "ProjectTokenV2";
}

/**
 * Known contracts list. Extend freely.
 *
 * Two real entries to start with — the contracts we've already verified work
 * through the viewer. Add more as you discover important works to preserve.
 */
export const KNOWN_CONTRACTS: KnownContract[] = [
  {
    chain: "ethereum",
    address: "0xBb47F0ED4A7E3BffcA75660dFa3B053FB7FcE78E",
    projectName: "Genomes",
    artistName: "Mike Tyka",
    kind: "GENTK",
  },
  {
    chain: "base",
    address: "0x1695Ac117aBAAfd92653Ca21f5CF071bC51d7Dc0",
    projectName: "rayincarnations",
    artistName: "volatilemoods",
    kind: "ProjectTokenV2",
  },
  // Add more known contracts here over time.
];
