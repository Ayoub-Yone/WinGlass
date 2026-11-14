//! Live top-level windows (EnumWindows) + taskbar pinned shortcuts + HICON -> PNG icons.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, RPC_E_CHANGED_MODE, WPARAM};
use windows::Win32::Graphics::Dwm::{DWMWA_CLOAKED, DwmGetWindowAttribute};
use windows::Win32::Graphics::Gdi::{
    BI_RGB, BITMAP, BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleDC, CreateDIBSection, DIB_RGB_COLORS,
    DeleteDC, DeleteObject, GetDC, GetObjectW, HBITMAP, HGDIOBJ, ReleaseDC, SelectObject,
};
use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL;
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile,
    STGM_READ,
};
use windows::Win32::System::Threading::{
    GetCurrentProcessId, OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    QueryFullProcessImageNameW,
};
use windows::Win32::UI::Shell::{
    IShellLinkW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON, SHGetFileInfoW, ShellExecuteW, ShellLink,
};
use windows::Win32::UI::WindowsAndMessaging::{
    DI_MASK, DI_NORMAL, DestroyIcon, DrawIconEx, EnumChildWindows, EnumWindows, GCLP_HICON, GW_OWNER,
    GWL_EXSTYLE, GetClassLongPtrW, GetForegroundWindow, GetIconInfo, GetWindow, GetWindowLongPtrW,
    GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, HICON, ICON_BIG, ICONINFO, IsIconic,
    IsWindowVisible, SMTO_ABORTIFHUNG, SW_MINIMIZE, SW_RESTORE, SW_SHOWNORMAL, SendMessageTimeoutW,
    SetForegroundWindow, ShowWindow, SwitchToThisWindow, WM_GETICON, WS_EX_APPWINDOW, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW,
};
use windows::core::{BOOL, PCWSTR, w};

use super::{from_wide, sentinel, wide};
use crate::lru::LruCache;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppEntry {
    /// Stable id: pinned shortcut path, or lowercase exe path for unpinned running apps.
    pub id: String,
    pub name: String,
    pub exe_path: Option<String>,
    pub icon_key: String,
    pub pinned_path: Option<String>,
    pub windows: Vec<AppWindow>,
    pub is_active: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppWindow {
    pub hwnd: i64,
    pub title: String,
    pub is_minimized: bool,
    pub is_active: bool,
}

pub(crate) struct RawWindow {
    pub hwnd: HWND,
    pub title: String,
    pub exe: String,
}

struct PinnedShortcut {
    path: String,
    name: String,
    target: Option<String>,
}

/// Successful icon extractions only — failures are retried on the next request. Bounded: a long
/// session sees many short-lived windows, and each PNG data URL is several KB.
pub const ICON_CACHE_CAPACITY: usize = 64;
static ICON_CACHE: Lazy<Mutex<LruCache<String>>> = Lazy::new(|| Mutex::new(LruCache::new(ICON_CACHE_CAPACITY)));
static PINNED_CACHE: Lazy<Mutex<Option<(Instant, Vec<(String, String, Option<String>)>)>>> =
    Lazy::new(|| Mutex::new(None));

type StaJob = Box<dyn FnOnce() + Send>;

/// Dedicated single-threaded-apartment worker. Shell APIs (SHGetFileInfoW, IShellLinkW) require
/// an STA; Tauri's blocking pool threads may already be MTA, where those calls fail.
static STA: Lazy<Mutex<std::sync::mpsc::Sender<StaJob>>> = Lazy::new(|| {
    let (tx, rx) = std::sync::mpsc::channel::<StaJob>();
    std::thread::Builder::new()
        .name("lumabar-shell-sta".into())
        .spawn(move || {
            let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
            if hr.is_err() && hr != RPC_E_CHANGED_MODE {
                eprintln!("[lumabar] shell STA init failed: {hr:?}");
            }
            for job in rx {
                job();
            }
            unsafe { CoUninitialize() };
        })
        .expect("spawn shell STA thread");
    Mutex::new(tx)
});

/// Run `f` on the shell STA thread and wait for its result.
fn with_com<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    let (tx, rx) = std::sync::mpsc::channel();
    let job: StaJob = Box::new(move || {
        let _ = tx.send(f());
    });
    STA.lock().send(job).ok()?;
    rx.recv_timeout(Duration::from_secs(10)).ok()
}

pub fn process_image_path(pid: u32) -> Option<String> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = vec![0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, windows::core::PWSTR(buf.as_mut_ptr()), &mut len);
        let _ = CloseHandle(handle);
        ok.ok()?;
        Some(String::from_utf16_lossy(&buf[..len as usize]))
    }
}

