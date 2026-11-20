//! Dock geometry, top/bottom edge snapping, fullscreen auto-hide and cursor hit-testing for the
//! transparent overlay windows (dock + toast).
//!
//! The dock window spans 96% of the monitor work-area width and is taller than the visible pill so
//! popovers / context menus can render inside it. Every pixel that is not an interactive region is
//! click-through: a 30 Hz thread compares the cursor with the rectangles each webview reports and
//! toggles `set_ignore_cursor_events` only when the answer changes.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use parking_lot::{Condvar, Mutex};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use windows::Win32::Foundation::{COLORREF, HWND, POINT, RECT};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITOR_DEFAULTTONULL, MONITORINFO, MONITORINFOEXW, MonitorFromPoint, MonitorFromWindow,
};
use windows::Win32::System::Threading::GetCurrentProcessId;
use windows::Win32::UI::HiDpi::GetDpiForWindow;
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
        "settings" => Some((1000.0, 680.0, tr(lang, Text::SettingsTitle))),
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
    /// A flyout / menu / preview is open or a text field has focus: auto-hide must wait.
    hold: bool,
    interactive: Option<bool>,
}

static HIT_REGIONS: Lazy<Mutex<HashMap<String, HitEntry>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static HIT_THREAD_STARTED: AtomicBool = AtomicBool::new(false);

