# Migration log — _legacy/onchfs-viewer → genartLiveViewer

旧アプリ `_legacy/onchfs-viewer`（読み取り専用・参照用）から新アプリ
`genartLiveViewer`（リポジトリルート）へ、コードを段階的に昇格＋リファクタする。

## 方針

- **進め方**: 依存関係の浅い順（葉 → 根）に移植。各ステップで「移植 → `npm run typecheck` → 動作確認」を回し、常にビルドが通る状態を保つ。
- **スコープ**: legacy と同等（fxhash 世代アートの保存ビューア）。新機能は移植完了後に検討。
- **_legacy は触らない**: `tsconfig` の `exclude` に登録済み。参照のみ。

## 進捗チェックリスト

| # | レイヤー | 対象 | 状態 |
|---|---------|------|------|
| 0 | 基盤 | git, package.json, tsconfig, vite×2, index.html, main.tsx(最小), App/styles(仮) | ✅ 完了 |
| 1 | 純粋関数 | chains.ts, url-params.ts, resolver/uri.ts | ✅ 完了 |
| 2 | キャッシュ/リゾルバ | cache/chunks.ts, resolver/{ipfs,onchfs,large-file,index}.ts | ✅ 完了 |
| 3 | Service Worker | sw/worker.ts, sw/register.ts（main.tsx に登録配線） | ✅ 完了 |
| 4 | アーカイブ | archive/index.ts | ✅ 完了 |
| 5 | NFT / Discovery | discovery/types.ts(`ArtworkItem`)のみ移植。nft/* と discovery runtime は除外 | ✅ 完了 |
| 6 | UI | App.tsx, styles.css（仮を置換） | ✅ 完了 |
| 7 | 抽出スクリプト | extract-project.mjs, extract-tezos.mjs, find-contract.mjs | ✅ 完了 |

## 判断メモ（移植中に決める）

- **discovery/**: legacy 内でも「(legacy)」と注記された wallet/GraphQL discovery。
  fxhash API 依存は「fxhash 消滅後も動く」という理念と相反するため、初期スコープから
  除外する方向で検討。除外する場合 nft/inspector.ts などの依存有無を確認。
- **App.tsx（696行）**: 単一ファイルが肥大。File/URI モードでコンポーネント分割すると
  リファクタ価値が高い。step #6 で判断。

## ステップ記録

### 環境: 作業ディレクトリのリネーム（`#dev` → `dev`）

**問題**: 旧パス `~/#dev`（ホーム直下の `#` 付きフォルダ）の `#` が Vite/Rollup のプロダクションビルドを破壊。
Rollup はモジュールを絶対パスで解決するため、`#` 以降が URL フラグメント扱いとなり、
`./App` などの相対 import が全て解決不能になる（`Could not resolve "./App"`）。
シンボリックリンク経由も realpath 解決で `#` に戻るため無効。`#`-free なパスに複製すると
ビルド成功することを確認。

**対応**: `~/#dev` → `~/dev` にリネーム（恒久解決）。
リネーム後にメインビルド成功を確認（31 modules → dist/assets）。

**影響メモ**: VSCode で開いていたワークスペースは旧パス `#dev` のため、
**フォルダを `~/dev` で開き直す**必要がある。

### #0 基盤構築（完了）

- `git init`（ルートは元々 git 管理外だった）
- `package.json`: name を `genart-live-viewer`、version `0.1.0`。依存は legacy と同一。
- `tsconfig.json`: `exclude` に `_legacy` を追加。
- `vite.config.ts` / `vite.sw.config.ts`: legacy からそのまま。
- `index.html`: title を `genart live viewer` に変更。
- `src/main.tsx`: 最小構成。SW 登録は #3 で配線予定（コメントで明示）。
- `src/App.tsx` / `src/styles.css`: 起動確認用のプレースホルダ。#6 で本実装に置換。
- フォルダ: `src/{resolver,cache,sw,archive,nft}`, `docs/`, `public/` を作成。
  `src/discovery` は除外候補のため意図的に未作成。

### #1〜#7 移植（完了）

各ステップで「コピー昇格 → `npm run typecheck`」を回し、常にグリーンを維持した。
legacy は新 `package.json` と依存・構造が一致するため、純粋ロジック層（#1〜#4, #6）は
忠実コピーで通過（リファクタ不要）。

- **#1〜#4, #6**: `chains/url-params/resolver/cache/sw/archive/App/styles` を忠実移植。
  `main.tsx` に `registerServiceWorker()` を配線（#3）。
- **#5 discovery 除外の確定**: App.tsx は discovery から **型 `ArtworkItem` のみ** import し、
  `discoverWallet`（fxhash GraphQL 依存）等の関数は一切呼んでいないことを確認
  （UI のデータ源はローカル JSON ＋ファイル選択のみ）。`nft/inspector` は `discovery/onchain`
  からのみ依存。よって **fxhash API 依存かつ UI 未到達の dead code** であり、除外しても機能後退ゼロ。
  → `src/discovery/types.ts`（`ArtworkItem` のみ）＋ `src/discovery/index.ts`（再エクスポート）を作成。
  `DiscoveryResult` と runtime（fxhash-api/onchain/known-contracts）, `nft/{abi,inspector}` は不採用。
  復活させたくなれば legacy から戻せる。
- **#7 抽出スクリプト**: `extract-project.mjs` / `extract-tezos.mjs` / `find-contract.mjs` と
  `.env.example` をルートへ移植。Node 組み込み＋`fetch` のみ依存（追加パッケージ不要）。
  出力先 `__dirname/public/projects/` は Vite 配信パスかつ App の `fetch("/projects/...")` と一致。
  事前抽出ツールであり、生成 JSON を viewer が fxhash 非依存で読む設計のため理念と整合。
  `node --check` で 3 本とも構文 OK。

### 最終検証（build + smoke）

- `npm run build`: tsc → メインビルド（1224 modules）→ SW ビルド（2075 modules, `sw.js` 1.3MB,
  dynamic import インライン化）まで成功。SW のサイズ警告は viem/onchfs 同梱による想定内で情報のみ。
- `npm run preview` + HTTP スモーク: `index.html`（title/`#root`/module script）正常、
  `sw.js` がルートで `content-type: text/javascript` 配信（SW 登録要件 OK）、
  `/projects/_index.json` 不在時も App 側 `.catch()` でハンドル済みでクラッシュなし。

### ランタイム検証（実ブラウザ・完了）

DEMO 値（Genomes #1196, `onchfs://046f4712…`, chain=ethereum）で実 Chrome をヘッドレス
駆動し（Node 25 の global WebSocket で CDP を直接叩く依存ゼロのドライバ。playwright 不要）、
UI 経由で URI モード → Load を実行して以下を確認した。

- **アプリ起動**: `#root` 描画、タイトル "fxhash viewer" 表示。
- **Service Worker**: `navigator.serviceWorker.ready` が `active: http://localhost:4173/sw.js`。
- **onchfs 解決（SW 経由）**: iframe は本物の Genomes（SwissGL + Neural Cellular Automata）。
  サブリソース `fxhash.js` / `swissgl.js` / `index.js` / `nca.png` がすべて **200**。
  `nca.png`（NCA 重みテクスチャ）は onchfs チャンク読みで **約10.9秒**かけて取得。
- **描画**: 40秒待機後、canvas 940×661 で平均輝度 189.7・非黒ピクセル 100%・maxChannel 255。
  全面に色が出ており WebGL レンダリング成立（ロード直後の黒画面は nca.png 取得完了前の一時状態）。

外部到達性は事前に確認済み（eth.drpc.org が `eth_blockNumber` 応答、ipfs.io 200）。
→ **fxhash サーバを一切経由せず、チェーン上の onchfs バイトから アートを再生できることを実証**。
