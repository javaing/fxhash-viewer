#!/usr/bin/env node
/**
 * extract-url.mjs
 *
 * One-command pipeline: an fxhash artwork URL (or slug / contract address) →
 * resolve its metadata → identify the chain → run the right extractor
 * (extract-tezos.mjs for Tezos, extract-project.mjs for EVM). The chosen
 * extractor writes public/projects/<Name>.json and refreshes _index.json.
 *
 * Usage:
 *   node extract-url.mjs <fxhash-url | slug | 0x-contract> [--dry-run] [--force]
 *
 * Examples:
 *   node extract-url.mjs https://www.fxhash.xyz/generative/slug/forsaken
 *   node extract-url.mjs https://www.fxhash.xyz/generative/12345
 *   node extract-url.mjs forsaken
 *   node extract-url.mjs 0x1234...abcd            # EVM contract directly
 *
 * Flags:
 *   --dry-run   Resolve + detect chain only; print the planned command, write nothing.
 *   --force     Overwrite an existing public/projects/<Name>.json (guarded by default).
 *
 * Chain detection:
 *   fxhash's GraphQL has no `chain` field, so we infer it from
 *   gentkContractAddress — `KT1…` ⇒ Tezos, `0x…` ⇒ EVM. For EVM we probe Base
 *   then Ethereum RPC to tell the two apart.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractTezosByGraphQL } from "./scripts/extract-tezos-graphql.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECTS_DIR = join(__dirname, "public", "projects");
const GRAPHQL = "https://api.fxhash.xyz/graphql";
const RPCS = { base: "https://base.drpc.org", ethereum: "https://eth.drpc.org" };
const SEL_TOTAL_SUPPLY = "0x18160ddd";

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const input = argv.find((a) => !a.startsWith("--"));
const dryRun = flags.has("--dry-run");
const force = flags.has("--force");

if (!input) {
  console.error("Usage: node extract-url.mjs <fxhash-url | slug | 0x-contract> [--dry-run] [--force]");
  process.exit(1);
}

/** Mirror the extractors' filename rule so we can predict/guard the output. */
function safeName(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
}

/** Parse the input into one of: { address } | { id } | { slug }. */
function parseTarget(s) {
  s = s.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) return { address: s };
  if (/^KT1[0-9A-Za-z]{33}$/.test(s)) return { address: s };
  // .../generative/slug/<slug>  |  .../generative/<slug-or-id>  |  .../project/<slug>
  const m = s.match(/fxhash\.xyz\/(?:generative|project)\/(?:slug\/)?([^/?#]+)/i);
  const token = m ? decodeURIComponent(m[1]) : s;
  if (/^\d+$/.test(token)) return { id: Number(token) };
  return { slug: token };
}

async function fetchJson(url, init, { tries = 3 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, init);
      if (r.status === 429) throw new Error("rate limited (429)");
      return await r.json();
    } catch (err) {
      lastErr = err;
      await new Promise((res) => setTimeout(res, 600 * (i + 1)));
    }
  }
  throw lastErr;
}

async function gql(query) {
  const j = await fetchJson(GRAPHQL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (j.errors) throw new Error(j.errors.map((e) => e.message).join("; "));
  return j.data;
}

const PROJECT_FIELDS =
  "id version slug name gentkContractAddress issuerContractAddress generativeUri metadataUri";

async function resolveBySlugOrId(target) {
  if (target.slug != null) {
    const d = await gql(`{ generativeToken(slug:${JSON.stringify(target.slug)}){ ${PROJECT_FIELDS} } }`);
    return d.generativeToken;
  }
  const d = await gql(`{ generativeToken(id:${target.id}){ ${PROJECT_FIELDS} } }`);
  return d.generativeToken;
}

/** Probe Base then Ethereum: whichever returns a sane totalSupply() is the chain. */
async function probeEvmChain(addr) {
  for (const chain of ["base", "ethereum"]) {
    try {
      const j = await fetchJson(RPCS[chain], {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "eth_call",
          params: [{ to: addr, data: SEL_TOTAL_SUPPLY }, "latest"],
        }),
      });
      if (j.result && j.result !== "0x" && !j.error) {
        const n = parseInt(j.result, 16);
        if (n > 0 && n < 1_000_000) return chain;
      }
    } catch { /* try next chain */ }
  }
  return null;
}

/** Last-resort EVM resolver: scrape the contract address via find-contract.mjs. */
function findContractViaScrape(slugOrUrl) {
  const res = spawnSync(process.execPath, [join(__dirname, "find-contract.mjs"), slugOrUrl], {
    encoding: "utf8",
  });
  const out = `${res.stdout || ""}\n${res.stderr || ""}`;
  const m = out.match(/Project contract:\s*(0x[0-9a-fA-F]{40})/i);
  return m ? m[1] : null;
}

