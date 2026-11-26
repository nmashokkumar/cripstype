use gtk::cairo;
use gtk::gdk;
use gtk::glib;
use gtk::prelude::*;
use std::cell::RefCell;
use std::rc::Rc;

#[derive(Clone, Debug)]
pub struct NativeOverlayState {
    pub visible: bool,
    pub overlay_state: String,
    pub is_hands_free: bool,
    pub elapsed_ms: u64,
    pub audio_levels: Vec<f64>,
    pub error_message: Option<String>,
}

impl Default for NativeOverlayState {
    fn default() -> Self {
        Self {
            visible: false,
            overlay_state: "idle".to_string(),
            is_hands_free: false,
            elapsed_ms: 0,
            audio_levels: vec![0.18; 10],
            error_message: None,
        }
    }
}

struct OverlayWidgets {
    window: gtk::Window,
    drawing_area: gtk::DrawingArea,
    state: Rc<RefCell<NativeOverlayState>>,
}

thread_local! {
    static OVERLAY_UI: RefCell<Option<OverlayWidgets>> = const { RefCell::new(None) };
}

const PILL_WIN_W: i32 = 380;
const PILL_WIN_H: i32 = 56;

fn format_mm_ss(ms: u64) -> String {
    let total_sec = ms / 1000;
    let mins = total_sec / 60;
    let secs = total_sec % 60;
    format!("{}:{:02}", mins, secs)
}

fn draw_rounded_rect(cr: &cairo::Context, x: f64, y: f64, w: f64, h: f64, r: f64) {
    let r = r.min(w / 2.0).min(h / 2.0);
    let deg = std::f64::consts::PI / 180.0;
    cr.new_sub_path();
    cr.arc(x + w - r, y + r, r, -90.0 * deg, 0.0);
    cr.arc(x + w - r, y + h - r, r, 0.0, 90.0 * deg);
    cr.arc(x + r, y + h - r, r, 90.0 * deg, 180.0 * deg);
    cr.arc(x + r, y + r, r, 180.0 * deg, 270.0 * deg);
    cr.close_path();
}

fn position_above_dock(win: &gtk::Window) {
    if let Some(display) = gdk::Display::default() {
        let monitor = display
            .primary_monitor()
            .or_else(|| display.monitor(0));
        if let Some(monitor) = monitor {
            let geom = monitor.geometry();
            let work = monitor.workarea();
            let mon_bottom = geom.y() + geom.height();
            let work_bottom = work.y() + work.height();
            let work_inset = (mon_bottom - work_bottom).max(0);
            let margin_bottom = (work_inset + 108).max(148);

            let log_x = geom.x() + (geom.width() - PILL_WIN_W) / 2;
            let log_y = mon_bottom - PILL_WIN_H - margin_bottom;
            win.move_(log_x, log_y);
        }
    }
}

