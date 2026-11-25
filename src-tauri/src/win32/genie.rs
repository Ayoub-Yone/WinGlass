//! macOS-style "genie" minimize / restore for dock clicks. The app's window is drawn as horizontal
//! DWM thumbnail strips (composited by DWM on the GPU: no pixel copy, live content) in a short-lived,
//! click-through, top-most overlay, each strip pinched toward the dock icon frame by frame. Windows'
//! own minimize / restore animation is turned off for that window meanwhile
//! (`DWMWA_TRANSITIONS_FORCEDISABLED`, restored afterwards). Geometry is pure (`strips`, tested).

use std::collections::HashSet;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::{
    DWM_THUMBNAIL_PROPERTIES, DWM_TNP_OPACITY, DWM_TNP_RECTDESTINATION, DWM_TNP_RECTSOURCE, DWM_TNP_SOURCECLIENTAREAONLY,
    DWM_TNP_VISIBLE, DWMWA_EXTENDED_FRAME_BOUNDS, DWMWA_TRANSITIONS_FORCEDISABLED, DwmFlush, DwmGetWindowAttribute,
    DwmRegisterThumbnail, DwmSetWindowAttribute, DwmUnregisterThumbnail, DwmUpdateThumbnailProperties,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetWindowPlacement, GetWindowRect, HTTRANSPARENT,
    IsIconic, MSG, PM_REMOVE, PeekMessageW, RegisterClassW, SW_MINIMIZE, SW_RESTORE, SW_SHOWNOACTIVATE, ShowWindow,
    TranslateMessage, WINDOWPLACEMENT, WM_NCHITTEST, WNDCLASSW, WPF_RESTORETOMAXIMIZED, WS_EX_NOACTIVATE,
    WS_EX_NOREDIRECTIONBITMAP, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_POPUP,
};
use windows::core::{BOOL, w};

const MINIMIZE_MS: u64 = 520;
const RESTORE_MS: u64 = 460;
/// Freeze frame after a restore: held while the app presents its first frames, then faded out.
const HOLD: Duration = Duration::from_millis(100);
const FADE: Duration = Duration::from_millis(120);

/// Screen rectangle in physical pixels, as floats for the animation maths.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rf {
    pub l: f32,
    pub t: f32,
    pub r: f32,
    pub b: f32,
}

impl Rf {
    fn from_rect(r: RECT) -> Self {
        Rf { l: r.left as f32, t: r.top as f32, r: r.right as f32, b: r.bottom as f32 }
    }
    fn flip(self) -> Self {
        Rf { l: self.l, t: -self.b, r: self.r, b: -self.t }
    }
}

/// One strip: the source band `[v0, v1]` (fractions of the window height, top = 0) and where it goes.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Strip {
    pub v0: f32,
    pub v1: f32,
    pub dst: Rf,
}

fn clamp01(x: f32) -> f32 {
    x.clamp(0.0, 1.0)
}
fn smooth(x: f32) -> f32 {
    let x = clamp01(x);
    x * x * (3.0 - 2.0 * x)
}
fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

/// Genie shape at progress `p` (0 = the window as it is, 1 = inside the icon). The sides bend into a
/// funnel first, the edge nearest the dock leads, the far edge follows into the icon.
pub fn strips(win: Rf, icon: Rf, p: f32, n: usize) -> Vec<Strip> {
    // Solve with the icon below the window; a dock on top is the mirror image.
    let flipped = (icon.t + icon.b) < (win.t + win.b);
    let (w, i) = if flipped { (win.flip(), icon.flip()) } else { (win, icon) };
    let bend = smooth(p / 0.55);
    let near = lerp(w.b, i.b, smooth((p - 0.08) / 0.72));
    let far = lerp(w.t, i.t, smooth((p - 0.25) / 0.75));
    let span = (i.t - w.t).max(1.0);
    (0..n)
        .map(|k| {
            let (a, b) = (k as f32 / n as f32, (k + 1) as f32 / n as f32);
            let (y0, y1) = (lerp(far, near, a), lerp(far, near, b));
            let u = smooth((0.5 * (y0 + y1) - w.t) / span);
            let pinch = bend * u.max(smooth(p)); // at p = 1 every strip is icon-wide
            let dst = Rf { l: lerp(w.l, i.l, pinch), t: y0, r: lerp(w.r, i.r, pinch), b: y1 };
            if flipped { Strip { v0: 1.0 - b, v1: 1.0 - a, dst: dst.flip() } } else { Strip { v0: a, v1: b, dst } }
        })
        .collect()
}

/// Fade into the icon over the last fifth so the hand-off to the dock icon is seamless.
fn opacity(p: f32) -> u8 {
    (255.0 * (1.0 - smooth((p - 0.8) / 0.2))).round() as u8
}

