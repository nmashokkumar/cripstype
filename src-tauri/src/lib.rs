use serde::{Deserialize, Serialize};

mod native_dictation;
#[cfg(target_os = "linux")]
mod linux_daemon;
#[cfg(target_os = "linux")]
mod native_overlay;
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, WindowEvent,
};
#[cfg(not(target_os = "linux"))]
use tauri::PhysicalPosition;
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// Shared runtime preferences managed by the Tauri backend.
pub struct AppRuntimeState {
    minimize_to_tray: AtomicBool,
    overlay_ignore_cursor: AtomicBool,
    pending_toggle: AtomicBool,
    quitting: AtomicBool,
}

impl Default for AppRuntimeState {
    fn default() -> Self {
        Self {
            minimize_to_tray: AtomicBool::new(true),
            overlay_ignore_cursor: AtomicBool::new(true),
            pending_toggle: AtomicBool::new(false),
            quitting: AtomicBool::new(false),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyBindingPayload {
    pub code: String,
    pub ctrl: Option<bool>,
    pub alt: Option<bool>,
    pub shift: Option<bool>,
    pub meta: Option<bool>,
    pub label: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyConflictInfo {
    pub shortcut: String,
    pub owner_name: String,
    pub schema: String,
    pub key: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyApplyResult {
    pub applied: bool,
    pub conflict: Option<HotkeyConflictInfo>,
}

/// Converts a browser KeyboardEvent `code` + modifiers into a Tauri shortcut string.
fn to_tauri_shortcut(binding: &HotkeyBindingPayload) -> Option<String> {
    let mut parts: Vec<&str> = Vec::new();
    if binding.ctrl.unwrap_or(false) {
        parts.push("Ctrl");
    }
    if binding.alt.unwrap_or(false) {
        parts.push("Alt");
    }
    if binding.shift.unwrap_or(false) {
        parts.push("Shift");
    }
    if binding.meta.unwrap_or(false) {
        parts.push("Super");
    }

    let key = match binding.code.as_str() {
        "Space" => "Space",
        "Enter" => "Enter",
        "Tab" => "Tab",
        "Escape" => "Escape",
        "Backspace" => "Backspace",
        code if code.starts_with("Key") && code.len() == 4 => &code[3..],
        code if code.starts_with("Digit") && code.len() == 6 => &code[5..],
        code if code.starts_with('F') && code.len() <= 3 => code,
        // Pure modifier-only keys cannot be registered directly via OS global-shortcut APIs;
        // skip gracefully so hands-free combo remains active.
        _ => return None,
    };

    parts.push(key);
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("+"))
    }
}

#[cfg(unix)]
fn ipc_socket_path() -> std::path::PathBuf {
    let dir = std::env::var_os("XDG_RUNTIME_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    dir.join("crisptype-ipc.sock")
}

#[cfg(unix)]
fn try_send_ipc(cmd: &str) -> bool {
    use std::os::unix::net::UnixStream;
    let path = ipc_socket_path();
    if let Ok(mut stream) = UnixStream::connect(&path) {
        let _ = stream.write_all(cmd.as_bytes());
        let _ = stream.write_all(b"\n");
        let _ = stream.flush();
        return true;
    }
    false
}

#[cfg(not(unix))]
fn try_send_ipc(_cmd: &str) -> bool {
    false
}

#[cfg(unix)]
fn start_ipc_listener(app: AppHandle) {
    use std::io::{BufRead, BufReader};
    use std::os::unix::net::UnixListener;

    let path = ipc_socket_path();
    let _ = std::fs::remove_file(&path);
    if let Ok(listener) = UnixListener::bind(&path) {
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut reader = BufReader::new(stream);
                let mut line = String::new();
                if reader.read_line(&mut line).is_ok() {
                    match line.trim() {
                        "toggle" => trigger_global_toggle(&app),
                        "show" => reveal_main_window(&app),
                        _ => {}
                    }
                }
            }
        });
    }
}

#[cfg(not(unix))]
fn start_ipc_listener(_app: AppHandle) {}

/// Helper that pipes UTF-8 text into a child process's stdin directly (never via a shell
/// and never as a CLI argument that could appear in process listings).
fn pipe_text_to_command(program: &str, args: &[&str], text: &str) -> bool {
    Command::new(program)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .and_then(|mut child| {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(text.as_bytes());
            }
            child.wait()
        })
        .map(|status| status.success())
        .unwrap_or(false)
}

