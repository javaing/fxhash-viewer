/**
 * Builds the query string and hash fragment that fxhash generative artworks
 * expect to receive when they're loaded standalone.
 *
 * Convention reverse-engineered from fxhash artifact URIs and the fxhash
 * snippet SDK source:
 *   ?cid=onchfs://...
 *   &fxhash={hash}                — generation hash (hex for EVM, base58 for Tezos)
 *   &fxminter={addr}             — minter address (tz1... or 0x...)
 *   &fxiteration={n}             — iteration number within the project
 *   &fxcontext=standalone        — context flag
 *   &fxchain={ETHEREUM|BASE|TEZOS} — chain identifier (v3+ artworks)
 *   &fxparams={hex}              — params (SDK v2, in query string)
 *   #0x{hex}                     — params (SDK v3+, in hash fragment)
 */
export interface FxParams {
  /** The full uri (onchfs:// or ipfs://). */
  cid: string;
  /** Hash used as the RNG seed (hex for EVM, base58 for Tezos). */
  fxhash: string;
  /** Iteration number within the project. */
  iteration: number;
  /** Address of the minter wallet. */
  minter?: string;
  /** Chain identifier for v3+ artworks. */
  chain?: string;
  /** Optional input bytes for parametric works. */
  inputBytes?: string;
}

const CHAIN_TO_FXCHAIN: Record<string, string> = {
  ethereum: "ETHEREUM",
  base: "BASE",
  tezos: "TEZOS",
};

export function buildArtworkUrlSuffix(params: FxParams): string {
  const qs = new URLSearchParams();
  qs.set("cid", params.cid);
  qs.set("fxhash", params.fxhash);
  qs.set("fxiteration", String(params.iteration));
  qs.set("fxcontext", "standalone");

  if (params.chain) {
    qs.set("fxchain", CHAIN_TO_FXCHAIN[params.chain] || params.chain.toUpperCase());
  }

  if (params.minter) {
    qs.set("fxminter", params.minter);
  }
  // If minter is unknown, don't set fxminter at all — let the artwork's
  // boilerplate handle the absence. Passing a fake address (burn address)
  // is worse because artworks that use fxminter for visual output will
  // render the wrong composition.

  if (params.inputBytes) {
    qs.set("fxparams", params.inputBytes);
  }

  const queryString = "?" + qs.toString();
  const hash = params.inputBytes ? `#0x${params.inputBytes}` : "";
  return queryString + hash;
}