static BUSY: Lazy<Mutex<HashSet<isize>>> = Lazy::new(|| Mutex::new(HashSet::new()));

/// Minimize `hwnd` into `icon` (screen px). Returns at once; the animation runs on its own thread.
pub fn minimize(hwnd: HWND, icon: RECT) {
    let Some(win) = visible_bounds(hwnd) else {
        return minimize_window(hwnd);
    };
    spawn(hwnd, move |h| {
        // Refused for an elevated window (Task Manager); Windows shows no animation of its own for
        // those here (it would aim at the hidden taskbar), so the genie plays either way.
        set_transitions(h, false);
        let Some(overlay) = Overlay::new(h, win, Rf::from_rect(icon)) else {
            minimize_window(h);
            set_transitions(h, true);
            return;
        };
        overlay.frame(0.0);
        overlay.show();
        minimize_window(h);
        // An elevated window gets a posted command: it minimizes a few ms later.
        if wait_iconic(h) {
            overlay.run(MINIMIZE_MS, false);
        }
        set_transitions(h, true);
    });
}

/// Waits up to 500 ms for `hwnd` to be minimized. False on timeout.
fn wait_iconic(hwnd: HWND) -> bool {
    let deadline = Instant::now() + Duration::from_millis(500);
    while unsafe { !IsIconic(hwnd).as_bool() } {
        if Instant::now() > deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    true
}

/// Minimize any window. `ShowWindow` is access-denied on an elevated window (Task Manager), but its
/// own system command still goes through (WM_SYSCOMMAND passes the UIPI filter).
pub fn minimize_window(hwnd: HWND) {
    use windows::Win32::UI::WindowsAndMessaging::{PostMessageW, SC_MINIMIZE, WM_SYSCOMMAND};
    unsafe {
        let _ = ShowWindow(hwnd, SW_MINIMIZE);
        if !IsIconic(hwnd).as_bool() {
            let _ = PostMessageW(Some(hwnd), WM_SYSCOMMAND, WPARAM(SC_MINIMIZE as usize), LPARAM(0));
        }
    }
}

/// Restore any window. On an elevated window `ShowWindow` is access-denied; `SwitchToThisWindow`
/// (the Alt+Tab path) is allowed and restores it.
pub fn restore_window(hwnd: HWND) {
    use windows::Win32::UI::WindowsAndMessaging::SwitchToThisWindow;
    unsafe {
        let _ = ShowWindow(hwnd, SW_RESTORE);
        if IsIconic(hwnd).as_bool() {
            SwitchToThisWindow(hwnd, true);
        }
    }
}

/// Restore `hwnd` out of `icon`, then focus it with `focus`.
pub fn restore(hwnd: HWND, icon: RECT, focus: fn(HWND)) {
    let Some(win) = restored_bounds(hwnd) else {
        restore_window(hwnd);
        return focus(hwnd);
    };
    spawn(hwnd, move |h| {
        set_transitions(h, false); // refused for elevated windows, which Windows does not animate here
        let Some(overlay) = Overlay::new(h, win, Rf::from_rect(icon)) else {
            restore_window(h);
            focus(h);
            set_transitions(h, true);
            return;
        };
        overlay.frame(1.0);
        overlay.show();
        overlay.run(RESTORE_MS, true);
        // Hand-off. The strips are live: once restored, many apps (Chromium, UWP, flip-model) present
        // nothing for a few frames, and the strips would go empty with them (the "gap"). So the
        // landed frame is frozen into a still picture, the window is restored under it, and the
        // picture fades out once the app has had time to present.
        let freeze = Freeze::capture(&win);
        drop(overlay);
        restore_window(h);
        focus(h);
        if let Some(freeze) = freeze {
            freeze.hold_and_fade(HOLD, FADE);
        }
        set_transitions(h, true);
    });
}

fn spawn(hwnd: HWND, job: impl FnOnce(HWND) + Send + 'static) {
    let key = hwnd.0 as isize;
    if !BUSY.lock().insert(key) {
        return; // a genie for this window is already running: a double click is ignored
    }
    let run = move || {
        // Frames must not wait behind the dock's own work (app list refresh, glass redraw).
        unsafe {
            use windows::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_HIGHEST};
            let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_HIGHEST);
        }
        job(HWND(key as *mut core::ffi::c_void));
        BUSY.lock().remove(&key);
    };
    if std::thread::Builder::new().name("winglass-genie".into()).spawn(run).is_err() {
        BUSY.lock().remove(&key);
    }
}