/// Positions the floating transparent overlay at bottom-center above the dock.
#[cfg(not(target_os = "linux"))]
fn position_overlay_bottom_center(app: &AppHandle) {
    if let Some(overlay) = app.get_webview_window("overlay") {
        if let Ok(Some(monitor)) = overlay.current_monitor().or_else(|_| app.primary_monitor()) {
            let mon_size = monitor.size();
            let mon_pos = monitor.position();
            let scale = monitor.scale_factor();
            let overlay_w = (380.0 * scale) as i32;
            let overlay_h = (96.0 * scale) as i32;
            let mon_bottom = mon_pos.y + mon_size.height as i32;

            // Keep overlay comfortably above the bottom dock and input bar at all times
            let work_area = monitor.work_area();
            let work_bottom = work_area.position.y + work_area.size.height as i32;
            let work_inset = (mon_bottom - work_bottom).max(0);
            let margin_bottom = (work_inset + (108.0 * scale) as i32).max((148.0 * scale) as i32);

            let x = mon_pos.x + (mon_size.width as i32 - overlay_w) / 2;
            let y = mon_bottom - overlay_h - margin_bottom;
            let _ = overlay.set_position(PhysicalPosition::new(x, y));
        }
    }
}

/// Reveals the main CrispType window from the system tray (recreating it if it was destroyed to save RAM).
fn reveal_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }

    if let Ok(builder) = tauri::WebviewWindowBuilder::new(
        app,
        "main",
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("CrispType")
    .inner_size(1120.0, 760.0)
    .min_inner_size(820.0, 580.0)
    .resizable(true)
    .visible(true)
    .build()
    {
        #[cfg(target_os = "linux")]
        configure_linux_mic_only_permissions(&builder);
        let _ = builder.set_focus();
    }
}

fn trigger_global_toggle(app: &AppHandle) {
    #[cfg(target_os = "linux")]
    {
        let _ = app;
        native_dictation::toggle();
        return;
    }

    #[cfg(not(target_os = "linux"))]
    {
        position_overlay_bottom_center(app);
        let _ = app.emit_to("main", "crisptype:dictation-toggle", ());
    }
}

/// Starts a tiny `127.0.0.1:51120` HTTP trigger server so shortcuts like
/// `curl -s http://127.0.0.1:51120/trigger?mode=hands_free` fire in ~2ms with zero binary spawn.
fn start_http_trigger_server(app: AppHandle) {
    use std::io::{BufRead, BufReader};
    use std::net::TcpListener;

    if let Ok(listener) = TcpListener::bind("127.0.0.1:51120") {
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let mut reader = BufReader::new(&stream);
                let mut line = String::new();
                if reader.read_line(&mut line).is_ok() {
                    match native_dictation::parse_http_trigger_request(&line) {
                        Some("toggle") | Some("start") => {
                            trigger_global_toggle(&app);
                            let _ = stream.write_all(
                                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"ok\":true}",
                            );
                        }
                        Some("stop") => {
                            native_dictation::stop();
                            let _ = stream.write_all(
                                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"ok\":true}",
                            );
                        }
                        Some("health") => {
                            let _ = stream.write_all(
                                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"ok\":true}",
                            );
                        }
                        _ => {
                            let _ = stream.write_all(
                                b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n",
                            );
                        }
                    }
                }
            }
        });
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveAppInfo {
    pub app_name: String,
    pub window_title: String,
    pub platform: &'static str,
}

#[cfg(target_os = "linux")]
fn to_gnome_binding(shortcut: &str) -> String {
    let mut out = String::new();
    for part in shortcut.split('+') {
        match part.trim() {
            "Ctrl" | "Control" => out.push_str("<Control>"),
            "Alt" => out.push_str("<Alt>"),
            "Shift" => out.push_str("<Shift>"),
            "Super" | "Meta" => out.push_str("<Super>"),
            "Space" => out.push_str("space"),
            other => out.push_str(&other.to_lowercase()),
        }
    }
    out
}

