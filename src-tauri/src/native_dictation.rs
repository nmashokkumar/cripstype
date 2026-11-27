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

pub fn classify_active_app(app_name: &str, window_title: &str) -> (String, &'static str) {
    let combined = format!("{} {}", window_title, app_name).to_lowercase();

    const RULES: &[(&str, &str, &[&str])] = &[
        ("Gmail", "email", &["gmail", "mail.google.com"]),
        ("Outlook", "email", &["outlook"]),
        ("Thunderbird", "email", &["thunderbird"]),
        ("Proton Mail", "email", &["protonmail", "proton mail", "mail.proton"]),
        ("WhatsApp", "personal", &["whatsapp", "web.whatsapp"]),
        ("Telegram", "personal", &["telegram"]),
        ("Signal", "personal", &["signaldesktop", "signal"]),
        ("Discord", "personal", &["discord"]),
        ("Messenger", "personal", &["messenger"]),
        ("Instagram", "personal", &["instagram"]),
        ("Slack", "work", &["slack"]),
        ("Microsoft Teams", "work", &["ms-teams", "teams"]),
        ("Google Chat", "work", &["google chat", "chat.google.com"]),
        ("Zoom", "work", &["zoom"]),
        ("Notion", "work", &["notion"]),
        ("Jira", "work", &["jira", "atlassian"]),
        ("Linear", "work", &["linear"]),
        ("Antigravity", "work", &["antigravity"]),
        ("VS Code", "work", &["vs code", "visual studio code", "vscode"]),
        ("Cursor", "work", &["cursor"]),
        ("Terminal", "work", &["terminal", "gnome-terminal", "kitty", "alacritty", "wezterm", "konsole"]),
        ("GitHub", "work", &["github"]),
        ("Google Docs", "work", &["google docs", "docs.google.com"]),
        ("Figma", "work", &["figma"]),
        ("Brave Browser", "other", &["brave"]),
        ("Chrome", "other", &["google chrome", "chrome"]),
        ("Firefox", "other", &["firefox"]),
    ];

    for (canonical, category, keywords) in RULES {
        if keywords.iter().any(|kw| combined.contains(kw)) {
            return ((*canonical).to_string(), category);
        }
    }

    let trimmed = app_name.trim();
    if trimmed.is_empty() {
        ("General".to_string(), "other")
    } else {
        (trimmed.to_string(), "other")
    }
}

pub fn default_style_for_category(category: &str) -> &'static str {
    match category {
        "email" => "formal",
        "work" => "casual",
        "personal" => "very_casual",
        _ => "formal",
    }
}

