#!/usr/bin/env node
/**
 * find-contract.mjs
 *
 * Resolves a fxhash project name or URL to its contract address.
 *
 * Usage:
 *   node find-contract.mjs "The Flood & The Whale"
 *   node find-contract.mjs https://www.fxhash.xyz/project/the-flood-and-the-whale
 *   node find-contract.mjs the-flood-and-the-whale
 *
 * Tries multiple strategies:
 *   1. Fetch the fxhash project page and extract the contract address
 *   2. Query fxhash GraphQL API by project name
 *   3. Search Basescan/Etherscan for FXGEN contracts matching the name
 */

const arg = process.argv.slice(2).join(" ").trim();
if (!arg) {
  console.error("Usage:");
  console.error('  node find-contract.mjs "Project Name"');
  console.error("  node find-contract.mjs https://www.fxhash.xyz/project/slug");
  process.exit(1);
}

// Extract slug from URL if given
let slug = arg;
const urlMatch = arg.match(/fxhash\.xyz\/(?:project|generative)\/(.+?)(?:\?|$)/);
if (urlMatch) {
  slug = urlMatch[1];
  // If it's already a contract address, we're done
  if (/^0x[0-9a-fA-F]{40}$/.test(slug)) {
    console.log(`Contract address: ${slug}`);
    process.exit(0);
  }
}

console.log(`Looking up: "${slug}"\n`);

async function tryFxhashPage() {
  // Try fetching the project page — the HTML often contains the contract address
  const urls = [
    `https://www.fxhash.xyz/project/${slug}`,
    `https://www.fxhash.xyz/generative/${slug}`,
  ];

  for (const url of urls) {
    try {
      console.log(`  Fetching ${url}...`);
      const resp = await fetch(url, {
        headers: {
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "accept": "text/html",
        },
        redirect: "follow",
      });
      if (!resp.ok) continue;

      const html = await resp.text();

      // Look for contract addresses in the page
      // fxhash pages often have the contract in meta tags, JSON-LD, or inline scripts
      const addresses = new Set();
      const addrPattern = /0x[0-9a-fA-F]{40}/g;
      let match;
      while ((match = addrPattern.exec(html)) !== null) {
        // Filter out common non-project addresses (zero address, etc.)
        const addr = match[0].toLowerCase();
        if (addr === "0x" + "0".repeat(40)) continue;
        if (addr === "0x" + "f".repeat(40)) continue;
        addresses.add(match[0]);
      }

      if (addresses.size > 0) {
        console.log(`\n  Found ${addresses.size} address(es) on page:`);
        for (const addr of addresses) {
          console.log(`    ${addr}`);
        }

        // Try to identify the project contract by checking if it has totalSupply
        for (const addr of addresses) {
          try {
            const isProject = await checkIsProjectContract(addr);
            if (isProject) {
              console.log(`\n✅ Project contract: ${addr}`);
              console.log(`\nTo extract iterations:`);
              console.log(`  node extract-project.mjs <metadata.json> ${addr}`);
              return addr;
            }
          } catch {}
        }
      }
    } catch (err) {
      console.log(`  Failed: ${err.message}`);
    }
  }
  return null;
}

async function tryGraphQL() {
  console.log("  Trying fxhash GraphQL API...");
  const projectName = slug
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());

  const query = `{
    generativeTokens(filters: { name_eq: "${projectName}" }, take: 5) {
      id
      name
      metadata
    }
  }`;

  try {
    const resp = await fetch("https://api.fxhash.xyz/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
    });
    const json = await resp.json();
    if (json.data?.generativeTokens?.length > 0) {
      for (const token of json.data.generativeTokens) {
        console.log(`  Found: ${token.name} (id: ${token.id})`);
        // Check if the id is a contract address
        if (/^0x[0-9a-fA-F]{40}$/.test(token.id)) {
          console.log(`\n✅ Project contract: ${token.id}`);
          return token.id;
        }
      }
    } else {
      console.log("  No results from GraphQL.");
    }
  } catch (err) {
    console.log(`  GraphQL failed: ${err.message}`);
  }
  return null;
}

async function checkIsProjectContract(addr) {
  // Quick check: does this contract have totalSupply()?
  const rpcs = ["https://base.drpc.org", "https://eth.drpc.org"];
  for (const rpc of rpcs) {
    try {
      const resp = await fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "eth_call",
          params: [{ to: addr, data: "0x18160ddd" }, "latest"],
        }),
      });
      const json = await resp.json();
      if (json.result && json.result !== "0x" && !json.error) {
        const supply = parseInt(json.result, 16);
        if (supply > 0 && supply < 100000) return true;
      }
    } catch {}
  }
  return false;
}

async function main() {
  // Strategy 1: fetch fxhash page
  let result = await tryFxhashPage();
  if (result) return;

  // Strategy 2: GraphQL API
  result = await tryGraphQL();
  if (result) return;

  console.log("\n❌ Could not find the contract address automatically.");
  console.log("\nManual method:");
  console.log("  1. Open the project page on fxhash.xyz in your browser");
  console.log("  2. Press F12 → Network tab");
  console.log("  3. Reload the page");
  console.log("  4. Filter by 'graphql' or 'api'");
  console.log("  5. Look for responses containing a 0x... contract address");
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
