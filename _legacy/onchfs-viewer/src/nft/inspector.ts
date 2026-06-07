import { getClient, type ChainKey } from "../chains";
import { projectTokenV2Abi } from "./abi";

export interface VersionInfo {
  version: number;
  renderer: `0x${string}`;
  mutableURI: string;
  immutableURI: string;
  lastIteration: bigint;
  onchainPointer: `0x${string}`;
}

export interface NftMetadata {
  name: string;
  symbol: string;
  currentVersion: number;
  version: VersionInfo;
}

/**
 * Reads fxhash project metadata directly from contract storage, bypassing
 * `tokenURI()`.
 *
 * Why bypass tokenURI:
 *   tokenURI() returns "https://media.fxhash.xyz/metadata/.../metadata.json"
 *   which is a centralized HTTP endpoint. If fxhash goes away, that URL
 *   stops resolving, and any viewer that depends on it dies with fxhash.
 *
 * What we do instead:
 *   1. Read currentVersion() — a simple uint stored on-chain.
 *   2. Read versionInfo(currentVersion) — returns the renderer, IPFS/onchfs
 *      URIs, and onchain pointer, all from contract storage.
 *   3. The immutableURI is what we hand to the URI resolver.
 *
 * This path uses only public RPC + immutable contract code, so it survives
 * fxhash's hypothetical disappearance.
 */
export async function inspectNft(
  chain: ChainKey,
  contract: `0x${string}`,
): Promise<NftMetadata> {
  const client = getClient(chain);

  // Read the simple bits in parallel.
  const [name, symbol, currentVersion] = await Promise.all([
    client.readContract({ address: contract, abi: projectTokenV2Abi, functionName: "name" }),
    client.readContract({ address: contract, abi: projectTokenV2Abi, functionName: "symbol" }),
    client.readContract({ address: contract, abi: projectTokenV2Abi, functionName: "currentVersion" }),
  ]);

  // Then the version-specific data.
  const versionResult = await client.readContract({
    address: contract,
    abi: projectTokenV2Abi,
    functionName: "versionInfo",
    args: [currentVersion],
  });

  // viem returns named-tuple outputs as either an array or an object depending
  // on ABI shape. Our ABI declares named outputs, so it should be an object —
  // we destructure defensively just in case.
  const [renderer, mutableURI, immutableURI, lastIteration, onchainPointer] = versionResult as readonly [
    `0x${string}`,
    string,
    string,
    bigint,
    `0x${string}`,
  ];

  return {
    name,
    symbol,
    currentVersion: Number(currentVersion),
    version: {
      version: Number(currentVersion),
      renderer,
      mutableURI,
      immutableURI,
      lastIteration,
      onchainPointer,
    },
  };
}

/**
 * Picks the best URI for resolving the generative bundle.
 *
 * Priority:
 *   1. immutableURI (the canonical, content-addressed pointer)
 *   2. mutableURI (only as a last resort — it can change)
 *
 * Returns null if neither is present, which would indicate a project that
 * stored its content via onchainPointer only (a Solidity contract whose
 * bytecode is the data, SSTORE2-style). That path isn't supported yet.
 */
export function pickGenerativeUri(info: VersionInfo): string | null {
  if (info.immutableURI) return info.immutableURI;
  if (info.mutableURI) return info.mutableURI;
  return null;
}