/// Turns Windows' own minimize / restore transition off (`false`) or back on for `hwnd`. Never
/// sleeps: it is re-enabled once the genie has finished, so the animation thread never stalls.
/// False when Windows refuses (an elevated window, from this non-elevated process).
fn set_transitions(hwnd: HWND, enabled: bool) -> bool {
    let v = BOOL::from(!enabled);
    unsafe { DwmSetWindowAttribute(hwnd, DWMWA_TRANSITIONS_FORCEDISABLED, &v as *const BOOL as _, size_of::<BOOL>() as u32) }.is_ok()
}

/// Visible frame (no invisible resize borders) of a shown window.
fn visible_bounds(hwnd: HWND) -> Option<Rf> {
    let mut r = RECT::default();
    unsafe {
        if IsIconic(hwnd).as_bool() {
            return None;
        }
        DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &mut r as *mut RECT as _, size_of::<RECT>() as u32).ok()?;
    }
    sane(Rf::from_rect(r))
}

/// Where a minimized window comes back: its restore rectangle, or its monitor's work area if it was maximized.
fn restored_bounds(hwnd: HWND) -> Option<Rf> {
    use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromRect};
    let mut wp = WINDOWPLACEMENT { length: size_of::<WINDOWPLACEMENT>() as u32, ..Default::default() };
    unsafe {
        GetWindowPlacement(hwnd, &mut wp).ok()?;
        let normal = wp.rcNormalPosition; // workspace coordinates
        let mon = MonitorFromRect(&normal, MONITOR_DEFAULTTONEAREST);
        let mut mi = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
        if !GetMonitorInfoW(mon, &mut mi).as_bool() {
            return None;
        }
        if wp.flags.0 & WPF_RESTORETOMAXIMIZED.0 != 0 {
            return sane(Rf::from_rect(mi.rcWork));
        }
        let (dx, dy) = ((mi.rcWork.left - mi.rcMonitor.left) as f32, (mi.rcWork.top - mi.rcMonitor.top) as f32);
        let r = Rf::from_rect(normal);
        // ≈7 px invisible resize border each side (left, right, bottom) on Windows 10/11.
        sane(Rf { l: r.l + dx + 7.0, t: r.t + dy, r: r.r + dx - 7.0, b: r.b + dy - 7.0 })
    }
}

fn sane(r: Rf) -> Option<Rf> {
    (r.r - r.l >= 40.0 && r.b - r.t >= 40.0 && r.r - r.l < 20_000.0 && r.b - r.t < 20_000.0).then_some(r)
}

unsafe extern "system" fn overlay_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if msg == WM_NCHITTEST {
        return LRESULT(HTTRANSPARENT as isize);
    }
    unsafe { DefWindowProcW(hwnd, msg, wp, lp) }
}

struct Overlay {
    hwnd: HWND,
    thumbs: Vec<isize>,
    origin: (f32, f32),
    win: Rf,
    icon: Rf,
    /// Source size in thumbnail coordinates (the source window's rect, borders included).
    src_frame: (f32, f32, f32, f32),
}

/// Visible frame of a shown window inside its thumbnail source (the window rect, invisible borders
/// included): (x, y, w, h). None while minimized, where that rect is meaningless.
fn source_frame(source: HWND) -> Option<(f32, f32, f32, f32)> {
    let mut wr = RECT::default();
    let mut fr = RECT::default();
    unsafe {
        if IsIconic(source).as_bool() {
            return None;
        }
        GetWindowRect(source, &mut wr).ok()?;
        DwmGetWindowAttribute(source, DWMWA_EXTENDED_FRAME_BOUNDS, &mut fr as *mut RECT as _, size_of::<RECT>() as u32).ok()?;
    }
    Some(((fr.left - wr.left) as f32, (fr.top - wr.top) as f32, (fr.right - fr.left) as f32, (fr.bottom - fr.top) as f32))
}

