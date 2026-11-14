//! Dock geometry, top/bottom edge snapping, fullscreen auto-hide and cursor hit-testing for the
//! transparent overlay windows (dock + toast).
//!
//! The dock window spans 96% of the monitor work-area width and is taller than the visible pill so
//! popovers / context menus can render inside it. Every pixel that is not an interactive region is
//! click-through: a 30 Hz thread compares the cursor with the rectangles each webview reports and
//! toggles `set_ignore_cursor_events` only when the answer changes.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use windows::Win32::Foundation::{COLORREF, HWND, POINT, RECT};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow};
use windows::Win32::System::Threading::GetCurrentProcessId;
use windows::Win32::UI::Shell::{
    QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN, SHQueryUserNotificationState,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetClassNameW, GetCursorPos, GetForegroundWindow, GetWindowRect, GetWindowThreadProcessId,
    GWL_EXSTYLE, GWL_STYLE, GetWindowLongPtrW, HWND_TOPMOST, IsZoomed, LWA_ALPHA, SW_HIDE, SW_SHOWNOACTIVATE, SWP_NOACTIVATE, SWP_NOMOVE,
    SWP_NOSIZE, SetLayeredWindowAttributes, SetWindowLongPtrW, SetWindowPos, ShowWindow, WS_CAPTION, WS_EX_APPWINDOW, WS_EX_LAYERED,
    WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT,
};

use super::{from_wide, memory, taskbar};
use crate::AppState;
use crate::graphics;
use crate::i18n::{Lang, Text, tr};

/// Logical px reserved above (bottom dock) or below (top dock) the pill for popovers & menus.
pub const POPOVER_SPACE: f64 = 470.0;
pub const EDGE_MARGIN: f64 = 10.0;
pub const TOAST_GAP: f64 = 12.0;
pub const TOAST_WIDTH: f64 = 440.0;
pub const TOAST_HEIGHT: f64 = 380.0;
pub const MAX_WIDTH_RATIO: f64 = 0.96;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DockEdge {
    Bottom,
    Top,
}

