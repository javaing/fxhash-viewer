# Architecture & investigation log

This file records what we learned about fxhash's on-chain architecture while building this viewer. The code's design choices flow directly from these findings, so this is the canonical place to look when something seems oddly specific.

## Table of contents

- [Core goal](#core-goal)
- [The fxhash NFT architecture](#the-fxhash-nft-architecture)
- [URI schemes (onchfs:// and ipfs://)](#uri-schemes)
- [How onchfs works on chain](#how-onchfs-works-on-chain)
- [The Service Worker](#the-service-worker)
- [The two-tier onchfs resolver](#the-two-tier-onchfs-resolver)
- [Cache strategy](#cache-strategy)
- [Known gotchas](#known-gotchas)
- [Test cases (real artworks)](#test-cases-real-artworks)
- [Discord context](#discord-context-from-fxhash-people)
- [Investigation tooling](#investigation-tooling)
- [Things we don't do yet](#things-we-dont-do-yet)
- [Open questions](#open-questions)

---

## Core goal

Make a viewer for fxhash generative art that **survives fxhash's disappearance**. The rest of this document is about identifying every point where the design could accidentally depend on fxhash, and engineering each one away.

The strict success criterion: if fxhash.xyz, media.fxhash.xyz, onchfs.fxhash2.xyz, and api.v2.fxhash.xyz all stopped responding tomorrow, this viewer would still load the same artworks correctly.

---

## The fxhash NFT architecture

fxhash has gone through **two generations** of on-chain architecture on EVM chains. They look similar from the outside but differ substantially under the hood.

### Generation 1: fxhash 2.0 (Ethereum mainnet, 2023+)

The classic onchfs deployment. Architecture:

- **GENTK contracts** — one per project. ERC-721 NFT contracts with `symbol = "GENTK"`.
- **IPFSRenderer** at `0x48F00F8314920ca0cd763D74acFe8cFE4024a274` — single shared renderer for all GENTK projects. Builds `tokenURI()` strings (centralized https URLs) and also returns the original onchfs/ipfs URI when asked. Confusingly named: it serves both schemes.
- **ContractRegistry** at `0x4DAc308c686D747A804B7E95db606695a529A750` — service locator mapping `keccak256(name)` → address. Holds the `defaultMetadataURI` config (`https://media.fxhash.xyz/metadata/ethereum/`) which explains why `tokenURI()` returns centralized URLs.
- **onchfs FileSystem** at `0x9e0f2864c6f125bbf599df6ca6e6c3774c5b2e04` — the actual on-chain file system contract holding inodes and orchestrating reads from the Content Store.
- **Content Store** at `0xc6806fd75745bb5f5b32ada19963898155f9db91` — holds the raw chunks. Address read from FileSystem via `CONTENT_STORE()`.

Many "Genomes" / generative-art-with-onchfs projects live here.

### Generation 2: $FXH protocol (Base, 2025+)

A separate, newer system built around art coins.

- **ProjectTokenV2 contracts** — one per project, with per-project tokens (often with thematic symbols, e.g. `"VOLATILE"`).
- Each is its own immutable deployment (no Proxy), with its own constructor args for token, weth, admin, owner, and `_versionManager`.
- **versionManager** — typically a Gnosis Safe multisig controlled by fxhash signers. Can call `setCurrentVersion(uint256)` to switch between versions. Cannot upgrade the contract's code.
- onchfs FileSystem on Base lives at `0x2983008f292a43f208bba0275afd7e9b3d39af3b`, with its own Content Store reachable via the FileSystem's `CONTENT_STORE()`.

In our sample, all Base $FXH artworks turned out to be **IPFS-stored** rather than onchfs-stored. The schema supports onchfs (the `immutableURI` could be `onchfs://...` and `onchainPointer` could be non-zero for SSTORE2 storage), but in practice the early Base catalog leans on IPFS.

### Why we bypass `tokenURI()`

```
tokenURI(131) → "https://media.fxhash.xyz/metadata/ethereum/0x.../131/metadata.json"
```

That's a centralized HTTP endpoint at fxhash. Following it makes the viewer trivially break the moment fxhash goes offline. So we ignore it entirely and read content-addressed URIs directly from contract state — `versionInfo(currentVersion)` on Base, or directly the user-provided onchfs/ipfs URI in URI mode.

### The versioning system

On Base, each project supports per-version data:

```
struct Version {
  address renderer;       // off-chain or on-chain rendering address
  string  mutableURI;     // updatable URI (typically empty)
  string  immutableURI;   // canonical URI (ipfs:// or onchfs://)
  uint256 lastIteration;  // for batched releases
  address onchainPointer; // SSTORE2-style on-chain content (zero for IPFS-only projects)
}
```

The current version can be changed via `setCurrentVersion(uint256)`, callable only by the `versionManager`. Two important nuances:

1. **`VersionInfoUpdated` events are immutable on-chain.** Even if the Safe overwrites version data later, the original values can be reconstructed from event logs.
2. **fxhash death implicitly freezes versions.** No signers → no `setCurrentVersion` calls → the current version is locked forever.

So while the Safe is theoretically an upgrade authority, the failure mode is benign for the archival use case: once fxhash is gone, the art is frozen as-is.

---

## URI schemes

### `ipfs://` — works today

IPFS-stored artwork bundles. We resolve by racing public gateways:

```
ipfs.io, dweb.link, cloudflare-ipfs.com, gateway.pinata.cloud,
nftstorage.link, gateway.fxhash.xyz (last as fallback)
```

The first responder wins, others are aborted. Long-term persistence depends on **pinning**. While fxhash exists they pin everything; after they're gone, popular artworks tend to remain on public nodes and dedicated archivists. For real long-term safety we encourage users to pin favorites themselves.

### `onchfs://` — implemented via official package + custom fallback

See [How onchfs works on chain](#how-onchfs-works-on-chain) and [The two-tier onchfs resolver](#the-two-tier-onchfs-resolver) below.

---

## How onchfs works on chain

onchfs (On-Chain File System) is fxhash's design for storing entire generative art bundles (HTML, JS, libraries, images, model weights) on the blockchain itself.

### Two-contract architecture

- **FileSystem** contract — holds inodes, exposes the public API (`readFile`, `inodes`, `concatenateChunks`, etc.)
- **Content Store** contract — holds the actual chunk bytes, keyed by their content hash

The FileSystem references the Content Store via its `CONTENT_STORE()` view function.

### Inode model

Two kinds of inodes:

- **Directory** (`InodeType = 0`): `(string[] filenames, bytes32[] fileChecksums)` — a list of named children, each pointing to another inode CID
- **File** (`InodeType = 1`): `(bytes metadata, bytes32[] chunkChecksums)` — the file's HPACK-encoded metadata and an ordered list of chunk pointers

Reading a file means:
1. Look up the file inode (which contains the chunk pointer list).
2. For each chunk pointer, fetch the chunk bytes from the Content Store.
3. Concatenate in order.
4. Decode the metadata to recover HTTP-style headers (`content-type`, `content-encoding`).
5. If `content-encoding: gzip`, decompress.

### Deduplication

Files within a directory are stored as references to **content-addressed CIDs**, not inline data. The same byte content uploaded by two different projects gets the same CID and is stored once on-chain.

Critically, **a directory entry can reference a CID stored on a different chain.** A directory on Ethereum mainnet can have a file entry whose CID is actually stored on Tezos. This is by design but adds resolution complexity.

### Real contract addresses

From the official `onchfs` npm package (v0.1.0) source:

| Chain | FileSystem contract |
|-------|---------------------|
| Ethereum mainnet | `0x9e0f2864c6f125bbf599df6ca6e6c3774c5b2e04` |
| Base mainnet | `0x2983008f292a43f208bba0275afd7e9b3d39af3b` |
| Ethereum Sepolia | `0x4f555d39e89f6d768f75831d610b3940fa94c6b1` |
| Base Sepolia | `0x3fb48e03291b2490f939c961a1ad088437129f71` |
| Tezos mainnet | `KT1Ae7dT1gsLw2tRnUMXSCmEyF74KVkM6LUo` |

Function selectors (for raw eth_call probing):

| Function | Selector |
|----------|----------|
| `inodeExists(bytes32)` | `0x31c11f6b` |
| `inodes(bytes32)` | `0x7ea664a4` |
| `readFile(bytes32)` | `0x3a72a9c4` |
| `concatenateChunks(bytes32[])` | `0x3487ae16` |
| `CONTENT_STORE()` | `0x6bdd12cf` |

---

## The Service Worker

The SW exists to make sandboxed `<iframe>` rendering tractable.

Without a SW, an artwork's HTML can reference assets like `<script src="./lib.js">` or `<link href="/assets/foo.css">`. The browser issues real HTTP requests for those, and they need to resolve to the right bytes from onchfs/IPFS. The SW intercepts those requests, runs them through our resolver, and returns the right bytes with the right headers.

### URL routing

The URL convention is:

```
/view/{scheme}/{addr}/{path...}?{fxhash params}&chain={key}
```

When the user clicks "Load", the React UI:
1. Parses the URI (`onchfs://...` or `ipfs://...`).
2. Constructs a SW URL like `/view/onchfs/<cid>/`.
3. Adds query parameters (`fxhash`, `fxiteration`, `fxminter`, etc.) that the artwork's JS will read from `window.location`.
4. Points an `<iframe sandbox="allow-scripts allow-same-origin" src="/view/...">` at it.

### Sandbox attributes

The iframe uses `sandbox="allow-scripts allow-same-origin"`. The console produces a warning that this combination "can escape its sandboxing" — this is technically true but practically necessary. Without `allow-same-origin`, the iframe has origin `null` and can't load assets from `localhost` (CORS denial). The warning is informational, not a real security regression for our use case (artworks ship from immutable CIDs we control via the SW).

The SW adds a strict CSP to every response (especially `connect-src 'none'`) which is the actual security boundary against malicious artworks reaching out to the network.

### Response decompression

Browsers don't auto-decompress SW-constructed responses based on `content-encoding`. The SW handles this manually using `DecompressionStream` (`gzip` and `deflate`), then strips the `content-encoding` header before returning.

---

## The two-tier onchfs resolver

This is the most subtle piece of the architecture.

### Tier 1: official `onchfs` package

For most files (HTML, JS, libraries — typically under 100KB each), we delegate to `Onchfs.resolver.create([...])`. The package handles:

- File Objects / Content Store contract addresses per chain
- inode tree traversal with `index.html` directory fallback
- chunk fetching and concatenation
- HPACK metadata decoding into HTTP headers
- gzip / deflate decoding for `content-encoding`-tagged content
- Multi-chain lookup (try each configured chain until one has the CID)

API:

```ts
import Onchfs from "onchfs"

const resolve = Onchfs.resolver.create([
  { blockchain: "eip155:1",    rpcs: ETHEREUM_RPCS },
  { blockchain: "eip155:8453", rpcs: BASE_RPCS },
  { blockchain: "tezos:mainnet", rpcs: TEZOS_RPCS },
])

const response = await resolve("/cid/path")
// { status, content: Uint8Array, headers, error? }
```

### Tier 2: chunked fallback for large files

The package's `readFile(bytes32)` makes a single `eth_call` that internally concatenates all chunks and returns them as one big `bytes`. For files larger than ~100KB, this exhausts the eth_call gas limit (50M gas) during memory expansion:

```
out of gas: gas exhausted during memory expansion: 50000000
```

When this happens, the package wraps the error as:

> "An error occurred when reading the content of the file of cid `4739adf...`: searched all available blockchains, resource not found."

The error message is misleading — the file IS on a configured chain, it's just too big to return in one call.

Our workaround: when we detect this error, extract the failing CID from the message and fall back to our own implementation (`src/resolver/large-file.ts`):

1. Call `FileSystem.inodes(cid)` to get the chunk pointer list (this is cheap).
2. Batch chunk pointers in groups of 5.
3. Call `FileSystem.concatenateChunks([batch])` for each batch in parallel.
4. Concatenate the batch results in order.
5. Decode HPACK metadata via `Onchfs.metadata.decode()` for the `content-type` header.

The batch size of 5 is empirically safe (we measured 50 fails, 10-20 works depending on chunk size, 5 is conservative). A typical chunk is ~24KB, so a batch of 5 returns ~120KB — well under any gas limit.

This pattern is documented in `src/resolver/onchfs.ts` with the error-pattern matcher `isLargeFileFailure()`.

### Why not always use Tier 2

Tier 1 handles directory traversal, multi-chain lookup, HPACK decoding, gzip decompression, and metadata-driven content-type for free. Reimplementing all that just to avoid the package's single failure mode would be wasted work. Tier 2 only kicks in for the specific case the package can't handle.

---

## Cache strategy

Both onchfs chunks and IPFS responses are content-addressed and immutable, so once we've seen content we can cache it forever.

The SW stores fully-resolved responses (already gzip-decompressed) in IndexedDB via `idb-keyval`, keyed by `{scheme}:{cid}{path}`. On future requests, a cache hit bypasses RPC entirely and returns instantly.

This gives the viewer a third useful property: **offline mode**. Once you've seen an artwork, you can see it again with no network, indefinitely. It's also what makes complex artworks feel fast on the second view (the first view does dozens or hundreds of RPC calls; the second does zero).

---

## Known gotchas

### Resolution-dependent art

Some artworks vary their output based on canvas size — not just the framing but the **actual generative state**. Genomes #1196 is a documented example: its `index.js` computes a "scale level" from `canvas.width × canvas.height`:

```js
const SCL = Math.max(3, sc(Math.max(canvas.width, canvas.height)))
```

The scale level changes how many multi-scale simulation passes run, which changes the rendered image meaningfully. So a 1080p window shows a different snapshot than a 4K window, **at the same iteration with the same fxhash**.

This is a property of the artwork, not the viewer. fxhash's own player shows the same dependency. We've documented this in our README but a future enhancement is a "canvas size preset" UI (1024², 1920×1080, 3840×2160) so users can reliably reproduce a specific look.

### Public RPC CORS support

Many public Ethereum RPCs accept HTTP requests from servers but block them from browsers via CORS:

- ❌ `eth.llamarpc.com`, `base.llamarpc.com` (no CORS)
- ❌ `rpc.ankr.com` (now requires API key)
- ❌ Tezos: `mainnet.api.tez.ie`, `mainnet.tezos.marigold.dev` (inconsistent)
- ✅ `eth.drpc.org`, `base.drpc.org`, `cloudflare-eth.com`, `1rpc.io/eth`, `mainnet.base.org`
- ✅ Tezos: `mainnet.ecadinfra.com`, `rpc.tzbeta.net`

When picking RPCs for browser use, always verify CORS support. The viem `fallback` transport will rotate through them automatically and prefer the fastest.

### Cross-chain content references

A directory entry can point to a file CID stored on a different chain. The onchfs package's resolver handles this transparently as long as both chains are configured in the resolver controller list. We include `tezos:mainnet` in our resolver setup specifically for this reason — old fxhash projects often have shared library files originally uploaded to Tezos.

### Service Worker re-registration on rebuild

When developing, rebuilding the project produces a new `sw.js`. The browser is conservative about replacing live Service Workers, sometimes leaving the new one in a `waiting to activate` state.

If you see strange behavior after a rebuild — old logic, missing features, cached errors — the fix is:

1. F12 → Application → Storage → **Clear site data**
2. Close the tab
3. Open a fresh tab

Just `Ctrl+Shift+R` is not always enough.

### iframe sandbox attribute requirements

The iframe **must** have `sandbox="allow-scripts allow-same-origin"`. Without `allow-same-origin`, the iframe gets `origin: null` and can't fetch its own assets through the SW (CORS denial). The "this can escape sandboxing" warning is informational; the actual security is the CSP we apply in SW responses.

---

## Test cases (real artworks)

These are confirmed working in the viewer, useful for regression checks.

### Blokkendoos (Peter Pasma) — onchfs, simple

The textbook "single-HTML self-contained" case ciphrd referenced when discussing onchfs design.

- Chain: Ethereum
- URI: `onchfs://c522b2b8f9ada187f6ff6a1ff7501d5611be6ee152350e692ca5019adf970d60`
- fxhash: `0xc47e74dae7539fb836b4fadfe9f9f21dc6894dd9ae23ed53c89cb0ae6c3d5e8b`
- Iteration: 494
- Minter: `0x4aa93c41dEb2bb0E088b1728e40Db6322b6C3010`

### Genomes #1196 (Mike Tyka) — onchfs, complex with large asset

The "neural cellular automaton" piece that exposed the gas-limit bug in the official package's `readFile`. Tests the Tier 2 chunked-reading fallback. The directory contains a ~445KB `nca.png` file (neural network weights encoded as PNG pixels) split across 19 chunks of 24KB each.

- Chain: Ethereum
- URI: `onchfs://046f4712c2aaa344f82f1ef8ffed2ab8c9714819228e29c6a28cf67b14377f61`
- fxhash: `0xdd9b8e6407bb9ac960d7ae7986fcb0470691398a84a9e84b0995d2c2bdf9397f`
- Iteration: 1196
- Minter: `0x8A05e5EEcaB2C1b5dfAf26CF11c9845bF971fB45`

The `nca.png` lookup also exercises cross-CID resolution: it's stored at CID `4739adf87bbfa5a9abd795aae739d14a9c1ae90c7ed891615b45c18ad9fd0652` (separate from the main directory's `046f4712...` CID, but on the same chain).

### rayincarnations (volatilemoods) — IPFS, on Base

The IPFS path and `inspectNft()` flow are exercised by this Base $FXH protocol artwork.

- Chain: Base
- NFT Contract: `0x1695Ac117aBAAfd92653Ca21f5CF071bC51d7Dc0`
- Token ID: 1
- Resolves to: `ipfs://QmVhXb3TTnvspdjgKy6eensWuqbHkAMYHYfh1Jt2gnXGmh`

---

## Discord context from fxhash people

Context from a Discord conversation between Peter Pasma (artist, Blokkendoos creator) and ciphrd (fxhash founder).

### ciphrd on the design intent

> "It would be fairly straightforward to write a contract which takes a onchfs CID and serves the content of the file as a string. It would work for projects where the whole project is stored as a single string. However, for most projects they are relying on the http protocol to link files together, thus resulting in needing some kind of http proxy to route http requests to ethereum read calls. That's essentially what the onchfs proxy is doing."
>
> "anyone running an ONCHFS server can load onchfs projects as long as they have access to a blockchain public rpc."

Our viewer is exactly such a server, running in the user's browser via Service Worker. No HTTP proxy hosted by anyone is needed.

### Peter Pasma on the conservation gap

> "the 'known reliable' part of the ONCHFS proxy service... is a HARD requirement to the whole thing to work. It's not a 'nice to have'. I just wanted to bring this up for people thinking about conservation efforts, to spin up an ONCHFS proxy service somewhere."

This viewer is one such conservation effort. Peter's framing helped justify the work: the on-chain bytes are useless without infrastructure to read them, and that infrastructure has historically been a single fxhash-operated service.

### ciphrd on swapping the gateway

> "We built the contracts so that the left-most part of the URI (`https://onchfs.fxhash2.xyz/`) can be edited at once for all collections. Initially we hoped we could have other marketplaces/wallets to integrate onchfs natively so that we could eventually swap this part for `onchfs://`, however we were never big enough to initiate this."

So tokenURI URLs in production currently embed the fxhash gateway as a prefix. Our viewer ignores them entirely and works with raw CIDs from `versionInfo` or direct URI input.

---

## Investigation tooling

Three standalone Node.js scripts ship with the project. They're not part of the viewer's runtime; they're diagnostic helpers used during development and useful when debugging future issues.

- **`probe.mjs`** — Given an NFT contract address, detects which chain it's on, whether it's a Proxy (EIP-1967 implementation slot), and extracts embedded address constants from its bytecode. Used early on to figure out how the fxhash NFT contracts work.

- **`locate-cid.mjs`** — Given a 64-hex CID, queries `inodeExists()` and `readFile()` on every known FileSystem contract address (Ethereum mainnet, Base, Sepolia, Base Sepolia) to find where a file lives. Detects PNG/GIF/JPEG/gzip from the first bytes.

- **`inspect-file.mjs`** — Given a CID known to be a file, calls `inodes()` to dump its full structure: file vs directory, metadata bytes, chunk count, chunk pointers. Then tests increasing batch sizes against `concatenateChunks()` to find the gas-safe maximum. Used to discover the 50M-gas issue with large files.

All three are pure Node.js with no dependencies beyond standard `fetch`. Run with `node <script>.mjs <args>`.

---

## Things we don't do yet

- **SSTORE2-style on-chain content** (`onchainPointer` projects). When a project's content is stored as the bytecode of a Solidity contract rather than via onchfs, we'd need to call `getCode(onchainPointer)`, strip the leading STOP opcode, and treat the rest as the data. None of the artworks we sampled use this path, but the contracts support it. Implementing it later is straightforward.

- **fx(params) bytes encoding.** For parametric works, we pass `fxparams` through as a hex string. We don't decode the parameter ABI itself; the artwork's own JS handles that.

- **Discovery by browsing.** This viewer is single-artwork at a time. Future additions: enumerate fxhash project contracts (via Transfer event scanning or fxhash's own GraphQL API while it exists), let users browse their collections.

- **Snapshot recording.** Reading `VersionInfoUpdated` events to pin to the "originally minted" state regardless of later Safe-triggered version changes. Cheap to add later.

- **Full local archival.** Zip-download an artwork's entire directory tree for offline preservation. The Peter Pasma "conservation" use case, fully realized.

- **Canvas size presets.** Mitigate resolution-dependent art (Genomes-style) by letting users pick a fixed virtual canvas size.

---

## Open questions

- Does any current Ethereum mainnet project actually use SSTORE2-style content via `onchainPointer`? None of the artworks we sampled do, but the contracts support it.
- Are there public Tezos RPCs with better CORS support than ecadinfra? Ours works but a wider fallback would be more resilient.
- Will fxhash deploy newer renderer / FileSystem versions that change ABIs? Our resolver is loosely coupled (it goes through the `onchfs` package and a stable subset of the FileSystem ABI for the chunked fallback), but a clean-break new architecture would require updates.