pub fn set_hit_regions(window: WebviewWindow, rects: Vec<HitRect>, capture_all: bool, hold: bool) {
    let label = window.label().to_string();
    let hwnd = window.hwnd().map(|h| h.0 as isize).unwrap_or(0);
    let mut map = HIT_REGIONS.lock();
    match map.get_mut(&label) {
        Some(entry) => {
            entry.rects = rects;
            entry.capture_all = capture_all;
            entry.hold = hold;
            if hwnd != 0 {
                entry.hwnd = hwnd;
            }
        }
        None => {
            map.insert(label, HitEntry { hwnd, rects, capture_all, hold, interactive: None });
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

/// The dock's interactive rects in screen coordinates, and whether the dock asks to stay open
/// (open flyout, menu, drag, focused text field — whole-window capture counts as a hold).
fn dock_hit_state() -> (Vec<RECT>, bool) {
    let map = HIT_REGIONS.lock();
    let Some(entry) = map.get("dock") else { return (Vec::new(), false) };
    let hold = entry.hold || entry.capture_all;
    let Some(win) = hwnd_rect(entry.hwnd) else { return (Vec::new(), hold) };
    let rects = entry
        .rects
        .iter()
        .map(|r| RECT {
            left: win.left + r[0] as i32,
            top: win.top + r[1] as i32,
            right: win.left + (r[0] + r[2]) as i32,
            bottom: win.top + (r[1] + r[3]) as i32,
        })
        .collect();
    (rects, hold)
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
        .name("winglass-hittest".into())
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

/// Shell surfaces that can be foreground (and may even span the monitor) but are never a
/// "fullscreen app": the desktop, the taskbar, Alt+Tab / Task View, Start / Search hosts.
pub const SHELL_CLASSES: &[&str] = &[
    "Progman",
    "WorkerW",
    "Shell_TrayWnd",
    "Shell_SecondaryTrayWnd",
    "XamlExplorerHostIslandWindow",
    "MultitaskingViewFrame",
    "TaskSwitcherWnd",
    "TaskSwitcherOverlayWnd",
    "ForegroundStaging",
    "Windows.UI.Core.CoreWindow",
    "NotifyIconOverflowWindow",
    "TopLevelWindowForOverflowXamlIsland",
];

/// Everything the hide decision needs to know about the foreground window.
#[derive(Debug, Clone, PartialEq)]
pub struct ForegroundInfo {
    pub class: String,
    pub own_process: bool,
    pub zoomed: bool,
    pub has_caption: bool,
    pub rect: RECT,
    pub monitor: RECT,
}

/// Pure decision: hide the dock **only** while the *current* foreground window is a fullscreen
/// (exclusive or borderless) app on the dock's monitor. A game running in the background never
/// keeps the dock hidden: the moment Alt+Tab / Win / a click moves the foreground elsewhere this
/// returns false. `d3d_fullscreen` (SHQueryUserNotificationState) only vouches for a foreground
/// window that already covers the dock's monitor.
pub fn should_hide_for(fg: Option<&ForegroundInfo>, dock_monitor: RECT, d3d_fullscreen: bool) -> bool {
    let Some(fg) = fg else { return false };
    if fg.own_process || SHELL_CLASSES.contains(&fg.class.as_str()) || fg.monitor != dock_monitor {
        return false;
    }
    let covers = fg.rect.left <= fg.monitor.left
        && fg.rect.top <= fg.monitor.top
        && fg.rect.right >= fg.monitor.right
        && fg.rect.bottom >= fg.monitor.bottom;
    // With a hidden taskbar a *maximized* window also covers the whole monitor, even while a
    // game elsewhere keeps SHQueryUserNotificationState at D3D-fullscreen. Real fullscreen
    // (games, video players, F11 browsers) is never zoomed.
    if !covers || fg.zoomed {
        return false;
    }
    // Exclusive fullscreen may keep a caption style; then D3D state must vouch for it.
    !fg.has_caption || d3d_fullscreen
}

/// Inspect a window for `should_hide_for`. `None` when it is gone or has no monitor.
pub fn foreground_info(hwnd: HWND) -> Option<ForegroundInfo> {
    if hwnd.is_invalid() {
        return None;
    }
    unsafe {
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE) as u32;
        let mut rect = RECT::default();
        GetWindowRect(hwnd, &mut rect).ok()?;
        Some(ForegroundInfo {
            class: class_name(hwnd),
            own_process: pid == GetCurrentProcessId(),
            zoomed: IsZoomed(hwnd).as_bool(),
            has_caption: style & WS_CAPTION.0 == WS_CAPTION.0,
            rect,
            monitor: monitor_rect_of(hwnd)?,
        })
    }
}

fn d3d_fullscreen() -> bool {
    match unsafe { SHQueryUserNotificationState() } {
        Ok(state) => state == QUNS_RUNNING_D3D_FULL_SCREEN || state == QUNS_PRESENTATION_MODE,
        Err(_) => false,
    }
}

/// Should the dock be hidden right now? Decided from the *current* foreground window only.
fn fullscreen_in_front(dock_hwnd: HWND) -> bool {
    let Some(dock_monitor) = monitor_rect_of(dock_hwnd) else { return false };
    let fg = foreground_info(unsafe { GetForegroundWindow() });
    should_hide_for(fg.as_ref(), dock_monitor, d3d_fullscreen())
}

/// Foreground-change wake-up for the watcher (fed by the sentinel's EVENT_SYSTEM_FOREGROUND hook).
static FG_WAKE: Lazy<(Mutex<bool>, Condvar)> = Lazy::new(|| (Mutex::new(false), Condvar::new()));

/// Called from the WinEvent hook: re-evaluate fullscreen immediately instead of on the next tick.
pub fn notify_foreground_changed() {
    let (lock, cvar) = &*FG_WAKE;
    *lock.lock() = true;
    cvar.notify_one();
}

/// Wait up to `timeout` for a foreground change. Returns true when one arrived.
fn wait_foreground_change(timeout: Duration) -> bool {
    let (lock, cvar) = &*FG_WAKE;
    let mut pending = lock.lock();
    if !*pending {
        let _ = cvar.wait_for(&mut pending, timeout);
    }
    std::mem::replace(&mut *pending, false)
}

/// Fallback poll when no foreground event arrives (exclusive-fullscreen transitions do not
/// always raise one).
const FULLSCREEN_POLL: Duration = Duration::from_millis(150);
/// Taskbar enforcement / affinity / display-change checks keep their 500 ms cadence.
const HOUSEKEEPING_EVERY: Duration = Duration::from_millis(500);
/// Slide-out animation length before the dock is truly hidden.
const SLIDE_OUT: Duration = Duration::from_millis(300);

// ---------------------------------------------------------------------------------------------
// Auto-hide (« Masquer automatiquement le dock »)
// ---------------------------------------------------------------------------------------------

/// Cursor poll cadence while auto-hide is on (reveal must feel instant at the edge).
pub const AUTO_HIDE_POLL: Duration = Duration::from_millis(35);
/// How long the cursor must stay away before the dock slides out.
pub const AUTO_HIDE_GRACE: Duration = Duration::from_millis(400);
/// Hysteresis around the dock's interactive rects, logical px.
pub const AUTO_HIDE_MARGIN: f64 = 24.0;
/// Reveal band: distance in px from the docked edge's last pixel row.
pub const EDGE_REVEAL_PX: i32 = 3;

/// Is the cursor within `margin` px of any of the rects?
pub fn near_any(cursor: POINT, rects: &[RECT], margin: i32) -> bool {
    rects.iter().any(|r| {
        cursor.x >= r.left - margin && cursor.x < r.right + margin && cursor.y >= r.top - margin && cursor.y < r.bottom + margin
    })
}

/// Is the cursor touching the docked edge of `monitor` (<= `EDGE_REVEAL_PX`) within `span` (x range)?
pub fn at_reveal_edge(cursor: POINT, monitor: RECT, span: (i32, i32), edge: DockEdge) -> bool {
    if cursor.x < span.0 || cursor.x >= span.1 || cursor.y < monitor.top || cursor.y >= monitor.bottom {
        return false;
    }
    match edge {
        DockEdge::Bottom => monitor.bottom - 1 - cursor.y <= EDGE_REVEAL_PX,
        DockEdge::Top => cursor.y - monitor.top <= EDGE_REVEAL_PX,
    }
}

/// One cursor sample for the auto-hide state machine.
#[derive(Debug, Clone, Copy, Default)]
pub struct AutoHideSample {
    /// Cursor is more than the margin away from every interactive rect (false when none is known).
    pub away: bool,
    /// Cursor touches the docked screen edge within the dock's span.
    pub at_edge: bool,
    /// A flyout / menu / preview / focused field / Settings or picker window keeps the dock open.
    pub hold: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutoHideEffect {
    /// Start the slide-out (webview animation, hit regions dropped, capture paused).
    StartHide,
    /// Slide finished: truly hide the window.
    FinishHide,
    /// Show again (raw Win32) and slide in.
    Reveal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum AutoHidePhase {
    #[default]
    Shown,
    Leaving(Instant),
    Hidden,
}

/// Pure auto-hide state machine: hide after `AUTO_HIDE_GRACE` away (never while held), reveal
/// only at the screen edge.
#[derive(Debug, Default)]
pub struct AutoHide {
    phase: AutoHidePhase,
    away_since: Option<Instant>,
}

impl AutoHide {
    pub fn is_hidden(&self) -> bool {
        self.phase != AutoHidePhase::Shown
    }

    /// A fullscreen hide took over mid-slide: the window is hidden now, so a slide is finished.
    pub fn settle(&mut self) {
        if let AutoHidePhase::Leaving(_) = self.phase {
            self.phase = AutoHidePhase::Hidden;
        }
    }

    pub fn step(&mut self, enabled: bool, s: AutoHideSample, now: Instant) -> Option<AutoHideEffect> {
        if !enabled || s.hold {
            self.away_since = None;
            if self.phase == AutoHidePhase::Shown {
                return None;
            }
            self.phase = AutoHidePhase::Shown;
            return Some(AutoHideEffect::Reveal);
        }
        match self.phase {
            AutoHidePhase::Shown => {
                // Resting on the edge counts as "near": no hide/reveal ping-pong there.
                if !s.away || s.at_edge {
                    self.away_since = None;
                    return None;
                }
                let since = *self.away_since.get_or_insert(now);
                if now.duration_since(since) < AUTO_HIDE_GRACE {
                    return None;
                }
                self.away_since = None;
                self.phase = AutoHidePhase::Leaving(now);
                Some(AutoHideEffect::StartHide)
            }
            AutoHidePhase::Leaving(_) | AutoHidePhase::Hidden if s.at_edge => {
                self.phase = AutoHidePhase::Shown;
                Some(AutoHideEffect::Reveal)
            }
            AutoHidePhase::Leaving(since) if now.duration_since(since) >= SLIDE_OUT => {
                self.phase = AutoHidePhase::Hidden;
                Some(AutoHideEffect::FinishHide)
            }
            _ => None,
        }
    }
}

/// Horizontal span the dock window would cover on `monitor` (centered, `MAX_WIDTH_RATIO`).
pub fn dock_span_on(monitor: RECT) -> (i32, i32) {
    let width = monitor.right - monitor.left;
    let inset = ((width as f64 * (1.0 - MAX_WIDTH_RATIO)) / 2.0).round() as i32;
    (monitor.left + inset, monitor.right - inset)
}

/// Monitor under the cursor: bounds and device name (`\.\DISPLAY2`, as Tauri names monitors).
fn monitor_at(cursor: POINT) -> Option<(RECT, String)> {
    unsafe {
        let monitor = MonitorFromPoint(cursor, MONITOR_DEFAULTTONULL);
        if monitor.is_invalid() {
            return None;
        }
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if !GetMonitorInfoW(monitor, &mut info.monitorInfo).as_bool() {
            return None;
        }
        let len = info.szDevice.iter().position(|&c| c == 0).unwrap_or(info.szDevice.len());
        Some((info.monitorInfo.rcMonitor, from_wide(&info.szDevice[..len])))
    }
}

/// Read the cursor, the dock's rects and holds for one auto-hide step. The second value names
/// another monitor whose docked edge the cursor touches: the dock moves there.
fn sample_auto_hide(app: &AppHandle, dock_hwnd: HWND, edge: DockEdge) -> Option<(AutoHideSample, Option<String>)> {
    let mut cursor = POINT::default();
    unsafe { GetCursorPos(&mut cursor) }.ok()?;
    let monitor = monitor_rect_of(dock_hwnd)?;
    let window = hwnd_rect(dock_hwnd.0 as isize)?;
    let (rects, held) = dock_hit_state();
    let scale = unsafe { GetDpiForWindow(dock_hwnd) }.max(96) as f64 / 96.0;
    let margin = (AUTO_HIDE_MARGIN * scale).round() as i32;
    let modal_open = app.get_webview_window("settings").is_some() || app.get_webview_window("picker").is_some();
    let mut at_edge = at_reveal_edge(cursor, monitor, (window.left, window.right), edge);
    let mut move_to = None;
    if !at_edge {
        if let Some((other, name)) = monitor_at(cursor).filter(|(r, _)| *r != monitor) {
            if at_reveal_edge(cursor, other, dock_span_on(other), edge) {
                at_edge = true;
                move_to = Some(name);
            }
        }
    }
    let sample = AutoHideSample { away: !rects.is_empty() && !near_any(cursor, &rects, margin), at_edge, hold: held || modal_open };
    Some((sample, move_to))
}

/// Put the dock on another monitor (same edge) and remember it, like a drag-snap does.
fn move_dock_to(app: &AppHandle, monitor_name: String) {
    {
        let state = app.state::<AppState>();
        let mut settings = state.settings.write();
        settings.monitor = Some(monitor_name);
        let _ = settings.save(&state.db);
    }
    relayout_and_broadcast(app);
}

/// Tell the webviews whether to slide away. Global events: the JS `listen()` used by DataHub does
/// not receive `emit_to` events. Only the dock applies `dock:autohide`; toasts keep showing.
fn emit_hidden(app: &AppHandle, fullscreen: bool, auto_hidden: bool) {
    let _ = app.emit("dock:autohide", auto_hidden);
    let _ = app.emit("dock:fullscreen", fullscreen);
}

fn show_overlays(dock: &WebviewWindow, toast: Option<&WebviewWindow>) {
    show_no_activate(dock);
    if let Some(t) = toast {
        show_no_activate(t);
    }
}

/// Fullscreen watcher: event-driven foreground rule (+150 ms fallback poll), hidden-taskbar
/// enforcement and display-change relayout.
pub fn start_fullscreen_watch(app: AppHandle) {
    std::thread::Builder::new()
        .name("winglass-fullscreen".into())
        .spawn(move || {
            let mut hidden = false;
            let mut last_monitor: Option<(i32, i32, u32, u32, u64)> = None;
            let mut cached_hwnd: isize = 0;
            let mut last_housekeeping = Instant::now() - HOUSEKEEPING_EVERY;
            let mut last_broadcast = Instant::now();
            let mut auto = AutoHide::default();
            let mut fullscreen = false;
            let mut last_fullscreen_check = Instant::now() - FULLSCREEN_POLL;
            loop {
                let auto_on = app.state::<AppState>().settings.read().auto_hide_dock;
                let foreground_changed = wait_foreground_change(if auto_on { AUTO_HIDE_POLL } else { FULLSCREEN_POLL });

                let Some(dock) = app.get_webview_window("dock") else { continue };
                if cached_hwnd == 0 {
                    match dock.hwnd() {
                        Ok(raw) => cached_hwnd = raw.0 as isize,
                        Err(_) => continue,
                    }
                }
                let dock_hwnd = HWND(cached_hwnd as *mut core::ffi::c_void);

                if last_housekeeping.elapsed() >= HOUSEKEEPING_EVERY {
                    last_housekeeping = Instant::now();
                    taskbar::enforce_hidden();
                    graphics::dxgi_capture::verify_affinity();
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
                }
                if last_broadcast.elapsed() >= Duration::from_secs(5) {
                    // Periodic re-broadcast so a reloaded webview resyncs its slide state.
                    last_broadcast = Instant::now();
                    emit_hidden(&app, hidden, auto.is_hidden());
                }

                let (enabled, auto_on, edge) = {
                    let s = app.state::<AppState>();
                    let s = s.settings.read();
                    (s.hide_on_fullscreen, s.auto_hide_dock, DockEdge::parse(&s.position))
                };
                // The fullscreen rule keeps its own cadence even while auto-hide polls at 35 ms.
                if foreground_changed || last_fullscreen_check.elapsed() >= FULLSCREEN_POLL {
                    last_fullscreen_check = Instant::now();
                    fullscreen = enabled && fullscreen_in_front(dock_hwnd);
                }
                let toast = app.get_webview_window("toast");

                if fullscreen == hidden {
                    if !hidden {
                        // Auto-hide only runs while no fullscreen app already has the dock hidden.
                        let sample = if auto_on { sample_auto_hide(&app, dock_hwnd, edge) } else { Some((AutoHideSample::default(), None)) };
                        let sample = sample.map(|(s, move_to)| {
                            if let Some(name) = move_to {
                                // Second screen: the dock follows the cursor to the edge it touches.
                                move_dock_to(&app, name);
                            }
                            s
                        });
                        match sample.and_then(|s| auto.step(auto_on, s, Instant::now())) {
                            Some(AutoHideEffect::StartHide) => emit_hidden(&app, false, true),
                            Some(AutoHideEffect::FinishHide) => {
                                // The window stays shown but empty: no hit rect is registered, so it is
                                // fully click-through, and nothing is captured. Not SW_HIDE: WebView2
                                // needs a moment to present again after it, which swallowed the slide-in.
                                graphics::set_paused(true);
                            }
                            Some(AutoHideEffect::Reveal) => {
                                show_no_activate(&dock);
                                graphics::set_paused(false);
                                emit_hidden(&app, false, false);
                            }
                            None => {}
                        }
                        if foreground_changed {
                            // The app that just lost the foreground may have been topmost: keep the
                            // overlays above whatever took over (raw Win32, never activates).
                            show_overlays(&dock, toast.as_ref());
                        }
                    }
                    continue;
                }

                if fullscreen {
                    emit_hidden(&app, true, auto.is_hidden());
                    // Let the slide-out finish, but abort if the foreground moves on meanwhile
                    // (Alt+Tab straight out of the game): hiding follows the current foreground only.
                    let interrupted = wait_foreground_change(SLIDE_OUT);
                    if interrupted && !(enabled && fullscreen_in_front(dock_hwnd)) {
                        fullscreen = false;
                        emit_hidden(&app, false, auto.is_hidden());
                        continue;
                    }
                    hidden = true;
                    // Nothing is composited while the dock is hidden: stop the desktop capture.
                    graphics::set_paused(true);
                    // Truly hide so the topmost transparent windows never interfere with
                    // exclusive fullscreen.
                    hide_overlay(&dock);
                    if let Some(t) = &toast {
                        hide_overlay(t);
                    }
                } else {
                    hidden = false;
                    // An auto-hidden dock stays tucked away; the fullscreen hide finished its slide.
                    auto.settle();
                    // Instant wake: Alt+Tab, Win key, desktop, any windowed app. An auto-hidden dock
                    // comes back slid out (invisible, click-through) with the capture still paused.
                    show_overlays(&dock, toast.as_ref());
                    if !auto.is_hidden() {
                        graphics::set_paused(false);
                    }
                    emit_hidden(&app, false, auto.is_hidden());
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
        assert_eq!(modal_spec("settings", Lang::En).map(|s| (s.0, s.1)), Some((1000.0, 680.0)));
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

    const MON: RECT = RECT { left: 0, top: 0, right: 1920, bottom: 1080 };
    const MON2: RECT = RECT { left: 1920, top: 0, right: 4480, bottom: 1440 };

    fn fg(class: &str, rect: RECT) -> ForegroundInfo {
        ForegroundInfo { class: class.into(), own_process: false, zoomed: false, has_caption: false, rect, monitor: MON }
    }

    #[test]
    fn borderless_fullscreen_game_in_front_hides_the_dock() {
        let game = fg("UnrealWindow", MON);
        assert!(should_hide_for(Some(&game), MON, false));
        assert!(should_hide_for(Some(&game), MON, true));
        // Exclusive fullscreen that kept a caption style still counts when D3D says so.
        let captioned = ForegroundInfo { has_caption: true, ..fg("RiotWindowClass", MON) };
        assert!(should_hide_for(Some(&captioned), MON, true));
        assert!(!should_hide_for(Some(&captioned), MON, false));
    }

    #[test]
    fn alt_tab_out_of_a_game_wakes_the_dock_immediately() {
        // The game is still running (and D3D fullscreen may still be reported), but the foreground
        // is now the task switcher / desktop / a normal app: the dock must be shown.
        for class in SHELL_CLASSES {
            assert!(!should_hide_for(Some(&fg(class, MON)), MON, true), "{class} must not hide the dock");
        }
        let browser = ForegroundInfo { has_caption: true, ..fg("Chrome_WidgetWin_1", RECT { left: 100, top: 100, right: 1500, bottom: 900 }) };
        assert!(!should_hide_for(Some(&browser), MON, true));
        let discord = fg("Chrome_WidgetWin_1", RECT { left: 0, top: 0, right: 1200, bottom: 800 });
        assert!(!should_hide_for(Some(&discord), MON, true));
        assert!(!should_hide_for(None, MON, true));
    }

    #[test]
    fn maximized_windows_winglass_and_other_monitors_never_hide_the_dock() {
        let maximized = ForegroundInfo { zoomed: true, has_caption: true, ..fg("ConsoleWindowClass", MON) };
        assert!(!should_hide_for(Some(&maximized), MON, false));
        // Regression: a game left running keeps QUNS at D3D-fullscreen; a maximized window in
        // front must still show the dock.
        assert!(!should_hide_for(Some(&maximized), MON, true));
        let own = ForegroundInfo { own_process: true, ..fg("Tauri Window", MON) };
        assert!(!should_hide_for(Some(&own), MON, true));
        let elsewhere = ForegroundInfo { monitor: MON2, ..fg("UnrealWindow", MON2) };
        assert!(!should_hide_for(Some(&elsewhere), MON, true));
    }

    /// Real Win32 inspection path: a borderless popup covering the monitor is detected as
    /// fullscreen, a captioned window of the same size is not. The windows are never shown.
    #[test]
    fn win32_window_inspection_feeds_the_rule() {
        use windows::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN, WINDOW_EX_STYLE, WS_OVERLAPPEDWINDOW, WS_POPUP,
        };
        use windows::core::w;
        unsafe {
            let (w_, h_) = (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN));
            let make = |style| {
                CreateWindowExW(WINDOW_EX_STYLE(0), w!("STATIC"), w!("winglass-test"), style, 0, 0, w_, h_, None, None, None, None)
                    .expect("create test window")
            };
            let popup = make(WS_POPUP);
            let framed = make(WS_OVERLAPPEDWINDOW);
            let p = foreground_info(popup).expect("popup info");
            let f = foreground_info(framed).expect("framed info");
            // Our own test process owns them: the own-process guard must reject both as-is…
            assert!(p.own_process && !should_hide_for(Some(&p), p.monitor, true));
            // …and with the guard lifted (as if another process) only the borderless one hides.
            let foreign_popup = ForegroundInfo { own_process: false, ..p.clone() };
            let foreign_framed = ForegroundInfo { own_process: false, ..f.clone() };
            assert!(should_hide_for(Some(&foreign_popup), p.monitor, false));
            assert!(!should_hide_for(Some(&foreign_framed), f.monitor, false));
            let _ = DestroyWindow(popup);
            let _ = DestroyWindow(framed);
        }
    }

    #[test]
    fn foreground_wake_is_consumed_once() {
        notify_foreground_changed();
        assert!(wait_foreground_change(Duration::from_millis(10)));
        assert!(!wait_foreground_change(Duration::from_millis(10)));
    }

    const PILL: RECT = RECT { left: 700, top: 1012, right: 1220, bottom: 1070 };
    const SPAN: (i32, i32) = (38, 1881);

    fn pt(x: i32, y: i32) -> POINT {
        POINT { x, y }
    }

    #[test]
    fn other_monitors_reveal_within_their_own_centered_span() {
        // Second screen to the left of the main one, 1920 wide.
        let left = RECT { left: -1920, top: 120, right: 0, bottom: 1200 };
        let span = dock_span_on(left);
        assert_eq!(span, (-1882, -38));
        assert!(at_reveal_edge(pt(-960, 1199), left, span, DockEdge::Bottom));
        assert!(at_reveal_edge(pt(-960, 120), left, span, DockEdge::Top));
        assert!(!at_reveal_edge(pt(-960, 1195), left, span, DockEdge::Bottom));
        assert!(!at_reveal_edge(pt(-1910, 1199), left, span, DockEdge::Bottom));
        assert_eq!(dock_span_on(MON), (38, 1882));
    }

    #[test]
    fn auto_hide_hysteresis_is_24px_around_the_dock() {
        assert!(near_any(pt(800, 1040), &[PILL], 24));
        assert!(near_any(pt(700 - 24, 1040), &[PILL], 24));
        assert!(near_any(pt(900, 1012 - 24), &[PILL], 24));
        assert!(!near_any(pt(700 - 25, 1040), &[PILL], 24));
        assert!(!near_any(pt(900, 1012 - 25), &[PILL], 24));
        // An open flyout's rect extends the "near" area.
        let flyout = RECT { left: 760, top: 600, right: 1100, bottom: 1000 };
        assert!(near_any(pt(900, 620), &[PILL, flyout], 24));
        assert!(!near_any(pt(900, 620), &[PILL], 24));
    }

    #[test]
    fn reveal_only_within_3px_of_the_docked_edge() {
        // Bottom: last pixel row is 1079.
        for y in 1076..=1079 {
            assert!(at_reveal_edge(pt(900, y), MON, SPAN, DockEdge::Bottom), "y={y}");
        }
        assert!(!at_reveal_edge(pt(900, 1075), MON, SPAN, DockEdge::Bottom));
        assert!(!at_reveal_edge(pt(900, 1079), MON, SPAN, DockEdge::Top));
        // Top.
        for y in 0..=3 {
            assert!(at_reveal_edge(pt(900, y), MON, SPAN, DockEdge::Top), "y={y}");
        }
        assert!(!at_reveal_edge(pt(900, 4), MON, SPAN, DockEdge::Top));
        // Outside the dock's horizontal span or on another monitor below.
        assert!(!at_reveal_edge(pt(10, 1079), MON, SPAN, DockEdge::Bottom));
        assert!(!at_reveal_edge(pt(1900, 1079), MON, SPAN, DockEdge::Bottom));
        assert!(!at_reveal_edge(pt(900, 1080), MON, SPAN, DockEdge::Bottom));
    }

    fn away() -> AutoHideSample {
        AutoHideSample { away: true, ..Default::default() }
    }

    #[test]
    fn auto_hide_waits_for_the_grace_delay_then_slides_out() {
        let t0 = Instant::now();
        let mut a = AutoHide::default();
        assert_eq!(a.step(true, away(), t0), None);
        assert_eq!(a.step(true, away(), t0 + Duration::from_millis(399)), None);
        // Coming back resets the grace timer.
        assert_eq!(a.step(true, AutoHideSample::default(), t0 + Duration::from_millis(420)), None);
        assert_eq!(a.step(true, away(), t0 + Duration::from_millis(500)), None);
        assert_eq!(a.step(true, away(), t0 + Duration::from_millis(899)), None);
        let t1 = t0 + Duration::from_millis(900);
        assert_eq!(a.step(true, away(), t1), Some(AutoHideEffect::StartHide));
        assert!(a.is_hidden());
        assert_eq!(a.step(true, away(), t1 + Duration::from_millis(100)), None);
        assert_eq!(a.step(true, away(), t1 + SLIDE_OUT), Some(AutoHideEffect::FinishHide));
        assert_eq!(a.step(true, away(), t1 + SLIDE_OUT * 3), None);
    }

    #[test]
    fn auto_hide_reveals_only_at_the_edge() {
        let t0 = Instant::now();
        let mut a = AutoHide::default();
        a.step(true, away(), t0);
        a.step(true, away(), t0 + AUTO_HIDE_GRACE);
        a.step(true, away(), t0 + AUTO_HIDE_GRACE + SLIDE_OUT);
        // Hovering where the pill used to be (no rects while hidden -> not "away") does nothing.
        assert_eq!(a.step(true, AutoHideSample::default(), t0 + Duration::from_secs(2)), None);
        assert!(a.is_hidden());
        let edge = AutoHideSample { at_edge: true, away: true, hold: false };
        assert_eq!(a.step(true, edge, t0 + Duration::from_secs(3)), Some(AutoHideEffect::Reveal));
        assert!(!a.is_hidden());
        // Resting on the edge away from the pill never re-hides (no ping-pong).
        assert_eq!(a.step(true, edge, t0 + Duration::from_secs(10)), None);
        // Touching the edge mid-slide also brings it back.
        let mut b = AutoHide::default();
        b.step(true, away(), t0);
        assert_eq!(b.step(true, away(), t0 + AUTO_HIDE_GRACE), Some(AutoHideEffect::StartHide));
        assert_eq!(b.step(true, edge, t0 + AUTO_HIDE_GRACE + Duration::from_millis(50)), Some(AutoHideEffect::Reveal));
    }

    #[test]
    fn open_flyouts_and_modals_lock_the_dock_open() {
        let t0 = Instant::now();
        let held = AutoHideSample { away: true, hold: true, at_edge: false };
        let mut a = AutoHide::default();
        for ms in [0, 400, 5000] {
            assert_eq!(a.step(true, held, t0 + Duration::from_millis(ms)), None);
        }
        assert!(!a.is_hidden());
        // Releasing the hold starts a fresh grace period.
        let t1 = t0 + Duration::from_secs(6);
        assert_eq!(a.step(true, away(), t1), None);
        assert_eq!(a.step(true, away(), t1 + AUTO_HIDE_GRACE), Some(AutoHideEffect::StartHide));
        // A hold that appears while hidden (Settings opened from the tray) reveals it.
        assert_eq!(a.step(true, held, t1 + Duration::from_secs(1)), Some(AutoHideEffect::Reveal));
    }

    #[test]
    fn turning_auto_hide_off_restores_the_dock_immediately() {
        let t0 = Instant::now();
        let mut a = AutoHide::default();
        a.step(true, away(), t0);
        a.step(true, away(), t0 + AUTO_HIDE_GRACE);
        assert_eq!(a.step(false, away(), t0 + Duration::from_secs(1)), Some(AutoHideEffect::Reveal));
        for s in 2..5 {
            assert_eq!(a.step(false, away(), t0 + Duration::from_secs(s)), None);
        }
        assert!(!a.is_hidden());
        // A fullscreen hide that interrupts the slide leaves it hidden, not half-way.
        let mut b = AutoHide::default();
        b.step(true, away(), t0);
        b.step(true, away(), t0 + AUTO_HIDE_GRACE);
        b.settle();
        assert_eq!(b.step(true, away(), t0 + Duration::from_secs(5)), None);
        assert!(b.is_hidden());
    }

    #[test]
    fn dock_edge_round_trips() {
        assert_eq!(DockEdge::parse("top"), DockEdge::Top);
        assert_eq!(DockEdge::parse("bottom"), DockEdge::Bottom);
        assert_eq!(DockEdge::parse("sideways"), DockEdge::Bottom);
        assert_eq!(DockEdge::Top.as_str(), "top");
    }
}