impl DockEdge {
    pub fn parse(s: &str) -> DockEdge {
        if s == "top" { DockEdge::Top } else { DockEdge::Bottom }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            DockEdge::Bottom => "bottom",
            DockEdge::Top => "top",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockLayout {
    pub position: &'static str,
    pub dock_height: f64,
    pub popover_space: f64,
    pub edge_margin: f64,
    pub scale_factor: f64,
    pub monitor_name: Option<String>,
}

/// Physical-pixel rectangle (monitor bounds or a window placement).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MonitorRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Dock window placement: centered, 96% of the work-area width, flush with the chosen edge and
/// tall enough for the pill plus its popover space.
pub fn dock_geometry(monitor: MonitorRect, work_width: u32, scale: f64, dock_height: f64, edge: DockEdge) -> MonitorRect {
    let width = (work_width as f64 * MAX_WIDTH_RATIO).round();
    let height = ((POPOVER_SPACE + dock_height + EDGE_MARGIN) * scale).round();
    let x = monitor.x as f64 + (monitor.width as f64 - width) / 2.0;
    let y = match edge {
        DockEdge::Bottom => monitor.y as f64 + monitor.height as f64 - height,
        DockEdge::Top => monitor.y as f64,
    };
    MonitorRect { x: x.round() as i32, y: y.round() as i32, width: width as u32, height: height as u32 }
}

/// Toast window placement: `TOAST_GAP` above a bottom dock (toasts stack upward) or below a top
/// dock (toasts stack downward).
pub fn toast_geometry(monitor: MonitorRect, scale: f64, dock_height: f64, edge: DockEdge) -> MonitorRect {
    let width = (TOAST_WIDTH * scale).round();
    let height = (TOAST_HEIGHT * scale).round();
    let x = monitor.x as f64 + (monitor.width as f64 - width) / 2.0;
    let pill_extent = (EDGE_MARGIN + dock_height + TOAST_GAP) * scale;
    let y = match edge {
        DockEdge::Bottom => monitor.y as f64 + monitor.height as f64 - pill_extent - height,
        DockEdge::Top => monitor.y as f64 + pill_extent,
    };
    MonitorRect { x: x.round() as i32, y: y.round() as i32, width: width as u32, height: height as u32 }
}

/// Edge a vertical drag snaps to: the half of the monitor the cursor is released in.
pub fn edge_for_cursor(cursor_y: f64, monitor: MonitorRect) -> DockEdge {
    if cursor_y < monitor.y as f64 + monitor.height as f64 / 2.0 { DockEdge::Top } else { DockEdge::Bottom }
}

fn pick_monitor(app: &AppHandle, preferred: Option<&str>) -> Option<Monitor> {
    let monitors = app.available_monitors().unwrap_or_default();
    if let Some(name) = preferred {
        if let Some(m) = monitors.iter().find(|m| m.name().map(|n| n == name).unwrap_or(false)) {
            return Some(m.clone());
        }
    }
    app.primary_monitor().ok().flatten().or_else(|| monitors.into_iter().next())
}

/// Position dock + toast windows for the current settings. Returns the layout sent to webviews.
pub fn layout_windows(app: &AppHandle) -> Option<DockLayout> {
    let state = app.state::<AppState>();
    let settings = state.settings.read().clone();
    let monitor = pick_monitor(app, settings.monitor.as_deref())?;
    let scale = monitor.scale_factor();
    let work = monitor.work_area();
    let mon_pos = monitor.position();
    let mon_size = monitor.size();
    let edge = DockEdge::parse(&settings.position);
    let dock_h = settings.dock_height();

    let monitor_rect = MonitorRect { x: mon_pos.x, y: mon_pos.y, width: mon_size.width, height: mon_size.height };

    if let Some(dock) = app.get_webview_window("dock") {
        let g = dock_geometry(monitor_rect, work.size.width, scale, dock_h, edge);
        let _ = dock.set_size(PhysicalSize::new(g.width, g.height));
        let _ = dock.set_position(PhysicalPosition::new(g.x, g.y));
    }

    if let Some(toast) = app.get_webview_window("toast") {
        let g = toast_geometry(monitor_rect, scale, dock_h, edge);
        let _ = toast.set_size(PhysicalSize::new(g.width, g.height));
        let _ = toast.set_position(PhysicalPosition::new(g.x, g.y));
    }

    Some(DockLayout {
        position: edge.as_str(),
        dock_height: dock_h,
        popover_space: POPOVER_SPACE,
        edge_margin: EDGE_MARGIN,
        scale_factor: scale,
        monitor_name: monitor.name().cloned(),
    })
}

/// Re-layout and broadcast `dock:position-changed` + `dock:layout`.
pub fn relayout_and_broadcast(app: &AppHandle) {
    if let Some(layout) = layout_windows(app) {
        let _ = app.emit("dock:position-changed", layout.position);
        let _ = app.emit("dock:layout", &layout);
    }
}

/// Called when a vertical dock drag ends: pick the monitor under the cursor and the nearest edge.
pub fn snap_to_cursor(app: &AppHandle) -> Option<DockEdge> {
    let cursor = app.cursor_position().ok()?;
    let monitor = app.monitor_from_point(cursor.x, cursor.y).ok().flatten()?;
    let rect = MonitorRect { x: monitor.position().x, y: monitor.position().y, width: monitor.size().width, height: monitor.size().height };
    let edge = edge_for_cursor(cursor.y, rect);
    {
        let state = app.state::<AppState>();
        let mut settings = state.settings.write();
        settings.position = edge.as_str().to_string();
        settings.monitor = monitor.name().cloned();
        let _ = settings.save(&state.db);
    }
    relayout_and_broadcast(app);
    Some(edge)
}

// ---------------------------------------------------------------------------------------------
// Lazy modal windows (picker / settings)
// ---------------------------------------------------------------------------------------------

/// Logical size and localized title of a lazily created modal window.
pub fn modal_spec(label: &str, lang: Lang) -> Option<(f64, f64, &'static str)> {
    match label {
        "picker" => Some((920.0, 640.0, tr(lang, Text::PickerTitle))),
        "settings" => Some((860.0, 640.0, tr(lang, Text::SettingsTitle))),
        _ => None,
    }
}

/// App URL of a modal window; `tab` (settings only) is restricted to a plain identifier.
pub fn modal_url(label: &str, tab: Option<&str>) -> String {
    let mut url = format!("index.html?window={label}");
    if let Some(tab) = tab.filter(|t| !t.is_empty() && t.len() <= 32 && t.chars().all(|c| c.is_ascii_alphanumeric())) {
        url.push_str("&tab=");
        url.push_str(tab);
    }
    url
}

/// WebView2 refuses to create a webview whose browser arguments differ from the ones its
/// user-data folder was first opened with, so runtime-created windows reuse the dock's verbatim.
fn shared_browser_args(app: &AppHandle) -> Option<String> {
    app.config().app.windows.iter().find_map(|w| w.additional_browser_args.clone())
}

fn center_and_show(app: &AppHandle, window: &WebviewWindow) {
    let preferred = app.state::<AppState>().settings.read().monitor.clone();
    if let Some(monitor) = pick_monitor(app, preferred.as_deref()) {
        if let Ok(size) = window.outer_size() {
            let work = monitor.work_area();
            let x = work.position.x as f64 + (work.size.width as f64 - size.width as f64) / 2.0;
            let y = work.position.y as f64 + (work.size.height as f64 - size.height as f64) / 2.0;
            let _ = window.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
        }
    }
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

/// Show the picker / settings window, creating it on demand. Neither window exists while closed:
/// each WebView2 instance costs tens of MB, so they are destroyed on close (`close_modal`) and
/// only `dock` + `toast` stay resident.
///
/// Must not be called from a synchronous command: creating a window from the IPC thread
/// deadlocks on Windows. Async commands and the main thread (tray menu) are fine.
pub fn open_modal(app: &AppHandle, label: &str, tab: Option<&str>) -> Result<(), String> {
    let lang = Lang::parse(&app.state::<AppState>().settings.read().language);
    let (width, height, title) = modal_spec(label, lang).ok_or_else(|| format!("window '{label}' cannot be opened"))?;
    if let Some(window) = app.get_webview_window(label) {
        if let Some(tab) = tab {
            let _ = app.emit_to(label, "settings:navigate", tab);
        }
        center_and_show(app, &window);
        return Ok(());
    }
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App(modal_url(label, tab).into()))
        .title(title)
        .inner_size(width, height)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .visible(false);
    if let Some(args) = shared_browser_args(app) {
        builder = builder.additional_browser_args(&args);
    }
    let window = builder.build().map_err(|e| format!("could not create the {label} window: {e}"))?;
    center_and_show(app, &window);
    Ok(())
}

/// Destroy a modal window (its webview and renderer go with it).
pub fn close_modal(app: &AppHandle, label: &str) -> Result<(), String> {
    if modal_spec(label, Lang::Fr).is_none() {
        return Err(format!("window '{label}' cannot be closed"));
    }
    match app.get_webview_window(label) {
        Some(window) => window.destroy().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

/// Bookkeeping once a modal window is gone: forget its hit regions and return its memory.
pub fn on_modal_destroyed(label: &str) {
    HIT_REGIONS.lock().remove(label);
    memory::request_trim(memory::WINDOW_CLOSE_TRIM_DELAY);
}

// ---------------------------------------------------------------------------------------------
// Click-through hit testing
// ---------------------------------------------------------------------------------------------

/// Rect in *physical* pixels relative to the window's top-left: [x, y, w, h].
pub type HitRect = [f64; 4];

struct HitEntry {
    /// Cached on registration (main thread). Calling `window.hwnd()` from the hit-test thread
    /// would round-trip through the event loop.
    hwnd: isize,
    rects: Vec<HitRect>,
    capture_all: bool,
    interactive: Option<bool>,
}

static HIT_REGIONS: Lazy<Mutex<HashMap<String, HitEntry>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static HIT_THREAD_STARTED: AtomicBool = AtomicBool::new(false);

pub fn set_hit_regions(window: WebviewWindow, rects: Vec<HitRect>, capture_all: bool) {
    let label = window.label().to_string();
    let hwnd = window.hwnd().map(|h| h.0 as isize).unwrap_or(0);
    let mut map = HIT_REGIONS.lock();
    match map.get_mut(&label) {
        Some(entry) => {
            entry.rects = rects;
            entry.capture_all = capture_all;
            if hwnd != 0 {
                entry.hwnd = hwnd;
            }
        }
        None => {
            map.insert(label, HitEntry { hwnd, rects, capture_all, interactive: None });
        }
    }
}

fn hwnd_rect(hwnd: isize) -> Option<RECT> {
    if hwnd == 0 {
        return None;
    }
    let mut rect = RECT::default();
    unsafe { GetWindowRect(HWND(hwnd as *mut core::ffi::c_void), &mut rect).ok()? };
    Some(rect)
}

fn hit_test_tick() {
    let mut cursor = POINT::default();
    if unsafe { GetCursorPos(&mut cursor) }.is_err() {
        return;
    }
    // Decide under the lock, act after releasing it: the Tauri call dispatches to the main
    // thread, which may itself be waiting for this lock inside `set_hit_regions`.
    let mut changes: Vec<(isize, bool)> = Vec::new();
    {
        let mut map = HIT_REGIONS.lock();
        for entry in map.values_mut() {
            let interactive = if entry.capture_all {
                true
            } else if let Some(rect) = hwnd_rect(entry.hwnd) {
                let lx = (cursor.x - rect.left) as f64;
                let ly = (cursor.y - rect.top) as f64;
                entry.rects.iter().any(|r| lx >= r[0] && lx <= r[0] + r[2] && ly >= r[1] && ly <= r[1] + r[3])
            } else {
                false
            };
            if entry.interactive != Some(interactive) {
                entry.interactive = Some(interactive);
                if entry.hwnd != 0 {
                    changes.push((entry.hwnd, interactive));
                }
            }
        }
    }
    for (hwnd, interactive) in changes {
        set_click_through(HWND(hwnd as *mut core::ffi::c_void), !interactive);
    }
}

pub fn start_hit_testing() {
    if HIT_THREAD_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::Builder::new()
        .name("lumabar-hittest".into())
        .spawn(|| loop {
            hit_test_tick();
            std::thread::sleep(Duration::from_millis(33));
        })
        .expect("spawn hit-test thread");
}

// ---------------------------------------------------------------------------------------------
// Overlay window styles
//
// The dock and toast windows are created hidden and are shown, hidden and made click-through
// with raw Win32 calls only. Tauri (tao) keeps its own copy of each window's flags and rewrites
// GWL_STYLE / GWL_EXSTYLE from that copy whenever one of them changes: since it never saw the
// window being shown, toggling `set_ignore_cursor_events` after startup re-applied the styles
// without WS_VISIBLE and the dock vanished the moment the cursor entered the pill. So nothing
// here may go through a tao flag setter once the window is up.
// ---------------------------------------------------------------------------------------------

/// Extended style for an overlay window: always layered + topmost + tool window (kept out of
/// Alt+Tab / Task View like the real taskbar), click-through unless the cursor is over content.
fn overlay_ex_style(current: isize, click_through: bool) -> isize {
    let base = (current | (WS_EX_LAYERED.0 | WS_EX_TOOLWINDOW.0 | WS_EX_TOPMOST.0) as isize) & !(WS_EX_APPWINDOW.0 as isize);
    if click_through { base | WS_EX_TRANSPARENT.0 as isize } else { base & !(WS_EX_TRANSPARENT.0 as isize) }
}

/// Toggle mouse pass-through. Only the WS_EX_TRANSPARENT bit changes; visibility, z-order and
/// every other style are left exactly as they are.
fn set_click_through(hwnd: HWND, click_through: bool) {
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let wanted = overlay_ex_style(ex, click_through);
        if wanted != ex {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, wanted);
        }
    }
}

/// One-time setup before an overlay window is first shown: start click-through.
pub fn prepare_overlay(window: &WebviewWindow) {
    // The only tao flag change, made while the window is still hidden: it also gives the layered
    // window its opaque alpha so it renders once shown.
    let _ = window.set_ignore_cursor_events(true);
    if let Ok(raw) = window.hwnd() {
        let hwnd = HWND(raw.0 as *mut core::ffi::c_void);
        unsafe {
            let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 255, LWA_ALPHA);
        }
        set_click_through(hwnd, true);
    }
}

/// Show a window above everything else without activating it (never steal focus from the user's app).
pub fn show_no_activate(window: &WebviewWindow) {
    if let Ok(raw) = window.hwnd() {
        let hwnd = HWND(raw.0 as *mut core::ffi::c_void);
        unsafe {
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }
    }
}

/// Hide an overlay window (fullscreen app in front). The only code path that hides the dock.
fn hide_overlay(window: &WebviewWindow) {
    if let Ok(raw) = window.hwnd() {
        unsafe {
            let _ = ShowWindow(HWND(raw.0 as *mut core::ffi::c_void), SW_HIDE);
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Fullscreen detection
// ---------------------------------------------------------------------------------------------

fn monitor_rect_of(hwnd: HWND) -> Option<RECT> {
    unsafe {
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        if GetMonitorInfoW(monitor, &mut info).as_bool() { Some(info.rcMonitor) } else { None }
    }
}

fn class_name(hwnd: HWND) -> String {
    let mut buf = [0u16; 128];
    let len = unsafe { GetClassNameW(hwnd, &mut buf) };
    from_wide(&buf[..len.max(0) as usize])
}

/// True when the foreground window (not the desktop / shell / lumabar) covers its whole monitor
/// and that monitor is the dock's monitor.
fn foreground_covers_monitor(dock_hwnd: HWND) -> bool {
    unsafe {
        let fg = GetForegroundWindow();
        if fg.is_invalid() {
            return false;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(fg, Some(&mut pid));
        if pid == GetCurrentProcessId() {
            return false;
        }
        let class = class_name(fg);
        if matches!(class.as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd") {
            return false;
        }
        // With an auto-hide taskbar a *maximized* window also covers the whole monitor. Real
        // fullscreen (games, video players, F11 browsers) is borderless and not zoomed.
        let style = GetWindowLongPtrW(fg, GWL_STYLE) as u32;
        if IsZoomed(fg).as_bool() || style & WS_CAPTION.0 == WS_CAPTION.0 {
            return false;
        }
        let mut rect = RECT::default();
        if GetWindowRect(fg, &mut rect).is_err() {
            return false;
        }
        let (Some(fg_mon), Some(dock_mon)) = (monitor_rect_of(fg), monitor_rect_of(dock_hwnd)) else {
            return false;
        };
        if fg_mon != dock_mon {
            return false;
        }
        rect.left <= fg_mon.left && rect.top <= fg_mon.top && rect.right >= fg_mon.right && rect.bottom >= fg_mon.bottom
    }
}

fn notification_state_fullscreen() -> bool {
    match unsafe { SHQueryUserNotificationState() } {
        Ok(state) => state == QUNS_RUNNING_D3D_FULL_SCREEN || state == QUNS_PRESENTATION_MODE,
        Err(_) => false,
    }
}

/// 500 ms watcher: fullscreen auto-hide, hidden-taskbar enforcement and display-change relayout.
pub fn start_fullscreen_watch(app: AppHandle) {
    std::thread::Builder::new()
        .name("lumabar-fullscreen".into())
        .spawn(move || {
            let mut hidden = false;
            let mut last_monitor: Option<(i32, i32, u32, u32, u64)> = None;
            let mut cached_hwnd: isize = 0;
            let mut tick: u64 = 0;
            loop {
                std::thread::sleep(Duration::from_millis(500));
                taskbar::enforce_hidden();
                graphics::dxgi_capture::verify_affinity();

                let Some(dock) = app.get_webview_window("dock") else { continue };
                if cached_hwnd == 0 {
                    match dock.hwnd() {
                        Ok(raw) => cached_hwnd = raw.0 as isize,
                        Err(_) => continue,
                    }
                }
                let dock_hwnd = HWND(cached_hwnd as *mut core::ffi::c_void);

                // Display configuration changes (resolution / DPI / monitor unplugged).
                if let Ok(Some(monitor)) = dock.current_monitor() {
                    let key = (
                        monitor.position().x,
                        monitor.position().y,
                        monitor.size().width,
                        monitor.size().height,
                        (monitor.scale_factor() * 1000.0) as u64,
                    );
                    if last_monitor.is_some_and(|prev| prev != key) {
                        relayout_and_broadcast(&app);
                    }
                    last_monitor = Some(key);
                }

                let enabled = app.state::<AppState>().settings.read().hide_on_fullscreen;
                let fullscreen = enabled && (notification_state_fullscreen() || foreground_covers_monitor(dock_hwnd));
                tick += 1;
                if tick % 10 == 0 {
                    // Periodic re-broadcast so a reloaded webview resyncs its slide state.
                    let _ = app.emit("dock:fullscreen", hidden);
                }
                if fullscreen != hidden {
                    hidden = fullscreen;
                    // Nothing is composited while the dock is hidden: stop the desktop capture.
                    graphics::set_paused(fullscreen);
                    let _ = app.emit("dock:fullscreen", fullscreen);
                    let toast = app.get_webview_window("toast");
                    if fullscreen {
                        // Let the slide-out animation finish, then truly hide so the topmost
                        // transparent windows never interfere with exclusive fullscreen.
                        std::thread::sleep(Duration::from_millis(320));
                        hide_overlay(&dock);
                        if let Some(t) = toast {
                            hide_overlay(&t);
                        }
                    } else {
                        show_no_activate(&dock);
                        if let Some(t) = toast {
                            show_no_activate(&t);
                        }
                    }
                }
            }
        })
        .expect("spawn fullscreen watcher");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn click_through_toggle_only_changes_the_transparent_bit() {
        let visible_unrelated = 0x0000_0110isize; // WS_EX_WINDOWEDGE | WS_EX_ACCEPTFILES
        let through = overlay_ex_style(visible_unrelated, true);
        let solid = overlay_ex_style(through, false);
        assert_ne!(through & WS_EX_TRANSPARENT.0 as isize, 0);
        assert_eq!(solid & WS_EX_TRANSPARENT.0 as isize, 0);
        assert_eq!(through ^ solid, WS_EX_TRANSPARENT.0 as isize);
        for style in [through, solid] {
            assert_ne!(style & WS_EX_TOPMOST.0 as isize, 0);
            assert_ne!(style & WS_EX_LAYERED.0 as isize, 0);
            assert_ne!(style & WS_EX_TOOLWINDOW.0 as isize, 0);
            assert_eq!(style & WS_EX_APPWINDOW.0 as isize, 0);
            assert_eq!(style & visible_unrelated, visible_unrelated);
        }
        // Idempotent.
        assert_eq!(overlay_ex_style(solid, false), solid);
        assert_eq!(overlay_ex_style(through, true), through);
    }

    #[test]
    fn only_picker_and_settings_are_lazy_modals() {
        assert_eq!(modal_spec("picker", Lang::En).map(|s| (s.0, s.1)), Some((920.0, 640.0)));
        assert_eq!(modal_spec("settings", Lang::En).map(|s| (s.0, s.1)), Some((860.0, 640.0)));
        assert!(modal_spec("dock", Lang::En).is_none());
        assert!(modal_spec("toast", Lang::Fr).is_none());
    }

    #[test]
    fn modal_titles_follow_the_language() {
        assert_eq!(modal_spec("picker", Lang::Fr).map(|s| s.2), Some("Ajouter des widgets"));
        assert_eq!(modal_spec("picker", Lang::En).map(|s| s.2), Some("Add Widgets"));
    }

    #[test]
    fn modal_url_carries_a_sanitized_tab() {
        assert_eq!(modal_url("settings", Some("automations")), "index.html?window=settings&tab=automations");
        assert_eq!(modal_url("settings", None), "index.html?window=settings");
        assert_eq!(modal_url("settings", Some("a&window=dock")), "index.html?window=settings");
        assert_eq!(modal_url("picker", Some("")), "index.html?window=picker");
    }

    const FHD: MonitorRect = MonitorRect { x: 0, y: 0, width: 1920, height: 1080 };

    #[test]
    fn size_presets_resize_the_dock_window() {
        // compact 46 / medium 58 / large 70 logical px of pill + popover space + edge margin.
        for (dock_h, expected) in [(46.0, 526), (58.0, 538), (70.0, 550)] {
            let bottom = dock_geometry(FHD, 1920, 1.0, dock_h, DockEdge::Bottom);
            assert_eq!(bottom.height, expected);
            assert_eq!(bottom.width, 1843);
            // Bottom edge of the window always sits on the bottom edge of the monitor.
            assert_eq!(bottom.y + bottom.height as i32, 1080);
            // Horizontally centered.
            assert!((bottom.x * 2 + bottom.width as i32 - 1920).abs() <= 1);
        }
    }

    #[test]
    fn dock_snaps_to_top_and_bottom_edges() {
        let top = dock_geometry(FHD, 1920, 1.0, 58.0, DockEdge::Top);
        let bottom = dock_geometry(FHD, 1920, 1.0, 58.0, DockEdge::Bottom);
        assert_eq!(top.y, 0);
        assert_eq!(bottom.y, 1080 - 538);
        // Secondary monitor to the left, 150% scaling.
        let second = MonitorRect { x: -2560, y: 200, width: 2560, height: 1440 };
        let g = dock_geometry(second, 2560, 1.5, 58.0, DockEdge::Top);
        assert_eq!((g.y, g.height), (200, 807));
        assert!(g.x >= -2560 && g.x + g.width as i32 <= 0);
    }

    #[test]
    fn toasts_stack_upward_from_a_bottom_dock_and_downward_from_a_top_dock() {
        let pill_extent = (EDGE_MARGIN + 58.0 + TOAST_GAP) as i32; // 80
        let above = toast_geometry(FHD, 1.0, 58.0, DockEdge::Bottom);
        // Window ends exactly TOAST_GAP above the pill.
        assert_eq!(above.y + above.height as i32, 1080 - pill_extent);
        let below = toast_geometry(FHD, 1.0, 58.0, DockEdge::Top);
        // Window starts exactly TOAST_GAP below the pill.
        assert_eq!(below.y, pill_extent);
        assert_eq!((above.width, above.height), (440, 380));
        // The toast window never overlaps the pill for any size preset.
        for dock_h in [46.0, 58.0, 70.0] {
            let t = toast_geometry(FHD, 1.0, dock_h, DockEdge::Bottom);
            assert!(t.y + t.height as i32 <= 1080 - (EDGE_MARGIN + dock_h) as i32);
        }
    }

    #[test]
    fn drag_release_picks_the_nearest_edge() {
        assert_eq!(edge_for_cursor(100.0, FHD), DockEdge::Top);
        assert_eq!(edge_for_cursor(539.0, FHD), DockEdge::Top);
        assert_eq!(edge_for_cursor(540.0, FHD), DockEdge::Bottom);
        assert_eq!(edge_for_cursor(1079.0, FHD), DockEdge::Bottom);
        let second = MonitorRect { x: 0, y: -1080, width: 1920, height: 1080 };
        assert_eq!(edge_for_cursor(-900.0, second), DockEdge::Top);
        assert_eq!(edge_for_cursor(-100.0, second), DockEdge::Bottom);
    }

    #[test]
    fn dock_edge_round_trips() {
        assert_eq!(DockEdge::parse("top"), DockEdge::Top);
        assert_eq!(DockEdge::parse("bottom"), DockEdge::Bottom);
        assert_eq!(DockEdge::parse("sideways"), DockEdge::Bottom);
        assert_eq!(DockEdge::Top.as_str(), "top");
    }
}
