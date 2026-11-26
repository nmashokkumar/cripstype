use serde::{Deserialize, Serialize};
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, State, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// Shared runtime preferences managed by the Tauri backend.
pub struct AppRuntimeState {
    minimize_to_tray: AtomicBool,
}

impl Default for AppRuntimeState {
    fn default() -> Self {
        Self {
            minimize_to_tray: AtomicBool::new(true),
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveAppInfo {
    pub app_name: String,
    pub window_title: String,
    pub platform: &'static str,
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

/// Positions the floating transparent overlay at bottom-center of the active monitor.
fn position_overlay_bottom_center(app: &AppHandle) {
    if let Some(overlay) = app.get_webview_window("overlay") {
        if let Ok(Some(monitor)) = overlay.current_monitor().or_else(|_| app.primary_monitor()) {
            let mon_size = monitor.size();
            let mon_pos = monitor.position();
            let scale = monitor.scale_factor();
            let overlay_w = (380.0 * scale) as i32;
            let overlay_h = (96.0 * scale) as i32;
            let margin_bottom = (28.0 * scale) as i32;

            let x = mon_pos.x + (mon_size.width as i32 - overlay_w) / 2;
            let y = mon_pos.y + mon_size.height as i32 - overlay_h - margin_bottom;
            let _ = overlay.set_position(PhysicalPosition::new(x, y));
        }
    }
}

/// Reveals the main CrispType window from the system tray and focuses it.
fn reveal_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Triggers dictation toggle on the main window (even when hidden in tray)
/// and ensures the always-on-top overlay is positioned over active apps.
fn trigger_global_toggle(app: &AppHandle) {
    position_overlay_bottom_center(app);
    let _ = app.emit_to("main", "crisptype:dictation-toggle", ());
}

/// Registers the active global hotkey(s) with the OS.
fn register_shortcuts(app: &AppHandle, hands_free_shortcut: &str) {
    let shortcut_manager = app.global_shortcut();
    let _ = shortcut_manager.unregister_all();

    let app_handle = app.clone();
    let _ = shortcut_manager.on_shortcut(hands_free_shortcut, move |_app, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
            trigger_global_toggle(&app_handle);
        }
    });
}

#[tauri::command]
fn set_overlay_visible(app: AppHandle, visible: bool) {
    if let Some(overlay) = app.get_webview_window("overlay") {
        if visible {
            position_overlay_bottom_center(&app);
            let _ = overlay.set_always_on_top(true);
            let _ = overlay.show();
        } else {
            let _ = overlay.hide();
        }
    }
}

#[tauri::command]
fn set_overlay_interactive(app: AppHandle, interactive: bool) {
    if let Some(overlay) = app.get_webview_window("overlay") {
        let _ = overlay.set_ignore_cursor_events(!interactive);
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
fn update_hotkeys(
    app: AppHandle,
    _push_to_talk: Option<HotkeyBindingPayload>,
    hands_free: Option<HotkeyBindingPayload>,
) {
    let combo = hands_free
        .as_ref()
        .and_then(to_tauri_shortcut)
        .unwrap_or_else(|| "Ctrl+Alt+Space".to_string());
    register_shortcuts(&app, &combo);
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
    if !copy_text(text) {
        return false;
    }

    #[cfg(target_os = "linux")]
    {
        let is_wayland = std::env::var("WAYLAND_DISPLAY").is_ok();
        if is_wayland {
            return Command::new("wtype")
                .args(["-M", "ctrl", "-k", "v", "-m", "ctrl"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
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
        PermissionRequestExt, UserMediaPermissionRequest, UserMediaPermissionRequestExt,
        WebViewExt,
    };

    let _ = window.with_webview(|webview| {
        let wk_webview = webview.inner();
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
    let started_from_autostart = std::env::args().any(|arg| arg == "--autostart");

    tauri::Builder::default()
        .manage(AppRuntimeState::default())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .invoke_handler(tauri::generate_handler![
            set_overlay_visible,
            set_overlay_interactive,
            set_minimize_to_tray,
            set_autostart,
            get_autostart,
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
                if started_from_autostart {
                    let _ = main_win.hide();
                }
            }
            if let Some(overlay_win) = app.get_webview_window("overlay") {
                configure_linux_mic_only_permissions(&overlay_win);
                let _ = overlay_win.set_ignore_cursor_events(true);
                let _ = overlay_win.hide();
            }

            // 2. Build system tray icon & menu
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

            // 3. Register default global hotkey (works even when main window is closed to tray)
            register_shortcuts(&handle, "Ctrl+Alt+Space");

            Ok(())
        })
        .on_window_event(|window, event| {
            // Keep CrispType alive in the system tray when the user closes the main window
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    let runtime_state = window.state::<AppRuntimeState>();
                    if runtime_state.minimize_to_tray.load(Ordering::Relaxed) {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running CrispType");
}
