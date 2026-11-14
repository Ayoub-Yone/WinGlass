//! Liquid-glass backdrop: the desktop wallpaper region directly behind the dock.
//!
//! The shell's desktop window (`Progman`) is rendered with `PrintWindow(PW_RENDERFULLCONTENT)`
//! into a small DIB the size of the dock pill; a viewport offset on the memory DC makes GDI clip
//! everything but that region, so the full desktop is never copied. This follows whatever the
//! shell shows as wallpaper (fit modes, slideshows, per-monitor and animated wallpapers).
//!
//! Why the wallpaper and not the live screen: capturing what is behind the dock from the composed
//! screen needs the dock excluded from capture (`WDA_EXCLUDEFROMCAPTURE`) plus a desktop
//! duplication session, and on some GPU / driver combinations that pairing makes the excluded
//! window disappear from the physical display. The dock must never be able to hide itself, so
//! no display affinity is set and nothing on the composed screen is captured.
//!
//! * One memory DC + DIB section are reused; they are re-created only when the pill changes size
//!   and released while parked.
//! * Frames identical to the published one are dropped, so a static wallpaper costs one ~10 ms
//!   render every `REFRESH` and no IPC.
//! * Full pause: while the theme is not liquid glass, or the dock is hidden behind a fullscreen
//!   app, the thread parks on a condition variable.
//! * Frames are served to WebGL through the `glass://capture?t=<seq>` URI scheme as raw BGRA.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use once_cell::sync::Lazy;
use parking_lot::{Condvar, Mutex};
use tauri::{AppHandle, Emitter};
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Gdi::{
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleDC, CreateDIBSection, DIB_RGB_COLORS, DeleteDC, DeleteObject,
    GdiFlush, HBITMAP, HDC, HGDIOBJ, SelectObject, SetViewportOrgEx,
};
use windows::Win32::Storage::Xps::{PRINT_WINDOW_FLAGS, PrintWindow};
use windows::Win32::UI::WindowsAndMessaging::{FindWindowW, GetWindowRect};
use windows::core::w;

/// The most recent backdrop. `seq == 0` means "no frame". The pixel buffer is reused across
/// frames and only grows when the dock rect does.
pub struct FrameBuffer {
    pub seq: u64,
    pub width: u32,
    pub height: u32,
    /// Tightly packed BGRA rows, `width * height * 4` bytes.
    pub bgra: Vec<u8>,
}

static ENABLED: AtomicBool = AtomicBool::new(false);
/// Dock hidden behind a fullscreen app: nothing to composite, so nothing to render.
static PAUSED: AtomicBool = AtomicBool::new(false);
static SEQ: AtomicU64 = AtomicU64::new(0);
static CAPTURE_RECT: Lazy<Mutex<Option<RECT>>> = Lazy::new(|| Mutex::new(None));
static LATEST: Lazy<Mutex<FrameBuffer>> = Lazy::new(|| Mutex::new(FrameBuffer { seq: 0, width: 0, height: 0, bgra: Vec::new() }));
static STATUS: Lazy<Mutex<String>> = Lazy::new(|| Mutex::new("idle".into()));
/// Parks the thread while there is nothing to do; also cuts the refresh wait short.
static WAKE: Lazy<(Mutex<()>, Condvar)> = Lazy::new(|| (Mutex::new(()), Condvar::new()));

/// How often the wallpaper is re-rendered (slideshows, animated wallpapers, wallpaper changes).
const REFRESH: Duration = Duration::from_secs(2);
/// Safety net for the parked thread; every state change also notifies it explicitly.
const PARK_TIMEOUT: Duration = Duration::from_secs(5);
const RETRY: Duration = Duration::from_secs(2);
/// `PW_RENDERFULLCONTENT`: render DirectComposition content too (the wallpaper is one).
const PW_RENDERFULLCONTENT: PRINT_WINDOW_FLAGS = PRINT_WINDOW_FLAGS(2);
const MAX_SIDE: i32 = 8192;

