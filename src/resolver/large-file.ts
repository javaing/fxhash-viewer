import { getClient, type ChainKey } from "../chains";
import type { Address } from "viem";

/**
 * Large-file reader: bypasses the onchfs package's `readFile()` for files
 * too large to read in a single contract call.
 *
 * Why this exists:
 *   The official onchfs package calls FileSystem.readFile(bytes32) which
 *   internally concatenates all chunks and returns the full bytes. For
 *   files larger than ~100KB this exhausts the eth_call gas limit (50M)
 *   during memory expansion. Files like neural-network weight blobs in
 *   onchfs-stored generative artworks routinely exceed this.
 *
 * What this does:
 *   1. Calls FileSystem.inodes(cid) to get the chunk pointer list.
 *   2. Reads chunks in small batches via FileSystem.concatenateChunks([...]).
 *   3. Concatenates the batches in JavaScript, avoiding any per-call gas
 *      blowup. Batch size is conservative to stay well under gas limits
 *      even for chunks larger than the common 24KB.
 *
 * Per-chain configuration of the FileSystem contract address comes from
 * the onchfs package's internal registry; we mirror those addresses here.
 */

// Contract addresses extracted from the onchfs package source (EVM only).
const FILESYSTEM_ADDRESSES: Partial<Record<ChainKey, Address>> = {
  ethereum: "0x9e0f2864c6f125bbf599df6ca6e6c3774c5b2e04",
  base: "0x2983008f292a43f208bba0275afd7e9b3d39af3b",
};

// We need a tiny ABI subset for the two functions we call directly.
const filesystemAbi = [
  {
    type: "function",
    name: "inodes",
    stateMutability: "view",
    inputs: [{ name: "checksum", type: "bytes32" }],
    outputs: [
      { name: "inodeType", type: "uint8" },
      {
        name: "file",
        type: "tuple",
        components: [
          { name: "metadata", type: "bytes" },
          { name: "chunkChecksums", type: "bytes32[]" },
        ],
      },
      {
        name: "directory",
        type: "tuple",
        components: [
          { name: "filenames", type: "string[]" },
          { name: "fileChecksums", type: "bytes32[]" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "concatenateChunks",
    stateMutability: "view",
    inputs: [{ name: "_pointers", type: "bytes32[]" }],
    outputs: [{ name: "fileContent", type: "bytes" }],
  },
] as const;

/**
 * Batch size for chunk reads. Empirically:
 *   - 5 chunks of 24KB each → 120KB returned, well under gas limits
 *   - 10 chunks of 24KB each → 240KB returned, also fine
 *   - 50 chunks → ran out of gas in our measurements
 *
 * We pick 5 as a safe default that scales to larger chunk sizes too.
 */
const CHUNK_BATCH_SIZE = 5;

interface ChunkedFileInode {
  metadata: Uint8Array;
  chunkPointers: `0x${string}`[];
}

/**
 * Read a file inode's chunk list and metadata.
 *
 * Returns null when the inode at `cid` isn't a file (it's a directory or
 * doesn't exist), letting callers know to fall back to other resolution
 * strategies.
 */
async function getFileInode(
  chain: ChainKey,
  cid: `0x${string}`,
): Promise<ChunkedFileInode | null> {
  const address = FILESYSTEM_ADDRESSES[chain];
  if (!address) return null;

  const client = getClient(chain);
  const result = await client.readContract({
    address,
    abi: filesystemAbi,
    functionName: "inodes",
    args: [cid],
  });

  const [inodeType, file] = result as readonly [
    number,
    { metadata: `0x${string}`; chunkChecksums: readonly `0x${string}`[] },
    unknown,
  ];

  // 0 = DIRECTORY, 1 = FILE per the onchfs InodeType enum
  if (inodeType !== 1) return null;

  return {
    metadata: hexToBytes(file.metadata),
    chunkPointers: [...file.chunkChecksums],
  };
}

/**
 * Read file content for a given CID by batching chunk reads.
 *
 * This is the gas-safe alternative to the package's single-call readFile.
 * The order of bytes in the output matches the order of chunkPointers,
 * which is determined by how the file was originally uploaded — i.e. its
 * natural byte order.
 */
export async function readLargeFile(
  chain: ChainKey,
  cid: `0x${string}`,
): Promise<{ body: Uint8Array; metadata: Uint8Array } | null> {
  const inode = await getFileInode(chain, cid);
  if (!inode) return null;

  const address = FILESYSTEM_ADDRESSES[chain];
  if (!address) return null;
  const client = getClient(chain);

  // Split chunk pointers into batches and read each batch in parallel.
  // Parallel reads against the same RPC are fine since each is a read-only
  // call; viem's fallback transport will distribute them across endpoints
  // if any are configured.
  const batches: `0x${string}`[][] = [];
  for (let i = 0; i < inode.chunkPointers.length; i += CHUNK_BATCH_SIZE) {
    batches.push(inode.chunkPointers.slice(i, i + CHUNK_BATCH_SIZE));
  }

  const batchResults = await Promise.all(
    batches.map((batch) =>
      client.readContract({
        address,
        abi: filesystemAbi,
        functionName: "concatenateChunks",
        args: [batch],
      }),
    ),
  );

  // Concatenate batch results in order.
  const parts = batchResults.map((hex) => hexToBytes(hex));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const body = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    body.set(p, off);
    off += p.length;
  }

  return { body, metadata: inode.metadata };
}

/**
 * Try reading a file across all configured EVM chains.
 *
 * Returns the first successful result, or null if the file isn't a file
 * inode on any of them.
 */
export async function readLargeFileAcrossChains(
  cid: `0x${string}`,
  chainsToTry: ChainKey[] = ["ethereum", "base"],
): Promise<{ body: Uint8Array; metadata: Uint8Array; chain: ChainKey } | null> {
  for (const chain of chainsToTry) {
    try {
      const result = await readLargeFile(chain, cid);
      if (result) return { ...result, chain };
    } catch {
      // Try the next chain.
    }
  }
  return null;
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.substr(i * 2, 2), 16);
  }
  return out;
}