fn ensure_created() {
    OVERLAY_UI.with(|cell| {
        if cell.borrow().is_some() {
            return;
        }

        let win = gtk::Window::new(gtk::WindowType::Toplevel);
        win.set_decorated(false);
        win.set_resizable(false);
        win.set_skip_taskbar_hint(true);
        win.set_skip_pager_hint(true);
        win.set_keep_above(true);
        win.set_accept_focus(false);
        win.set_focus_on_map(false);
        win.set_type_hint(gdk::WindowTypeHint::Utility);
        win.set_app_paintable(true);
        win.set_default_size(PILL_WIN_W, PILL_WIN_H);
        win.set_size_request(PILL_WIN_W, PILL_WIN_H);

        if let Some(screen) = WidgetExt::screen(&win) {
            if let Some(visual) = screen.rgba_visual() {
                win.set_visual(Some(&visual));
            }
        }

        let area = gtk::DrawingArea::new();
        area.set_size_request(PILL_WIN_W, PILL_WIN_H);
        area.add_events(gdk::EventMask::BUTTON_PRESS_MASK);
        win.add(&area);

        let state = Rc::new(RefCell::new(NativeOverlayState::default()));
        let draw_state = state.clone();

        area.connect_draw(move |_widget, cr| {
            cr.set_operator(cairo::Operator::Source);
            cr.set_source_rgba(0.0, 0.0, 0.0, 0.0);
            let _ = cr.paint();
            cr.set_operator(cairo::Operator::Over);

            let st = draw_state.borrow();
            if !st.visible || st.overlay_state == "idle" {
                return glib::Propagation::Proceed;
            }

            let pill_h = 42.0;
            let pill_w = match st.overlay_state.as_str() {
                "listening" if st.is_hands_free => 190.0,
                "listening" => 104.0,
                "transcribing" => 154.0,
                "done" => 116.0,
                "error" => 280.0,
                _ => 150.0,
            };
            let px = (PILL_WIN_W as f64 - pill_w) / 2.0;
            let py = (PILL_WIN_H as f64 - pill_h) / 2.0;

            draw_rounded_rect(cr, px, py, pill_w, pill_h, pill_h / 2.0);
            cr.set_source_rgba(0.102, 0.102, 0.102, 0.96);
            let _ = cr.fill_preserve();

            if st.overlay_state == "error" {
                cr.set_source_rgba(0.937, 0.267, 0.267, 0.9);
            } else {
                cr.set_source_rgba(1.0, 1.0, 1.0, 0.85);
            }
            cr.set_line_width(1.5);
            let _ = cr.stroke();

            match st.overlay_state.as_str() {
                "listening" => {
                    let bar_count = 10;
                    let bar_w = 3.0;
                    let gap = 3.0;
                    let bars_total_w = bar_count as f64 * bar_w + (bar_count - 1) as f64 * gap;
                    let start_x = if st.is_hands_free {
                        px + 16.0
                    } else {
                        px + (pill_w - bars_total_w) / 2.0
                    };
                    let center_y = py + pill_h / 2.0;

                    cr.set_source_rgba(1.0, 1.0, 1.0, 1.0);
                    for i in 0..bar_count {
                        let lvl = st.audio_levels.get(i).copied().unwrap_or(0.2);
                        let bh = (lvl * 22.0).round().max(5.0).min(24.0);
                        let bx = start_x + i as f64 * (bar_w + gap);
                        let by = center_y - bh / 2.0;
                        draw_rounded_rect(cr, bx, by, bar_w, bh, bar_w / 2.0);
                        let _ = cr.fill();
                    }

                    if st.is_hands_free {
                        let timer_str = format_mm_ss(st.elapsed_ms);
                        cr.select_font_face("Sans", cairo::FontSlant::Normal, cairo::FontWeight::Normal);
                        cr.set_font_size(12.0);
                        cr.set_source_rgba(0.85, 0.86, 0.90, 0.95);
                        let timer_x = start_x + bars_total_w + 10.0;
                        cr.move_to(timer_x, center_y + 4.0);
                        let _ = cr.show_text(&timer_str);

                        let sep_x = timer_x + 36.0;
                        cr.set_source_rgba(1.0, 1.0, 1.0, 0.25);
                        cr.set_line_width(1.0);
                        cr.move_to(sep_x, center_y - 8.0);
                        cr.line_to(sep_x, center_y + 8.0);
                        let _ = cr.stroke();

                        let btn_r = 12.0;
                        let btn_cx = px + pill_w - 20.0;
                        let btn_cy = center_y;
                        cr.arc(btn_cx, btn_cy, btn_r, 0.0, std::f64::consts::TAU);
                        cr.set_source_rgba(1.0, 1.0, 1.0, 0.16);
                        let _ = cr.fill();

                        cr.set_source_rgba(1.0, 1.0, 1.0, 0.95);
                        cr.set_line_width(1.8);
                        cr.move_to(btn_cx - 4.5, btn_cy + 0.5);
                        cr.line_to(btn_cx - 1.2, btn_cy + 3.8);
                        cr.line_to(btn_cx + 4.8, btn_cy - 3.2);
                        let _ = cr.stroke();
                    }
                }
                "transcribing" => {
                    let center_y = py + pill_h / 2.0;
                    cr.arc(px + 20.0, center_y, 4.0, 0.0, std::f64::consts::TAU);
                    cr.set_source_rgba(0.22, 0.74, 0.97, 1.0);
                    let _ = cr.fill();

                    cr.select_font_face("Sans", cairo::FontSlant::Normal, cairo::FontWeight::Normal);
                    cr.set_font_size(12.5);
                    cr.set_source_rgba(1.0, 1.0, 1.0, 0.95);
                    cr.move_to(px + 32.0, center_y + 4.5);
                    let _ = cr.show_text("Polishing text...");
                }
                "done" => {
                    let center_y = py + pill_h / 2.0;
                    cr.arc(px + 20.0, center_y, 4.0, 0.0, std::f64::consts::TAU);
                    cr.set_source_rgba(0.20, 0.83, 0.60, 1.0);
                    let _ = cr.fill();

                    cr.select_font_face("Sans", cairo::FontSlant::Normal, cairo::FontWeight::Normal);
                    cr.set_font_size(12.5);
                    cr.set_source_rgba(1.0, 1.0, 1.0, 0.95);
                    cr.move_to(px + 32.0, center_y + 4.5);
                    let _ = cr.show_text("Pasted!");
                }
                "error" => {
                    let center_y = py + pill_h / 2.0;
                    cr.arc(px + 18.0, center_y, 4.0, 0.0, std::f64::consts::TAU);
                    cr.set_source_rgba(0.937, 0.267, 0.267, 1.0);
                    let _ = cr.fill();

                    let msg = st.error_message.as_deref().unwrap_or("Dictation error");
                    let short: String = msg.chars().take(30).collect();
                    let label = if msg.chars().count() > 30 {
                        format!("{}...", short)
                    } else {
                        short
                    };
                    cr.select_font_face("Sans", cairo::FontSlant::Normal, cairo::FontWeight::Normal);
                    cr.set_font_size(11.5);
                    cr.set_source_rgba(1.0, 1.0, 1.0, 0.92);
                    cr.move_to(px + 28.0, center_y + 4.0);
                    let _ = cr.show_text(&label);

                    let bx = px + pill_w - 18.0;
                    cr.set_source_rgba(1.0, 1.0, 1.0, 0.75);
                    cr.set_line_width(1.6);
                    cr.move_to(bx - 4.0, center_y - 4.0);
                    cr.line_to(bx + 4.0, center_y + 4.0);
                    cr.move_to(bx + 4.0, center_y - 4.0);
                    cr.line_to(bx - 4.0, center_y + 4.0);
                    let _ = cr.stroke();
                }
                _ => {}
            }

            glib::Propagation::Proceed
        });

        let click_state = state.clone();
        area.connect_button_press_event(move |_widget, _ev| {
            let st = click_state.borrow();
            if st.overlay_state == "listening" && st.is_hands_free {
                crate::native_dictation::stop();
            } else if st.overlay_state == "error" {
                set_visible(false);
            }
            glib::Propagation::Stop
        });

        *cell.borrow_mut() = Some(OverlayWidgets {
            window: win,
            drawing_area: area,
            state,
        });
    });
}