pub fn window_pid(hwnd: HWND) -> u32 {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    pid
}

pub fn window_title(hwnd: HWND) -> String {
    unsafe {
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return String::new();
        }
        let mut buf = vec![0u16; len as usize + 1];
        let copied = GetWindowTextW(hwnd, &mut buf);
        String::from_utf16_lossy(&buf[..copied.max(0) as usize])
    }
}

fn is_cloaked(hwnd: HWND) -> bool {
    let mut cloaked: u32 = 0;
    unsafe {
        DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut _, std::mem::size_of::<u32>() as u32)
            .is_ok()
            && cloaked != 0
    }
}

/// Taskbar-eligible: visible, unowned (or WS_EX_APPWINDOW), not a tool window, not cloaked, titled.
fn is_taskbar_window(hwnd: HWND) -> bool {
    unsafe {
        if !IsWindowVisible(hwnd).as_bool() || is_cloaked(hwnd) {
            return false;
        }
        let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        if ex_style & WS_EX_TOOLWINDOW.0 != 0 {
            return false;
        }
        let owner = GetWindow(hwnd, GW_OWNER).unwrap_or_default();
        if !owner.is_invalid() && ex_style & WS_EX_APPWINDOW.0 == 0 {
            return false;
        }
        if ex_style & WS_EX_NOACTIVATE.0 != 0 && ex_style & WS_EX_APPWINDOW.0 == 0 {
            return false;
        }
        GetWindowTextLengthW(hwnd) > 0
    }
}

unsafe extern "system" fn enum_child_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let state = unsafe { &mut *(lparam.0 as *mut (u32, Option<u32>)) };
    let pid = window_pid(hwnd);
    if pid != state.0 {
        state.1 = Some(pid);
        return BOOL(0);
    }
    BOOL(1)
}

/// UWP apps are hosted by ApplicationFrameHost.exe; the real process owns a child CoreWindow.
fn resolve_uwp_exe(hwnd: HWND, host_pid: u32) -> Option<String> {
    let mut state: (u32, Option<u32>) = (host_pid, None);
    unsafe {
        let _ = EnumChildWindows(Some(hwnd), Some(enum_child_proc), LPARAM(&mut state as *mut _ as isize));
    }
    state.1.and_then(process_image_path)
}

unsafe extern "system" fn enum_windows_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let out = unsafe { &mut *(lparam.0 as *mut Vec<RawWindow>) };
    if !is_taskbar_window(hwnd) {
        return BOOL(1);
    }
    let pid = window_pid(hwnd);
    if pid == unsafe { GetCurrentProcessId() } {
        return BOOL(1);
    }
    let mut exe = process_image_path(pid).unwrap_or_default();
    if exe.to_ascii_lowercase().ends_with("applicationframehost.exe") {
        if let Some(real) = resolve_uwp_exe(hwnd, pid) {
            exe = real;
        }
    }
    out.push(RawWindow { hwnd, title: window_title(hwnd), exe });
    BOOL(1)
}

pub(crate) fn enumerate_windows() -> Vec<RawWindow> {
    let mut out: Vec<RawWindow> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(enum_windows_proc), LPARAM(&mut out as *mut _ as isize));
    }
    out
}

fn pinned_dir() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(|a| {
        PathBuf::from(a).join("Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar")
    })
}

fn resolve_shortcut(path: &Path) -> Option<String> {
    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
        let persist: IPersistFile = windows::core::Interface::cast(&link).ok()?;
        let wpath = wide(&path.to_string_lossy());
        persist.Load(PCWSTR(wpath.as_ptr()), STGM_READ).ok()?;
        let mut buf = vec![0u16; 1024];
        link.GetPath(&mut buf, std::ptr::null_mut(), 0).ok()?;
        let target = from_wide(&buf);
        if target.is_empty() { None } else { Some(target) }
    }
}

fn pinned_shortcuts() -> Vec<PinnedShortcut> {
    {
        let cache = PINNED_CACHE.lock();
        if let Some((at, items)) = cache.as_ref() {
            if at.elapsed() < Duration::from_secs(30) {
                return items
                    .iter()
                    .map(|(p, n, t)| PinnedShortcut { path: p.clone(), name: n.clone(), target: t.clone() })
                    .collect();
            }
        }
    }
    let mut items: Vec<(String, String, Option<String>)> = Vec::new();
    if let Some(dir) = pinned_dir() {
        if let Ok(entries) = std::fs::read_dir(dir) {
            let mut paths: Vec<PathBuf> = entries
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| p.extension().map(|x| x.eq_ignore_ascii_case("lnk")).unwrap_or(false))
                .collect();
            paths.sort();
            let resolved = with_com(move || {
                paths
                    .into_iter()
                    .map(|path| {
                        let name = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                        let target = resolve_shortcut(&path);
                        (path.to_string_lossy().to_string(), name, target)
                    })
                    .collect::<Vec<_>>()
            });
            items = resolved.unwrap_or_default();
        }
    }
    *PINNED_CACHE.lock() = Some((Instant::now(), items.clone()));
    items.into_iter().map(|(path, name, target)| PinnedShortcut { path, name, target }).collect()
}

