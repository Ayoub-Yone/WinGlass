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
use tauri::{AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewWindow};
use windows::Win32::Foundation::{HWND, POINT, RECT};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow};
use windows::Win32::System::Threading::GetCurrentProcessId;
use windows::Win32::UI::Shell::{
    QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN, SHQueryUserNotificationState,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetClassNameW, GetCursorPos, GetForegroundWindow, GetWindowRect, GetWindowThreadProcessId,
    GWL_EXSTYLE, GWL_STYLE, GetWindowLongPtrW, IsZoomed, SW_SHOWNOACTIVATE, WS_CAPTION, SetWindowLongPtrW, ShowWindow, WS_EX_APPWINDOW,
    WS_EX_TOOLWINDOW,
};

use super::{from_wide, taskbar};
use crate::AppState;

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

    let win_w = (work.size.width as f64 * MAX_WIDTH_RATIO).round();
    let win_h = ((POPOVER_SPACE + dock_h + EDGE_MARGIN) * scale).round();
    let x = mon_pos.x as f64 + (mon_size.width as f64 - win_w) / 2.0;
    let y = match edge {
        DockEdge::Bottom => mon_pos.y as f64 + mon_size.height as f64 - win_h,
        DockEdge::Top => mon_pos.y as f64,
    };

    if let Some(dock) = app.get_webview_window("dock") {
        let _ = dock.set_size(PhysicalSize::new(win_w as u32, win_h as u32));
        let _ = dock.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
    }

    if let Some(toast) = app.get_webview_window("toast") {
        let tw = (TOAST_WIDTH * scale).round();
        let th = (TOAST_HEIGHT * scale).round();
        let tx = mon_pos.x as f64 + (mon_size.width as f64 - tw) / 2.0;
        let pill_extent = (EDGE_MARGIN + dock_h + TOAST_GAP) * scale;
        let ty = match edge {
            DockEdge::Bottom => mon_pos.y as f64 + mon_size.height as f64 - pill_extent - th,
            DockEdge::Top => mon_pos.y as f64 + pill_extent,
        };
        let _ = toast.set_size(PhysicalSize::new(tw as u32, th as u32));
        let _ = toast.set_position(PhysicalPosition::new(tx.round() as i32, ty.round() as i32));
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
    let mid = monitor.position().y as f64 + monitor.size().height as f64 / 2.0;
    let edge = if cursor.y < mid { DockEdge::Top } else { DockEdge::Bottom };
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

/// Center a modal window (picker / settings) on the dock's monitor and show it.
pub fn show_centered(app: &AppHandle, label: &str) {
    let Some(window) = app.get_webview_window(label) else { return };
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

// ---------------------------------------------------------------------------------------------
// Click-through hit testing
// ---------------------------------------------------------------------------------------------

/// Rect in *physical* pixels relative to the window's top-left: [x, y, w, h].
pub type HitRect = [f64; 4];

struct HitEntry {
    window: WebviewWindow,
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
            map.insert(label, HitEntry { window, hwnd, rects, capture_all, interactive: None });
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
    let mut changes: Vec<(WebviewWindow, bool)> = Vec::new();
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
                changes.push((entry.window.clone(), interactive));
            }
        }
    }
    for (window, interactive) in changes {
        let _ = window.set_ignore_cursor_events(!interactive);
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

/// Keep overlay windows out of Alt+Tab / Task View (WS_EX_TOOLWINDOW), like the real taskbar.
pub fn make_tool_window(window: &WebviewWindow) {
    if let Ok(raw) = window.hwnd() {
        let hwnd = HWND(raw.0 as *mut core::ffi::c_void);
        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, (ex | WS_EX_TOOLWINDOW.0 as isize) & !(WS_EX_APPWINDOW.0 as isize));
        }
    }
}

/// Show a window without activating it (never steal focus from the user's app).
pub fn show_no_activate(window: &WebviewWindow) {
    if let Ok(raw) = window.hwnd() {
        unsafe {
            let _ = ShowWindow(HWND(raw.0 as *mut core::ffi::c_void), SW_SHOWNOACTIVATE);
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
                    let _ = app.emit("dock:fullscreen", fullscreen);
                    let toast = app.get_webview_window("toast");
                    if fullscreen {
                        // Let the slide-out animation finish, then truly hide so the topmost
                        // transparent windows never interfere with exclusive fullscreen.
                        std::thread::sleep(Duration::from_millis(320));
                        let _ = dock.hide();
                        if let Some(t) = toast {
                            let _ = t.hide();
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
