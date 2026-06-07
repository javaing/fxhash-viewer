# fxhash viewer

A browser-based viewer for [fxhash](https://www.fxhash.xyz/) generative art, designed to **outlive fxhash itself**.

The viewer reads artwork code directly from IPFS and the Ethereum/Base/Tezos blockchains (via onchfs), with no dependency on fxhash servers. If fxhash.xyz disappears tomorrow, this viewer continues to work.

## Features

- **Multi-chain support**: Ethereum, Base, Tezos
- **Multi-protocol support**: IPFS and onchfs (On-Chain File System)
- **Deterministic rendering**: Math.pow patch and `<base>` tag injection match fxhash's own viewer
- **fx(params) support**: Parametric artworks render with correct collector-chosen parameters
- **Project browsing**: Extract all iterations of a project, browse with thumbnail grid
- **Offline archive**: Download any artwork as a self-contained ZIP
- **fxhash-independent**: No fxhash API calls during artwork viewing

## Quick Start

```bash
npm install
npm run build
npm run preview
```

Open `http://localhost:4173/` in your browser.

## Extracting Projects

Before browsing iterations, extract a project's data using the included scripts.

### EVM projects (Ethereum / Base)

```bash
# From project metadata JSON
node extract-project.mjs metadata.json

# From contract address
node extract-project.mjs 0x76e27D6C7B8324fD42Fe21D63DA5195551dc1cc4 ethereum
node extract-project.mjs 0x1084D99FB4E49A6693e305f7BC0dfA926D6a6c3F base
```

### Tezos projects

```bash
# From project metadata JSON
node extract-tezos.mjs metadata.json

# By project name
node extract-tezos.mjs --name "De/Frag"
```

Extracted data is saved to `public/projects/` and automatically appears in the viewer's **File** mode.

## How It Works

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Browser                                                 │
│                                                          │
│  ┌──────────────┐    ┌──────────────────────────────┐   │
│  │  React UI    │    │  iframe (artwork)             │   │
│  │  - File mode │    │  - Served by Service Worker   │   │
│  │  - URI mode  │───▶│  - <base> tag → IPFS gateway  │   │
│  │  - Archive   │    │  - Math.pow patch injected    │   │
│  └──────────────┘    └──────────────────────────────┘   │
│                              │                           │
│  ┌──────────────────────────┐│                           │
│  │  Service Worker          ││                           │
│  │  - Fetches root HTML     │◀                           │
│  │  - Injects patches       │                            │
│  │  - Caches in IndexedDB   │                            │
│  └──────────┬───────────────┘                            │
│             │                                            │
└─────────────┼────────────────────────────────────────────┘
              │
    ┌─────────┴──────────┐
    │                    │
┌───▼───┐          ┌─────▼─────┐
│ IPFS  │          │  onchfs   │
│ (6    │          │ Ethereum  │
│ gates)│          │ Base      │
└───────┘          │ Tezos     │
                   └───────────┘
```

### Deterministic Rendering

The viewer injects two critical patches into artwork HTML (matching fxhash.xyz's own implementation):

1. **`<base>` tag**: Redirects all relative URLs to the IPFS gateway, so sub-resources (JS, GLSL shaders, CSS) load directly without Service Worker interception.

2. **`Math.pow` override**: Fixes floating-point precision in base58 hash decoding. Without this, `Math.pow(58, 11)` returns slightly different values across browsers, causing the PRNG seed to diverge and producing completely different artwork.

### Supported Artwork Types

| Type | Chain | Resolution | Status |
|------|-------|-----------|--------|
| onchfs single-file HTML | Ethereum | via SW | ✅ |
| onchfs multi-file (large assets) | Ethereum | via SW + chunked fallback | ✅ |
| IPFS standard | Ethereum/Base/Tezos | via gateway + base tag | ✅ |
| IPFS with XHR sub-resources (.glsl) | Base | via gateway + base tag | ✅ |
| IPFS with Web Audio (blob:) | Tezos | via gateway | ✅ |
| fx(params) parametric | Tezos | via fxparams injection | ✅ |

## Project Structure

```
fxhash-viewer/
├── src/
│   ├── App.tsx              # Main UI (File/URI modes)
│   ├── styles.css           # Monochrome theme (Inter font)
│   ├── url-params.ts        # fxhash/fxparams URL construction
│   ├── chains.ts            # Ethereum/Base/Tezos RPC config
│   ├── sw/worker.ts         # Service Worker (HTML injection)
│   ├── resolver/
│   │   ├── ipfs.ts          # IPFS gateway racing + sticky
│   │   ├── onchfs.ts        # onchfs two-tier resolver
│   │   └── large-file.ts    # Chunked reading for >100KB files
│   ├── cache/chunks.ts      # IndexedDB content cache
│   ├── archive/index.ts     # ZIP archive creation
│   └── discovery/           # Wallet/GraphQL discovery (legacy)
├── extract-project.mjs      # EVM iteration extractor
├── extract-tezos.mjs        # Tezos iteration extractor
├── find-contract.mjs        # Contract address finder
├── public/projects/          # Extracted project JSONs
├── vite.config.ts           # Main app build
├── vite.sw.config.ts        # SW build (inlineDynamicImports)
├── ARCHITECTURE.md          # Detailed technical documentation
└── LICENSE                  # MIT
```

## Building

The project uses a **two-pass build**:

```bash
npm run build
# Pass 1: vite build          → main app (dist/assets/)
# Pass 2: vite build --config vite.sw.config.ts → SW (dist/sw.js)
```

The SW is built separately with `inlineDynamicImports: true` because browsers reject dynamic `import()` in Service Workers.

## Deployment

The `dist/` folder is a static site. Deploy to any static hosting:

```bash
# GitHub Pages
npm run build
# Push dist/ to gh-pages branch

# Cloudflare Pages
npm run build
# Set build output directory to dist/

# Any HTTP server
npx serve dist
```

## Known Limitations

- **GraphQL discovery**: fxhash's EVM API endpoint is undocumented; wallet discovery falls back to on-chain enumeration of known contracts
- **Floating-point drift**: Complex physics simulations may produce subtly different results across CPU architectures (documented in ARCHITECTURE.md)
- **Temporal drift**: Animated artworks that use real-time clocks may not reproduce frame-perfectly

## Credits

Built as a conservation tool for fxhash generative art. Inspired by conversations between [ciphrd](https://twitter.com/caborissov) (fxhash founder) and [Peter Pasma](https://twitter.com/piterpasma) about the importance of infrastructure-independent art preservation.

## License

MIT