pub(crate) fn display_name(exe: &str, fallback_title: &str) -> String {
    Path::new(exe)
        .file_stem()
        .map(|s| {
            let mut name = s.to_string_lossy().to_string();
            if let Some(first) = name.get_mut(0..1) {
                first.make_ascii_uppercase();
            }
            name
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| fallback_title.to_string())
}

static FRIENDLY_CACHE: Lazy<Mutex<LruCache<String>>> = Lazy::new(|| Mutex::new(LruCache::new(ICON_CACHE_CAPACITY)));

/// The executable's own product name (version-info `FileDescription`, e.g. "Google Chrome"), falling
/// back to the capitalized file stem. Cached in a bounded LRU.
pub fn friendly_name(exe: &str) -> String {
    if let Some(hit) = FRIENDLY_CACHE.lock().get(exe) {
        return hit;
    }
    let name = version_description(exe).unwrap_or_else(|| display_name(exe, ""));
    FRIENDLY_CACHE.lock().insert(exe.to_string(), name.clone());
    name
}

fn version_description(exe: &str) -> Option<String> {
    use windows::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW};
    if exe.is_empty() {
        return None;
    }
    let wexe = wide(exe);
    unsafe {
        let size = GetFileVersionInfoSizeW(PCWSTR(wexe.as_ptr()), None);
        if size == 0 {
            return None;
        }
        let mut data = vec![0u8; size as usize];
        GetFileVersionInfoW(PCWSTR(wexe.as_ptr()), None, size, data.as_mut_ptr() as *mut _).ok()?;
        // First language/codepage pair, then that block's FileDescription.
        let mut ptr: *mut core::ffi::c_void = std::ptr::null_mut();
        let mut len = 0u32;
        let translation = wide(r"\VarFileInfo\Translation");
        let mut pairs: Vec<(u16, u16)> = Vec::new();
        if VerQueryValueW(data.as_ptr() as *const _, PCWSTR(translation.as_ptr()), &mut ptr, &mut len).as_bool() && len >= 4 {
            let words = std::slice::from_raw_parts(ptr as *const u16, (len / 2) as usize);
            pairs.extend(words.chunks_exact(2).map(|w| (w[0], w[1])));
        }
        pairs.extend([(0x0409, 0x04B0), (0x0409, 0x04E4), (0x040C, 0x04B0)]);
        for (lang, cp) in pairs {
            let key = wide(&format!(r"\StringFileInfo\{lang:04x}{cp:04x}\FileDescription"));
            if VerQueryValueW(data.as_ptr() as *const _, PCWSTR(key.as_ptr()), &mut ptr, &mut len).as_bool() && len > 1 {
                let text = from_wide(std::slice::from_raw_parts(ptr as *const u16, len as usize)).trim().to_string();
                if !text.is_empty() {
                    return Some(text);
                }
            }
        }
    }
    None
}

