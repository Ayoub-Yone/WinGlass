//! Taskbar-style window previews for the dock's app icons: every open top-level window of an app,
//! rendered with `PrintWindow(PW_RENDERFULLCONTENT)` (GPU / DirectComposition content included),
//! cropped to the DWM frame and scaled down to a small PNG. Minimized windows have nothing to
//! render, so they come back without a thumbnail (the card shows the app icon instead); hung
//! windows are skipped rather than blocking on WM_PRINT.
//! Focus / close only ever act on a window the dock currently lists as an app window.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::Serialize;
use windows::Win32::Foundation::{HWND, LPARAM, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::{DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute};
use windows::Win32::Graphics::Gdi::{
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleDC, CreateDIBSection, DIB_RGB_COLORS, DeleteDC,
    DeleteObject, GetDC, ReleaseDC, SelectObject,
};
use windows::Win32::Storage::Xps::{PRINT_WINDOW_FLAGS, PrintWindow};
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowRect, IsHungAppWindow, IsIconic, PostMessageW, SW_RESTORE, ShowWindow, WM_CLOSE,
};

use super::apps_enum;

/// `PW_RENDERFULLCONTENT`: include DirectComposition / GPU content (browsers, UWP).
const PW_RENDERFULLCONTENT: PRINT_WINDOW_FLAGS = PRINT_WINDOW_FLAGS(2);
/// Thumbnail box (physical pixels); the card shows it at half size for crisp HiDPI.
const MAX_W: u32 = 400;
const MAX_H: u32 = 240;
/// Larger windows are not captured (bounded memory for the DIB).
const MAX_SIDE: i32 = 8192;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowPreview {
    pub hwnd: i64,
    pub title: String,
    pub is_minimized: bool,
    pub is_active: bool,
    /// PNG data URL, or None (minimized, hung, or the window rendered nothing).
    pub thumbnail: Option<String>,
}

/// Largest size with the same aspect ratio that fits in `max_w` x `max_h` (never upscales).
pub fn fit(w: u32, h: u32, max_w: u32, max_h: u32) -> (u32, u32) {
    if w == 0 || h == 0 {
        return (0, 0);
    }
    let scale = (max_w as f64 / w as f64).min(max_h as f64 / h as f64).min(1.0);
    (((w as f64 * scale).round() as u32).max(1), ((h as f64 * scale).round() as u32).max(1))
}

/// A frame where (almost) every pixel is black: the window drew nothing (e.g. still loading).
pub fn is_blank(bgra: &[u8]) -> bool {
    let total = bgra.len() / 4;
    if total == 0 {
        return true;
    }
    let lit = bgra.chunks_exact(4).filter(|p| p[0].max(p[1]).max(p[2]) > 10).count();
    lit * 50 < total
}

fn hwnd_of(raw: i64) -> HWND {
    HWND(raw as isize as *mut core::ffi::c_void)
}

