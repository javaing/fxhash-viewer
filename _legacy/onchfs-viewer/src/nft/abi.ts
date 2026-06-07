/**
 * Minimal ABI for fxhash's ProjectTokenV2 NFT contracts.
 *
 * Only the read functions we need are included — the goal is to bypass
 * `tokenURI()` (which returns an https://media.fxhash.xyz/... URL we don't
 * want to depend on) and instead read the version data directly from
 * contract storage, where the IPFS/onchfs URI lives.
 *
 * Source: https://basescan.org/address/0x1695ac117abaafd92653ca21f5cf071bc51d7dc0#code
 */
export const projectTokenV2Abi = [
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "currentVersion",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "versionInfo",
    stateMutability: "view",
    inputs: [{ name: "version", type: "uint256" }],
    outputs: [
      { name: "renderer", type: "address" },
      { name: "mutableURI", type: "string" },
      { name: "immutableURI", type: "string" },
      { name: "lastIteration", type: "uint256" },
      { name: "onchainPointer", type: "address" },
    ],
  },
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "address" }],
  },
] as const;