impl Overlay {
    fn new(source: HWND, win: Rf, icon: Rf) -> Option<Self> {
        static CLASS: Lazy<bool> = Lazy::new(|| unsafe {
            let instance = GetModuleHandleW(None).unwrap_or_default();
            RegisterClassW(&WNDCLASSW { lpfnWndProc: Some(overlay_proc), hInstance: instance.into(), lpszClassName: w!("WinGlassGenie"), ..Default::default() }) != 0
        });
        if !*CLASS {
            return None;
        }
        let (l, t) = (win.l.min(icon.l).floor(), win.t.min(icon.t).floor());
        let (r, b) = (win.r.max(icon.r).ceil(), win.b.max(icon.b).ceil());
        let frame = source_frame(source).unwrap_or((7.0, 0.0, win.r - win.l, win.b - win.t));
        unsafe {
            let instance = GetModuleHandleW(None).ok()?;
            let hwnd = CreateWindowExW(
                WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TRANSPARENT | WS_EX_NOREDIRECTIONBITMAP,
                w!("WinGlassGenie"),
                w!(""),
                WS_POPUP,
                l as i32,
                t as i32,
                (r - l) as i32,
                (b - t) as i32,
                None,
                None,
                Some(instance.into()),
                None,
            )
            .ok()?;
            // Each strip costs one DWM call per frame (~42 µs measured): 40 strips stay under ~1.7 ms, so
            // a 240 Hz screen gets a new frame every 1–2 refreshes (96 strips took 4 ms: every 3rd).
            let n = (((win.b - win.t) / 20.0) as usize).clamp(24, 40);
            let mut thumbs = Vec::with_capacity(n);
            for _ in 0..n {
                match DwmRegisterThumbnail(hwnd, source) {
                    Ok(id) => thumbs.push(id),
                    Err(_) => {
                        thumbs.into_iter().for_each(|id| { let _ = DwmUnregisterThumbnail(id); });
                        let _ = DestroyWindow(hwnd);
                        return None;
                    }
                }
            }
            Some(Overlay { hwnd, thumbs, origin: (l, t), win, icon, src_frame: frame })
        }
    }

    fn show(&self) {
        unsafe {
            let _ = ShowWindow(self.hwnd, SW_SHOWNOACTIVATE);
            let _ = DwmFlush();
        }
    }

    fn frame(&self, p: f32) {
        let (fx, fy, fw, fh) = self.src_frame;
        let (ox, oy) = self.origin;
        let alpha = opacity(p);
        for (s, &id) in strips(self.win, self.icon, p, self.thumbs.len()).iter().zip(&self.thumbs) {
            let props = DWM_THUMBNAIL_PROPERTIES {
                dwFlags: DWM_TNP_RECTDESTINATION | DWM_TNP_RECTSOURCE | DWM_TNP_OPACITY | DWM_TNP_VISIBLE | DWM_TNP_SOURCECLIENTAREAONLY,
                rcDestination: RECT {
                    left: (s.dst.l - ox).round() as i32,
                    top: (s.dst.t - oy).round() as i32,
                    right: (s.dst.r - ox).round() as i32,
                    bottom: (s.dst.b - oy).round() as i32,
                },
                rcSource: RECT {
                    left: fx as i32,
                    top: (fy + s.v0 * fh).round() as i32,
                    right: (fx + fw) as i32,
                    bottom: (fy + s.v1 * fh).round() as i32,
                },
                opacity: alpha,
                fVisible: BOOL::from(s.dst.b - s.dst.t >= 0.5),
                fSourceClientAreaOnly: BOOL::from(false),
            };
            unsafe {
                let _ = DwmUpdateThumbnailProperties(id, &props);
            }
        }
    }

    /// Runs the animation to its end, vsynced on DWM (`reverse`: icon -> window).
    fn run(&self, ms: u64, reverse: bool) {
        let start = Instant::now();
        let total = Duration::from_millis(ms);
        let mut last_cost = Duration::from_millis(2);
        loop {
            // Sample the animation at the vblank this frame will actually be shown on: the first one
            // after the updates are sent (last frame's cost + margin), not the moment the loop woke
            // up — that drifts by a few ms per frame and reads as micro-stutter.
            let lead = last_cost + Duration::from_micros(500);
            let shown_at = next_vblank(lead).map_or_else(|| start.elapsed(), |at| at.saturating_duration_since(start));
            let k = (shown_at.as_secs_f32() / total.as_secs_f32()).min(1.0);
            let t = Instant::now();
            self.frame(if reverse { 1.0 - k } else { k });
            last_cost = t.elapsed();
            unsafe {
                let mut msg = MSG::default();
                while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
                if DwmFlush().is_err() {
                    std::thread::sleep(Duration::from_millis(16));
                }
            }
            if k >= 1.0 {
                break;
            }
        }
    }
}

fn timing() -> Option<windows::Win32::Graphics::Dwm::DWM_TIMING_INFO> {
    use windows::Win32::Graphics::Dwm::{DWM_TIMING_INFO, DwmGetCompositionTimingInfo};
    let mut info = DWM_TIMING_INFO { cbSize: size_of::<DWM_TIMING_INFO>() as u32, ..Default::default() };
    unsafe { DwmGetCompositionTimingInfo(HWND::default(), &mut info) }.ok().map(|_| info)
}