/// Pinned shortcuts first (with any matching running windows), then unpinned running apps grouped by exe.
pub fn list_apps() -> Vec<AppEntry> {
    let raw = enumerate_windows();
    let tracked = sentinel::last_external_foreground();
    let foreground = unsafe { GetForegroundWindow() };
    let fg_raw = if window_pid(foreground) == unsafe { GetCurrentProcessId() } { tracked } else { foreground.0 as isize };

    let to_window = |w: &RawWindow| AppWindow {
        hwnd: w.hwnd.0 as i64,
        title: w.title.clone(),
        is_minimized: unsafe { IsIconic(w.hwnd).as_bool() },
        is_active: w.hwnd.0 as isize == fg_raw,
    };

    let mut used = vec![false; raw.len()];
    let mut out = Vec::new();

    for pin in pinned_shortcuts() {
        let target_lower = pin.target.as_ref().map(|t| t.to_ascii_lowercase());
        let mut windows = Vec::new();
        if let Some(target) = &target_lower {
            for (i, w) in raw.iter().enumerate() {
                if !used[i] && w.exe.to_ascii_lowercase() == *target {
                    used[i] = true;
                    windows.push(to_window(w));
                }
            }
        }
        let is_active = windows.iter().any(|w| w.is_active);
        out.push(AppEntry {
            id: pin.path.clone(),
            name: pin.name.clone(),
            exe_path: pin.target.clone(),
            icon_key: pin.path.clone(),
            pinned_path: Some(pin.path),
            windows,
            is_active,
        });
    }

    let mut groups: Vec<(String, Vec<usize>)> = Vec::new();
    for (i, w) in raw.iter().enumerate() {
        if used[i] {
            continue;
        }
        let key = if w.exe.is_empty() { format!("hwnd:{}", w.hwnd.0 as i64) } else { w.exe.to_ascii_lowercase() };
        match groups.iter_mut().find(|(k, _)| *k == key) {
            Some((_, idx)) => idx.push(i),
            None => groups.push((key, vec![i])),
        }
    }
    for (key, indices) in groups {
        let first = &raw[indices[0]];
        let windows: Vec<AppWindow> = indices.iter().map(|&i| to_window(&raw[i])).collect();
        let is_active = windows.iter().any(|w| w.is_active);
        out.push(AppEntry {
            id: key,
            name: display_name(&first.exe, &first.title),
            exe_path: if first.exe.is_empty() { None } else { Some(first.exe.clone()) },
            icon_key: if first.exe.is_empty() { format!("hwnd:{}", first.hwnd.0 as i64) } else { first.exe.clone() },
            pinned_path: None,
            windows,
            is_active,
        });
    }
    out
}

// ---------------------------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------------------------

struct DibCanvas {
    dc: windows::Win32::Graphics::Gdi::HDC,
    bitmap: HBITMAP,
    old: HGDIOBJ,
    bits: *mut u8,
    size: i32,
}

impl DibCanvas {
    unsafe fn new(size: i32) -> Option<DibCanvas> {
        unsafe {
            let screen = GetDC(None);
            let dc = CreateCompatibleDC(Some(screen));
            ReleaseDC(None, screen);
            let bmi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: size,
                    biHeight: -size,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
            let bitmap = match CreateDIBSection(Some(dc), &bmi, DIB_RGB_COLORS, &mut bits, None, 0) {
                Ok(b) => b,
                Err(_) => {
                    let _ = DeleteDC(dc);
                    return None;
                }
            };
            let old = SelectObject(dc, bitmap.into());
            std::ptr::write_bytes(bits as *mut u8, 0, (size * size * 4) as usize);
            Some(DibCanvas { dc, bitmap, old, bits: bits as *mut u8, size })
        }
    }

    fn pixels(&self) -> &[u8] {
        unsafe { std::slice::from_raw_parts(self.bits, (self.size * self.size * 4) as usize) }
    }
}

impl Drop for DibCanvas {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.dc, self.old);
            let _ = DeleteObject(self.bitmap.into());
            let _ = DeleteDC(self.dc);
        }
    }
}

/// Native icon size from GetIconInfo (falls back to 32).
fn icon_size(icon: HICON) -> i32 {
    unsafe {
        let mut info = ICONINFO::default();
        if GetIconInfo(icon, &mut info).is_err() {
            return 32;
        }
        let source = if !info.hbmColor.is_invalid() { info.hbmColor } else { info.hbmMask };
        let mut bm = BITMAP::default();
        let got = GetObjectW(source.into(), std::mem::size_of::<BITMAP>() as i32, Some(&mut bm as *mut _ as *mut _));
        let mut size = if got > 0 { bm.bmWidth } else { 32 };
        if info.hbmColor.is_invalid() {
            // Monochrome icon: mask holds AND + XOR halves stacked vertically.
            size = bm.bmWidth;
        }
        if !info.hbmColor.is_invalid() {
            let _ = DeleteObject(info.hbmColor.into());
        }
        if !info.hbmMask.is_invalid() {
            let _ = DeleteObject(info.hbmMask.into());
        }
        size.clamp(16, 256)
    }
}