pub fn build_start_handshake(
    api_key: Option<&str>,
    app_name: &str,
    app_category: &str,
    preset: &str,
) -> Value {
    let mut obj = json!({
        "type": "start",
        "preset": preset,
        "app_context": app_name,
        "app_category": app_category,
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FinalTranscriptResult {
    pub text: String,
    pub raw_text: String,
    pub filler_removed_count: u32,
}

/// Extracts final transcript and raw ASR text from a WebSocket JSON message.
/// Returns `Ok(Some(res))` on final transcript, `Ok(None)` for status/partial frames, or `Err(msg)` on error.
pub fn extract_final_transcript(json_str: &str) -> Result<Option<FinalTranscriptResult>, String> {
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
    let text_field = v.get("text").and_then(Value::as_str);
    let raw_field = v.get("raw_text").and_then(Value::as_str);
    let filler_removed_count = v
        .get("filler_removed_count")
        .and_then(Value::as_u64)
        .unwrap_or(0) as u32;
    if is_final || formatted.is_some() || text_field.is_some() {
        let text = formatted.or(text_field).unwrap_or("").trim().to_string();
        let raw_text = raw_field
            .filter(|s| !s.trim().is_empty())
            .or(text_field)
            .unwrap_or(&text)
            .trim()
            .to_string();
        if is_final || !text.is_empty() {
            return Ok(Some(FinalTranscriptResult {
                text,
                raw_text,
                filler_removed_count,
            }));
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

#[cfg(target_os = "linux")]
pub fn pending_history_path() -> Option<std::path::PathBuf> {
    dirs::config_dir().map(|d| d.join("com.crisptype.app").join("pending_history.jsonl"))
}

#[cfg(not(target_os = "linux"))]
pub fn pending_history_path() -> Option<std::path::PathBuf> {
    None
}

#[cfg(target_os = "linux")]
pub fn pending_audio_dir() -> Option<std::path::PathBuf> {
    dirs::config_dir().map(|d| d.join("com.crisptype.app").join("pending_audio"))
}

#[cfg(not(target_os = "linux"))]
pub fn pending_audio_dir() -> Option<std::path::PathBuf> {
    None
}

pub fn dataset_samples_path() -> Option<std::path::PathBuf> {
    dirs::config_dir().map(|d| d.join("com.crisptype.app").join("dataset_samples.jsonl"))
}

pub fn append_dataset_sample_record(sample: &Value) {
    use std::io::Write;
    let Some(path) = dataset_samples_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(file, "{}", sample);
    }
    if let Ok(raw) = std::fs::read_to_string(&path) {
        let lines: Vec<&str> = raw.lines().filter(|l| !l.trim().is_empty()).collect();
        if lines.len() > 200 {
            let kept = lines[lines.len() - 200..].join("\n") + "\n";
            let _ = std::fs::write(&path, kept);
        }
    }
}

pub fn encode_wav_from_pcm(pcm: &[u8], sample_rate: u32, channels: u16, bits_per_sample: u16) -> Vec<u8> {
    let data_len = pcm.len() as u32;
    let byte_rate = sample_rate * u32::from(channels) * u32::from(bits_per_sample) / 8;
    let block_align = channels * bits_per_sample / 8;
    let mut wav = Vec::with_capacity(44 + pcm.len());
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
    wav.extend_from_slice(&channels.to_le_bytes());
    wav.extend_from_slice(&sample_rate.to_le_bytes());
    wav.extend_from_slice(&byte_rate.to_le_bytes());
    wav.extend_from_slice(&block_align.to_le_bytes());
    wav.extend_from_slice(&bits_per_sample.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    wav.extend_from_slice(pcm);
    wav
}

pub fn encode_base64(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(((data.len() + 2) / 3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((triple >> 18) & 0x3F) as usize] as char);
        out.push(TABLE[((triple >> 12) & 0x3F) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((triple >> 6) & 0x3F) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(triple & 0x3F) as usize] as char
        } else {
            '='
        });
    }
    out
}

fn prune_pending_audio_dir(dir: &std::path::Path, max_files: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(std::time::SystemTime, std::path::PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("wav") {
                return None;
            }
            let modified = e.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
            Some((modified, p))
        })
        .collect();
    if files.len() <= max_files {
        return;
    }
    files.sort_by_key(|(t, _)| *t);
    let excess = files.len() - max_files;
    for (_, path) in files.into_iter().take(excess) {
        let _ = std::fs::remove_file(path);
    }
}

fn append_pending_history(
    res: &FinalTranscriptResult,
    app_name: &str,
    app_category: &str,
    style_used: &str,
    duration_ms: u64,
    recorded_pcm: &[u8],
) {
    use std::io::Write;
    let Some(path) = pending_history_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let word_count = res.text.split_whitespace().count();
    let id = format!("native-{}-{}", now_ms, word_count);

    let mut audio_file: Option<String> = None;
    if !recorded_pcm.is_empty() {
        if let Some(audio_dir) = pending_audio_dir() {
            if std::fs::create_dir_all(&audio_dir).is_ok() {
                let file_name = format!("{}.wav", id);
                let wav_bytes = encode_wav_from_pcm(recorded_pcm, 16000, 1, 16);
                if std::fs::write(audio_dir.join(&file_name), &wav_bytes).is_ok() {
                    audio_file = Some(file_name);
                    prune_pending_audio_dir(&audio_dir, 15);
                }
            }
        }
    }

    let entry = json!({
        "id": id,
        "text": res.text,
        "rawText": if res.raw_text.is_empty() { &res.text } else { &res.raw_text },
        "audioFile": audio_file,
        "numWords": word_count,
        "durationMs": duration_ms.max(400),
        "timestamp": now_ms,
        "styleUsed": style_used,
        "contextUsed": app_category,
        "appTag": if app_name.is_empty() { "General" } else { app_name },
        "flagged": false,
        "fillerRemovedCount": res.filler_removed_count,
        "correctionsAppliedCount": 0,
        "language": "en"
    });
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(file, "{}", entry);
    }

    let dataset_sample = json!({
        "id": id,
        "timestamp": now_ms,
        "appTag": if app_name.is_empty() { "General" } else { app_name },
        "contextUsed": app_category,
        "styleUsed": style_used,
        "rawText": if res.raw_text.is_empty() { &res.text } else { &res.raw_text },
        "cleanedText": res.text,
        "durationMs": duration_ms.max(400),
        "fillerRemovedCount": res.filler_removed_count,
    });
    append_dataset_sample_record(&dataset_sample);
}

struct NativeConfig {
    server_url: String,
    api_key: Option<String>,
    styles_by_context: Option<Value>,
}

fn load_native_config() -> NativeConfig {
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
                let styles_by_context = v.get("stylesByContext").cloned();
                if !url.is_empty() {
                    return NativeConfig {
                        server_url: url,
                        api_key: key,
                        styles_by_context,
                    };
                }
            }
        }
    }
    NativeConfig {
        server_url: "http://localhost:8000".to_string(),
        api_key: None,
        styles_by_context: None,
    }
}

