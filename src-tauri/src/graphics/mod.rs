//! Liquid-glass backdrop sources and the `glass://capture` response.
//!
//! * `dxgi_capture` — **live**: desktop duplication of whatever is behind the dock (default).
//! * `backdrop` — **wallpaper**: the shell wallpaper only; fallback selectable in Settings.
//!
//! Exactly one source runs at a time (and none unless the theme is liquid glass).

pub mod backdrop;
pub mod dxgi_capture;

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::AppHandle;
use tauri::http::{Response, StatusCode};
use windows::Win32::Foundation::RECT;

/// The most recent backdrop frame. `seq == 0` means "no frame". The pixel buffer is reused across
/// frames and only grows when the captured region does.
pub struct FrameBuffer {
    pub seq: u64,
    pub width: u32,
    pub height: u32,
    /// Where the dock pill sits inside the frame, `[x, y, w, h]` in pixels. The live source
    /// captures a margin around the pill so the blur has real colour to pull in.
    pub inner: [u32; 4],
    /// Tightly packed BGRA rows, `width * height * 4` bytes.
    pub bgra: Vec<u8>,
}

impl FrameBuffer {
    pub const fn empty() -> FrameBuffer {
        FrameBuffer { seq: 0, width: 0, height: 0, inner: [0; 4], bgra: Vec::new() }
    }
}

/// True while the wallpaper source is the selected one.
static WALLPAPER: AtomicBool = AtomicBool::new(false);

pub fn is_wallpaper_source(glass_backdrop: &str) -> bool {
    glass_backdrop == "wallpaper"
}

pub fn start(app: AppHandle) {
    dxgi_capture::start(app.clone());
    backdrop::start(app);
}

/// Select the backdrop source for the current theme / settings.
pub fn configure(app: &AppHandle, liquid_glass: bool, glass_backdrop: &str) {
    let wallpaper = is_wallpaper_source(glass_backdrop);
    WALLPAPER.store(wallpaper, Ordering::SeqCst);
    // Disable first so the two sources never overlap.
    if wallpaper {
        dxgi_capture::set_enabled(app, false);
        backdrop::set_enabled(liquid_glass);
    } else {
        backdrop::set_enabled(false);
        dxgi_capture::set_enabled(app, liquid_glass);
    }
}

/// Screen-space physical rect of the dock pill.
pub fn set_rect(rect: RECT) {
    dxgi_capture::set_rect(rect);
    backdrop::set_rect(rect);
}

/// Pause while the dock is hidden behind a fullscreen app.
pub fn set_paused(paused: bool) {
    dxgi_capture::set_paused(paused);
    backdrop::set_paused(paused);
}

pub fn status() -> String {
    if WALLPAPER.load(Ordering::SeqCst) {
        format!("wallpaper: {}", backdrop::status())
    } else {
        format!("live: {}", dxgi_capture::status())
    }
}

/// Build the `glass://capture` response: raw BGRA bytes + X-Width / X-Height / X-Inner headers.
/// The body is the only per-response allocation (the scheme handler must own what it returns).
pub fn capture_response() -> Response<Vec<u8>> {
    let builder = || {
        Response::builder()
            .header("Access-Control-Allow-Origin", "*")
            .header("Access-Control-Expose-Headers", "X-Width, X-Height, X-Inner, X-Seq")
            .header("Cache-Control", "no-store")
    };
    let respond = |frame: &FrameBuffer| {
        let [x, y, w, h] = frame.inner;
        builder()
            .status(StatusCode::OK)
            .header("Content-Type", "application/octet-stream")
            .header("X-Width", frame.width.to_string())
            .header("X-Height", frame.height.to_string())
            .header("X-Inner", format!("{x},{y},{w},{h}"))
            .header("X-Seq", frame.seq.to_string())
            .body(frame.bgra.clone())
    };
    let response = if WALLPAPER.load(Ordering::SeqCst) { backdrop::with_latest(respond) } else { dxgi_capture::with_latest(respond) }
        .unwrap_or_else(|| builder().status(StatusCode::NO_CONTENT).body(Vec::new()));
    response.unwrap_or_else(|_| Response::new(Vec::new()))
}

#[cfg(test)]
mod tests {
    use super::is_wallpaper_source;

    #[test]
    fn live_capture_is_the_default_source() {
        assert!(!is_wallpaper_source("live"));
        assert!(!is_wallpaper_source(""));
        assert!(is_wallpaper_source("wallpaper"));
    }
}