/// Render an HICON into straight-alpha RGBA and encode as PNG.
pub fn hicon_to_png(icon: HICON) -> Option<Vec<u8>> {
    let size = icon_size(icon).min(64).max(32);
    unsafe {
        let color = DibCanvas::new(size)?;
        DrawIconEx(color.dc, 0, 0, icon, size, size, 0, None, DI_NORMAL).ok()?;
        let mut rgba = Vec::with_capacity((size * size * 4) as usize);
        let px = color.pixels();
        let has_alpha = px.chunks_exact(4).any(|p| p[3] != 0);

        let mask_pixels = if has_alpha {
            None
        } else {
            let mask = DibCanvas::new(size)?;
            DrawIconEx(mask.dc, 0, 0, icon, size, size, 0, None, DI_MASK).ok()?;
            Some(mask.pixels().to_vec())
        };

        for (i, p) in px.chunks_exact(4).enumerate() {
            let (b, g, r) = (p[0], p[1], p[2]);
            let a = match &mask_pixels {
                None => p[3],
                // Mask: black = opaque, white = transparent.
                Some(m) => if m[i * 4] == 0 { 255 } else { 0 },
            };
            if has_alpha && a > 0 && a < 255 {
                // DIB from DrawIconEx is premultiplied; un-premultiply for PNG.
                let un = |c: u8| ((c as u32 * 255 + a as u32 / 2) / a as u32).min(255) as u8;
                rgba.extend_from_slice(&[un(r), un(g), un(b), a]);
            } else {
                rgba.extend_from_slice(&[r, g, b, a]);
            }
        }

        let img = image::RgbaImage::from_raw(size as u32, size as u32, rgba)?;
        let mut png = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).ok()?;
        Some(png)
    }
}

fn file_icon(path: &str) -> Option<HICON> {
    let wpath = wide(path);
    let mut info = SHFILEINFOW::default();
    let ok = unsafe {
        SHGetFileInfoW(
            PCWSTR(wpath.as_ptr()),
            FILE_ATTRIBUTE_NORMAL,
            Some(&mut info),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        )
    };
    if ok != 0 && !info.hIcon.is_invalid() { Some(info.hIcon) } else { None }
}

fn window_icon(hwnd: HWND) -> Option<HICON> {
    unsafe {
        let mut result: usize = 0;
        SendMessageTimeoutW(hwnd, WM_GETICON, WPARAM(ICON_BIG as usize), LPARAM(0), SMTO_ABORTIFHUNG, 60, Some(&mut result));
        if result == 0 {
            result = GetClassLongPtrW(hwnd, GCLP_HICON);
        }
        if result == 0 { None } else { Some(HICON(result as *mut core::ffi::c_void)) }
    }
}

/// Data URL for an icon key (file path, or `hwnd:<n>`), served from the bounded LRU cache.
pub fn icon_data_url(key: &str) -> Option<String> {
    if let Some(hit) = ICON_CACHE.lock().get(key) {
        return Some(hit);
    }
    let png = if let Some(raw) = key.strip_prefix("hwnd:") {
        raw.parse::<i64>().ok().and_then(|h| {
            // Window icons are owned by the window; never destroy them.
            window_icon(HWND(h as isize as *mut core::ffi::c_void)).and_then(hicon_to_png)
        })
    } else {
        let path = key.to_string();
        with_com(move || {
            file_icon(&path).and_then(|icon| {
                let png = hicon_to_png(icon);
                unsafe {
                    let _ = DestroyIcon(icon);
                }
                png
            })
        })
        .flatten()
    };
    let url = png.map(|bytes| format!("data:image/png;base64,{}", STANDARD.encode(bytes)))?;
    ICON_CACHE.lock().insert(key.to_string(), url.clone());
    Some(url)
}

// ---------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------

/// Taskbar semantics: focused -> minimize, minimized -> restore + focus, background -> focus.
pub fn activate_window(hwnd_raw: i64) -> Result<(), String> {
    let hwnd = HWND(hwnd_raw as isize as *mut core::ffi::c_void);
    unsafe {
        if !IsWindowVisible(hwnd).as_bool() {
            return Err("window no longer exists".into());
        }
        let last_external = sentinel::last_external_foreground();
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
            focus(hwnd);
        } else if last_external == hwnd.0 as isize {
            let _ = ShowWindow(hwnd, SW_MINIMIZE);
        } else {
            focus(hwnd);
        }
    }
    Ok(())
}

pub fn focus(hwnd: HWND) {
    unsafe {
        if !SetForegroundWindow(hwnd).as_bool() {
            SwitchToThisWindow(hwnd, true);
        }
    }
}

pub fn shell_open(target: &str, args: Option<&str>) -> Result<(), String> {
    let wtarget = wide(target);
    let wargs = args.map(wide);
    let result = unsafe {
        ShellExecuteW(
            None,
            w!("open"),
            PCWSTR(wtarget.as_ptr()),
            wargs.as_ref().map(|a| PCWSTR(a.as_ptr())).unwrap_or(PCWSTR::null()),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    // ShellExecute returns a value > 32 on success.
    if result.0 as isize > 32 { Ok(()) } else { Err(format!("ShellExecuteW failed ({})", result.0 as isize)) }
}
