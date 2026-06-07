import type { ChainKey } from "../chains";

/**
 * Normalized representation of a single artwork (one iteration of a project).
 *
 * In the legacy app this shape was produced by two "discovery" paths — the
 * fxhash GraphQL API and an on-chain ERC-721 enumeration fallback. Both of
 * those depended (directly or as a convenience) on fxhash infrastructure,
 * which contradicts this viewer's goal of surviving fxhash's shutdown, and
 * neither was actually wired into the UI. They were dropped during migration.
 *
 * What remains is this shared shape, which the file/project loader in App.tsx
 * builds from local JSON (the output of extract-project.mjs) or a single
 * fxhash metadata file. Keeping the type here preserves the option of
 * re-introducing live discovery later without reshaping the UI.
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

  /** Provenance of this item, for diagnostics & UI hints. */
  source: "graphql" | "onchain";
}