/// Render `hwnd` into a scaled PNG data URL.
fn capture(hwnd: HWND) -> Option<String> {
    unsafe {
        if IsIconic(hwnd).as_bool() || IsHungAppWindow(hwnd).as_bool() {
            return None;
        }
        let mut outer = RECT::default();
        GetWindowRect(hwnd, &mut outer).ok()?;
        let (w, h) = (outer.right - outer.left, outer.bottom - outer.top);
        if w <= 0 || h <= 0 || w > MAX_SIDE || h > MAX_SIDE {
            return None;
        }
        // Visible frame inside the window rect (drops Windows 10/11's invisible resize borders).
        let mut frame = RECT::default();
        let crop = if DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &mut frame as *mut RECT as *mut _, std::mem::size_of::<RECT>() as u32).is_ok() {
            let l = (frame.left - outer.left).clamp(0, w - 1);
            let t = (frame.top - outer.top).clamp(0, h - 1);
            (l, t, (frame.right - frame.left).clamp(1, w - l), (frame.bottom - frame.top).clamp(1, h - t))
        } else {
            (0, 0, w, h)
        };

        let screen = GetDC(None);
        let dc = CreateCompatibleDC(Some(screen));
        ReleaseDC(None, screen);
        let bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let Ok(bitmap) = CreateDIBSection(Some(dc), &bmi, DIB_RGB_COLORS, &mut bits, None, 0) else {
            let _ = DeleteDC(dc);
            return None;
        };
        let old = SelectObject(dc, bitmap.into());
        let printed = PrintWindow(hwnd, dc, PW_RENDERFULLCONTENT).as_bool();
        let pixels = if printed && !bits.is_null() {
            Some(std::slice::from_raw_parts(bits as *const u8, (w * h * 4) as usize).to_vec())
        } else {
            None
        };
        SelectObject(dc, old);
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(dc);
        let pixels = pixels?;

        let (cl, ct, cw, ch) = crop;
        let mut rgba = Vec::with_capacity((cw * ch * 4) as usize);
        for y in ct..ct + ch {
            let row = &pixels[((y * w + cl) * 4) as usize..((y * w + cl + cw) * 4) as usize];
            for p in row.chunks_exact(4) {
                // GDI leaves alpha undefined: the thumbnail is opaque.
                rgba.extend_from_slice(&[p[2], p[1], p[0], 255]);
            }
        }
        if is_blank(&rgba) {
            return None;
        }
        let full = image::RgbaImage::from_raw(cw as u32, ch as u32, rgba)?;
        let (tw, th) = fit(cw as u32, ch as u32, MAX_W, MAX_H);
        let small = image::imageops::resize(&full, tw, th, image::imageops::FilterType::Triangle);
        let mut png = Vec::new();
        small.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).ok()?;
        Some(format!("data:image/png;base64,{}", STANDARD.encode(png)))
    }
}

/// Every open window of the dock entry `app_id`, with a fresh thumbnail each.
pub fn previews(app_id: &str) -> Vec<WindowPreview> {
    let Some(app) = apps_enum::list_apps().into_iter().find(|a| a.id == app_id) else { return Vec::new() };
    app.windows
        .into_iter()
        .map(|w| WindowPreview {
            thumbnail: capture(hwnd_of(w.hwnd)),
            hwnd: w.hwnd,
            title: w.title,
            is_minimized: w.is_minimized,
            is_active: w.is_active,
        })
        .collect()
}

/// Only windows the dock lists as app windows can be focused / closed from a preview.
fn listed(hwnd: i64) -> bool {
    apps_enum::list_apps().iter().any(|a| a.windows.iter().any(|w| w.hwnd == hwnd))
}

/// Bring that window to the front, restoring it when minimized.
pub fn focus(hwnd: i64) -> Result<(), String> {
    if !listed(hwnd) {
        return Err("window is not an open app window".into());
    }
    let h = hwnd_of(hwnd);
    unsafe {
        if IsIconic(h).as_bool() {
            let _ = ShowWindow(h, SW_RESTORE);
        }
    }
    apps_enum::focus(h);
    Ok(())
}

/// Ask the window to close (WM_CLOSE: the app may still prompt to save).
pub fn close(hwnd: i64) -> Result<(), String> {
    if !listed(hwnd) {
        return Err("window is not an open app window".into());
    }
    unsafe { PostMessageW(Some(hwnd_of(hwnd)), WM_CLOSE, WPARAM(0), LPARAM(0)) }.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::{fit, is_blank};

    #[test]
    fn thumbnails_keep_the_aspect_ratio_and_never_upscale() {
        assert_eq!(fit(1920, 1080, 400, 240), (400, 225));
        assert_eq!(fit(1080, 1920, 400, 240), (135, 240));
        assert_eq!(fit(300, 200, 400, 240), (300, 200));
        assert_eq!(fit(0, 100, 400, 240), (0, 0));
    }

    #[test]
    fn black_frames_count_as_blank() {
        assert!(is_blank(&[0u8; 400]));
        let mut lit = vec![0u8; 400];
        lit[0..12].copy_from_slice(&[200, 200, 200, 255, 90, 90, 90, 255, 30, 30, 30, 255]);
        assert!(!is_blank(&lit));
        assert!(is_blank(&[]));
    }
}
