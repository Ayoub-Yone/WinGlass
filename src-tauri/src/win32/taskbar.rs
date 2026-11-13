//! Non-destructive Windows taskbar replacement.
//!
//! Safety invariants (see CLAUDE.md):
//! * The original AppBar state is captured once, before any modification, and mirrored to
//!   `%APPDATA%\lumabar\taskbar_state.json` so a hard-killed session can be repaired on next launch.
//! * `restore()` is idempotent, lock-free on the hot path and safe to call from panic hooks,
//!   console handlers and session-end messages.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, Ordering};

use serde::{Deserialize, Serialize};
use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::UI::Shell::{
    ABM_GETSTATE, ABM_SETSTATE, ABS_ALWAYSONTOP, ABS_AUTOHIDE, APPBARDATA, SHAppBarMessage,
};
use windows::Win32::UI::WindowsAndMessaging::{
    FindWindowExW, FindWindowW, IsWindowVisible, SW_HIDE, SW_SHOWNA, ShowWindow,
};
use windows::core::w;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskbarMode {
    /// Leave the Windows taskbar untouched.
    Native,
    /// Force ABS_AUTOHIDE so the native taskbar collapses off-screen.
    AutoHide,
    /// ABS_AUTOHIDE (reclaims the work area) + SW_HIDE on every tray window.
    CompletelyHidden,
}

impl TaskbarMode {
    pub fn parse(value: &str) -> TaskbarMode {
        match value {
            "native" => TaskbarMode::Native,
            "completely_hidden" => TaskbarMode::CompletelyHidden,
            _ => TaskbarMode::AutoHide,
        }
    }
}

#[derive(Serialize, Deserialize)]
struct PersistedState {
    original_state: u32,
}

/// `u32::MAX` means "not captured yet".
static ORIGINAL_STATE: AtomicU32 = AtomicU32::new(u32::MAX);
static MODIFIED: AtomicBool = AtomicBool::new(false);
/// 0 = native, 1 = auto_hide, 2 = completely_hidden
static CURRENT_MODE: AtomicI64 = AtomicI64::new(0);

fn state_file() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(|appdata| PathBuf::from(appdata).join("lumabar").join("taskbar_state.json"))
}

fn persist_original(state: u32) {
    if let Some(path) = state_file() {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string(&PersistedState { original_state: state }) {
            let _ = std::fs::write(path, json);
        }
    }
}

fn clear_persisted() {
    if let Some(path) = state_file() {
        let _ = std::fs::remove_file(path);
    }
}

fn read_persisted() -> Option<u32> {
    let path = state_file()?;
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<PersistedState>(&text).ok().map(|p| p.original_state)
}

/// Primary `Shell_TrayWnd` followed by every `Shell_SecondaryTrayWnd`.
pub fn find_taskbars() -> Vec<HWND> {
    let mut out = Vec::new();
    unsafe {
        if let Ok(primary) = FindWindowW(w!("Shell_TrayWnd"), None) {
            if !primary.is_invalid() {
                out.push(primary);
            }
        }
        let mut after: Option<HWND> = None;
        // Bounded loop: no machine has more than a few dozen monitors.
        for _ in 0..64 {
            match FindWindowExW(None, after, w!("Shell_SecondaryTrayWnd"), None) {
                Ok(hwnd) if !hwnd.is_invalid() => {
                    out.push(hwnd);
                    after = Some(hwnd);
                }
                _ => break,
            }
        }
    }
    out
}

fn appbar_data() -> APPBARDATA {
    let primary = unsafe { FindWindowW(w!("Shell_TrayWnd"), None) }.unwrap_or_default();
    APPBARDATA {
        cbSize: std::mem::size_of::<APPBARDATA>() as u32,
        hWnd: primary,
        uCallbackMessage: 0,
        uEdge: 0,
        rc: RECT::default(),
        lParam: LPARAM(0),
    }
}

