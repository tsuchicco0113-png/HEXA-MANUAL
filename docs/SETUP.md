# ビルド〜使用手順

前提: Node 18+ / Rust 1.77+ / Chrome または Edge がインストール済み。

## 1. スキャフォールド

`tauri.conf.json` は手書きせず、公式テンプレートに生成させます。
スキーマが版で変わるので、これが一番確実です。

```bash
npm create tauri-app@latest hexa-manual
```

対話は以下を選択:

| 質問 | 回答 |
|---|---|
| Identifier | `com.hexastage.hexa-manual` |
| Frontend language | TypeScript / JavaScript |
| Package manager | npm |
| UI template | Vanilla |
| UI flavor | TypeScript |

```bash
cd hexa-manual
npm install
```

ここで一度 `npm run tauri dev` を実行し、空のウィンドウが出ることを確認しておきます。
**ここで動かないなら Rust ツールチェーンの問題**なので、先に切り分けます。
Windows なら Visual Studio C++ Build Tools、Linux なら `libwebkit2gtk-4.1-dev` が要ります。

## 2. 依存を追加

```bash
npm i @tauri-apps/plugin-http @tauri-apps/plugin-dialog @mozilla/readability marked
```

```bash
cd src-tauri
cargo add tauri-plugin-http tauri-plugin-dialog
cargo add anyhow serde_json tempfile
cargo add base64@0.22
cargo add tungstenite --no-default-features --features handshake
cd ..
```

`tungstenite` のバージョンを確認してください。0.22 以降なら `ws.read()` / `ws.send()`、
0.21 以前なら `read_message()` / `write_message()` なので `cdp.rs` の 2 箇所を直します。

```bash
cargo tree -p tungstenite --manifest-path src-tauri/Cargo.toml | head -1
```

## 3. ファイルを配置

```
hexa-manual/
├─ index.html                          ← 差し替え
├─ src/
│  ├─ main.ts                          ← 差し替え
│  └─ lib/
│     ├─ types.ts                      ← 追加
│     ├─ fetcher.ts                    ← 追加
│     ├─ discover.ts                   ← 追加
│     ├─ extract.ts                    ← 追加
│     ├─ build.ts                      ← 追加
│     └─ pipeline.ts                   ← 追加
└─ src-tauri/
   ├─ capabilities/default.json        ← 差し替え
   └─ src/
      ├─ lib.rs                        ← 差し替え
      └─ pdf/
         ├─ mod.rs                     ← 追加
         ├─ cdp.rs                     ← 追加
         └─ browser.rs                 ← 追加
```

テンプレートが `src/main.ts` から `styles.css` を import している場合は、その行を消します。
`src-tauri/src/main.rs` はテンプレートのまま（`lib.rs` の `run()` を呼ぶだけ）で構いません。

## 4. 起動

```bash
npm run tauri dev
```

ウィンドウ下部のログに `browser: C:\Program Files\...\chrome.exe` のような行が
出れば、Rust 側まで通っています。ここが出ないなら `detect_browser` で
止まっているので、PDF 生成まで進む前に解決します。

## 5. 動作確認の順番

急に本番サイトを流すと、どこで壊れたか判らなくなります。3 段階で。

**(a) 発見だけ確認** — 最大ページを `5` にして「HTML だけ保存」を押す。
ログの `経路:` が `llms-full` / `llms` / `sitemap` / `crawl` のどれになったかを見ます。
`crawl` に落ちているなら sitemap の検出に失敗しています。

**(b) 組版を確認** — 保存した `preview.html` を Chrome で開き、`Ctrl+P` の
プレビューを見ます。**CSS の調整はここでやるのが圧倒的に速い**。
`build.ts` の `printCss()` を直して再生成、のループを回します。
Rust 側を経由すると 1 回 10 秒かかりますが、この方法なら即座です。

**(c) PDF を出す** — 最大ページを `20` くらいにして「解析して PDF」。
出た PDF をビューアで開き、しおりペインに階層が出ているか確認します。
出ていなければ `outline` フラグか見出し階層の問題です。

そこまで通ったら最大ページを本来の値に上げます。

## 6. リリースビルド

```bash
npm run tauri build
```

成果物:

- Windows: `src-tauri/target/release/bundle/nsis/*.exe`
- macOS: `src-tauri/target/release/bundle/dmg/*.dmg`
- Linux: `src-tauri/target/release/bundle/appimage/*.AppImage`

署名なしで配ると Windows は SmartScreen、macOS は Gatekeeper が出ます。
BOOTH で配るなら、その回避手順（右クリック→開く 等）を商品説明に書いておきます。

## つまずきポイント

| 症状 | 原因 | 対処 |
|---|---|---|
| `fetch` が全部 null | capabilities の HTTP スコープ未設定 | `default.json` を差し替えたか確認。変更後は `tauri dev` を再起動 |
| `Failed to resolve import "@tauri-apps/plugin-http"` | npm 側の追加漏れ | `npm i` し直して dev を再起動 |
| ログが `crawl` になる | sitemap が別名 | `discover.ts` の `candidates` にそのサイトのパスを足す |
| 全ページ「本文抽出できず」 | 独自レイアウトで Readability が外れる | `extract.ts` の fallback セレクタにそのサイトの本文 class を追加 |
| PDF が真っ白 | `file://` の読み込み失敗 | `--headless=new` を `--headless` に落として再試行 |
| ビルドは通るが dev で白画面 | `styles.css` の import 残り | `src/main.ts` の import 行を削除 |