/// Run `f` on the latest frame, if there is one.
pub fn with_latest<T>(f: impl FnOnce(&FrameBuffer) -> T) -> Option<T> {
    let frame = LATEST.lock();
    (frame.seq != 0).then(|| f(&frame))
}

pub fn status() -> String {
    STATUS.lock().clone()
}

fn set_status(s: &str) {
    let mut status = STATUS.lock();
    if *status != s {
        *status = s.to_string();
    }
}

fn wake() {
    let _guard = WAKE.0.lock();
    WAKE.1.notify_all();
}

/// Rendering runs only for the liquid-glass theme with a known dock rect and a visible dock.
fn should_capture() -> Option<RECT> {
    if !ENABLED.load(Ordering::SeqCst) || PAUSED.load(Ordering::SeqCst) {
        return None;
    }
    *CAPTURE_RECT.lock()
}

/// Screen-space physical rect behind the dock pill.
pub fn set_rect(rect: RECT) {
    let mut current = CAPTURE_RECT.lock();
    if *current != Some(rect) {
        *current = Some(rect);
        drop(current);
        wake();
    }
}

/// Pause while the dock is hidden behind a fullscreen app.
pub fn set_paused(paused: bool) {
    if PAUSED.swap(paused, Ordering::SeqCst) != paused {
        wake();
    }
}

pub fn set_enabled(enabled: bool) {
    if ENABLED.swap(enabled, Ordering::SeqCst) == enabled {
        return;
    }
    if !enabled {
        // Leaving liquid glass: drop the frame and give its memory back.
        let mut frame = LATEST.lock();
        frame.seq = 0;
        frame.bgra = Vec::new();
    }
    wake();
}

/// Offset of `rect` inside the desktop window, i.e. the viewport shift that puts the dock
/// region at the origin of the small bitmap.
fn viewport_origin(desktop: &RECT, rect: &RECT) -> (i32, i32) {
    (desktop.left - rect.left, desktop.top - rect.top)
}

fn frame_size(rect: &RECT) -> Option<(i32, i32)> {
    let w = rect.right - rect.left;
    let h = rect.bottom - rect.top;
    (w >= 4 && h >= 4 && w <= MAX_SIDE && h <= MAX_SIDE).then_some((w, h))
}

/// Reused GDI surface: a memory DC with a top-down 32-bit DIB section selected into it.
struct Surface {
    dc: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
    bits: *mut u8,
    width: i32,
    height: i32,
}

impl Surface {
    fn create(width: i32, height: i32) -> Result<Surface, String> {
        unsafe {
            let dc = CreateCompatibleDC(None);
            if dc.is_invalid() {
                return Err("CreateCompatibleDC failed".into());
            }
            let info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width,
                    biHeight: -height, // top-down
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
            let bitmap = match CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0) {
                Ok(bitmap) if !bits.is_null() => bitmap,
                Ok(bitmap) => {
                    let _ = DeleteObject(bitmap.into());
                    let _ = DeleteDC(dc);
                    return Err("CreateDIBSection returned no pixels".into());
                }
                Err(err) => {
                    let _ = DeleteDC(dc);
                    return Err(format!("CreateDIBSection: {err}"));
                }
            };
            let previous = SelectObject(dc, bitmap.into());
            Ok(Surface { dc, bitmap, previous, bits: bits as *mut u8, width, height })
        }
    }

    fn pixels(&self) -> &[u8] {
        unsafe { std::slice::from_raw_parts(self.bits, self.width as usize * self.height as usize * 4) }
    }
}

impl Drop for Surface {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.dc, self.previous);
            let _ = DeleteObject(self.bitmap.into());
            let _ = DeleteDC(self.dc);
        }
    }
}

