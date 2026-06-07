import { getClient } from "../chains";
import { inspectNft, pickGenerativeUri } from "../nft/inspector";
import { KNOWN_CONTRACTS, type KnownContract } from "./known-contracts";
import type { ArtworkItem } from "./types";

/**
 * Minimal ERC-721 enumeration ABI for the on-chain fallback.
 *
 * `balanceOf(owner)` gives a count; `tokenOfOwnerByIndex(owner, i)` walks
 * the ownership list. This is the IERC721Enumerable extension — not every
 * contract supports it, but fxhash's GENTK contracts do.
 */
const enumerableAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "tokenOfOwnerByIndex",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "index", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

/**
 * Try to discover artworks owned by the wallet using on-chain reads only.
 *
 * This is the "fxhash dies, we keep working" path. It only finds artworks
 * from contracts in `KNOWN_CONTRACTS`, which is a curated list. The
 * trade-off is intentional: enumerating every fxhash project contract
 * without an indexer is infeasible, and even if it were, scanning
 * thousands of contracts per wallet lookup would be very slow.
 *
 * Returns the artworks the wallet holds across all known contracts, in
 * the order the contracts appear in the list (and within each contract,
 * the order the contract returns them via tokenOfOwnerByIndex).
 */
export async function discoverOnchain(
  walletAddress: string,
): Promise<{ items: ArtworkItem[]; diagnostic: string }> {
  const owner = walletAddress.toLowerCase() as `0x${string}`;
  const items: ArtworkItem[] = [];
  const errors: string[] = [];

  for (const contract of KNOWN_CONTRACTS) {
    try {
      const found = await scanContract(contract, owner);
      items.push(...found);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${contract.projectName} (${contract.address.slice(0, 8)}...): ${msg}`);
    }
  }

  const diagnostic = [
    `Scanned ${KNOWN_CONTRACTS.length} known contract(s), found ${items.length} item(s).`,
    ...(errors.length > 0 ? [`Errors: ${errors.join("; ")}`] : []),
  ].join(" ");

  return { items, diagnostic };
}

async function scanContract(contract: KnownContract, owner: `0x${string}`): Promise<ArtworkItem[]> {
  const client = getClient(contract.chain);

  // How many tokens does the wallet hold from this contract?
  let balance: bigint;
  try {
    balance = (await client.readContract({
      address: contract.address,
      abi: enumerableAbi,
      functionName: "balanceOf",
      args: [owner],
    })) as bigint;
  } catch (err) {
    throw new Error(`balanceOf failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (balance === 0n) return [];

  // Walk the indexed ownership list. We cap at a reasonable limit because
  // tokenOfOwnerByIndex requires N RPC calls; for whales with hundreds of
  // tokens this would be heavy.
  const cap = balance > 100n ? 100n : balance;
  const tokenIds: bigint[] = [];
  for (let i = 0n; i < cap; i++) {
    try {
      const id = (await client.readContract({
        address: contract.address,
        abi: enumerableAbi,
        functionName: "tokenOfOwnerByIndex",
        args: [owner, i],
      })) as bigint;
      tokenIds.push(id);
    } catch {
      // If enumeration breaks midway (e.g. ERC721Enumerable not supported,
      // or RPC hiccup) we just stop and use what we have.
      break;
    }
  }

  // For each token id, get a minimal display record. For ProjectTokenV2
  // contracts we can call versionInfo to get the immutableURI directly.
  // For GENTK contracts we'd ideally call the renderer; for now we don't
  // attempt that and rely on URI mode for actual rendering.
  const projectInfo = await safeInspect(contract);

  return tokenIds.map((id) =>
    buildItem(contract, id.toString(), projectInfo),
  );
}

async function safeInspect(
  contract: KnownContract,
): Promise<{ generativeUri: string; thumbnailUri: string } | null> {
  // Only ProjectTokenV2 has the versionInfo getter we know how to read.
  if (contract.kind !== "ProjectTokenV2") return null;
  try {
    const metadata = await inspectNft(contract.chain, contract.address);
    const generativeUri = pickGenerativeUri(metadata.version) ?? "";
    return { generativeUri, thumbnailUri: "" };
  } catch {
    return null;
  }
}

function buildItem(
  contract: KnownContract,
  tokenId: string,
  projectInfo: { generativeUri: string; thumbnailUri: string } | null,
): ArtworkItem {
  return {
    key: `${contract.chain}:${contract.address.toLowerCase()}:${tokenId}`,
    name: `${contract.projectName} #${tokenId}`,
    projectName: contract.projectName,
    artistName: contract.artistName ?? "",
    thumbnailUri: projectInfo?.thumbnailUri ?? "",
    generativeUri: projectInfo?.generativeUri ?? "",
    fxhash: "", // Not knowable from on-chain enumeration alone for GENTK contracts.
    iteration: Number(tokenId),
    minter: "",
    chain: contract.chain,
    contract: contract.address.toLowerCase() as `0x${string}`,
    tokenId,
    fxparams: "",
    source: "onchain",
  };
}