/// The first vblank at least `lead` from now, as an `Instant` (DWM reports QPC ticks).
fn next_vblank(lead: Duration) -> Option<Instant> {
    use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
    let info = timing()?;
    let (mut now, mut freq) = (0i64, 0i64);
    unsafe {
        QueryPerformanceCounter(&mut now).ok()?;
        QueryPerformanceFrequency(&mut freq).ok()?;
    }
    let period = info.qpcRefreshPeriod as i64;
    if freq <= 0 || period <= 0 {
        return None;
    }
    let ready = now + (lead.as_nanos() as i128 * freq as i128 / 1_000_000_000) as i64;
    let mut vblank = info.qpcVBlank as i64;
    while vblank <= ready {
        vblank += period;
    }
    Some(Instant::now() + Duration::from_nanos(((vblank - now) as i128 * 1_000_000_000 / freq as i128) as u64))
}

impl Drop for Overlay {
    fn drop(&mut self) {
        unsafe {
            for &id in &self.thumbs {
                let _ = DwmUnregisterThumbnail(id);
            }
            let _ = DestroyWindow(self.hwnd);
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Title-bar minimize button
// ---------------------------------------------------------------------------------------------

/// Dock icon of every window the dock lists, in screen px (pushed by the dock: `set_dock_icon_rects`).
static ICONS: Lazy<Mutex<std::collections::HashMap<isize, RECT>>> = Lazy::new(|| Mutex::new(std::collections::HashMap::new()));
/// Window whose minimize button is being pressed (set on button down, checked on button up).
static PRESSED: Lazy<Mutex<Option<isize>>> = Lazy::new(|| Mutex::new(None));

/// How sure the hook is that a press is on a minimize button.
#[derive(Clone, Copy, PartialEq, Debug)]
enum MinButton {
    /// The window said so (`HTMINBUTTON`): the overlay can go up before the app even minimizes.
    Reported,
    /// The window draws its own buttons and answers "client" (Windows Terminal, Task Manager,
    /// Electron apps): the press is in the usual minimize slot, so only a real minimize counts.
    Slot,
}

/// Is `(x, y)` in the usual minimize slot of a window whose visible frame is `frame`: the third
/// caption button from the right (46 px wide at 100 %), in the top 40 px?
fn in_min_slot(frame: RECT, x: i32, y: i32, scale: f32) -> bool {
    let button = (46.0 * scale).round() as i32;
    let top = (40.0 * scale).round() as i32;
    y >= frame.top && y < frame.top + top && x >= frame.right - 3 * button && x < frame.right - 2 * button
}

pub fn set_icon_rects(rects: impl IntoIterator<Item = (isize, RECT)>) {
    *ICONS.lock() = rects.into_iter().collect();
}

/// `WM_NCHITTEST` answer for a click on a window's own minimize button.
const HTMINBUTTON: usize = 8;

/// Low-level mouse hook on its own thread: a click on a dock-listed window's minimize button turns
/// Windows' transition off for that window *before* the app gets the click, so the genie replaces it.
/// The hook only reads: every event is passed on unchanged, and it never blocks (`try_lock`, a 25 ms
/// abort-if-hung hit test, and only for presses near a listed window's top-right corner).
pub fn start_title_bar_hook() {
    let _ = std::thread::Builder::new().name("winglass-minbutton".into()).spawn(|| unsafe {
        use windows::Win32::UI::WindowsAndMessaging::{GetMessageW, SetWindowsHookExW, UnhookWindowsHookEx, WH_MOUSE_LL};
        let instance = GetModuleHandleW(None).unwrap_or_default();
        let Ok(hook) = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), Some(instance.into()), 0) else {
            return;
        };
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        let _ = UnhookWindowsHookEx(hook);
    });
}

unsafe extern "system" fn mouse_proc(code: i32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    use windows::Win32::UI::WindowsAndMessaging::{CallNextHookEx, HC_ACTION, MSLLHOOKSTRUCT, WM_LBUTTONDOWN, WM_LBUTTONUP};
    if code == HC_ACTION as i32 && (wp.0 as u32 == WM_LBUTTONDOWN || wp.0 as u32 == WM_LBUTTONUP) {
        let info = unsafe { &*(lp.0 as *const MSLLHOOKSTRUCT) };
        let target = min_button_under(info.pt);
        if wp.0 as u32 == WM_LBUTTONDOWN {
            *PRESSED.lock() = target.map(|(h, _, _)| h.0 as isize);
        } else if let Some(pressed) = PRESSED.lock().take() {
            // A real click: pressed and released on the same window's minimize button.
            if let Some((hwnd, icon, kind)) = target.filter(|(h, _, _)| h.0 as isize == pressed) {
                on_minimize_click(hwnd, icon, kind);
            }
        }
    }
    unsafe { CallNextHookEx(None, code, wp, lp) }
}

/// The dock-listed top-level window whose minimize button is under `pt`, with its dock icon.
fn min_button_under(pt: windows::Win32::Foundation::POINT) -> Option<(HWND, RECT, MinButton)> {
    use windows::Win32::UI::HiDpi::GetDpiForWindow;
    use windows::Win32::UI::WindowsAndMessaging::{GA_ROOT, GetAncestor, SMTO_ABORTIFHUNG, SendMessageTimeoutW, WM_NCHITTEST, WindowFromPoint};
    unsafe {
        let under = WindowFromPoint(pt);
        let root = GetAncestor(under, GA_ROOT);
        let icon = *ICONS.try_lock()?.get(&(root.0 as isize))?;
        // Caption buttons sit in the top-right corner: skip the hit test for every other click.
        let mut frame = RECT::default();
        DwmGetWindowAttribute(root, DWMWA_EXTENDED_FRAME_BOUNDS, &mut frame as *mut RECT as _, size_of::<RECT>() as u32).ok()?;
        if pt.y - frame.top > 96 || frame.right - pt.x > 480 {
            return None;
        }
        let xy = ((pt.y as u16 as u32) << 16 | pt.x as u16 as u32) as isize;
        let hit = |h: HWND| {
            let mut out = 0usize;
            let sent = SendMessageTimeoutW(h, WM_NCHITTEST, WPARAM(0), LPARAM(xy), SMTO_ABORTIFHUNG, 25, Some(&mut out));
            sent.0 != 0 && out == HTMINBUTTON
        };
        // The window right under the cursor first: WinUI / UWP title bars answer from a child window.
        if (under != root && hit(under)) || hit(root) {
            return Some((root, icon, MinButton::Reported));
        }
        let scale = GetDpiForWindow(root).max(96) as f32 / 96.0;
        in_min_slot(frame, pt.x, pt.y, scale).then_some((root, icon, MinButton::Slot))
    }
}

/// Called from the hook, before the app sees the button release: transition off now (synchronous),
/// and the genie starts once the window is minimized. If it is not minimized within 500 ms (the app
/// cancelled, or a `Slot` guess was wrong), the transition is turned back on and nothing else happens.
fn on_minimize_click(hwnd: HWND, icon: RECT, kind: MinButton) {
    let Some(win) = visible_bounds(hwnd) else { return };
    set_transitions(hwnd, false); // refused for elevated windows, which Windows does not animate here
    spawn(hwnd, move |h| {
        let Some(overlay) = Overlay::new(h, win, Rf::from_rect(icon)) else {
            set_transitions(h, true);
            return;
        };
        // A reported button: the overlay goes up at once as an exact live copy, so the window never
        // leaves a gap. A slot guess: only once it is really minimized (the overlay is not
        // click-through for other apps, and a wrong guess must not eat the next clicks).
        if kind == MinButton::Reported {
            overlay.frame(0.0);
            overlay.show();
        }
        if !wait_iconic(h) {
            set_transitions(h, true);
            return;
        }
        if kind == MinButton::Slot {
            overlay.frame(0.0);
            overlay.show();
        }
        overlay.run(MINIMIZE_MS, false);
        set_transitions(h, true);
    });
}

/// A still picture of a screen rectangle in a click-through, top-most layered window: bridges the
/// frames between the last strip and the restored app's first present.
struct Freeze {
    hwnd: HWND,
}

impl Freeze {
    fn capture(area: &Rf) -> Option<Self> {
        use windows::Win32::Foundation::{POINT, SIZE};
        use windows::Win32::Graphics::Gdi::{
            AC_SRC_OVER, BLENDFUNCTION, BitBlt, CAPTUREBLT, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject,
            GetDC, ReleaseDC, SRCCOPY, SelectObject,
        };
        use windows::Win32::UI::WindowsAndMessaging::{ULW_ALPHA, UpdateLayeredWindow, WS_EX_LAYERED};
        let (l, t) = (area.l.round() as i32, area.t.round() as i32);
        let (w, h) = ((area.r - area.l).round() as i32, (area.b - area.t).round() as i32);
        if w <= 0 || h <= 0 {
            return None;
        }
        unsafe {
            let instance = GetModuleHandleW(None).ok()?;
            // Same class as the strip overlay (registered by Overlay::new, which always runs first).
            let hwnd = CreateWindowExW(
                WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TRANSPARENT,
                w!("WinGlassGenie"),
                w!(""),
                WS_POPUP,
                l,
                t,
                w,
                h,
                None,
                None,
                Some(instance.into()),
                None,
            )
            .ok()?;
            let screen = GetDC(None);
            let mem = CreateCompatibleDC(Some(screen));
            let bmp = CreateCompatibleBitmap(screen, w, h);
            let old = SelectObject(mem, bmp.into());
            // The composed screen there is the landed strips: the window's last picture where it returns.
            let copied = BitBlt(mem, 0, 0, w, h, Some(screen), l, t, SRCCOPY | CAPTUREBLT).is_ok();
            // Constant alpha only (AlphaFormat 0): BitBlt leaves the alpha channel at 0.
            let blend = BLENDFUNCTION { BlendOp: AC_SRC_OVER as u8, BlendFlags: 0, SourceConstantAlpha: 255, AlphaFormat: 0 };
            let shown = copied
                && UpdateLayeredWindow(
                    hwnd,
                    Some(screen),
                    Some(&POINT { x: l, y: t }),
                    Some(&SIZE { cx: w, cy: h }),
                    Some(mem),
                    Some(&POINT::default()),
                    Default::default(),
                    Some(&blend),
                    ULW_ALPHA,
                )
                .is_ok();
            SelectObject(mem, old);
            let _ = DeleteObject(bmp.into());
            let _ = DeleteDC(mem);
            ReleaseDC(None, screen);
            if !shown {
                let _ = DestroyWindow(hwnd);
                return None;
            }
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            let _ = DwmFlush();
            Some(Freeze { hwnd })
        }
    }