/// Render the wallpaper region behind `rect` and publish it. `Ok(None)` = unchanged.
fn render(surface: &mut Option<Surface>, rect: &RECT) -> Result<Option<u64>, String> {
    let (w, h) = frame_size(rect).ok_or("dock rect is empty")?;
    let desktop: HWND = unsafe { FindWindowW(w!("Progman"), None) }.map_err(|_| "desktop window not found".to_string())?;
    let mut desktop_rect = RECT::default();
    unsafe { GetWindowRect(desktop, &mut desktop_rect) }.map_err(|e| format!("GetWindowRect: {e}"))?;

    if surface.as_ref().is_none_or(|s| s.width != w || s.height != h) {
        *surface = None;
        *surface = Some(Surface::create(w, h)?);
    }
    let Some(s) = surface.as_ref() else { return Err("no surface".into()) };

    let (ox, oy) = viewport_origin(&desktop_rect, rect);
    unsafe {
        let _ = SetViewportOrgEx(s.dc, ox, oy, None);
        let ok = PrintWindow(desktop, s.dc, PW_RENDERFULLCONTENT).as_bool();
        let _ = GdiFlush();
        if !ok {
            return Err("PrintWindow failed".into());
        }
    }

    let pixels = s.pixels();
    let mut frame = LATEST.lock();
    if frame.seq != 0 && frame.width == w as u32 && frame.height == h as u32 && frame.bgra.as_slice() == pixels {
        return Ok(None);
    }
    // No-op (no allocation) unless the dock rect changed size.
    frame.bgra.resize(pixels.len(), 0);
    frame.bgra.copy_from_slice(pixels);
    frame.width = w as u32;
    frame.height = h as u32;
    frame.seq = SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    Ok(Some(frame.seq))
}

pub fn start(app: AppHandle) {
    std::thread::Builder::new()
        .name("lumabar-backdrop".into())
        .spawn(move || {
            let mut surface: Option<Surface> = None;
            let mut rendered: Option<RECT> = None;
            loop {
                let Some(rect) = should_capture() else {
                    // Fully paused: release the GDI surface and park until woken.
                    surface = None;
                    rendered = None;
                    set_status(if PAUSED.load(Ordering::SeqCst) && ENABLED.load(Ordering::SeqCst) { "paused (fullscreen)" } else { "idle" });
                    let mut guard = WAKE.0.lock();
                    if should_capture().is_none() {
                        WAKE.1.wait_for(&mut guard, PARK_TIMEOUT);
                    }
                    continue;
                };

                let wait = match render(&mut surface, &rect) {
                    Ok(seq) => {
                        set_status("running");
                        rendered = Some(rect);
                        if let Some(seq) = seq {
                            let _ = app.emit_to("dock", "glass:frame", seq);
                        }
                        REFRESH
                    }
                    Err(err) => {
                        set_status(&format!("error: {err}"));
                        RETRY
                    }
                };

                // Sleep until the next refresh, or until the rect / theme / pause state changes.
                let mut guard = WAKE.0.lock();
                if should_capture() == rendered || rendered.is_none() {
                    WAKE.1.wait_for(&mut guard, wait);
                }
            }
        })
        .expect("spawn backdrop thread");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn viewport_shifts_dock_region_to_origin() {
        // Second monitor to the left and above: the desktop window starts at negative coordinates.
        let desktop = RECT { left: -2560, top: -160, right: 2560, bottom: 1440 };
        let dock = RECT { left: 401, top: 1372, right: 2158, bottom: 1430 };
        assert_eq!(viewport_origin(&desktop, &dock), (-2961, -1532));
        let primary_only = RECT { left: 0, top: 0, right: 1920, bottom: 1080 };
        assert_eq!(viewport_origin(&primary_only, &RECT { left: 100, top: 1000, right: 900, bottom: 1060 }), (-100, -1000));
    }

    #[test]
    fn frame_size_rejects_degenerate_rects() {
        assert_eq!(frame_size(&RECT { left: 10, top: 10, right: 1767, bottom: 68 }), Some((1757, 58)));
        assert_eq!(frame_size(&RECT { left: 0, top: 0, right: 2, bottom: 58 }), None);
        assert_eq!(frame_size(&RECT { left: 0, top: 0, right: 100, bottom: 0 }), None);
        assert_eq!(frame_size(&RECT { left: 50, top: 0, right: 10, bottom: 40 }), None);
        assert_eq!(frame_size(&RECT { left: 0, top: 0, right: 20000, bottom: 40 }), None);
    }
}
