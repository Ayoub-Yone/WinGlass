//! Open application windows for the dock's "active apps" box: every real user window (visible,
//! not a tool window, not cloaked, not the shell, not lumabar), one entry per top-level window.
//!
//! Window filtering and UWP host resolution are shared with `apps_enum` (taskbar semantics); icons
//! go through the same bounded LRU (`apps_enum::icon_data_url`).

use serde::Serialize;
use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::System::Threading::GetCurrentProcessId;
use windows::Win32::UI::WindowsAndMessaging::{
    GetClassNameW, GetForegroundWindow, IsIconic, IsWindow, PostMessageW, SW_RESTORE, ShowWindow, WM_CLOSE,
};

use super::{apps_enum, from_wide, sentinel};

/// Shell surfaces that can look like app windows.
const SHELL_CLASSES: &[&str] = &["Shell_TrayWnd", "Shell_SecondaryTrayWnd", "Progman", "WorkerW"];

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OpenApp {
    pub hwnd: i64,
    pub pid: u32,
    /// Full executable path ("" when the process cannot be queried, e.g. elevated).
    pub exe: String,
    /// Product name from the executable's version info ("Google Chrome"), else the file stem.
    pub name: String,
    pub title: String,
    pub is_focused: bool,
    pub is_minimized: bool,
    /// Key for `get_app_icon` (exe path, or `hwnd:<n>` when the path is unknown).
    pub icon_key: String,
}

fn class_name(hwnd: HWND) -> String {
    let mut buf = [0u16; 128];
    let len = unsafe { GetClassNameW(hwnd, &mut buf) };
    from_wide(&buf[..len.max(0) as usize])
}

/// Pure part of the filter (the visibility / tool-window / cloaking checks happen in apps_enum).
pub fn is_user_app(class: &str, pid: u32, own_pid: u32, title: &str) -> bool {
    pid != own_pid && !SHELL_CLASSES.contains(&class) && !title.trim().is_empty()
}

/// The window the user is working in: the real foreground, or — while lumabar itself is
/// foreground (its flyout was just clicked) — the last external one.
fn effective_foreground(own_pid: u32) -> isize {
    let fg = unsafe { GetForegroundWindow() };
    if apps_enum::window_pid(fg) == own_pid { sentinel::last_external_foreground() } else { fg.0 as isize }
}

pub fn list() -> Vec<OpenApp> {
    let own = unsafe { GetCurrentProcessId() };
    let focused = effective_foreground(own);
    apps_enum::enumerate_windows()
        .into_iter()
        .filter_map(|w| {
            let pid = apps_enum::window_pid(w.hwnd);
            if !is_user_app(&class_name(w.hwnd), pid, own, &w.title) {
                return None;
            }
            let name = if w.exe.is_empty() { w.title.clone() } else { apps_enum::friendly_name(&w.exe) };
            let hwnd = w.hwnd.0 as isize;
            Some(OpenApp {
                hwnd: hwnd as i64,
                pid,
                icon_key: if w.exe.is_empty() { format!("hwnd:{hwnd}") } else { w.exe.clone() },
                exe: w.exe,
                name,
                title: w.title,
                is_focused: hwnd == focused,
                is_minimized: unsafe { IsIconic(w.hwnd).as_bool() },
            })
        })
        .collect()
}

/// Only windows the box actually lists may be focused or closed (never arbitrary HWNDs).
fn listed(hwnd: isize) -> Result<HWND, String> {
    let h = HWND(hwnd as *mut core::ffi::c_void);
    if !unsafe { IsWindow(Some(h)).as_bool() } {
        return Err("this window no longer exists".into());
    }
    if !list().iter().any(|a| a.hwnd as isize == hwnd) {
        return Err("this window is not an open application".into());
    }
    Ok(h)
}

/// Restore if minimized, then bring to the front.
pub fn focus(hwnd: isize) -> Result<(), String> {
    let h = listed(hwnd)?;
    unsafe {
        if IsIconic(h).as_bool() {
            let _ = ShowWindow(h, SW_RESTORE);
        }
    }
    apps_enum::focus(h);
    Ok(())
}

/// Polite close (the app may ask to save).
pub fn close(hwnd: isize) -> Result<(), String> {
    let h = listed(hwnd)?;
    unsafe { PostMessageW(Some(h), WM_CLOSE, WPARAM(0), LPARAM(0)) }.map_err(|e| format!("PostMessageW failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, WINDOW_EX_STYLE, WS_OVERLAPPEDWINDOW, WS_VISIBLE};
    use windows::core::w;

    #[test]
    fn shell_lumabar_and_untitled_windows_are_excluded() {
        assert!(is_user_app("Chrome_WidgetWin_1", 100, 7, "GitHub - Google Chrome"));
        for class in SHELL_CLASSES {
            assert!(!is_user_app(class, 100, 7, "Program Manager"), "{class}");
        }
        assert!(!is_user_app("Tauri Window", 7, 7, "lumabar"));
        assert!(!is_user_app("Notepad", 100, 7, "   "));
    }

    /// Real enumeration: a visible titled window of this (test) process is filtered as "lumabar
    /// itself", and nothing listed is a shell surface, untitled or ours.
    #[test]
    fn real_enumeration_excludes_own_and_shell_windows() {
        unsafe {
            let own = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("STATIC"),
                w!("lumabar open-apps test"),
                WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                -30000,
                -30000,
                200,
                120,
                None,
                None,
                None,
                None,
            )
            .expect("create test window");
            let apps = list();
            let me = GetCurrentProcessId();
            assert!(apps.iter().all(|a| a.pid != me), "own windows are never listed");
            assert!(apps.iter().all(|a| a.hwnd != own.0 as i64));
            for a in &apps {
                assert!(!a.title.trim().is_empty());
                assert!(!SHELL_CLASSES.contains(&class_name(HWND(a.hwnd as isize as *mut _)).as_str()));
                assert!(!a.name.is_empty() && !a.icon_key.is_empty());
            }
            assert!(apps.iter().filter(|a| a.is_focused).count() <= 1);
            // Commands refuse windows that are not listed.
            assert!(focus(own.0 as isize).is_err());
            assert!(close(own.0 as isize).is_err());
            let _ = DestroyWindow(own);
            assert!(focus(own.0 as isize).is_err(), "destroyed window");
        }
    }

    #[test]
    fn friendly_names_come_from_version_info() {
        let explorer = format!("{}\\explorer.exe", std::env::var("WINDIR").unwrap_or_else(|_| "C:\\Windows".into()));
        let name = apps_enum::friendly_name(&explorer);
        assert!(!name.is_empty() && !name.eq_ignore_ascii_case("explorer.exe"), "{name}");
        assert_eq!(apps_enum::friendly_name("C:\\nope\\my-tool.exe"), "My-tool");
    }
}