/** Existing cleaned data we shouldn't silently clobber. */
function existingFileFor(name) {
  const predicted = join(PROJECTS_DIR, `${safeName(name)}.json`);
  if (existsSync(predicted)) return predicted;
  // Also catch files whose stored project.name matches (filename scheme drift).
  if (existsSync(PROJECTS_DIR)) {
    for (const f of readdirSync(PROJECTS_DIR)) {
      if (!f.endsWith(".json") || f.startsWith("_")) continue;
      try {
        const d = JSON.parse(readFileSync(join(PROJECTS_DIR, f), "utf8"));
        if (d.project?.name === name) return join(PROJECTS_DIR, f);
      } catch { /* ignore */ }
    }
  }
  return null;
}

function run(script, args) {
  console.log(`\n→ node ${script} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}\n`);
  const res = spawnSync(process.execPath, [join(__dirname, script), ...args], { stdio: "inherit" });
  if (res.status !== 0) throw new Error(`${script} exited with code ${res.status}`);
}

function guardOverwrite(name) {
  const existing = existingFileFor(name);
  if (existing && !force) {
    console.error(
      `\n⚠  ${existing.replace(__dirname + "/", "")} already exists.\n` +
        `   Re-extracting would overwrite it (and any manual cleanup). ` +
        `Pass --force to proceed.`,
    );
    process.exit(3);
  }
}

async function dispatchTezos(target, { name, generativeUri }) {
  console.log(`Chain:   tezos`);
  console.log(`Name:    ${name}`);
  console.log(`Code:    ${generativeUri || "(unknown)"}`);
  console.log(`Output:  public/projects/${safeName(name)}.json`);
  if (dryRun) { console.log("\n[dry-run] would extract via fxhash GraphQL objkts"); return; }
  guardOverwrite(name);
  // Project-scoped GraphQL extraction (exact), not a TzKT CID search (which
  // over-collects when a generative-code CID is reused across editions).
  const res = await extractTezosByGraphQL(target, {
    onProgress: (got, total) => process.stdout.write(`\r  fetched ${got}/${total} iteration(s)…`),
  });
  process.stdout.write("\n");
  console.log(`Saved ${res.count} iteration(s) to public/projects/${res.filename}`);
  if (res.count !== res.expected) {
    console.log(`  (note: fetched ${res.count} of ${res.expected} reported by fxhash)`);
  }
}

async function dispatchEvm({ address, name }) {
  const chain = await probeEvmChain(address);
  if (!chain) {
    console.error(`\n✖ Could not confirm an EVM chain (base/ethereum) for ${address}.`);
    process.exit(2);
  }
  console.log(`Chain:   ${chain} (probed)`);
  console.log(`Address: ${address}`);
  if (name) console.log(`Name:    ${name}`);
  if (dryRun) { console.log(`\n[dry-run] would run extract-project.mjs ${address} ${chain}`); return; }
  if (name) guardOverwrite(name);
  run("extract-project.mjs", [address, chain]);
}

async function main() {
  const target = parseTarget(input);

  // Direct contract address input.
  if (target.address) {
    if (target.address.startsWith("KT1")) {
      console.error(
        "A bare Tezos (KT1) contract can't be resolved to a project name here.\n" +
          "Pass the fxhash URL or slug instead (e.g. .../generative/slug/<slug>).",
      );
      process.exit(2);
    }
    await dispatchEvm({ address: target.address });
    return;
  }

  // Resolve slug / numeric id via fxhash GraphQL.
  console.log(`Resolving ${target.slug != null ? `slug "${target.slug}"` : `id ${target.id}`} …`);
  let project = null;
  try {
    project = await resolveBySlugOrId(target);
  } catch (err) {
    console.log(`  GraphQL lookup failed: ${err.message}`);
  }

  if (project) {
    const addr = project.gentkContractAddress || "";
    if (addr.startsWith("KT1")) {
      await dispatchTezos(target, { name: project.name, generativeUri: project.generativeUri });
      return;
    }
    if (addr.startsWith("0x")) {
      await dispatchEvm({ address: addr, name: project.name });
      return;
    }
    console.log(`Resolved "${project.name}" but its contract (${addr || "none"}) is an unknown chain.`);
  }

  // EVM fallback: the GraphQL is Tezos-centric, so scrape for a 0x contract.
  console.log("Trying EVM page-scrape fallback (find-contract.mjs) …");
  const scraped = findContractViaScrape(input);
  if (scraped) {
    await dispatchEvm({ address: scraped });
    return;
  }

  console.error(
    "\n✖ Could not resolve this URL to a project.\n" +
      "  - Check the URL/slug, or pass the contract address directly\n" +
      "    (0x… for EVM), or use the per-chain script manually.",
  );
  process.exit(1);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
