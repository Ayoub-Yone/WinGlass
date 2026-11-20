//! Liquid-glass backdrop source and the `glass://capture` response.
//!
//! * `dxgi_capture` — desktop duplication of whatever is behind the dock.
//!
//! The source only runs while the theme is liquid glass.

pub mod dxgi_capture;

use tauri::AppHandle;
use tauri::http::{Response, StatusCode};
use windows::Win32::Foundation::RECT;

/// The most recent backdrop frame. `seq == 0` means "no frame". The pixel buffer is reused across
/// frames and only grows when the captured region does.
pub struct FrameBuffer {
    pub seq: u64,
    pub width: u32,
    pub height: u32,
    /// Where the dock pill sits inside the frame, `[x, y, w, h]` in pixels. The capture
    /// includes a margin around the pill so the blur has real colour to pull in.
    pub inner: [u32; 4],
    /// Tightly packed BGRA rows, `width * height * 4` bytes.
    pub bgra: Vec<u8>,
}

impl FrameBuffer {
    pub const fn empty() -> FrameBuffer {
        FrameBuffer { seq: 0, width: 0, height: 0, inner: [0; 4], bgra: Vec::new() }
    }
}

pub fn start(app: AppHandle) {
    dxgi_capture::start(app);
}

/// Enable the capture for the current theme / settings.
pub fn configure(app: &AppHandle, liquid_glass: bool) {
    dxgi_capture::set_enabled(app, liquid_glass);
}

/// Screen-space physical rect of the dock pill.
pub fn set_rect(rect: RECT) {
    dxgi_capture::set_rect(rect);
}

/// Pause while the dock is hidden behind a fullscreen app.
pub fn set_paused(paused: bool) {
    dxgi_capture::set_paused(paused);
}

pub fn status() -> String {
    format!("live: {}", dxgi_capture::status())
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
    let response = dxgi_capture::with_latest(respond)
        .unwrap_or_else(|| builder().status(StatusCode::NO_CONTENT).body(Vec::new()));
    response.unwrap_or_else(|_| Response::new(Vec::new()))
}