#[cfg(target_os = "linux")]
fn parse_gsettings_str_list(raw: &str) -> Vec<String> {
    raw.trim()
        .trim_matches(|c| c == '[' || c == ']')
        .split(',')
        .map(|s| s.trim().trim_matches('\'').to_string())
        .filter(|s| !s.is_empty() && s != "@as")
        .collect()
}

#[cfg(target_os = "linux")]
fn format_gsettings_str_list(items: &[String]) -> String {
    if items.is_empty() {
        return "[]".to_string();
    }
    format!(
        "[{}]",
        items
            .iter()
            .map(|s| format!("'{}'", s))
            .collect::<Vec<_>>()
            .join(", ")
    )
}

#[cfg(target_os = "linux")]
fn is_gnome_wayland() -> bool {
    std::env::var("WAYLAND_DISPLAY").is_ok()
        && std::env::var("XDG_CURRENT_DESKTOP")
            .map(|d| d.to_uppercase().contains("GNOME"))
            .unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn check_gnome_shortcut_conflict(shortcut: &str, gnome_binding: &str) -> Option<HotkeyConflictInfo> {
    if !is_gnome_wayland() || gnome_binding.is_empty() {
        return None;
    }

    let crisptype_path = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/crisptype-hf/";
    if let Ok(out) = Command::new("gsettings")
        .args([
            "get",
            "org.gnome.settings-daemon.plugins.media-keys",
            "custom-keybindings",
        ])
        .output()
    {
        let raw = String::from_utf8_lossy(&out.stdout);
        for path in parse_gsettings_str_list(&raw) {
            if path == crisptype_path {
                continue;
            }
            let schema = format!(
                "org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:{}",
                path
            );
            let existing = Command::new("gsettings")
                .args(["get", &schema, "binding"])
                .output()
                .ok()
                .map(|o| {
                    String::from_utf8_lossy(&o.stdout)
                        .trim()
                        .trim_matches('\'')
                        .to_string()
                })
                .unwrap_or_default();
            if existing.eq_ignore_ascii_case(gnome_binding) {
                let name = Command::new("gsettings")
                    .args(["get", &schema, "name"])
                    .output()
                    .ok()
                    .map(|o| {
                        String::from_utf8_lossy(&o.stdout)
                            .trim()
                            .trim_matches('\'')
                            .to_string()
                    })
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "Another custom shortcut".to_string());
                return Some(HotkeyConflictInfo {
                    shortcut: shortcut.to_string(),
                    owner_name: name,
                    schema,
                    key: "binding".to_string(),
                });
            }
        }
    }

    // Check common GNOME desktop WM / keybinding conflicts (e.g. Alt+Space = Window Menu)
    let system_checks = [
        (
            "org.gnome.desktop.wm.keybindings",
            "activate-window-menu",
            "GNOME Window Menu",
        ),
        (
            "org.gnome.desktop.wm.keybindings",
            "switch-input-source",
            "GNOME Input Source Switcher",
        ),
    ];
    for (schema, key, owner) in system_checks {
        if let Ok(out) = Command::new("gsettings").args(["get", schema, key]).output() {
            let raw = String::from_utf8_lossy(&out.stdout);
            let list = parse_gsettings_str_list(&raw);
            if list.iter().any(|b| b.eq_ignore_ascii_case(gnome_binding)) {
                return Some(HotkeyConflictInfo {
                    shortcut: shortcut.to_string(),
                    owner_name: owner.to_string(),
                    schema: schema.to_string(),
                    key: key.to_string(),
                });
            }
        }
    }

    None
}

#[cfg(target_os = "linux")]
fn clear_gnome_shortcut_conflict(conflict: &HotkeyConflictInfo, gnome_binding: &str) {
    if conflict.key == "binding" {
        let _ = Command::new("gsettings")
            .args(["set", &conflict.schema, "binding", ""])
            .status();
        return;
    }

    if let Ok(out) = Command::new("gsettings")
        .args(["get", &conflict.schema, &conflict.key])
        .output()
    {
        let raw = String::from_utf8_lossy(&out.stdout);
        let filtered: Vec<String> = parse_gsettings_str_list(&raw)
            .into_iter()
            .filter(|b| !b.eq_ignore_ascii_case(gnome_binding))
            .collect();
        let formatted = format_gsettings_str_list(&filtered);
        let _ = Command::new("gsettings")
            .args(["set", &conflict.schema, &conflict.key, &formatted])
            .status();
    }
}

