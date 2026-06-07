import type { ArtworkItem } from "./types";
import type { ChainKey } from "../chains";

/**
 * fxhash's public GraphQL endpoint, used by fxhash-website itself.
 *
 * Schema notes (discovered iteratively, since EVM-side queries are
 * undocumented):
 *   - Filter operators are suffix-style: `_eq`, `_in`, `_gt`, etc.
 *   - `owner_in` takes a [String!]! array, not a single string.
 *   - The Objkt type does NOT have an `assignedMetadata` sub-struct;
 *     metadata fields live directly on Objkt (or in JSON `metadata`).
 *   - For EVM artworks, the `id` is typically "{contract}-{tokenId}".
 */
const FXHASH_GRAPHQL_URL = "https://api.fxhash.xyz/graphql";

const COLLECTION_QUERY = `
  query CollectionByOwner($owners: [String!]!) {
    objkts(filters: { owner_in: $owners }, take: 200) {
      id
      iteration
      generationHash
      metadata
      issuer {
        id
        name
        author {
          name
        }
      }
      minter {
        id
      }
      owner {
        id
      }
    }
  }
`;

interface RawObjkt {
  id?: string;
  iteration?: number;
  generationHash?: string;
  /** Raw JSON blob: contains generativeUri, artifactUri, thumbnailUri, etc. */
  metadata?: Record<string, unknown> | null;
  issuer?: {
    id?: string;
    name?: string;
    author?: { name?: string };
  };
  minter?: { id?: string };
  owner?: { id?: string };
}

/**
 * Try fetching the wallet's collection from the fxhash GraphQL API.
 *
 * Returns a result object even on failure so the caller can fall back to
 * on-chain discovery and surface diagnostic info to the user.
 */
export async function discoverViaGraphQL(
  walletAddress: string,
): Promise<{ items: ArtworkItem[]; diagnostic: string } | null> {
  try {
    const response = await fetch(FXHASH_GRAPHQL_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: COLLECTION_QUERY,
        // owner_in takes an array. Try both lowercase and checksum forms,
        // since on-chain addresses are canonicalized differently across
        // indexers.
        variables: { owners: [walletAddress.toLowerCase(), walletAddress] },
      }),
    });

    if (!response.ok) {
      // Try to read a friendly error body so the user can see what went wrong.
      let detail = `${response.status}`;
      try {
        const body = await response.text();
        if (body) detail = body.slice(0, 300);
      } catch {
        /* ignore */
      }
      return {
        items: [],
        diagnostic: `GraphQL HTTP ${response.status}: ${detail}`,
      };
    }

    const json = await response.json();
    if (json.errors) {
      const firstError = json.errors[0]?.message ?? JSON.stringify(json.errors[0]);
      return {
        items: [],
        diagnostic: `GraphQL errors: ${firstError}`,
      };
    }

    const rawItems: RawObjkt[] = json?.data?.objkts ?? [];
    const items: ArtworkItem[] = [];
    for (const raw of rawItems) {
      const item = normalizeObjkt(raw);
      if (item) items.push(item);
    }

    return {
      items,
      diagnostic: `GraphQL returned ${rawItems.length} item(s), ${items.length} usable.`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { items: [], diagnostic: `GraphQL request failed: ${msg}` };
  }
}

/**
 * Normalize a raw Objkt into our internal ArtworkItem shape.
 *
 * The metadata field is a JSON blob whose schema we infer defensively.
 * Common keys observed in fxhash metadata JSON (and present in the
 * Genomes example we have): generatorUri, artifactUri, thumbnailUri,
 * displayUri, name, description.
 */
function normalizeObjkt(raw: RawObjkt): ArtworkItem | null {
  // Extract metadata fields if present.
  const md = (raw.metadata ?? {}) as Record<string, unknown>;
  const generativeUri = pickString(md, ["generativeUri", "generatorUri", "artifactUri"]);
  if (!generativeUri) return null;

  const thumbnailUri = pickString(md, ["thumbnailUri", "displayUri", "image"]);
  const nameFromMd = pickString(md, ["name"]);

  const iteration = raw.iteration ?? 0;
  const fxhash = raw.generationHash ?? "";
  const minter = raw.minter?.id ?? "";
  const projectName = raw.issuer?.name ?? nameFromMd ?? "Unknown project";
  const name = nameFromMd || `${projectName} #${iteration || "?"}`;
  const artistName = raw.issuer?.author?.name ?? "";

  // EVM objkt id format: "{contract}-{tokenId}". Tezos format would be
  // numeric only — those aren't relevant to our viewer, skip them.
  const idStr = raw.id ?? "";
  const idMatch = idStr.match(/^(0x[0-9a-fA-F]{40})-(\d+)$/);
  if (!idMatch) {
    return null;
  }

  const [, contract, tokenId] = idMatch;
  // The schema doesn't (yet) tell us which chain. Default to ethereum;
  // a future enhancement is to detect from the contract address.
  const chain: ChainKey = "ethereum";

  return {
    key: `${chain}:${contract.toLowerCase()}:${tokenId}`,
    name,
    projectName,
    artistName,
    thumbnailUri,
    generativeUri,
    fxhash,
    iteration,
    minter,
    chain,
    contract: contract.toLowerCase() as `0x${string}`,
    tokenId,
    fxparams: "",
    source: "graphql",
  };
}

function pickString(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v) return v;
  }
  return "";
}
