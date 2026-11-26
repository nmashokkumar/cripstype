use serde_json::{json, Value};
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tungstenite::Message;

static IS_DICTATING: AtomicBool = AtomicBool::new(false);
static STOP_REQUESTED: AtomicBool = AtomicBool::new(false);

/// Derives the WebSocket transcription endpoint from a base HTTP/HTTPS/WS URL.
pub fn derive_ws_url(base_url: &str) -> Result<String, String> {
    let trimmed = base_url
        .trim()
        .trim_end_matches('/')
        .trim_end_matches("/api/v1/meetings/transcribe")
        .trim_end_matches("/transcribe")
        .trim_end_matches("/health")
        .trim_end_matches('/');

    if trimmed.is_empty() {
        return Err("Server URL is empty. Open CrispType Settings to set your server link.".to_string());
    }

    if trimmed.starts_with("ws://") || trimmed.starts_with("wss://") {
        Ok(format!("{}/api/v1/meetings/transcribe", trimmed))
    } else if let Some(rest) = trimmed.strip_prefix("https://") {
        Ok(format!("wss://{}/api/v1/meetings/transcribe", rest))
    } else if let Some(rest) = trimmed.strip_prefix("http://") {
        Ok(format!("ws://{}/api/v1/meetings/transcribe", rest))
    } else {
        Ok(format!("ws://{}/api/v1/meetings/transcribe", trimmed))
    }
}

/// Computes 10 normalized waveform bar heights [0.15..1.0] from 16-bit LE mono PCM bytes.
pub fn compute_rms_bars(pcm_bytes: &[u8]) -> Vec<f64> {
    let sample_count = pcm_bytes.len() / 2;
    if sample_count == 0 {
        return vec![0.18; 10];
    }

    let mut sum_sq = 0.0f64;
    for chunk in pcm_bytes.chunks_exact(2) {
        let sample = i16::from_le_bytes([chunk[0], chunk[1]]) as f64 / 32768.0;
        sum_sq += sample * sample;
    }
    let rms = (sum_sq / sample_count as f64).sqrt();
    let gain = (rms * 7.5).clamp(0.0, 1.0);

    let weights = [0.35, 0.55, 0.78, 0.95, 1.0, 1.0, 0.95, 0.78, 0.55, 0.35];
    weights
        .iter()
        .map(|w| (0.18 + gain * 0.82 * w).clamp(0.18, 1.0))
        .collect()
}

pub fn build_start_handshake(api_key: Option<&str>, app_name: &str) -> Value {
    let mut obj = json!({
        "type": "start",
        "preset": "natural",
        "app_context": app_name,
        "app_category": "other",
        "cleanup": {
            "removeFillerWords": true,
            "applySelfCorrections": true,
            "autoPunctuation": true,
            "autoCapitalization": true
        },
        "dictionary": []
    });
    if let Some(key) = api_key.map(str::trim).filter(|k| !k.is_empty()) {
        obj["api_key"] = Value::String(key.to_string());
    }
    obj
}

pub fn build_stop_frame(packets_sent: usize, bytes_sent: usize) -> Value {
    json!({
        "type": "stop",
        "packets_sent": packets_sent,
        "bytes_sent": bytes_sent
    })
}

/// Extracts final transcript from a WebSocket JSON message.
/// Returns `Ok(Some(text))` on final transcript, `Ok(None)` for status/partial frames, or `Err(msg)` on error.
pub fn extract_final_transcript(json_str: &str) -> Result<Option<String>, String> {
    let v: Value = serde_json::from_str(json_str).map_err(|e| format!("Invalid server JSON: {}", e))?;
    if v.get("status").and_then(Value::as_str) == Some("error") || v.get("error").is_some() {
        let msg = v
            .get("error")
            .or_else(|| v.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("Transcription server returned an error.");
        return Err(msg.to_string());
    }
    if v.get("status").and_then(Value::as_str) == Some("ready") {
        return Ok(None);
    }
    let is_final = v.get("is_final").and_then(Value::as_bool).unwrap_or(false);
    let formatted = v.get("formatted_text").and_then(Value::as_str);
    let raw = v.get("text").and_then(Value::as_str);
    if is_final || formatted.is_some() || raw.is_some() {
        let text = formatted.or(raw).unwrap_or("").trim().to_string();
        if is_final || !text.is_empty() {
            return Ok(Some(text));
        }
    }
    Ok(None)
}

/// Parses a single HTTP request line for `/trigger` or `/health`.
pub fn parse_http_trigger_request(request_line: &str) -> Option<&'static str> {
    let mut parts = request_line.split_whitespace();
    let method = parts.next()?;
    let path = parts.next()?;
    if method != "GET" && method != "POST" {
        return None;
    }
    if path == "/health" {
        return Some("health");
    }
    if path.starts_with("/trigger") {
        if path.contains("mode=stop") {
            return Some("stop");
        }
        if path.contains("mode=start") {
            return Some("start");
        }
        return Some("toggle");
    }
    None
}

