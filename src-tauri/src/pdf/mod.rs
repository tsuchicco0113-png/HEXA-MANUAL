mod browser;
mod cdp;

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use browser::{find_browser, Browser};
use cdp::Cdp;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfOptions {
    /// h1〜h6 からしおり（アウトライン）を生成する
    #[serde(default = "yes")]
    pub outline: bool,
    /// ページ番号フッターを入れる
    #[serde(default = "yes")]
    pub page_numbers: bool,
    /// 画像読み込みなどの全体タイムアウト（秒）
    #[serde(default = "default_timeout")]
    pub timeout_secs: u64,
}

fn yes() -> bool {
    true
}
fn default_timeout() -> u64 {
    180
}

impl Default for PdfOptions {
    fn default() -> Self {
        Self { outline: true, page_numbers: true, timeout_secs: 180 }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfResult {
    pub path: String,
    pub bytes: u64,
    pub image_count: u64,
}

const FOOTER: &str = r#"<div style="font-size:8px;width:100%;padding:0 14mm;
 color:#888;font-family:sans-serif;display:flex;justify-content:flex-end;">
 <span class="pageNumber"></span>&nbsp;/&nbsp;<span class="totalPages"></span></div>"#;

/// ヘッダーを空にしないと Chrome が既定でタイトルと日付を刷り込む
const HEADER_EMPTY: &str = "<span></span>";

/// フォントと画像の読み込み完了を待つ。
///
/// loadEventFired だけでは Web フォントが間に合わず、
/// 日本語が別のフォントで刷られたり画像が空枠になったりする。
const WAIT_READY_JS: &str = r#"
(async () => {
  try { await document.fonts.ready; } catch (e) {}
  const pending = [...document.images].filter(i => !i.complete);
  await Promise.all(pending.map(img => new Promise(resolve => {
    const done = () => resolve();
    img.addEventListener('load', done, { once: true });
    img.addEventListener('error', done, { once: true });
    setTimeout(done, 8000);   // 落ちている画像で全体を止めない
  })));
  return document.images.length;
})()
"#;

pub fn html_to_pdf(html: &str, out_path: &Path, opts: &PdfOptions) -> Result<PdfResult> {
    let overall = Duration::from_secs(opts.timeout_secs);

    // 一時 HTML に書き出して file:// で開く。
    // Page.setDocumentContent でも動くが、file:// のほうが
    // 相対解決とリソース読み込みの挙動が実ブラウザに近い。
    let dir = tempfile::Builder::new().prefix("hexa-manual-src-").tempdir()?;
    let src = dir.path().join("document.html");
    std::fs::write(&src, html).context("一時 HTML の書き出しに失敗しました")?;

    let exe = find_browser()?;
    let browser = Browser::launch(&exe)?;

    let mut cdp = Cdp::connect(&browser.ws_url)?;

    // ブラウザターゲットにぶら下げたページを 1 枚作って attach する
    let target = cdp.call(
        "Target.createTarget",
        json!({ "url": "about:blank" }),
        Duration::from_secs(15),
    )?;
    let target_id = target["targetId"].as_str().context("targetId がありません")?;

    let attached = cdp.call(
        "Target.attachToTarget",
        json!({ "targetId": target_id, "flatten": true }),
        Duration::from_secs(15),
    )?;
    let session_id = attached["sessionId"].as_str().context("sessionId がありません")?;
    cdp.set_session(session_id);

    cdp.call("Page.enable", json!({}), Duration::from_secs(10))?;
    cdp.call(
        "Emulation.setEmulatedMedia",
        json!({ "media": "print" }),
        Duration::from_secs(10),
    )?;

    cdp.call("Page.navigate", json!({ "url": file_url(&src) }), Duration::from_secs(30))?;
    cdp.wait_event("Page.loadEventFired", overall)?;

    let ready = cdp.call(
        "Runtime.evaluate",
        json!({
            "expression": WAIT_READY_JS,
            "awaitPromise": true,
            "returnByValue": true,
        }),
        overall,
    )?;
    let image_count = ready["result"]["value"].as_u64().unwrap_or(0);

    // ReturnAsStream にするのが要点。
    // 数百ページの PDF を base64 で 1 メッセージに載せると
    // WebSocket のフレーム上限を超えて接続ごと落ちる。
    let printed = cdp.call(
        "Page.printToPDF",
        json!({
            "transferMode": "ReturnAsStream",
            "printBackground": true,
            "preferCSSPageSize": true,          // CSS の @page を尊重する
            "generateTaggedPDF": opts.outline,
            "generateDocumentOutline": opts.outline,
            "displayHeaderFooter": opts.page_numbers,
            "headerTemplate": HEADER_EMPTY,
            "footerTemplate": if opts.page_numbers { FOOTER } else { HEADER_EMPTY },
        }),
        overall,
    )?;

    let handle = printed["stream"]
        .as_str()
        .context("PDF ストリームハンドルを取得できませんでした")?
        .to_string();

    let bytes = drain_stream(&mut cdp, &handle, out_path, overall)?;

    cdp.call("IO.close", json!({ "handle": handle }), Duration::from_secs(10))?;
    let _ = cdp.call(
        "Target.closeTarget",
        json!({ "targetId": target_id }),
        Duration::from_secs(5),
    );

    Ok(PdfResult {
        path: out_path.display().to_string(),
        bytes,
        image_count,
    })
}

/// IO.read を eof まで回してファイルに落とす
fn drain_stream(
    cdp: &mut Cdp,
    handle: &str,
    out_path: &Path,
    timeout: Duration,
) -> Result<u64> {
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let mut file = std::fs::File::create(out_path)
        .with_context(|| format!("出力先を作成できません: {}", out_path.display()))?;

    let mut total: u64 = 0;
    loop {
        let chunk: Value = cdp.call(
            "IO.read",
            json!({ "handle": handle, "size": 1 << 20 }),
            timeout,
        )?;

        let data = chunk["data"].as_str().unwrap_or("");
        if !data.is_empty() {
            let raw = if chunk["base64Encoded"].as_bool().unwrap_or(true) {
                B64.decode(data).context("PDF チャンクの base64 復号に失敗しました")?
            } else {
                data.as_bytes().to_vec()
            };
            file.write_all(&raw)?;
            total += raw.len() as u64;
        }

        if chunk["eof"].as_bool().unwrap_or(false) {
            break;
        }
    }
    file.flush()?;

    if total == 0 {
        bail!("PDF が空です。HTML の読み込みに失敗している可能性があります");
    }
    Ok(total)
}

/// Windows のユーザー名に空白が入るケースがあるので最低限のエスケープをする
fn file_url(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    let encoded = s.replace('%', "%25").replace(' ', "%20").replace('#', "%23");
    if encoded.starts_with('/') {
        format!("file://{encoded}")
    } else {
        format!("file:///{encoded}")
    }
}

// ---------------------------------------------------------------------------
// Tauri コマンド

/// フロントから `invoke("generate_pdf", { html, outPath, options })` で呼ぶ。
///
/// PDF 本体を IPC で返すと数十 MB の base64 が往復して固まるので、
/// Rust 側でファイルに書き、パスとサイズだけ返す。
#[tauri::command]
pub async fn generate_pdf(
    html: String,
    out_path: String,
    options: Option<PdfOptions>,
) -> Result<PdfResult, String> {
    let opts = options.unwrap_or_default();
    let path = PathBuf::from(out_path);

    // CDP クライアントがブロッキングなので、専用スレッドに逃がす
    tauri::async_runtime::spawn_blocking(move || html_to_pdf(&html, &path, &opts))
        .await
        .map_err(|e| format!("内部エラー: {e}"))?
        .map_err(|e| format!("{e:#}"))
}

/// 事前チェック用。UI の起動時に呼んで、無ければ案内を出す。
#[tauri::command]
pub fn detect_browser() -> Result<String, String> {
    find_browser()
        .map(|p| p.display().to_string())
        .map_err(|e| format!("{e:#}"))
}
