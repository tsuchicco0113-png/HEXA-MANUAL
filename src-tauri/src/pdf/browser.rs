use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};

/// 環境変数でパスを明示できるようにしておく。
/// ポータブル版 Chrome を使いたい人が必ずいる。
const ENV_OVERRIDE: &str = "HEXA_CHROME_PATH";

/// Chromium 系ブラウザを探す。
///
/// Edge を候補に入れているのが重要で、Windows では Edge が必ず入っている。
/// 「Chrome を入れてください」と言わずに済むかどうかで導入率が変わる。
pub fn find_browser() -> Result<PathBuf> {
    if let Ok(p) = std::env::var(ENV_OVERRIDE) {
        let p = PathBuf::from(p);
        if p.exists() {
            return Ok(p);
        }
        bail!("{ENV_OVERRIDE} に指定されたパスが存在しません: {}", p.display());
    }

    for c in candidates() {
        if c.exists() {
            return Ok(c);
        }
    }

    // Linux は PATH から探す
    #[cfg(target_os = "linux")]
    for name in [
        "google-chrome",
        "google-chrome-stable",
        "chromium",
        "chromium-browser",
        "microsoft-edge",
    ] {
        if let Ok(out) = Command::new("which").arg(name).output() {
            if out.status.success() {
                let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !p.is_empty() {
                    return Ok(PathBuf::from(p));
                }
            }
        }
    }

    Err(anyhow!(
        "Chromium 系ブラウザが見つかりません。Chrome または Edge をインストールするか、\
         環境変数 {ENV_OVERRIDE} に実行ファイルのパスを指定してください。"
    ))
}

#[cfg(target_os = "windows")]
fn candidates() -> Vec<PathBuf> {
    let mut v = Vec::new();
    for key in ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"] {
        if let Ok(base) = std::env::var(key) {
            v.push(PathBuf::from(&base).join(r"Google\Chrome\Application\chrome.exe"));
            v.push(PathBuf::from(&base).join(r"Microsoft\Edge\Application\msedge.exe"));
        }
    }
    v
}

#[cfg(target_os = "macos")]
fn candidates() -> Vec<PathBuf> {
    [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ]
    .iter()
    .map(PathBuf::from)
    .collect()
}

#[cfg(target_os = "linux")]
fn candidates() -> Vec<PathBuf> {
    ["/usr/bin/google-chrome", "/usr/bin/chromium", "/snap/bin/chromium"]
        .iter()
        .map(PathBuf::from)
        .collect()
}

/// 起動した Chrome プロセス。Drop で必ず kill する。
pub struct Browser {
    child: Child,
    pub ws_url: String,
    _profile: tempfile::TempDir,
}

impl Browser {
    pub fn launch(exe: &Path) -> Result<Self> {
        // 既存プロファイルを触ると起動中の Chrome に相乗りしてしまい、
        // headless にならない。必ず使い捨てプロファイルを渡す。
        let profile = tempfile::Builder::new()
            .prefix("hexa-manual-chrome-")
            .tempdir()
            .context("一時プロファイルを作成できません")?;

        let mut child = Command::new(exe)
            .args([
                "--headless=new",
                "--remote-debugging-port=0",
                "--disable-gpu",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-extensions",
                "--disable-background-networking",
                "--disable-sync",
                "--mute-audio",
                "--hide-scrollbars",
                // 印刷時のフォントの潰れを防ぐ
                "--font-render-hinting=none",
                "about:blank",
            ])
            .arg(format!("--user-data-dir={}", profile.path().display()))
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .with_context(|| format!("起動に失敗しました: {}", exe.display()))?;

        let stderr = child.stderr.take().expect("stderr piped");
        let ws_url = read_ws_url(stderr, Duration::from_secs(20));

        match ws_url {
            Ok(url) => Ok(Self { child, ws_url: url, _profile: profile }),
            Err(e) => {
                let _ = child.kill();
                Err(e)
            }
        }
    }
}

impl Drop for Browser {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Chrome は起動時に stderr へ
/// `DevTools listening on ws://127.0.0.1:PORT/devtools/browser/UUID`
/// を 1 行だけ出す。ポートを 0 にしているのでこれを読むしかない。
fn read_ws_url(stderr: std::process::ChildStderr, timeout: Duration) -> Result<String> {
    let deadline = Instant::now() + timeout;
    let mut reader = BufReader::new(stderr);
    let mut line = String::new();

    loop {
        if Instant::now() > deadline {
            bail!("DevTools エンドポイントを取得できませんでした（タイムアウト）");
        }
        line.clear();
        let n = reader.read_line(&mut line)?;
        if n == 0 {
            bail!("ブラウザが起動直後に終了しました");
        }
        if let Some(idx) = line.find("ws://") {
            return Ok(line[idx..].trim().to_string());
        }
    }
}
