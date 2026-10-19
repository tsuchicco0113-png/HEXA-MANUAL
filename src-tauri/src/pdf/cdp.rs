use std::collections::VecDeque;
use std::net::TcpStream;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

/// 最小限の CDP クライアント。
///
/// headless_chrome / chromiumoxide も使えるが、`generateDocumentOutline` は
/// バインディングによっては型に無い。しおり付き PDF が目的なので、
/// 任意のパラメータをそのまま送れる生 CDP のほうが確実。
pub struct Cdp {
    ws: WebSocket<MaybeTlsStream<TcpStream>>,
    next_id: u64,
    /// 応答待ちの間に届いたイベントを取りこぼさないための待避キュー
    events: VecDeque<Value>,
    session_id: Option<String>,
}

impl Cdp {
    pub fn connect(url: &str) -> Result<Self> {
        let (mut ws, _) = tungstenite::connect(url)?;

        // read() をブロックさせ続けないよう、短いタイムアウトを入れて
        // 呼び出し側の deadline 判定を回せるようにする
        if let MaybeTlsStream::Plain(s) = ws.get_mut() {
            s.set_read_timeout(Some(Duration::from_millis(250)))?;
        }

        Ok(Self { ws, next_id: 1, events: VecDeque::new(), session_id: None })
    }

    pub fn set_session(&mut self, session_id: impl Into<String>) {
        self.session_id = Some(session_id.into());
    }

    pub fn call(&mut self, method: &str, params: Value, timeout: Duration) -> Result<Value> {
        let id = self.next_id;
        self.next_id += 1;

        let mut msg = json!({ "id": id, "method": method, "params": params });
        if let Some(sid) = &self.session_id {
            msg["sessionId"] = json!(sid);
        }
        self.ws.send(Message::Text(msg.to_string().into()))?;

        let deadline = Instant::now() + timeout;
        loop {
            let Some(v) = self.pump(deadline)? else {
                bail!("{method} がタイムアウトしました");
            };
            if v.get("id").and_then(Value::as_u64) == Some(id) {
                if let Some(err) = v.get("error") {
                    bail!("{method} が失敗しました: {err}");
                }
                return Ok(v.get("result").cloned().unwrap_or(Value::Null));
            }
            if v.get("method").is_some() {
                self.events.push_back(v);
            }
        }
    }

    pub fn wait_event(&mut self, name: &str, timeout: Duration) -> Result<Value> {
        // すでに届いているものを先に見る
        if let Some(pos) = self
            .events
            .iter()
            .position(|e| e.get("method").and_then(Value::as_str) == Some(name))
        {
            return Ok(self.events.remove(pos).unwrap());
        }

        let deadline = Instant::now() + timeout;
        loop {
            let Some(v) = self.pump(deadline)? else {
                bail!("イベント {name} を待機中にタイムアウトしました");
            };
            if v.get("method").and_then(Value::as_str) == Some(name) {
                return Ok(v);
            }
            if v.get("method").is_some() {
                self.events.push_back(v);
            }
        }
    }

    /// 1 メッセージ読む。deadline を過ぎたら None。
    fn pump(&mut self, deadline: Instant) -> Result<Option<Value>> {
        loop {
            if Instant::now() >= deadline {
                return Ok(None);
            }
            match self.ws.read() {
                Ok(Message::Text(t)) => {
                    return Ok(Some(serde_json::from_str(t.as_str())?));
                }
                Ok(Message::Close(_)) => bail!("DevTools 接続が閉じられました"),
                Ok(_) => continue,
                Err(tungstenite::Error::Io(e))
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    continue
                }
                Err(e) => return Err(anyhow!(e)),
            }
        }
    }
}
