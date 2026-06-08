#!/usr/bin/env node
/**
 * extract-tezos.mjs
 *
 * Extracts all iteration data for a Tezos fxhash project using the TzKT API.
 * Produces the same JSON format as extract-project.mjs (EVM version), so the
 * output can be loaded in the onchfs-viewer's "By File" mode.
 *
 * Usage:
 *   node extract-tezos.mjs <metadata-file.json>
 *   node extract-tezos.mjs --name "De/Frag"
 *
 * Mode 1 (from metadata file):
 *   Provide a JSON file containing the project metadata (as seen on fxhash).
 *   The script extracts the project name and generativeUri automatically.
 *
 * Mode 2 (from project name):
 *   Provide the project name directly with --name flag.
 *
 * Output:
 *   A file named `project-<name>.json` with all iterations.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeIndex } from "./scripts/build-index.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECTS_DIR = join(__dirname, "public", "projects");

const TZKT_API = "https://api.tzkt.io/v1";

// fxhash GENTK contracts on Tezos mainnet
const GENTK_CONTRACTS = [
  "KT1U6EHmNxJTkvaWJ4ThczG4FSDaHC21ssvi", // GENTK v2 (most projects)
  "KT1KEa8z6vWXDJrVqtMrAeDVzsvxat3kHaCE", // GENTK v1 (older projects)
];

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
  return r.json();
}

/**
 * Search TzKT for fxhash tokens matching a project name.
 * TzKT indexes token metadata, so we can search by name prefix.
 */
async function searchByName(projectName) {
  console.log(`Searching TzKT for "${projectName}" tokens...`);

  let allTokens = [];
  for (const contract of GENTK_CONTRACTS) {
    const encodedName = encodeURIComponent(projectName);
    let offset = 0;
    const limit = 100;

    while (true) {
      const url =
        `${TZKT_API}/tokens?contract=${contract}` +
        `&metadata.name.as=${encodedName}*` +
        `&limit=${limit}&offset=${offset}` +
        `&select=tokenId,metadata,firstTime,holdersCount`;

      try {
        const tokens = await fetchJson(url);
        if (!tokens || tokens.length === 0) break;

        const matching = tokens.filter((t) => {
          const name = t.metadata?.name || "";
          if (!name.toLowerCase().startsWith(projectName.toLowerCase())) return false; const rest = name.slice(projectName.length); return rest === "" || /^ #\d/.test(rest);
        });

        allTokens.push(...matching.map((t) => ({ ...t, contract })));
        console.log(`  Found ${matching.length} tokens on ${contract.slice(0, 8)}... (batch ${offset / limit + 1})`);

        if (tokens.length < limit) break;
        offset += limit;
      } catch (err) {
        console.log(`  Contract ${contract.slice(0, 8)}...: ${err.message}`);
        break;
      }
    }
  }

  return allTokens;
}

/**
 * Fallback: search by the IPFS CID in the artifactUri.
 * This finds tokens even when the project name is short or ambiguous.
 */
async function searchByCid(generativeUri) {
  if (!generativeUri) return [];

  const cid = generativeUri.replace(/^ipfs:\/\//, "").replace(/^onchfs:\/\//, "");
  if (!cid || cid.length < 10) return [];

  console.log(`Searching TzKT by CID: ${cid.slice(0, 20)}...`);

  // Search across ALL contracts (no contract filter) — essential for fxhash v3
  // which uses per-project contracts instead of the shared GENTK contracts.
  const url =
    `${TZKT_API}/tokens?` +
    `metadata.artifactUri.as=*${encodeURIComponent(cid)}*` +
    `&limit=1000` +
    `&select=tokenId,metadata,firstTime,holdersCount,contract`;

  try {
    const tokens = await fetchJson(url);
    if (tokens && tokens.length > 0) {
      const contractAddr = tokens[0].contract?.address || "unknown";
      console.log(`  Found ${tokens.length} tokens on contract ${contractAddr}`);
      return tokens.map((t) => ({
        ...t,
        contract: t.contract?.address || contractAddr,
      }));
    }
  } catch (err) {
    console.log(`  CID search failed: ${err.message}`);
  }

  return [];
}

/**
 * Fallback: search across ALL Tezos contracts by token name.
 * Used for fxhash v3 projects which have their own per-project contracts
 * instead of being on the shared GENTK v1/v2 contracts.
 */
async function searchAllContractsByName(projectName) {
  console.log(`Searching ALL contracts for "${projectName}" tokens...`);

  const encodedName = encodeURIComponent(projectName);
  let allTokens = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const url =
      `${TZKT_API}/tokens?` +
      `metadata.name.as=${encodedName}*` +
      `&limit=${limit}&offset=${offset}` +
      `&select=tokenId,metadata,firstTime,holdersCount,contract`;

    try {
      const tokens = await fetchJson(url);
      if (!tokens || tokens.length === 0) break;

      const matching = tokens.filter((t) => {
        const name = t.metadata?.name || "";
        if (!name.toLowerCase().startsWith(projectName.toLowerCase())) return false; const rest = name.slice(projectName.length); return rest === "" || /^ #\d/.test(rest);
      });

      allTokens.push(...matching.map((t) => ({
        ...t,
        contract: t.contract?.address || "unknown",
      })));

      if (matching.length > 0) {
        console.log(`  Found ${matching.length} tokens (batch ${offset / limit + 1})`);
      }

      if (tokens.length < limit) break;
      offset += limit;

      // Safety limit
      if (offset > 2000) {
        console.log("  Reached search limit (2000). Stopping.");
        break;
      }
    } catch (err) {
      console.log(`  Search failed: ${err.message}`);
      break;
    }
  }

  return allTokens;
}

