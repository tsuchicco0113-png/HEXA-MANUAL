# PDF 化（Rust 側）セットアップ

## 依存

```toml
# src-tauri/Cargo.toml
[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-http = "2"
tauri-plugin-dialog = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
anyhow = "1"
base64 = "0.22"
tempfile = "3"
# ws:// のみ使うので TLS は不要
tungstenite = { version = "0.27", default-features = false, features = ["handshake"] }
```

`tungstenite` は 0.21 以前だと API が `read_message` / `write_message` で、
`Message::Text` も `String` を取ります。バージョンを下げる場合は
`cdp.rs` の `ws.read()` / `ws.send()` と `.into()` を合わせてください。

## 登録

```rust
// src-tauri/src/lib.rs
mod pdf;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            pdf::generate_pdf,
            pdf::detect_browser,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

## フロントからの呼び出し

```ts
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { run } from "./lib/pipeline";

// 起動時に一度
const browserPath = await invoke<string>("detect_browser").catch(() => null);
if (!browserPath) {
  // 「Chrome または Edge が必要です」の案内を出す
}

const result = await run(entryUrl, { onProgress: setProgress });

const outPath = await save({
  defaultPath: `${docTitle}.pdf`,
  filters: [{ name: "PDF", extensions: ["pdf"] }],
});
if (outPath) {
  const pdf = await invoke("generate_pdf", {
    html: result.html,
    outPath,
    options: { outline: true, pageNumbers: true, timeoutSecs: 240 },
  });
  console.log(pdf); // { path, bytes, imageCount }
}
```

## 設計上の判断

**なぜ WebView の `window.print()` ではないか**
Tauri の WebView からでも PDF は出せますが、しおり（アウトライン）も
ページ番号テンプレートも使えず、印刷ダイアログが挟まります。
`generateDocumentOutline` は CDP 経由でしか触れません。

**なぜ `headless_chrome` / `chromiumoxide` crate ではないか**
`generateDocumentOutline` は比較的新しい CDP パラメータで、
クレートの型定義に無いことがあります。目的がしおり付き PDF なので、
任意パラメータをそのまま送れる生 CDP のほうが確実で、依存も軽い。

**なぜ `ReturnAsStream` か**
既定の base64 一括返却だと、300 ページ級の PDF で WebSocket の
メッセージ上限を超えて接続ごと落ちます。`IO.read` で 1MB ずつ
引き出してファイルに直接書きます。

**なぜ使い捨てプロファイルか**
`--user-data-dir` を渡さないと、既に起動している Chrome に
相乗りしてしまい headless になりません。ユーザーのブラウザを
勝手に操作する事故も防げます。

## 詰まりやすいところ

| 症状 | 原因 | 対処 |
|---|---|---|
| 日本語が豆腐 | フォント未インストール | `build.ts` の `fontStack` を OS 標準（Yu Gothic / Hiragino）優先に |
| 画像が空枠 | 読み込み待ちが足りない | `WAIT_READY_JS` の個別タイムアウト 8000ms を伸ばす |
| しおりが出ない | 見出し階層が飛んでいる | h1 の次にいきなり h3 が来ていないか確認 |
| ページサイズが無視される | `preferCSSPageSize` と margin 指定の競合 | CDP 側で margin を渡さない（現状そうしている） |
| 起動が遅い | Chrome のコールドスタート | 初回のみ 1〜3 秒。複数回出すならセッションを使い回す |

**macOS の署名**
配布時、`Browser::launch` が外部プロセスを起動するため、
Hardened Runtime を有効にするなら `com.apple.security.cs.allow-unsigned-executable-memory`
ではなく、子プロセス起動が許可される entitlement 構成を確認してください。
Mac App Store 配布は難しく、Developer ID の直配布が現実的です。