#[cfg(target_os = "linux")]
fn register_gnome_custom_shortcut(shortcut: &str) {
    if !is_gnome_wayland() {
        return;
    }

    let path = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/crisptype-hf/";
    let binding = to_gnome_binding(shortcut);
    if binding.is_empty() {
        return;
    }

    let schema = format!(
        "org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:{}",
        path
    );
    let _ = Command::new("gsettings")
        .args(["set", &schema, "name", "CrispType Dictation (Hands-Free)"])
        .status();
    // Wrap in `sh -c` because gnome-settings-daemon does not run custom shortcuts through a shell
    let _ = Command::new("gsettings")
        .args([
            "set",
            &schema,
            "command",
            "sh -c \"curl -sf http://127.0.0.1:51120/trigger?mode=hands_free >/dev/null || crisptype --toggle\"",
        ])
        .status();
    let _ = Command::new("gsettings")
        .args(["set", &schema, "binding", &binding])
        .status();

    // Ensure our custom-keybinding path is in the active list
    if let Ok(out) = Command::new("gsettings")
        .args([
            "get",
            "org.gnome.settings-daemon.plugins.media-keys",
            "custom-keybindings",
        ])
        .output()
    {
        let current = String::from_utf8_lossy(&out.stdout);
        let mut items = parse_gsettings_str_list(&current);
        if !items.iter().any(|s| s == path) {
            items.push(path.to_string());
            let formatted = format_gsettings_str_list(&items);
            let _ = Command::new("gsettings")
                .args([
                    "set",
                    "org.gnome.settings-daemon.plugins.media-keys",
                    "custom-keybindings",
                    &formatted,
                ])
                .status();
        }
    }
}

/// Registers the active global hotkey(s) with the OS.
fn register_shortcuts(app: &AppHandle, hands_free_shortcut: &str) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    register_gnome_custom_shortcut(hands_free_shortcut);

    let shortcut_manager = app.global_shortcut();
    let _ = shortcut_manager.unregister_all();

    let app_handle = app.clone();
    let res = shortcut_manager.on_shortcut(hands_free_shortcut, move |_app, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
            trigger_global_toggle(&app_handle);
        }
    });

    #[cfg(not(target_os = "linux"))]
    if let Err(e) = res {
        return Err(e.to_string());
    }
    #[cfg(target_os = "linux")]
    let _ = res;

    Ok(())
}

#[tauri::command]
fn set_overlay_visible(app: AppHandle, state: State<'_, AppRuntimeState>, visible: bool) {
    #[cfg(target_os = "linux")]
    {
        let _ = (app, state);
        native_overlay::set_visible(visible);
        return;
    }

    #[cfg(not(target_os = "linux"))]
    if let Some(overlay) = app.get_webview_window("overlay") {
        if visible {
            position_overlay_bottom_center(&app);
            let _ = overlay.set_always_on_top(true);
            let _ = overlay.show();
            position_overlay_bottom_center(&app);
            let ignore = state.overlay_ignore_cursor.load(Ordering::Relaxed);
            let _ = overlay.set_ignore_cursor_events(ignore);
        } else {
            let _ = overlay.hide();
        }
    }
}

#[tauri::command]
fn set_overlay_interactive(app: AppHandle, state: State<'_, AppRuntimeState>, interactive: bool) {
    let ignore = !interactive;
    state.overlay_ignore_cursor.store(ignore, Ordering::Relaxed);
    #[cfg(target_os = "linux")]
    {
        let _ = app;
        native_overlay::set_interactive(interactive);
        return;
    }

    #[cfg(not(target_os = "linux"))]
    if let Some(overlay) = app.get_webview_window("overlay") {
        if overlay.is_visible().unwrap_or(false) {
            let _ = overlay.set_ignore_cursor_events(ignore);
        }
    }
}