pub fn get_state() -> u32 {
    let mut abd = appbar_data();
    unsafe { SHAppBarMessage(ABM_GETSTATE, &mut abd) as u32 }
}

fn set_state(state: u32) {
    let mut abd = appbar_data();
    abd.lParam = LPARAM(state as isize);
    unsafe {
        SHAppBarMessage(ABM_SETSTATE, &mut abd);
    }
}

fn show_all() {
    for hwnd in find_taskbars() {
        unsafe {
            let _ = ShowWindow(hwnd, SW_SHOWNA);
        }
    }
}

fn hide_all() {
    for hwnd in find_taskbars() {
        unsafe {
            let _ = ShowWindow(hwnd, SW_HIDE);
        }
    }
}

/// Used by the guardian process after lumabar died: if the state file still exists, lumabar never
/// restored, so put the taskbar back exactly as it was. Returns true when a repair happened.
pub fn repair_from_persisted() -> bool {
    match read_persisted() {
        Some(previous) => {
            show_all();
            set_state(previous);
            clear_persisted();
            true
        }
        None => false,
    }
}

/// Must run before any modification. If a previous session crashed without restoring,
/// repair the taskbar using the persisted original and keep that as the true original.
pub fn init() {
    if let Some(previous) = read_persisted() {
        show_all();
        set_state(previous);
        ORIGINAL_STATE.store(previous, Ordering::SeqCst);
    } else {
        let state = get_state();
        ORIGINAL_STATE.store(state & (ABS_AUTOHIDE | ABS_ALWAYSONTOP), Ordering::SeqCst);
    }
}

fn capture_original_once() -> u32 {
    let mut original = ORIGINAL_STATE.load(Ordering::SeqCst);
    if original == u32::MAX {
        original = get_state() & (ABS_AUTOHIDE | ABS_ALWAYSONTOP);
        ORIGINAL_STATE.store(original, Ordering::SeqCst);
    }
    original
}

pub fn apply(mode: TaskbarMode) {
    match mode {
        TaskbarMode::Native => {
            restore();
            CURRENT_MODE.store(0, Ordering::SeqCst);
        }
        TaskbarMode::AutoHide => {
            let original = capture_original_once();
            persist_original(original);
            MODIFIED.store(true, Ordering::SeqCst);
            CURRENT_MODE.store(1, Ordering::SeqCst);
            show_all();
            set_state(ABS_AUTOHIDE | (original & ABS_ALWAYSONTOP));
        }
        TaskbarMode::CompletelyHidden => {
            let original = capture_original_once();
            persist_original(original);
            MODIFIED.store(true, Ordering::SeqCst);
            CURRENT_MODE.store(2, Ordering::SeqCst);
            set_state(ABS_AUTOHIDE | (original & ABS_ALWAYSONTOP));
            hide_all();
        }
    }
}

/// Re-apply the current mode (Explorer restarted, or the shell re-showed a hidden tray).
pub fn reapply() {
    match CURRENT_MODE.load(Ordering::SeqCst) {
        1 => apply(TaskbarMode::AutoHide),
        2 => apply(TaskbarMode::CompletelyHidden),
        _ => {}
    }
}

/// In `completely_hidden` mode Windows re-shows the tray when Start opens; hide it again.
pub fn enforce_hidden() {
    if CURRENT_MODE.load(Ordering::SeqCst) != 2 {
        return;
    }
    for hwnd in find_taskbars() {
        unsafe {
            if IsWindowVisible(hwnd).as_bool() {
                let _ = ShowWindow(hwnd, SW_HIDE);
            }
        }
    }
}

/// Unconditional, idempotent restoration of the native taskbar.
pub fn restore() {
    show_all();
    if MODIFIED.swap(false, Ordering::SeqCst) {
        let original = ORIGINAL_STATE.load(Ordering::SeqCst);
        if original != u32::MAX {
            set_state(original);
        }
    }
    CURRENT_MODE.store(0, Ordering::SeqCst);
    clear_persisted();
}