pub fn set_visible(visible: bool) {
    glib::idle_add_once(move || {
        ensure_created();
        OVERLAY_UI.with(|cell| {
            if let Some(ui) = cell.borrow().as_ref() {
                ui.state.borrow_mut().visible = visible;
                if visible {
                    position_above_dock(&ui.window);
                    ui.window.set_keep_above(true);
                    ui.window.show_all();
                    position_above_dock(&ui.window);
                    ui.drawing_area.queue_draw();
                } else {
                    ui.window.hide();
                }
            }
        });
    });
}

pub fn set_interactive(interactive: bool) {
    glib::idle_add_once(move || {
        OVERLAY_UI.with(|cell| {
            if let Some(ui) = cell.borrow().as_ref() {
                if let Some(gdk_win) = ui.window.window() {
                    if interactive {
                        ui.window.input_shape_combine_region(None);
                    } else {
                        let empty = cairo::Region::create_rectangle(&cairo::RectangleInt::new(0, 0, 1, 1));
                        gdk_win.input_shape_combine_region(&empty, 0, 0);
                    }
                }
            }
        });
    });
}

pub fn update_state(
    overlay_state: String,
    is_hands_free: bool,
    elapsed_ms: u64,
    audio_levels: Vec<f64>,
    error_message: Option<String>,
) {
    glib::idle_add_once(move || {
        ensure_created();
        OVERLAY_UI.with(|cell| {
            if let Some(ui) = cell.borrow().as_ref() {
                let mut st = ui.state.borrow_mut();
                st.overlay_state = overlay_state;
                st.is_hands_free = is_hands_free;
                st.elapsed_ms = elapsed_ms;
                st.audio_levels = audio_levels;
                st.error_message = error_message;
                ui.drawing_area.queue_draw();
            }
        });
    });
}