#[tauri::command]
fn update_overlay_state(
    app: AppHandle,
    overlay_state: String,
    is_hands_free: bool,
    elapsed_ms: u64,
    audio_levels: Vec<f64>,
    error_message: Option<String>,
) {
    #[cfg(target_os = "linux")]
    {
        let _ = app;
        native_overlay::update_state(
            overlay_state,
            is_hands_free,
            elapsed_ms,
            audio_levels,
            error_message,
        );
    }
    #[cfg(not(target_os = "linux"))]
    let _ = (app, overlay_state, is_hands_free, elapsed_ms, audio_levels, error_message);
}

fn config_file_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("settings.json"))
}

#[tauri::command]
fn load_persisted_config(app: AppHandle) -> Option<String> {
    let path = config_file_path(&app)?;
    std::fs::read_to_string(path).ok()
}

#[tauri::command]
fn save_persisted_config(app: AppHandle, json: String) -> bool {
    let Some(path) = config_file_path(&app) else {
        return false;
    };
    if let Some(parent) = path.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return false;
        }
    }
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, json.as_bytes()).is_err() {
        return false;
    }
    std::fs::rename(&tmp, &path).is_ok()
}

#[tauri::command]
fn frontend_ready(app: AppHandle, state: State<'_, AppRuntimeState>) {
    if state.pending_toggle.swap(false, Ordering::SeqCst) {
        trigger_global_toggle(&app);
    }
}

#[tauri::command]
fn set_minimize_to_tray(state: State<'_, AppRuntimeState>, enabled: bool) {
    state.minimize_to_tray.store(enabled, Ordering::Relaxed);
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let autolaunch = app.autolaunch();
    if enabled {
        autolaunch.enable().map_err(|e| e.to_string())?;
    } else {
        autolaunch.disable().map_err(|e| e.to_string())?;
    }
    Ok(enabled)
}

#[tauri::command]
fn get_autostart(app: AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn apply_hotkeys(
    app: AppHandle,
    _push_to_talk: Option<HotkeyBindingPayload>,
    hands_free: Option<HotkeyBindingPayload>,
    force_replace: Option<bool>,
) -> HotkeyApplyResult {
    let combo = hands_free
        .as_ref()
        .and_then(to_tauri_shortcut)
        .unwrap_or_else(|| "Ctrl+Space".to_string());

    #[cfg(target_os = "linux")]
    {
        let gnome_binding = to_gnome_binding(&combo);
        if let Some(conflict) = check_gnome_shortcut_conflict(&combo, &gnome_binding) {
            if !force_replace.unwrap_or(false) {
                return HotkeyApplyResult {
                    applied: false,
                    conflict: Some(conflict),
                };
            }
            clear_gnome_shortcut_conflict(&conflict, &gnome_binding);
        }
    }

    if let Err(_err) = register_shortcuts(&app, &combo) {
        return HotkeyApplyResult {
            applied: false,
            conflict: Some(HotkeyConflictInfo {
                shortcut: combo,
                owner_name: "Another application".to_string(),
                schema: String::new(),
                key: String::new(),
            }),
        };
    }

    HotkeyApplyResult {
        applied: true,
        conflict: None,
    }
}

#[tauri::command]
fn update_hotkeys(
    app: AppHandle,
    _push_to_talk: Option<HotkeyBindingPayload>,
    hands_free: Option<HotkeyBindingPayload>,
) {
    let combo = hands_free
        .as_ref()
        .and_then(to_tauri_shortcut)
        .unwrap_or_else(|| "Ctrl+Space".to_string());
    let _ = register_shortcuts(&app, &combo);
}

#[tauri::command]
fn get_active_app() -> Option<ActiveAppInfo> {
    #[cfg(target_os = "linux")]
    {
        // Best-effort X11 active window detection via xdotool (gracefully returns None on Wayland
        // where compositors restrict window inspection; frontend falls back cleanly to "General").
        let title = Command::new("xdotool")
            .args(["getactivewindow", "getwindowname"])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();

        let app_name = Command::new("xdotool")
            .args(["getactivewindow", "getwindowclassname"])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();

        if !title.is_empty() || !app_name.is_empty() {
            return Some(ActiveAppInfo {
                app_name,
                window_title: title,
                platform: "linux",
            });
        }
        None
    }

    #[cfg(target_os = "windows")]
    {
        // Static Win32 foreground window query (zero user data interpolated)
        const PS_ACTIVE_WINDOW: &str = r#"
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinFocus {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
"@
$h = [WinFocus]::GetForegroundWindow()
if ($h -eq [IntPtr]::Zero) { exit 1 }
$sb = New-Object System.Text.StringBuilder 512
[void][WinFocus]::GetWindowText($h, $sb, 512)
$pidOut = 0
[void][WinFocus]::GetWindowThreadProcessId($h, [ref]$pidOut)
$proc = (Get-Process -Id $pidOut -ErrorAction SilentlyContinue).ProcessName
Write-Output "$proc|$($sb.ToString())"
"#;

        let output = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", PS_ACTIVE_WINDOW])
            .output()
            .ok()
            .filter(|o| o.status.success())?;

        let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let (app_name, window_title) = raw
            .split_once('|')
            .map(|(a, t)| (a.trim().to_string(), t.trim().to_string()))
            .unwrap_or((raw, String::new()));

        if !app_name.is_empty() || !window_title.is_empty() {
            return Some(ActiveAppInfo {
                app_name,
                window_title,
                platform: "windows",
            });
        }
        None
    }

    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        None
    }
}

#[tauri::command]
fn copy_text(text: String) -> bool {
    #[cfg(target_os = "linux")]
    {
        let is_wayland = std::env::var("WAYLAND_DISPLAY").is_ok();
        if is_wayland && pipe_text_to_command("wl-copy", &[], &text) {
            return true;
        }
        pipe_text_to_command("xclip", &["-selection", "clipboard"], &text)
            || pipe_text_to_command("xsel", &["--clipboard", "--input"], &text)
    }

    #[cfg(target_os = "windows")]
    {
        // Pipe directly to clip.exe via stdin (no shell escaping needed)
        pipe_text_to_command("clip.exe", &[], &text)
    }

    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        let _ = text;
        false
    }
}

