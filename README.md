# HEXA MANUAL

ドキュメントサイトのURLを入れると、本文を集めて **しおり・通しページ番号つきの1冊のPDF** にまとめるデスクトップアプリ（Tauri v2）。

HEXA STAGE 製ツール。単一HTML版 `hexa-manual.html` では CORS の壁でサイトを直接取得できなかったため、取得処理を Rust 側に逃がした後継版です。

> **ステータス: 実験段階 / 未検証**
> コードは一通り書いてありますが、実機でのビルド・実サイトでの動作確認はまだです。
> 動作確認の手順は [docs/SETUP.md](docs/SETUP.md) の「動作確認の順番」を参照してください。

## できること

- ページ一覧を4段フォールバックで発見: `llms-full.txt` → `llms.txt` → `sitemap.xml` → ナビゲーションのクロール
- sitemap は並び順に意味がないため、エントリページのサイドバー順で並べ替え
- `@mozilla/readability` ＋ ドキュメントサイト向けノイズ除去で本文だけ抽出
- 全ページを1本のHTMLに連結（id の名前空間化、内部リンクの文書内アンカー化、外部リンクのURL併記）
- ローカルの Chrome / Edge を CDP で操作し、しおり（アウトライン）つきPDFを出力

## 構成

| ファイル | 役割 |
|---|---|
| `src/lib/fetcher.ts` | 直列＋最小間隔つき fetch、SPA の 200 フォールバック判定、URL正規化 |
| `src/lib/discover.ts` | ページ発見（4段フォールバック）とサイドバー順の並べ替え |
| `src/lib/extract.ts` | Readability による本文抽出 |
| `src/lib/build.ts` | 連結HTMLの生成と印刷用CSS |
| `src/lib/pipeline.ts` | 全体のオーケストレーション |
| `src/main.ts` / `index.html` | 最小UI（URL入力・進捗・ログ） |
| `src-tauri/src/pdf/` | Chrome起動（`browser.rs`）、生CDPクライアント（`cdp.rs`）、PDF生成（`mod.rs`） |
| `src-tauri/src/lib.rs` | Tauriコマンド登録 |
| `src-tauri/capabilities/default.json` | HTTP権限 |

## セットアップ

このリポジトリには **ソースファイルだけ** が入っています。`package.json` や `tauri.conf.json` などの土台は含まれていないため、公式テンプレートで土台を作ってから重ねます。

手順は [docs/SETUP.md](docs/SETUP.md)、PDF化まわりの設計判断は [docs/PDF_SETUP.md](docs/PDF_SETUP.md) にあります。

必要なもの: Node 18+ / Rust 1.77+ / Chrome または Edge

## 使い方（ライブラリとして）

```ts
import { run } from "./lib/pipeline";

const result = await run("https://docs.example.com/guide/", {
  maxPages: 300,
  minIntervalMs: 300,
  docTitle: "Example Docs",
  onProgress: (e) => console.log(`[${e.phase}] ${e.current}/${e.total} ${e.message}`),
});

result.source;    // "llms-full" | "llms" | "sitemap" | "crawl"
result.skipped;   // 取得・抽出に失敗したページと理由
result.html;      // 連結済みHTML（generate_pdf に渡す）
```

## 未実装

- 日本語翻訳
- 表紙への HEXA STAGE ロゴ(SVG)
- 画像の data-URI 埋め込み（オフライン用）
- サイトごとのプロファイル保存
- `robots.txt` の Disallow 判定

## 注意

- 生成したPDFは **個人利用の範囲** で使ってください。ドキュメントの再配布は元サイトのライセンスに従う必要があります。
- 取得先サイトに負荷をかけないよう、既定では直列・300ms間隔です。
- `capabilities/default.json` は任意サイトを取得するためワイルドカードのHTTP権限を付けています。取得先を限定する運用にするなら絞ってください。