fn resolve_style_for_category(styles_by_context: Option<&Value>, category: &str) -> String {
    if let Some(map) = styles_by_context.and_then(Value::as_object) {
        if let Some(preset) = map.get(category).and_then(Value::as_str) {
            if !preset.trim().is_empty() {
                return preset.trim().to_string();
            }
        }
    }
    default_style_for_category(category).to_string()
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
    let config = load_native_config();
    let ws_url = match derive_ws_url(&config.server_url) {
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
    let active_info = crate::get_active_app();
    let (app_name, app_category) = match active_info {
        Some(info) => classify_active_app(&info.app_name, &info.window_title),
        None => ("General".to_string(), "other"),
    };
    let style_preset = resolve_style_for_category(config.styles_by_context.as_ref(), app_category);
    let handshake = build_start_handshake(
        config.api_key.as_deref(),
        &app_name,
        app_category,
        &style_preset,
    );

    let ws_handle = std::thread::spawn(move || -> Result<Option<FinalTranscriptResult>, String> {
        let (mut socket, _) =
            tungstenite::connect(&ws_url).map_err(|e| format!("Server connection failed: {}", e))?;
        socket
            .send(Message::Text(handshake.to_string()))
            .map_err(|_| "Failed to send WebSocket handshake.".to_string())?;

        while let Ok(ev) = rx.recv() {
            match ev {
                WsEvent::Packet(data) => {
                    if let Err(send_err) = socket.send(Message::Binary(data)) {
                        while let Ok(msg) = socket.read() {
                            if let Message::Text(txt) = msg {
                                if let Err(server_err) = extract_final_transcript(&txt) {
                                    return Err(server_err);
                                }
                            }
                        }
                        return Err(format!("WebSocket send failed ({}).", send_err));
                    }
                }
                WsEvent::Stop { packets, bytes } => {
                    let stop_frame = build_stop_frame(packets, bytes);
                    let _ = socket.send(Message::Text(stop_frame.to_string()));
                    break;
                }
            }
        }

        let deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < deadline {
            match socket.read() {
                Ok(Message::Text(txt)) => match extract_final_transcript(&txt) {
                    Ok(Some(res)) => {
                        let _ = socket.close(None);
                        return Ok(Some(res));
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
    let mut recorded_pcm: Vec<u8> = Vec::new();
    let mut buf = [0u8; 1024];

    while !STOP_REQUESTED.load(Ordering::SeqCst) {
        if started.elapsed() >= Duration::from_secs(300) {
            break;
        }
        match stdout.read_exact(&mut buf) {
            Ok(()) => {
                if recorded_pcm.len() < 16_000 * 2 * 300 {
                    recorded_pcm.extend_from_slice(&buf);
                }
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
        Ok(Some(res)) if !res.text.is_empty() => {
            let duration_ms = started.elapsed().as_millis() as u64;
            append_pending_history(&res, &app_name, app_category, &style_preset, duration_ms, &recorded_pcm);
            let _ = crate::paste_text(res.text);
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
            extract_final_transcript(
                r#"{"is_final":true,"formatted_text":"Hello world.","raw_text":"uh hello world","filler_removed_count":1}"#
            )
            .unwrap(),
            Some(FinalTranscriptResult {
                text: "Hello world.".to_string(),
                raw_text: "uh hello world".to_string(),
                filler_removed_count: 1,
            })
        );
        assert!(extract_final_transcript(r#"{"status":"error","error":"Bad key"}"#).is_err());
    }

    #[test]
    fn test_encode_wav_and_base64() {
        let wav = encode_wav_from_pcm(&[0x01, 0x02, 0x03, 0x04], 16000, 1, 16);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(wav.len(), 48);
        assert_eq!(encode_base64(b"Man"), "TWFu");
        assert_eq!(encode_base64(b"Ma"), "TWE=");
    }

    #[test]
    fn test_classify_active_app_and_style() {
        assert_eq!(
            classify_active_app("Brave Browser", "WhatsApp - Brave"),
            ("WhatsApp".to_string(), "personal")
        );
        assert_eq!(
            classify_active_app("google-chrome", "Inbox - Gmail - Google Chrome"),
            ("Gmail".to_string(), "email")
        );
        assert_eq!(
            classify_active_app("antigravity", "CrispType Workspace"),
            ("Antigravity".to_string(), "work")
        );
        assert_eq!(
            classify_active_app("Brave Browser", "Android Developers - Brave"),
            ("Brave Browser".to_string(), "other")
        );
        assert_eq!(
            classify_active_app("", ""),
            ("General".to_string(), "other")
        );
        assert_eq!(resolve_style_for_category(None, "personal"), "very_casual");
        assert_eq!(resolve_style_for_category(None, "work"), "casual");
        assert_eq!(resolve_style_for_category(None, "email"), "formal");
    }

    #[test]
    fn test_ws_tls_connector_initializes_without_panic() {
        // Ensures wss:// TLS connector never panics at runtime (e.g. missing CryptoProvider)
        let res = tungstenite::connect("wss://127.0.0.1:1/test");
        assert!(res.is_err());
    }
}