fn spawn_pcm_capture() -> Result<Child, String> {
    // Prefer ALSA `arecord -t raw` (routes through PipeWire on modern Linux and guarantees
    // headerless S16_LE 16 kHz mono PCM), falling back to `pw-record` if `arecord` is absent.
    if let Ok(child) = Command::new("arecord")
        .args(["-q", "-f", "S16_LE", "-r", "16000", "-c", "1", "-t", "raw", "-"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        return Ok(child);
    }

    Command::new("pw-record")
        .args(["--rate=16000", "--channels=1", "--format=s16", "-"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("No mic capture tool (arecord/pw-record) available: {}", e))
}

#[cfg(target_os = "linux")]
pub fn settings_json_path() -> Option<std::path::PathBuf> {
    dirs::config_dir().map(|d| d.join("com.crisptype.app").join("settings.json"))
}

#[cfg(not(target_os = "linux"))]
pub fn settings_json_path() -> Option<std::path::PathBuf> {
    None
}

fn load_server_credentials() -> (String, Option<String>) {
    if let Some(path) = settings_json_path() {
        if let Ok(raw) = std::fs::read_to_string(path) {
            if let Ok(v) = serde_json::from_str::<Value>(&raw) {
                let url = v
                    .get("serverUrl")
                    .and_then(Value::as_str)
                    .unwrap_or("http://localhost:8000")
                    .trim()
                    .to_string();
                let key = v
                    .get("apiKey")
                    .and_then(Value::as_str)
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty());
                if !url.is_empty() {
                    return (url, key);
                }
            }
        }
    }
    ("http://localhost:8000".to_string(), None)
}

pub fn is_active() -> bool {
    IS_DICTATING.load(Ordering::SeqCst)
}

pub fn stop() {
    if IS_DICTATING.load(Ordering::SeqCst) {
        STOP_REQUESTED.store(true, Ordering::SeqCst);
    }
}

pub fn toggle() {
    if IS_DICTATING.load(Ordering::SeqCst) {
        STOP_REQUESTED.store(true, Ordering::SeqCst);
        return;
    }

    if IS_DICTATING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    STOP_REQUESTED.store(false, Ordering::SeqCst);

    std::thread::spawn(move || {
        run_dictation_session();
        IS_DICTATING.store(false, Ordering::SeqCst);
        STOP_REQUESTED.store(false, Ordering::SeqCst);
    });
}

fn show_error_and_hide(msg: &str) {
    #[cfg(target_os = "linux")]
    {
        crate::native_overlay::update_state(
            "error".to_string(),
            false,
            0,
            vec![0.18; 10],
            Some(msg.to_string()),
        );
        crate::native_overlay::set_visible(true);
        crate::native_overlay::set_interactive(true);
    }
    let _ = msg;
    std::thread::sleep(Duration::from_millis(3200));
    #[cfg(target_os = "linux")]
    {
        crate::native_overlay::set_visible(false);
        crate::native_overlay::set_interactive(false);
    }
}

fn run_dictation_session() {
    let (server_url, api_key) = load_server_credentials();
    let ws_url = match derive_ws_url(&server_url) {
        Ok(u) => u,
        Err(e) => {
            show_error_and_hide(&e);
            return;
        }
    };

    #[cfg(target_os = "linux")]
    {
        crate::native_overlay::update_state(
            "listening".to_string(),
            true,
            0,
            vec![0.2; 10],
            None,
        );
        crate::native_overlay::set_visible(true);
        crate::native_overlay::set_interactive(true);
    }

    let mut child = match spawn_pcm_capture() {
        Ok(c) => c,
        Err(e) => {
            show_error_and_hide(&e);
            return;
        }
    };

    let mut stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            show_error_and_hide("Mic stream unavailable.");
            return;
        }
    };

    enum WsEvent {
        Packet(Vec<u8>),
        Stop { packets: usize, bytes: usize },
    }
    let (tx, rx) = std::sync::mpsc::channel::<WsEvent>();
    let app_name = crate::get_active_app()
        .map(|info| info.app_name)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "General".to_string());
    let handshake = build_start_handshake(api_key.as_deref(), &app_name);

    let ws_handle = std::thread::spawn(move || -> Result<Option<String>, String> {
        let (mut socket, _) =
            tungstenite::connect(&ws_url).map_err(|e| format!("Server connection failed: {}", e))?;
        socket
            .send(Message::Text(handshake.to_string()))
            .map_err(|_| "Failed to send WebSocket handshake.".to_string())?;

        while let Ok(ev) = rx.recv() {
            match ev {
                WsEvent::Packet(data) => {
                    if socket.send(Message::Binary(data)).is_err() {
                        return Err("WebSocket send failed.".to_string());
                    }
                }
                WsEvent::Stop { packets, bytes } => {
                    let stop_frame = build_stop_frame(packets, bytes);
                    let _ = socket.send(Message::Text(stop_frame.to_string()));
                    break;
                }
            }
        }

        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            match socket.read() {
                Ok(Message::Text(txt)) => match extract_final_transcript(&txt) {
                    Ok(Some(t)) => {
                        let _ = socket.close(None);
                        return Ok(Some(t));
                    }
                    Ok(None) => continue,
                    Err(e) => {
                        let _ = socket.close(None);
                        return Err(e);
                    }
                },
                Ok(Message::Close(_)) | Err(_) => break,
                _ => continue,
            }
        }
        let _ = socket.close(None);
        Ok(None)
    });

    let started = Instant::now();
    let mut last_ui_update = Instant::now();
    let mut packets_sent = 0usize;
    let mut bytes_sent = 0usize;
    let mut buf = [0u8; 1024];

    while !STOP_REQUESTED.load(Ordering::SeqCst) {
        if started.elapsed() >= Duration::from_secs(300) {
            break;
        }
        match stdout.read_exact(&mut buf) {
            Ok(()) => {
                if tx.send(WsEvent::Packet(buf.to_vec())).is_err() {
                    break;
                }
                packets_sent += 1;
                bytes_sent += buf.len();

                if last_ui_update.elapsed() >= Duration::from_millis(50) {
                    last_ui_update = Instant::now();
                    let bars = compute_rms_bars(&buf);
                    let elapsed_ms = started.elapsed().as_millis() as u64;
                    #[cfg(target_os = "linux")]
                    crate::native_overlay::update_state(
                        "listening".to_string(),
                        true,
                        elapsed_ms,
                        bars,
                        None,
                    );
                }
            }
            Err(_) => break,
        }
    }

    let _ = child.kill();
    let _ = child.wait();

    #[cfg(target_os = "linux")]
    {
        crate::native_overlay::set_interactive(false);
        crate::native_overlay::update_state(
            "transcribing".to_string(),
            true,
            started.elapsed().as_millis() as u64,
            vec![0.18; 10],
            None,
        );
    }

    let _ = tx.send(WsEvent::Stop {
        packets: packets_sent,
        bytes: bytes_sent,
    });
    drop(tx);

    let ws_result = ws_handle
        .join()
        .unwrap_or_else(|_| Err("Transcription worker panicked.".to_string()));

    match ws_result {
        Err(err) => {
            show_error_and_hide(&err);
            return;
        }
        Ok(Some(text)) if !text.is_empty() => {
            let _ = crate::paste_text(text);
            #[cfg(target_os = "linux")]
            crate::native_overlay::update_state(
                "done".to_string(),
                true,
                0,
                vec![0.18; 10],
                None,
            );
            std::thread::sleep(Duration::from_millis(850));
        }
        Ok(_) => {}
    }

    #[cfg(target_os = "linux")]
    {
        crate::native_overlay::set_visible(false);
        crate::native_overlay::set_interactive(false);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_derive_ws_url_variants() {
        assert_eq!(
            derive_ws_url("https://api.example.com/").unwrap(),
            "wss://api.example.com/api/v1/meetings/transcribe"
        );
        assert_eq!(
            derive_ws_url("http://localhost:8000").unwrap(),
            "ws://localhost:8000/api/v1/meetings/transcribe"
        );
        assert_eq!(
            derive_ws_url("https://host.test/api/v1/meetings/transcribe").unwrap(),
            "wss://host.test/api/v1/meetings/transcribe"
        );
        assert!(derive_ws_url("   ").is_err());
    }

    #[test]
    fn test_compute_rms_bars_silence_and_loud() {
        let silence = vec![0u8; 1024];
        let bars = compute_rms_bars(&silence);
        assert_eq!(bars.len(), 10);
        assert!(bars.iter().all(|&b| (b - 0.18).abs() < 1e-6));

        let mut loud = Vec::with_capacity(1024);
        for _ in 0..512 {
            loud.extend_from_slice(&20000i16.to_le_bytes());
        }
        let loud_bars = compute_rms_bars(&loud);
        assert!(loud_bars[4] > 0.8);
    }

    #[test]
    fn test_parse_http_trigger_request() {
        assert_eq!(
            parse_http_trigger_request("GET /trigger?mode=hands_free HTTP/1.1"),
            Some("toggle")
        );
        assert_eq!(
            parse_http_trigger_request("GET /trigger?mode=stop HTTP/1.1"),
            Some("stop")
        );
        assert_eq!(
            parse_http_trigger_request("GET /health HTTP/1.1"),
            Some("health")
        );
        assert_eq!(parse_http_trigger_request("GET /unknown HTTP/1.1"), None);
    }

    #[test]
    fn test_extract_final_transcript() {
        assert_eq!(extract_final_transcript(r#"{"status":"ready"}"#).unwrap(), None);
        assert_eq!(
            extract_final_transcript(r#"{"is_final":true,"formatted_text":"Hello world."}"#)
                .unwrap(),
            Some("Hello world.".to_string())
        );
        assert!(extract_final_transcript(r#"{"status":"error","error":"Bad key"}"#).is_err());
    }

    #[test]
    fn test_ws_tls_connector_initializes_without_panic() {
        // Ensures wss:// TLS connector never panics at runtime (e.g. missing CryptoProvider)
        let res = tungstenite::connect("wss://127.0.0.1:1/test");
        assert!(res.is_err());
    }
}
