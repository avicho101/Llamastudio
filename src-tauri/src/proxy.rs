//! ContextShift proxy.
//!
//! A tiny HTTP relay that sits in front of llama.cpp's OpenAI-compatible
//! endpoint. When enabled, it trims the conversation `messages` array so the
//! request fits inside the server's allocated context size (`-c`) *before*
//! forwarding — dropping the oldest messages and keeping the most recent ones.
//! This mirrors KoboldCpp's ContextShift: nothing restarts, the context window
//! stays fixed, and old tokens are shifted out so new ones fit.
//!
//! The response is streamed back byte-for-byte, so token generation speed is
//! unaffected (generation still happens entirely inside llama.cpp).

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use futures_util::StreamExt;
use tauri::{Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use serde_json::Value;

/// Rough token estimate: ~4 chars per token for English text.
fn estimate_tokens(text: &str) -> usize {
    let t = (text.chars().count() as f64 / 4.0).ceil() as usize;
    t.max(1)
}

/// Trim the `messages` array so total estimated tokens fit within `budget`.
/// The system message (if any) is always kept. Returns (trimmed_messages, dropped_count).
fn trim_messages(messages: &[Value], budget: usize) -> (Vec<Value>, usize) {
    let mut kept: Vec<Value> = Vec::new();
    let mut total = 0usize;
    let mut dropped = 0usize;

    // Separate the system message (keep it always) from the rest.
    let mut system: Option<Value> = None;
    let mut rest: Vec<&Value> = Vec::new();
    for m in messages {
        let role = m.get("role").and_then(|r| r.as_str()).unwrap_or("");
        if role == "system" {
            if system.is_none() {
                system = Some(m.clone());
                total += estimate_tokens(&m.to_string());
                continue;
            }
        }
        rest.push(m);
    }

    // Walk from the newest backward, keeping messages until we hit the budget.
    let mut selected: Vec<Value> = Vec::new();
    for m in rest.iter().rev() {
        let cost = estimate_tokens(&m.to_string());
        if !selected.is_empty() && total + cost > budget {
            dropped += 1;
            continue;
        }
        total += cost;
        selected.push((*m).clone());
    }
    // Restore original (oldest-first) order.
    selected.reverse();

    if let Some(s) = system {
        kept.push(s);
    }
    kept.extend(selected);
    (kept, dropped)
}

pub struct ProxyHandle {
    pub abort: Arc<AtomicBool>,
    pub task: tokio::task::JoinHandle<()>,
}

/// Kill whatever process is currently listening on `port` (best-effort).
/// On Windows: netstat -ano | findstr :PORT, then taskkill /F /PID.
/// On Unix: fuser -k PORT/tcp (or lsof fallback).
fn kill_listener_on_port(port: u16) {
    #[cfg(target_os = "windows")]
    {
        // Find the PID(s) listening on the port. Match both IPv4 (:8081) and
        // IPv6 ([::]:8081 / [0:0:0:0:0:0:0:0]:8081) forms.
        if let Ok(out) = std::process::Command::new("netstat")
            .args(["-ano"])
            .output()
        {
            let text = String::from_utf8_lossy(&out.stdout).to_string();
            for line in text.lines() {
                let lower = line.to_lowercase();
                if !lower.contains("listen") {
                    continue;
                }
                let has_port = line.contains(&format!(":{}", port))
                    || line.contains(&format!("]:{}", port));
                if !has_port {
                    continue;
                }
                if let Some(pid) = line.split_whitespace().last() {
                    if let Ok(pid) = pid.parse::<u32>() {
                        if pid == std::process::id() {
                            continue; // never kill ourselves
                        }
                        let _ = std::process::Command::new("taskkill")
                            .args(["/F", "/PID", &pid.to_string()])
                            .output();
                    }
                }
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = std::process::Command::new("fuser")
            .args(["-k", &format!("{}/tcp", port)])
            .output();
    }
}

/// Bind the proxy listener, retrying after killing any stale listener on the
/// port. On Windows the OS may take a moment to release a killed socket.
async fn bind_with_retry(
    addr: &str,
    listen_port: u16,
    app: &tauri::AppHandle,
) -> Result<TcpListener, String> {
    match TcpListener::bind(addr).await {
        Ok(l) => Ok(l),
        Err(e) => {
            let msg = e.to_string();
            let mut last_err = e;
            for attempt in 0..4 {
                push_proxy_log(
                    app,
                    &format!(
                        "[ContextShift] port {} in use (attempt {}), killing stale listener...",
                        listen_port,
                        attempt + 1
                    ),
                );
                kill_listener_on_port(listen_port);
                tokio::time::sleep(std::time::Duration::from_millis(600 + 400 * attempt)).await;
                match TcpListener::bind(addr).await {
                    Ok(l) => return Ok(l),
                    Err(e2) => last_err = e2,
                }
            }
            Err(format!(
                "Failed to bind ContextShift proxy on {}: {} (still busy after killing stale listener: {})",
                addr, msg, last_err
            ))
        }
    }
}

/// Start the ContextShift proxy. Listens on `listen_host:listen_port` and
/// forwards to `target_host:target_port` (llama.cpp). `ctx_size` is the server's
/// `-c`; `keep_pct` is the share of context (1..100) kept for recent messages.
pub async fn start_proxy(
    listen_host: String,
    listen_port: u16,
    target_host: String,
    target_port: u16,
    ctx_size: usize,
    keep_pct: usize,
    app: tauri::AppHandle,
) -> Result<ProxyHandle, String> {
    let addr = format!("{}:{}", listen_host, listen_port);
    let listener = bind_with_retry(&addr, listen_port, &app).await?;

    let abort = Arc::new(AtomicBool::new(false));
    let abort_task = abort.clone();

    let task = tokio::spawn(async move {
        loop {
            if abort_task.load(Ordering::SeqCst) {
                break;
            }
            let (stream, _) = match listener.accept().await {
                Ok(v) => v,
                Err(_) => {
                    // brief pause to avoid a hot loop on repeated errors
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    continue;
                }
            };
            let cfg = ConnCfg {
                target_host: target_host.clone(),
                target_port,
                ctx_size,
                keep_pct,
                app: app.clone(),
            };
            tokio::spawn(handle_conn(stream, cfg));
        }
    });

    Ok(ProxyHandle { abort, task })
}

/// Log a line to the app's Logs tab (used by the proxy module).
fn push_proxy_log(app: &tauri::AppHandle, line: &str) {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let _ = app.emit("server-log", crate::LogLine { line: line.to_string(), ts });
}

struct ConnCfg {
    target_host: String,
    target_port: u16,
    ctx_size: usize,
    keep_pct: usize,
    app: tauri::AppHandle,
}

async fn handle_conn(mut stream: TcpStream, cfg: ConnCfg) {
    // Read the full HTTP request (headers + body).
    let mut buf = Vec::with_capacity(8192);
    let mut byte = [0u8; 1];
    // Read until we have the full header block.
    let header_end = 'read: {
        loop {
            match stream.read(&mut byte).await {
                Ok(0) => break 'read None, // closed
                Ok(_) => {
                    buf.push(byte[0]);
                    if buf.len() >= 4 && &buf[buf.len() - 4..] == b"\r\n\r\n" {
                        break 'read Some(buf.len());
                    }
                    if buf.len() > 1_000_000 {
                        break 'read None; // sanity cap
                    }
                }
                Err(_) => break 'read None,
            }
        }
    };
    let header_end = match header_end {
        Some(v) => v,
        None => return,
    };

    // Parse request line + headers.
    let header_str = String::from_utf8_lossy(&buf[..header_end]);
    let mut lines = header_str.split("\r\n");
    let request_line = match lines.next() {
        Some(l) => l.to_string(),
        None => return,
    };
    let parts: Vec<&str> = request_line.split_whitespace().collect();
    if parts.len() < 2 {
        return;
    }
    let method = parts[0];
    let path = parts[1];

    // CORS preflight: answer OPTIONS directly (WebView2 enforces CORS, and
    // upstream llama-server would reject/ignore the preflight).
    if method.eq_ignore_ascii_case("OPTIONS") {
        let _ = stream
            .write_all(
                b"HTTP/1.1 204 No Content\r\n\
                  Access-Control-Allow-Origin: *\r\n\
                  Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
                  Access-Control-Allow-Headers: Content-Type, Authorization, X-Requested-With\r\n\
                  Access-Control-Max-Age: 86400\r\n\
                  Content-Length: 0\r\n\
                  Connection: keep-alive\r\n\r\n",
            )
            .await;
        return;
    }

    let mut content_length = 0usize;
    let mut wants_stream = false; // set by the LlamaStudio chat (X-LlamaStudio-Stream)
    for h in lines {
        if let Some((k, v)) = h.split_once(":") {
            if k.trim().eq_ignore_ascii_case("content-length") {
                content_length = v.trim().parse().unwrap_or(0);
            }
            if k.trim().eq_ignore_ascii_case("x-llamastudio-stream") {
                wants_stream = v.trim().eq_ignore_ascii_case("1");
            }
        }
    }

    // Read the body.
    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        if stream.read_exact(&mut body).await.is_err() {
            return;
        }
    }

    // Determine if this is a chat completion we should trim.
    let is_chat = method.eq_ignore_ascii_case("POST")
        && (path.starts_with("/v1/chat/completions") || path.starts_with("/chat/completions"));

    let mut final_body = body.clone();
    if is_chat && content_length > 0 {
        if let Ok(mut json) = serde_json::from_slice::<Value>(&body) {
            if let Some(messages) = json.get("messages").and_then(|m| m.as_array()) {
                // Budget: keep_pct of ctx_size, reserving ~25% for the reply.
                let keep = cfg.keep_pct.clamp(20, 95) as f64 / 100.0;
                let budget = ((cfg.ctx_size as f64) * keep * 0.75) as usize;
                let total_msgs: Vec<Value> = messages.clone();
                let full_cost: usize = total_msgs
                    .iter()
                    .map(|m| estimate_tokens(&m.to_string()))
                    .sum();
                if full_cost > budget && total_msgs.len() > 1 {
                    let (trimmed, dropped) = trim_messages(&total_msgs, budget);
                    if dropped > 0 {
                        json["messages"] = Value::Array(trimmed);
                        final_body = serde_json::to_vec(&json).unwrap_or(body.clone());
                        let _ = cfg.app.emit(
                            "server-log",
                            crate::LogLine {
                                line: format!(
                                    "[ContextShift] trimmed {} old message(s) to fit context ({} tokens budget)",
                                    dropped, budget
                                ),
                                ts: std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .map(|d| d.as_secs())
                                    .unwrap_or(0),
                            },
                        );
                    }
                }
            }
        }
    }

    // Forward to llama.cpp and stream the response back.
    let target_url = format!("http://{}:{}{}", cfg.target_host, cfg.target_port, path);
    let client = reqwest::Client::new();
    let resp = client
        .request(
            reqwest::Method::from_bytes(method.as_bytes()).unwrap_or(reqwest::Method::POST),
            &target_url,
        )
        .header("Content-Type", "application/json")
        .header("Access-Control-Allow-Origin", "*")
        .body(final_body)
        .send()
        .await;

    let resp = match resp {
        Ok(r) => r,
        Err(e) => {
            let _ = write_simple(
                &mut stream,
                502,
                &format!("ContextShift proxy: upstream error: {}", e),
            )
            .await;
            return;
        }
    };

    let status = resp.status();
    // Collect upstream headers BEFORE consuming the body stream (bytes_stream
    // takes ownership of resp).
    let mut head = format!(
        "HTTP/1.1 {} {}\r\n",
        status.as_u16(),
        status.canonical_reason().unwrap_or("OK")
    );
    for (k, v) in resp.headers() {
        let kn = k.as_str().to_ascii_lowercase();
        // Drop framing headers we regenerate ourselves.
        if kn == "content-length" || kn == "transfer-encoding" || kn == "connection" {
            continue;
        }
        if let Ok(vs) = v.to_str() {
            head.push_str(&format!("{}: {}\r\n", k.as_str(), vs));
        }
    }

    // Buffer the full upstream body, then forward with Content-Length framing.
    //
    // WHY: Goose's stream parser does NOT decode Transfer-Encoding: chunked.
    // llama.cpp sends its SSE response Content-Length-framed (which Goose reads
    // fine directly); if we re-chunk, Goose reads the chunk-framing hex as body
    // garbage -> "Stream decode error". So we mirror llama.cpp: Content-Length,
    // raw body. Tradeoff: Goose sees the reply when generation finishes, not
    // token-by-token. Correctness over token streaming.
    //
    // LlamaStudio's own chat sends X-LlamaStudio-Stream: 1 and wants true
    // token-by-token streaming (WebView2 handles chunked fine) — so for that
    // client we stream chunked instead of buffering.
    if wants_stream {
        // Forward chunked: write headers without Content-Length, then each
        // upstream chunk as an HTTP/1.1 chunk.
        let mut stream_head = head.clone();
        if !stream_head.to_ascii_lowercase().contains("access-control-allow-origin") {
            stream_head.push_str("Access-Control-Allow-Origin: *\r\n");
        }
        stream_head.push_str("Transfer-Encoding: chunked\r\n\r\n");
        if stream.write_all(stream_head.as_bytes()).await.is_err() {
            return;
        }
        let mut stream_body = resp.bytes_stream();
        while let Some(chunk) = stream_body.next().await {
            match chunk {
                Ok(c) => {
                    let mut framed = format!("{:X}\r\n", c.len()).into_bytes();
                    framed.extend_from_slice(&c);
                    framed.extend_from_slice(b"\r\n");
                    if stream.write_all(&framed).await.is_err() {
                        return;
                    }
                    if stream.flush().await.is_err() {
                        return;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = stream.write_all(b"0\r\n\r\n").await;
        let _ = stream.flush().await;
        return;
    }

    let mut body_bytes: Vec<u8> = Vec::new();
    let mut stream_body = resp.bytes_stream();
    while let Some(chunk) = stream_body.next().await {
        if let Ok(c) = chunk {
            body_bytes.extend_from_slice(&c);
        }
    }
    head.push_str(&format!("Content-Length: {}\r\n\r\n", body_bytes.len()));
    if stream.write_all(head.as_bytes()).await.is_err() {
        return;
    }
    if stream.write_all(&body_bytes).await.is_err() {
        return;
    }
    let _ = stream.flush().await;
}

async fn write_simple(stream: &mut TcpStream, status: u16, msg: &str) -> std::io::Result<()> {
    let body = format!("{{\"error\":\"{}\"}}", msg.replace('"', "'"));
    let head = format!(
        "HTTP/1.1 {} Error\r\nContent-Type: application/json\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\n\r\n",
        status,
        body.len()
    );
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(body.as_bytes()).await?;
    stream.flush().await
}