/**
 * Extract iteration data from a token's metadata.
 * Tezos fxhash token metadata has the params embedded in the artifactUri.
 */
function extractIteration(token, generativeUri) {
  const md = token.metadata || {};
  const name = md.name || "";
  const artifactUri = md.artifactUri || "";
  const thumbnailUri = md.thumbnailUri || md.displayUri || "";
  const iterationHash = md.iterationHash || "";

  // Parse iteration number from name like "De/Frag #42"
  const iterMatch = name.match(/#(\d+)\s*$/);
  const iteration = iterMatch ? parseInt(iterMatch[1]) : 0;

  // Parse fxhash params from artifactUri query string
  let fxhash = iterationHash;
  let minter = "";
  let fxparams = "";

  const qsMatch = artifactUri.match(/\?(.+)$/);
  if (qsMatch) {
    const params = new URLSearchParams(qsMatch[1]);
    fxhash = fxhash || params.get("fxhash") || "";
    minter = params.get("fxminter") || "";
    fxparams = params.get("fxparams") || "";
    if (!iteration) {
      const fxiter = params.get("fxiteration");
      if (fxiter) iteration;
    }
  }

  // The generativeUri is the project's code URI (same for all iterations).
  // If not provided, extract from artifactUri by stripping the query string.
  const artworkUri = generativeUri || artifactUri.split("?")[0] || "";

  return {
    tokenId: parseInt(token.tokenId) || 0,
    contract: token.contract || "unknown",
    name,
    iteration,
    fxhash,
    minter,
    fxparams,
    owner: "",
    thumbnailUri,
    generativeUri: artworkUri,
    viewerParams: {
      uri: artworkUri,
      fxhash,
      iteration,
      minter,
      fxparams,
    },
  };
}

/**
 * Resolve minter addresses for tokens that don't have fxminter in their
 * artifactUri. Uses TzKT's transfer history: the first transfer (where
 * from=null) is the mint event, and the `to` address is the minter.
 *
 * This is essential for legacy Tezos fxhash tokens (v1/v2) where the
 * metadata doesn't include the minter address.
 */
async function resolveMinters(iterations) {
  // Find iterations missing a minter
  const needsMinter = iterations.filter((it) => !it.minter);
  if (needsMinter.length === 0) return;

  console.log(`\nResolving minter addresses for ${needsMinter.length} token(s)...`);

  // Group by contract for efficient batching
  const byContract = new Map();
  for (const it of needsMinter) {
    const c = it.contract;
    if (!byContract.has(c)) byContract.set(c, []);
    byContract.get(c).push(it);
  }

  for (const [contract, items] of byContract) {
    // Batch tokenIds (max 50 per request to avoid URL length issues)
    for (let i = 0; i < items.length; i += 50) {
      const batch = items.slice(i, i + 50);
      const tokenIds = batch.map((it) => it.tokenId).join(",");

      try {
        const url =
          `${TZKT_API}/tokens/transfers?` +
          `token.contract=${contract}` +
          `&token.tokenId.in=${tokenIds}` +
          `&from.null=true` +
          `&select=token.tokenId,to.address` +
          `&limit=1000`;

        const transfers = await fetchJson(url);
        if (!transfers) continue;

        // Build tokenId → minter map
        const minterMap = new Map();
        for (const t of transfers) {
          const tid = t.token?.tokenId ?? t["token.tokenId"];
          const addr = t.to?.address ?? t["to.address"];
          if (tid !== undefined && addr) {
            minterMap.set(String(tid), addr);
          }
        }

        // Fill in minters
        for (const it of batch) {
          const minter = minterMap.get(String(it.tokenId));
          if (minter) {
            it.minter = minter;
            it.viewerParams.minter = minter;
          }
        }

        const resolved = batch.filter((it) => it.minter).length;
        console.log(`  Batch ${Math.floor(i / 50) + 1}: resolved ${resolved}/${batch.length} minters`);
      } catch (err) {
        console.log(`  Minter batch failed: ${err.message}`);
      }

      // Small delay between batches
      if (i + 50 < items.length) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }

  const stillMissing = iterations.filter((it) => !it.minter).length;
  if (stillMissing > 0) {
    console.log(`  ${stillMissing} token(s) still without minter (transfers not found).`);
  }
}

async function main() {
  let projectName = "";
  let generativeUri = "";
  let inputMetadata = null;

  // Parse arguments
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("Usage:");
    console.error("  node extract-tezos.mjs <metadata-file.json>");
    console.error('  node extract-tezos.mjs --name "De/Frag"');
    process.exit(1);
  }

  if (args[0] === "--name") {
    projectName = args[1];
    if (!projectName) {
      console.error("Please provide a project name after --name");
      process.exit(1);
    }
  } else if (args[0].endsWith(".json")) {
    console.log(`Reading metadata from ${args[0]}...`);
    inputMetadata = JSON.parse(readFileSync(args[0], "utf8"));
    projectName = inputMetadata.name || "";
    generativeUri = inputMetadata.generativeUri || inputMetadata.generatorUri || "";

    if (!projectName) {
      console.error("Could not find project name in metadata.");
      process.exit(1);
    }
  } else {
    projectName = args.join(" ");
  }

  console.log(`\nProject: ${projectName}`);
  if (generativeUri) console.log(`Generative URI: ${generativeUri}`);

  // Search TzKT — try name on GENTK contracts first, then CID, then all contracts
  let tokens = await searchByName(projectName);

  if (tokens.length === 0 && generativeUri) {
    console.log("\nName search on GENTK contracts returned 0. Trying CID search...");
    tokens = await searchByCid(generativeUri);
  }

  if (tokens.length === 0) {
    console.log("\nCID search returned 0. Trying all contracts by name (v3 projects)...");
    tokens = await searchAllContractsByName(projectName);
  }

  // ======= UNIFIED POST-SEARCH FILTERS =======
  // Applied to ALL search results regardless of which search path found them.

  // 1. Name filter: strict "ProjectName #N" pattern
  if (tokens.length > 0) {
    const before = tokens.length;
    tokens = tokens.filter((t) => {
      const name = t.metadata?.name || "";
      if (!name.toLowerCase().startsWith(projectName.toLowerCase())) return false;
      const rest = name.slice(projectName.length);
      return rest === "" || /^ #\d/.test(rest);
    });
    if (tokens.length < before) {
      console.log(`Name filter: ${before} → ${tokens.length} tokens (excluded ${before - tokens.length} with wrong name pattern)`);
    }
  }

  // 2. GenerativeUri filter: exclude tokens from other projects with same name
  //    Skip for early projects where each token has a unique CID.
  if (generativeUri && tokens.length > 1) {
    const baseCid = generativeUri.replace(/^ipfs:\/\//, "").replace(/^onchfs:\/\//, "");
    if (baseCid.length > 10) {
      const filtered = tokens.filter((t) => {
        const art = t.metadata?.artifactUri || "";
        return art.includes(baseCid);
      });
      const removedPct = (tokens.length - filtered.length) / tokens.length;
      if (filtered.length > 0 && removedPct < 0.8) {
        console.log(`CID filter: ${tokens.length} → ${filtered.length} tokens (excluded ${tokens.length - filtered.length} from other projects)`);
        tokens = filtered;
      } else if (filtered.length <= 1 && tokens.length > 1) {
        console.log(`Skipping CID filter (would reduce ${tokens.length} → ${filtered.length} — likely early project with unique CIDs)`);
        // For early projects: keep only tokens from the contract with the most matches.
        // This excludes tokens from OTHER projects on different contracts that share
        // the same name (e.g., "Uninhabitable" on GENTK v1 vs v2).
        const byContract = new Map();
        for (const t of tokens) {
          const c = t.contract || "unknown";
          byContract.set(c, (byContract.get(c) || 0) + 1);
        }
        if (byContract.size > 1) {
          let maxContract = "";
          let maxCount = 0;
          for (const [c, count] of byContract) {
            if (count > maxCount) { maxCount = count; maxContract = c; }
          }
          const before = tokens.length;
          tokens = tokens.filter((t) => t.contract === maxContract);
          console.log(`Contract filter: ${before} → ${tokens.length} tokens (kept ${maxContract.slice(0, 8)}..., excluded ${byContract.size - 1} other contract(s))`);
        }
      }
    }
  }

  console.log(`\nTotal tokens found: ${tokens.length}`);

  if (tokens.length === 0) {
    if (inputMetadata) {
      // No tokens on-chain, but we have the project metadata.
      // Create a single entry from the preview data so the user can at least
      // view the artwork in the viewer.
      console.log("\nNo minted tokens found on-chain.");
      console.log("Creating a single entry from the project's preview data...");

      const uri = generativeUri || "";
      const fxhash = inputMetadata.previewHash || "";
      const minter = inputMetadata.previewMinter || "";

      const output = {
        project: {
          name: projectName,
          contract: "unknown",
          chain: "tezos",
          generativeUri: uri,
          totalSupply: 1,
          extractedAt: new Date().toISOString(),
          note: "No minted tokens found. This entry uses the project preview data.",
        },
        iterations: [{
          tokenId: 0,
          name: `${projectName} (preview)`,
          iteration: 1,
          fxhash,
          minter,
          owner: minter,
          thumbnailUri: inputMetadata.thumbnailUri || "",
          generativeUri: uri,
          viewerParams: { uri, fxhash, iteration: 1, minter },
        }],
      };

      const safeName = projectName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
      const filename = `${safeName}.json`;
      const filepath = join(PROJECTS_DIR, filename);
      if (!existsSync(PROJECTS_DIR)) mkdirSync(PROJECTS_DIR, { recursive: true });
      writeFileSync(filepath, JSON.stringify(output, null, 2));
      updateIndex();
      console.log(`\nSaved to public/projects/${filename}`);
      console.log(`\nViewer params (preview):`);
      console.log(`  URI:       ${uri}`);
      console.log(`  fxhash:    ${fxhash}`);
      console.log(`  Iteration: 1`);
      console.log(`  Minter:    ${minter}`);
      return;
    }

    console.log("\nNo tokens found. Possible reasons:");
    console.log("  - No iterations have been minted yet");
    console.log("  - Project name spelling might differ from on-chain metadata");
    console.log("  - Try providing the metadata JSON file instead of --name");
    process.exit(0);
  }

  // Extract iteration data
  const iterations = tokens
    .map((t) => extractIteration(t, generativeUri))
    .sort((a, b) => a.iteration - b.iteration);

  // Resolve minter addresses for legacy tokens that don't include
  // fxminter in their artifactUri metadata.
  await resolveMinters(iterations);

  // If we didn't have generativeUri, get it from the first iteration
  if (!generativeUri && iterations.length > 0) {
    generativeUri = iterations[0].generativeUri;
    console.log(`Generative URI (from first token): ${generativeUri}`);
  }

  // Clean up temporary fields before saving
  for (const it of iterations) {
    delete it.contract;
  }

  // Build output
  const output = {
    project: {
      name: projectName,
      contract: tokens[0]?.contract || "unknown",
      chain: "tezos",
      generativeUri,
      totalSupply: iterations.length,
      extractedAt: new Date().toISOString(),
    },
    iterations,
  };

  const safeName = projectName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
  const filename = `${safeName}.json`;
  const filepath = join(PROJECTS_DIR, filename);

  if (!existsSync(PROJECTS_DIR)) mkdirSync(PROJECTS_DIR, { recursive: true });

  writeFileSync(filepath, JSON.stringify(output, null, 2));
  console.log(`\nSaved ${iterations.length} iteration(s) to public/projects/${filename}`);

  updateIndex();

  if (iterations.length > 0) {
    const ex = iterations[0];
    console.log(`\nExample — iteration ${ex.iteration}:`);
    console.log(`  URI:       ${ex.viewerParams.uri}`);
    console.log(`  fxhash:    ${ex.viewerParams.fxhash}`);
    console.log(`  Iteration: ${ex.viewerParams.iteration}`);
    console.log(`  Minter:    ${ex.viewerParams.minter}`);
  }
  console.log(`\nIn the viewer: select "By File" mode → your project appears in the list.`);
}

function updateIndex() {
  const n = writeIndex(PROJECTS_DIR);
  console.log(`Updated project index: ${n} project(s) available.`);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
