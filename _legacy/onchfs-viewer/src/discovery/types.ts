import type { ChainKey } from "../chains";

/**
 * Normalized representation of a single artwork owned by a wallet.
 *
 * Both the GraphQL path and the on-chain fallback path produce this shape,
 * so the UI consuming the discovery results doesn't have to care which
 * source they came from.
 */
export interface ArtworkItem {
  /** Stable identifier for React keys; combines chain, contract, and token. */
  key: string;

  /** Display name of the artwork itself ("Genomes #1196"). */
  name: string;

  /** Project / collection name ("Genomes"). May be empty if unknown. */
  projectName: string;

  /** Artist display name. May be empty if unknown. */
  artistName: string;

  /** Thumbnail URL for the iteration. May be an ipfs:// URI or https://. */
  thumbnailUri: string;

  /** Generative URI (`onchfs://...` or `ipfs://...`) that the viewer renders. */
  generativeUri: string;

  /** The 64-hex fxhash seed for this iteration. */
  fxhash: string;

  /** Iteration number within the project. */
  iteration: number;

  /** Minter wallet (the original creator of this iteration). */
  minter: string;

  /** fx(params) byte string for parametric artworks. Empty if non-parametric. */
  fxparams: string;

  /** Which chain this artwork lives on. */
  chain: ChainKey;

  /** NFT contract address (project token). */
  contract: `0x${string}`;

  /** ERC-721 token ID within that contract. */
  tokenId: string;

  /** Provenance of this discovery result, for diagnostics & UI hints. */
  source: "graphql" | "onchain";
}

/**
 * Discovery results from any source.
 */
export interface DiscoveryResult {
  items: ArtworkItem[];
  /** Where did the data come from? */
  source: "graphql" | "onchain" | "mixed";
  /** Per-source diagnostic messages, useful for telling the user what happened. */
  diagnostics: string[];
}