#[tauri::command]
fn paste_text(text: String) -> bool {
    let copied = copy_text(text.clone());
    if !copied {
        return false;
    }

    #[cfg(target_os = "linux")]
    {
        let is_wayland = std::env::var("WAYLAND_DISPLAY").is_ok();
        if is_wayland {
            // 1. Newer ydotool (v1.x) supports `ydotool key` for instant Ctrl+V via /dev/uinput
            let ydotool_key_ok = Command::new("ydotool")
                .args(["key", "29:1", "47:1", "47:0", "29:0"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            if ydotool_key_ok {
                return true;
            }

            // 2. Ubuntu's packaged ydotool (v0.1.8) supports `ydotool type --file -` via /dev/uinput
            if pipe_text_to_command(
                "ydotool",
                &["type", "--key-delay", "1", "--key-hold", "1", "--file", "-"],
                &text,
            ) {
                return true;
            }

            // 3. wlroots compositors (Sway/Hyprland) support wtype
            let wtype_ok = Command::new("wtype")
                .args(["-M", "ctrl", "-k", "v", "-m", "ctrl"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            if wtype_ok {
                return true;
            }

            // Never fall back to xdotool on Wayland (it triggers GNOME's Remote Desktop prompt).
            // Text is already copied to the Wayland clipboard via wl-copy.
            return false;
        }

        Command::new("xdotool")
            .args(["key", "--clearmodifiers", "ctrl+v"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    #[cfg(target_os = "windows")]
    {
        // Send Ctrl+V safely using a static command (text is already on the clipboard via clip.exe)
        Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-WindowStyle",
                "Hidden",
                "-Command",
                "$wshell = New-Object -ComObject WScript.Shell; $wshell.SendKeys('^v')",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        false
    }
}

/// On Linux (WebKitGTK), explicitly allow MICROPHONE-ONLY WebRTC permission requests
/// and deny camera/video requests so users are never prompted for camera access.
#[cfg(target_os = "linux")]
fn configure_linux_mic_only_permissions(window: &tauri::WebviewWindow) {
    use webkit2gtk::glib::Cast;
    use webkit2gtk::{
        PermissionRequestExt, SettingsExt, UserMediaPermissionRequest,
        UserMediaPermissionRequestExt, WebViewExt,
    };

    let _ = window.with_webview(|webview| {
        let wk_webview = webview.inner();
        if let Some(settings) = WebViewExt::settings(&wk_webview) {
            settings.set_media_playback_requires_user_gesture(false);
            settings.set_enable_media_stream(true);
        }
        wk_webview.connect_permission_request(|_wv, request| {
            if let Ok(media_req) = request.clone().downcast::<UserMediaPermissionRequest>() {
                if media_req.is_for_audio_device() && !media_req.is_for_video_device() {
                    media_req.allow();
                } else {
                    media_req.deny();
                }
                return true;
            }
            false
        });
    });
}

#[cfg(not(target_os = "linux"))]
fn configure_linux_mic_only_permissions(_window: &tauri::WebviewWindow) {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    {
        // Use XWayland when DISPLAY is available so bottom-center overlay positioning,
        // alwaysOnTop, and focus:false work reliably even under Wayland compositors (e.g. GNOME).
        if std::env::var_os("DISPLAY").is_some() && std::env::var_os("GDK_BACKEND").is_none() {
            std::env::set_var("GDK_BACKEND", "x11");
        }
    }

    let started_for_toggle = std::env::args().any(|arg| arg == "--toggle");
    let started_from_autostart = std::env::args().any(|arg| arg == "--autostart");
    let is_ui_process = std::env::args().any(|arg| arg == "--ui");

    #[cfg(target_os = "linux")]
    if !is_ui_process {
        let ipc_cmd = if started_for_toggle {
            "toggle"
        } else if started_from_autostart {
            "ping"
        } else {
            "show"
        };
        if try_send_ipc(ipc_cmd) {
            return;
        }
        linux_daemon::run_daemon(started_for_toggle, started_from_autostart);
        return;
    }

    #[cfg(not(target_os = "linux"))]
    {
        let ipc_cmd = if started_for_toggle {
            "toggle"
        } else if started_from_autostart {
            "ping"
        } else {
            "show"
        };
        if try_send_ipc(ipc_cmd) {
            return;
        }
    }
    let runtime_state = AppRuntimeState::default();
    runtime_state
        .pending_toggle
        .store(started_for_toggle, Ordering::SeqCst);

    tauri::Builder::default()
        .manage(runtime_state)
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .invoke_handler(tauri::generate_handler![
            set_overlay_visible,
            set_overlay_interactive,
            update_overlay_state,
            load_persisted_config,
            save_persisted_config,
            frontend_ready,
            set_minimize_to_tray,
            set_autostart,
            get_autostart,
            apply_hotkeys,
            update_hotkeys,
            get_active_app,
            copy_text,
            paste_text,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();

            // 1. Configure microphone-only WebKitGTK permission handling on Linux
            if let Some(main_win) = app.get_webview_window("main") {
                configure_linux_mic_only_permissions(&main_win);
                if !is_ui_process && (started_from_autostart || started_for_toggle) {
                    let _ = main_win.hide();
                }
            }
            if let Some(overlay_win) = app.get_webview_window("overlay") {
                configure_linux_mic_only_permissions(&overlay_win);
                let _ = overlay_win.hide();
            }

            #[cfg(target_os = "linux")]
            if is_ui_process {
                // In `--ui` child mode on Linux, `linux_daemon` owns the tray, IPC socket, and HTTP trigger.
                // Just listen on `crisptype-ui.sock` so repeated clicks focus this window.
                let ui_sock = std::env::var_os("XDG_RUNTIME_DIR")
                    .map(std::path::PathBuf::from)
                    .unwrap_or_else(std::env::temp_dir)
                    .join("crisptype-ui.sock");
                let _ = std::fs::remove_file(&ui_sock);
                if let Ok(listener) = std::os::unix::net::UnixListener::bind(&ui_sock) {
                    let ui_app = handle.clone();
                    std::thread::spawn(move || {
                        use std::io::{BufRead, BufReader};
                        for stream in listener.incoming().flatten() {
                            let mut reader = BufReader::new(stream);
                            let mut line = String::new();
                            if reader.read_line(&mut line).is_ok() {
                                reveal_main_window(&ui_app);
                                if line.trim() == "open_settings" {
                                    let _ = ui_app.emit_to("main", "crisptype:open-settings", ());
                                }
                            }
                        }
                    });
                }
                if std::env::args().any(|a| a == "--open-settings") {
                    let ui_app = handle.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(450));
                        let _ = ui_app.emit_to("main", "crisptype:open-settings", ());
                    });
                }
                return Ok(());
            }

            // 2. Build system tray icon & menu (non-Linux or standalone)
            let open_item = MenuItem::with_id(app, "open", "Open CrispType", true, None::<&str>)?;
            let toggle_item =
                MenuItem::with_id(app, "toggle", "Toggle Dictation", true, None::<&str>)?;
            let settings_item =
                MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit CrispType", true, None::<&str>)?;
            let tray_menu =
                Menu::with_items(app, &[&open_item, &toggle_item, &settings_item, &quit_item])?;

            let mut tray_builder = TrayIconBuilder::new()
                .tooltip("CrispType — Voice Dictation")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => reveal_main_window(app),
                    "toggle" => trigger_global_toggle(app),
                    "settings" => {
                        reveal_main_window(app);
                        let _ = app.emit_to("main", "crisptype:open-settings", ());
                    }
                    "quit" => {
                        app.state::<AppRuntimeState>()
                            .quitting
                            .store(true, Ordering::SeqCst);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        reveal_main_window(tray.app_handle());
                    }
                });

            if let Some(icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(icon.clone());
            }
            let _tray = tray_builder.build(app)?;

            // 3. Register default global hotkey (reading saved handsFreeHotkey if present, else Ctrl+Space)
            let initial_shortcut = load_persisted_config(handle.clone())
                .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
                .and_then(|v| {
                    serde_json::from_value::<HotkeyBindingPayload>(v.get("handsFreeHotkey")?.clone())
                        .ok()
                })
                .and_then(|b| to_tauri_shortcut(&b))
                .unwrap_or_else(|| "Ctrl+Space".to_string());
            let _ = register_shortcuts(&handle, &initial_shortcut);

            // 4. Listen for `crisptype --toggle` IPC requests and `127.0.0.1:51120/trigger` HTTP requests
            start_ipc_listener(handle.clone());
            start_http_trigger_server(handle.clone());

            Ok(())
        })
        .on_window_event(move |window, event| {
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    #[cfg(target_os = "linux")]
                    if is_ui_process {
                        let ui_sock = std::env::var_os("XDG_RUNTIME_DIR")
                            .map(std::path::PathBuf::from)
                            .unwrap_or_else(std::env::temp_dir)
                            .join("crisptype-ui.sock");
                        let _ = std::fs::remove_file(&ui_sock);
                        return;
                    }

                    let runtime_state = window.state::<AppRuntimeState>();
                    if runtime_state.minimize_to_tray.load(Ordering::Relaxed) {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building CrispType")
        .run(move |app_handle, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if is_ui_process {
                    return;
                }
                let state = app_handle.state::<AppRuntimeState>();
                if state.minimize_to_tray.load(Ordering::Relaxed)
                    && !state.quitting.load(Ordering::SeqCst)
                {
                    api.prevent_exit();
                }
            }
        });
}

#[cfg(target_os = "linux")]
fn state_pending_clear(app: &AppHandle) {
    app.state::<AppRuntimeState>()
        .pending_toggle
        .store(false, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_to_tauri_shortcut() {
        let b = HotkeyBindingPayload {
            code: "Space".to_string(),
            ctrl: Some(true),
            alt: Some(true),
            shift: None,
            meta: None,
            label: None,
        };
        assert_eq!(to_tauri_shortcut(&b).as_deref(), Some("Ctrl+Alt+Space"));

        let mod_only = HotkeyBindingPayload {
            code: "AltRight".to_string(),
            ctrl: None,
            alt: None,
            shift: None,
            meta: None,
            label: None,
        };
        assert_eq!(to_tauri_shortcut(&mod_only), None);
    }

    #[test]
    fn test_ipc_socket_path_ends_with_sock() {
        let p = ipc_socket_path();
        assert!(p.to_string_lossy().ends_with("crisptype-ipc.sock"));
    }

    #[test]
    fn test_to_gnome_binding() {
        assert_eq!(to_gnome_binding("Ctrl+Space"), "<Control>space");
        assert_eq!(to_gnome_binding("Ctrl+Alt+Space"), "<Control><Alt>space");
        assert_eq!(to_gnome_binding("Alt+Space"), "<Alt>space");
    }
}