    fn hold_and_fade(&self, hold: Duration, fade: Duration) {
        use windows::Win32::Graphics::Gdi::{AC_SRC_OVER, BLENDFUNCTION};
        use windows::Win32::UI::WindowsAndMessaging::{ULW_ALPHA, UpdateLayeredWindow};
        let start = Instant::now();
        while start.elapsed() < hold + fade {
            let k = start.elapsed().saturating_sub(hold).as_secs_f32() / fade.as_secs_f32();
            let alpha = (255.0 * (1.0 - smooth(k))).round() as u8;
            let blend = BLENDFUNCTION { BlendOp: AC_SRC_OVER as u8, BlendFlags: 0, SourceConstantAlpha: alpha, AlphaFormat: 0 };
            unsafe {
                let _ = UpdateLayeredWindow(self.hwnd, None, None, None, None, None, Default::default(), Some(&blend), ULW_ALPHA);
                if DwmFlush().is_err() {
                    std::thread::sleep(Duration::from_millis(16));
                }
            }
        }
    }
}

impl Drop for Freeze {
    fn drop(&mut self) {
        unsafe {
            let _ = DestroyWindow(self.hwnd);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WIN: Rf = Rf { l: 200.0, t: 100.0, r: 1400.0, b: 900.0 };
    const ICON_BELOW: Rf = Rf { l: 900.0, t: 1380.0, r: 940.0, b: 1420.0 };
    const ICON_ABOVE: Rf = Rf { l: 900.0, t: 10.0, r: 940.0, b: 50.0 };

    fn close(a: Rf, b: Rf) -> bool {
        (a.l - b.l).abs() < 0.01 && (a.t - b.t).abs() < 0.01 && (a.r - b.r).abs() < 0.01 && (a.b - b.b).abs() < 0.01
    }

    #[test]
    fn starts_as_the_window_and_ends_in_the_icon() {
        for icon in [ICON_BELOW, ICON_ABOVE] {
            let s0 = strips(WIN, icon, 0.0, 40);
            assert!(close(Rf { t: s0.iter().map(|s| s.dst.t).fold(f32::MAX, f32::min), b: s0.iter().map(|s| s.dst.b).fold(f32::MIN, f32::max), ..s0[0].dst }, WIN));
            assert!(s0.iter().all(|s| s.dst.l == WIN.l && s.dst.r == WIN.r));
            let s1 = strips(WIN, icon, 1.0, 40);
            assert!(s1.iter().all(|s| s.dst.l >= icon.l - 0.01 && s.dst.r <= icon.r + 0.01 && s.dst.t >= icon.t - 0.01 && s.dst.b <= icon.b + 0.01));
        }
    }

    #[test]
    fn strips_tile_the_source_and_stay_contiguous() {
        for icon in [ICON_BELOW, ICON_ABOVE] {
            for p in [0.0, 0.3, 0.6, 0.9] {
                let mut s = strips(WIN, icon, p, 32);
                s.sort_by(|a, b| a.v0.total_cmp(&b.v0));
                assert_eq!(s[0].v0, 0.0);
                assert!((s[31].v1 - 1.0).abs() < 1e-6);
                for pair in s.windows(2) {
                    assert!((pair[0].v1 - pair[1].v0).abs() < 1e-6);
                    assert!((pair[0].dst.b - pair[1].dst.t).abs() < 0.01, "gap at p={p}");
                }
            }
        }
    }

    #[test]
    fn the_minimize_slot_is_the_third_caption_button() {
        let frame = RECT { left: 100, top: 50, right: 1100, bottom: 800 };
        // 100 %: buttons are 46 px, minimize spans 962..1008.
        assert!(in_min_slot(frame, 980, 60, 1.0));
        assert!(!in_min_slot(frame, 1050, 60, 1.0)); // close
        assert!(!in_min_slot(frame, 1020, 60, 1.0)); // maximize
        assert!(!in_min_slot(frame, 950, 60, 1.0)); // left of the buttons
        assert!(!in_min_slot(frame, 980, 95, 1.0)); // below the title bar
        // 150 %: 69 px buttons, minimize spans 893..962.
        assert!(in_min_slot(frame, 900, 100, 1.5));
        assert!(!in_min_slot(frame, 980, 60, 1.5));
    }

    #[test]
    fn the_edge_nearest_the_dock_pinches_first() {
        let s = strips(WIN, ICON_BELOW, 0.3, 32);
        let width = |x: &Strip| x.dst.r - x.dst.l;
        assert!(width(&s[31]) < width(&s[0]));
        let s = strips(WIN, ICON_ABOVE, 0.3, 32);
        let top = s.iter().min_by(|a, b| a.dst.t.total_cmp(&b.dst.t)).unwrap();
        let bottom = s.iter().max_by(|a, b| a.dst.b.total_cmp(&b.dst.b)).unwrap();
        assert!(width(top) < width(bottom));
        assert_eq!(opacity(0.0), 255);
        assert_eq!(opacity(1.0), 0);
    }

    /// Slow (4 s each way) genie on a throw-away window of this process, into a fake icon at the
    /// bottom centre of the primary screen. Run by hand and watch / screenshot:
    /// `cargo test --lib live_genie -- --ignored --nocapture`.
    unsafe extern "system" fn test_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
        unsafe { DefWindowProcW(hwnd, msg, wp, lp) }
    }

    #[test]
    #[ignore = "draws on the real desktop"]
    fn live_genie() {
        use windows::Win32::Graphics::Gdi::{COLOR_HIGHLIGHT, HBRUSH};
        use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN, WS_OVERLAPPEDWINDOW, WS_VISIBLE, WINDOW_EX_STYLE};
        let pump = |ms: u64| {
            let end = Instant::now() + Duration::from_millis(ms);
            while Instant::now() < end {
                unsafe {
                    let mut msg = MSG::default();
                    while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                        let _ = TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        };
        unsafe {
            let instance = GetModuleHandleW(None).unwrap();
            RegisterClassW(&WNDCLASSW {
                lpfnWndProc: Some(test_proc),
                hInstance: instance.into(),
                lpszClassName: w!("WinGlassGenieTest"),
                hbrBackground: HBRUSH((COLOR_HIGHLIGHT.0 + 1) as usize as *mut core::ffi::c_void),
                ..Default::default()
            });
            let (sw, sh) = (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN));
            let hwnd = CreateWindowExW(WINDOW_EX_STYLE(0), w!("WinGlassGenieTest"), w!("Genie test"), WS_OVERLAPPEDWINDOW | WS_VISIBLE, sw / 4, sh / 6, sw / 2, sh / 2, None, None, Some(instance.into()), None).unwrap();
            pump(800);
            let icon = RECT { left: sw / 2 - 24, top: sh - 60, right: sw / 2 + 24, bottom: sh - 12 };
            println!("GENIE minimize start");
            let o = Overlay::new(hwnd, visible_bounds(hwnd).unwrap(), Rf::from_rect(icon)).unwrap();
            o.frame(0.0);
            o.show();
            set_transitions(hwnd, false);
            let _ = ShowWindow(hwnd, SW_MINIMIZE);
            o.run(4000, false);
            set_transitions(hwnd, true);
            drop(o);
            assert!(IsIconic(hwnd).as_bool());
            pump(500);
            println!("GENIE restore start");
            let o = Overlay::new(hwnd, restored_bounds(hwnd).unwrap(), Rf::from_rect(icon)).unwrap();
            o.frame(1.0);
            o.show();
            o.run(4000, true);
            let freeze = Freeze::capture(&restored_bounds(hwnd).unwrap());
            drop(o);
            set_transitions(hwnd, false);
            let _ = ShowWindow(hwnd, SW_RESTORE);
            if let Some(f) = freeze {
                f.hold_and_fade(HOLD, FADE);
            }
            set_transitions(hwnd, true);
            pump(600);
            let _ = DestroyWindow(hwnd);
        }
    }
}
