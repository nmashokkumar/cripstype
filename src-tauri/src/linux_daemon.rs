use gtk::glib;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::os::unix::net::{UnixListener, UnixStream};
use std::process::Command;
use std::sync::{Arc, Mutex};
use tray_icon::menu::{Menu, MenuEvent, MenuItem};
use tray_icon::{Icon, MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

fn ui_socket_path() -> std::path::PathBuf {
    let dir = std::env::var_os("XDG_RUNTIME_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    dir.join("crisptype-ui.sock")
}

fn spawn_or_focus_ui(open_settings: bool) {
    let sock = ui_socket_path();
    if let Ok(mut stream) = UnixStream::connect(&sock) {
        let cmd = if open_settings {
            b"open_settings\n".as_slice()
        } else {
            b"focus\n".as_slice()
        };
        let _ = stream.write_all(cmd);
        let _ = stream.flush();
        return;
    }

    if let Ok(exe) = std::env::current_exe() {
        let mut cmd = Command::new(exe);
        cmd.arg("--ui");
        if open_settings {
            cmd.arg("--open-settings");
        }
        let _ = cmd.spawn();
    }
}

fn load_tray_icon() -> Option<Icon> {
    let bytes = include_bytes!("../icons/icon.png");
    let img = image::load_from_memory(bytes).ok()?.into_rgba8();
    let (w, h) = img.dimensions();
    Icon::from_rgba(img.into_raw(), w, h).ok()
}

fn start_ipc_listener() {
    let path = crate::ipc_socket_path();
    let _ = std::fs::remove_file(&path);
    if let Ok(listener) = UnixListener::bind(&path) {
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut reader = BufReader::new(stream);
                let mut line = String::new();
                if reader.read_line(&mut line).is_ok() {
                    match line.trim() {
                        "toggle" => crate::native_dictation::toggle(),
                        "show" => spawn_or_focus_ui(false),
                        "open_settings" => spawn_or_focus_ui(true),
                        _ => {}
                    }
                }
            }
        });
    }
}

fn start_http_trigger_server() {
    if let Ok(listener) = TcpListener::bind("127.0.0.1:51120") {
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let mut reader = BufReader::new(&stream);
                let mut line = String::new();
                if reader.read_line(&mut line).is_ok() {
                    match crate::native_dictation::parse_http_trigger_request(&line) {
                        Some("toggle") | Some("start") => {
                            crate::native_dictation::toggle();
                            let _ = stream.write_all(
                                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"ok\":true}",
                            );
                        }
                        Some("stop") => {
                            crate::native_dictation::stop();
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

pub fn run_daemon(started_for_toggle: bool, started_from_autostart: bool) {
    if std::env::var_os("DISPLAY").is_some() && std::env::var_os("GDK_BACKEND").is_none() {
        std::env::set_var("GDK_BACKEND", "x11");
    }

    if gtk::init().is_err() {
        return;
    }

    // Register GNOME custom shortcut on startup from saved settings
    let initial_shortcut = crate::native_dictation::settings_json_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| {
            serde_json::from_value::<crate::HotkeyBindingPayload>(
                v.get("handsFreeHotkey")?.clone(),
            )
            .ok()
        })
        .and_then(|b| crate::to_tauri_shortcut(&b))
        .unwrap_or_else(|| "Ctrl+Space".to_string());
    crate::register_gnome_custom_shortcut(&initial_shortcut);

    start_ipc_listener();
    start_http_trigger_server();

    let open_item = MenuItem::with_id("open", "Open CrispType", true, None);
    let toggle_item = MenuItem::with_id("toggle", "Toggle Dictation", true, None);
    let settings_item = MenuItem::with_id("settings", "Settings", true, None);
    let quit_item = MenuItem::with_id("quit", "Quit CrispType", true, None);

    let tray_menu = Menu::new();
    let _ = tray_menu.append_items(&[&open_item, &toggle_item, &settings_item, &quit_item]);

    let mut tray_builder = TrayIconBuilder::new()
        .with_tooltip("CrispType — Voice Dictation")
        .with_menu(Box::new(tray_menu))
        .with_menu_on_left_click(false);
    if let Some(icon) = load_tray_icon() {
        tray_builder = tray_builder.with_icon(icon);
    }
    let tray = Arc::new(Mutex::new(tray_builder.build().ok()));

    // Poll tray menu & click events on GTK main loop
    let menu_rx = MenuEvent::receiver().clone();
    let tray_rx = TrayIconEvent::receiver().clone();
    glib::timeout_add_local(std::time::Duration::from_millis(50), move || {
        while let Ok(ev) = menu_rx.try_recv() {
            match ev.id.0.as_str() {
                "open" => spawn_or_focus_ui(false),
                "toggle" => crate::native_dictation::toggle(),
                "settings" => spawn_or_focus_ui(true),
                "quit" => {
                    let _ = std::fs::remove_file(crate::ipc_socket_path());
                    if let Ok(mut guard) = tray.lock() {
                        *guard = None;
                    }
                    gtk::main_quit();
                    return glib::ControlFlow::Break;
                }
                _ => {}
            }
        }
        while let Ok(ev) = tray_rx.try_recv() {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = ev
            {
                spawn_or_focus_ui(false);
            }
        }
        glib::ControlFlow::Continue
    });

    if started_for_toggle {
        crate::native_dictation::toggle();
    } else if !started_from_autostart {
        spawn_or_focus_ui(false);
    }

    gtk::main();
}
