/**
 * Public surface of the (now type-only) discovery module.
 *
 * The legacy runtime — `discoverWallet()` (fxhash GraphQL) and the on-chain
 * ERC-721 enumeration fallback in `onchain.ts`/`nft/inspector.ts` — was
 * intentionally not migrated. It depended on fxhash's API and was never wired
 * into the UI. See `types.ts` for the rationale. Only the shared artwork
 * shape is re-exported so `App.tsx` can keep importing from `./discovery`.
 */
export type { ArtworkItem } from "./types";
