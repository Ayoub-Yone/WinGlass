//! Notification-area apps behind the dock's « Afficher les icônes cachées » chevron.
//!
//! **Silent enumeration** — the Windows tray / overflow UI is never shown, focused or clicked:
//! 1. Windows 11 records every app that ever showed a tray icon under
//!    `HKCU\Control Panel\NotifyIconSettings\<id>` (`ExecutablePath` — possibly prefixed with a
//!    Known Folder GUID —, `InitialTooltip`, `IsPromoted`, `IconSnapshot`). An entry is live when
//!    its executable is running. lumabar's own entry is listed too (`is_self`).
//! 2. UI Automation (`TreeScope_Descendants`) reads `NotifyItemIcon`s from `Shell_TrayWnd` and the
//!    overflow (`TopLevelWindowForOverflowXamlIsland`) **only when Windows already exposes them**
//!    (taskbar on screen, flyout opened by the user): live names, and with the overflow open,
//!    running apps without a live icon drop out for a while (`ABSENT_TTL`). Windows does not expose
//!    the tray XAML while the taskbar is hidden, and never builds the overflow tree until it opens.
//! 3. Windows 10: the legacy `ToolbarWindow32` of `TrayNotifyWnd\SysPager` and
//!    `NotifyIconOverflowWindow` (`TB_BUTTONCOUNT` / `TB_GETBUTTON` + the shell's `TRAYDATA`, read
//!    from Explorer's memory) — hwnd / uID / callback message and the live HICON of every icon.
//!
//! Icons: the executable's (SHGetFileInfo, bounded LRU), else the live tray HICON (Win10), else one
//! of the app's window icons (WM_GETICON / GCLP_HICON), else the shell's `IconSnapshot`; with none
//! the dock draws a fallback glyph — an item is never dropped for lack of an icon.
//!
//! **Actions** act on the application, never on the shell:
//! * Open — restore + focus the app's main window; else a silent UIA Invoke when the item happens
//!   to be exposed (no cursor, no reveal); else the Win10 tray callback (posted click); else relaunch
//!   the executable (single-instance tray apps surface their window); else show its hidden window.
//! * Quit — `WM_CLOSE` to every top-level window of the app's processes, then, once no visible
//!   window remains, terminate what is still running (a visible "save changes?" prompt is left alone).
//! lumabar's own entry is handled by the dock (Settings modal / restore-and-quit).
//!
//! UIA objects live only on a per-call worker thread that initializes COM itself (invariant 5).

use std::collections::HashSet;
use std::path::Path;
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM, RECT, WAIT_TIMEOUT, WPARAM};
use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize};
use windows::Win32::System::Diagnostics::Debug::ReadProcessMemory;
use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS};
use windows::Win32::System::Memory::{MEM_COMMIT, MEM_RELEASE, MEM_RESERVE, PAGE_READWRITE, VirtualAllocEx, VirtualFreeEx};
use windows::Win32::System::Registry::{
    HKEY, HKEY_CURRENT_USER, KEY_READ, REG_VALUE_TYPE, RRF_RT_REG_BINARY, RRF_RT_REG_DWORD, RRF_RT_REG_SZ, RegCloseKey, RegEnumKeyExW,
    RegGetValueW, RegOpenKeyExW,
};
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, PROCESS_VM_OPERATION, PROCESS_VM_READ,
    TerminateProcess, WaitForSingleObject,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationInvokePattern, IUIAutomationLegacyIAccessiblePattern,
    TreeScope_Descendants, UIA_InvokePatternId, UIA_LegacyIAccessiblePatternId,
};
use windows::Win32::UI::Shell::{KF_FLAG_DEFAULT, SHGetKnownFolderPath};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, FindWindowExW, FindWindowW, GW_OWNER, GWL_EXSTYLE, GWL_STYLE, GetWindow, GetWindowLongW, GetWindowRect,
    GetWindowTextLengthW, GetWindowThreadProcessId, IsIconic, IsWindowVisible, PostMessageW, SW_RESTORE, SW_SHOW, SendMessageW, ShowWindow,
    WM_CLOSE, WM_LBUTTONDOWN, WM_LBUTTONUP, WS_CAPTION, WS_EX_TOOLWINDOW,
};
use windows::core::{BOOL, GUID, PCWSTR, PWSTR, w};

use super::{apps_enum, from_wide, wide};

const SETTINGS_KEY: &str = r"Control Panel\NotifyIconSettings";
/// A running app the live tray tree showed without an icon stays out of the list this long.
const ABSENT_TTL: Duration = Duration::from_secs(10 * 60);
/// How long Quit waits for the windows to close before terminating what is left.
const QUIT_GRACE: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrayIcon {
    /// NotifyIconSettings sub-key (stable across restarts), or `tb:<hwnd>:<uid>` on Windows 10.
    pub id: String,
    pub name: String,
    pub exe: String,
    /// PNG data URL; None = the dock draws its fallback glyph.
    pub icon_png: Option<String>,
    /// Lives in the "hidden icons" overflow rather than on the taskbar.
    pub is_hidden_overflow: bool,
    /// lumabar's own tray entry (the dock handles Open / Settings / Quit itself).
    pub is_self: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Open,
    /// The app's main window to the front (lumabar's own Settings are opened by the dock).
    Settings,
    Quit,
}

impl Action {
    pub fn parse(s: &str) -> Option<Action> {
        match s {
            "open" => Some(Action::Open),
            "settings" => Some(Action::Settings),
            "quit" => Some(Action::Quit),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    /// A main window was restored / focused.
    Focused,
    /// The tray item itself was invoked (UIA, or the Win10 callback message).
    Invoked,
    /// The executable was started again (single-instance apps surface their window).
    Launched,
    /// The app's hidden main window was shown.
    Shown,
    /// Every process exited after WM_CLOSE.
    Closed,
    /// Windows were closed, the background process was terminated.
    Terminated,
    /// A window is still visible after WM_CLOSE (e.g. a "save changes?" prompt): left to the user.
    StillOpen,
}

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

/// `{GUID}\rest` -> (GUID, rest). Plain paths -> None.
pub fn split_known_folder(path: &str) -> Option<(GUID, &str)> {
    let rest = path.strip_prefix('{')?;
    let end = rest.find('}')?;
    let hex: String = rest[..end].chars().filter(|c| *c != '-').collect();
    if hex.len() != 32 {
        return None;
    }
    let value = u128::from_str_radix(&hex, 16).ok()?;
    Some((GUID::from_u128(value), rest[end + 1..].trim_start_matches('\\')))
}

fn fold(s: &str) -> String {
    super::app_search::fold(s.trim())
}

/// How well a UIA tray item name ("Riot Client", " Discord", "AMD Software: Adrenalin Edition\n…")
/// matches one of an entry's names. 0 = no match.
pub fn match_score(candidates: &[String], uia_name: &str) -> u32 {
    let item = fold(uia_name.lines().next().unwrap_or(""));
    if item.is_empty() {
        return 0;
    }
    let mut best = 0;
    for c in candidates.iter().map(|c| fold(c)).filter(|c| c.len() >= 2) {
        let score = if c == item {
            100
        } else if item.starts_with(&c) || c.starts_with(&item) {
            80
        } else if item.contains(&c) || c.contains(&item) {
            60
        } else {
            let a: HashSet<&str> = item.split(|ch: char| !ch.is_alphanumeric()).filter(|w| w.len() >= 3).collect();
            let shared = c.split(|ch: char| !ch.is_alphanumeric()).filter(|w| w.len() >= 3 && a.contains(w)).count();
            if shared > 0 { 30 + 10 * shared as u32 } else { 0 }
        };
        best = best.max(score);
    }
    best
}

/// System-owned entries (Explorer, the Windows Update flyout host…) are not apps.
fn is_shell_owned(exe_lower: &str) -> bool {
    exe_lower.ends_with("\\explorer.exe") || exe_lower.ends_with("\\monotificationux.exe") || exe_lower.ends_with("\\rundll32.exe")
}

/// Drop bidi / zero-width marks shells put in tooltips (U+202A before "Microsoft 365…").
pub fn clean_name(s: &str) -> String {
    s.lines()
        .next()
        .unwrap_or("")
        .chars()
        .filter(|c| !matches!(*c as u32, 0x200B..=0x200F | 0x202A..=0x202E | 0x2066..=0x2069 | 0xFEFF))
        .collect::<String>()
        .trim()
        .to_string()
}

pub fn has_area(r: RECT) -> bool {
    r.right - r.left >= 4 && r.bottom - r.top >= 4
}

/// What Quit does once the grace period is over.
#[derive(Debug, PartialEq, Eq)]
pub enum QuitStep {
    Done,
    /// A visible window survived WM_CLOSE: the app is asking the user something.
    LeaveToUser,
    /// Only background processes remain.
    Terminate,
}

pub fn quit_step(alive_processes: usize, visible_windows: usize) -> QuitStep {
    if alive_processes == 0 {
        QuitStep::Done
    } else if visible_windows > 0 {
        QuitStep::LeaveToUser
    } else {
        QuitStep::Terminate
    }
}

/// Exes (lower-case) the live tray tree showed without an icon, with when that was seen.
#[derive(Debug, Default)]
pub struct Absent(Vec<(String, Instant)>);

impl Absent {
    pub fn mark(&mut self, exe: &str, at: Instant) {
        self.clear(exe);
        self.0.push((exe.to_string(), at));
        if self.0.len() > 64 {
            self.0.remove(0);
        }
    }
    pub fn clear(&mut self, exe: &str) {
        self.0.retain(|(e, _)| e != exe);
    }
    pub fn contains(&self, exe: &str, now: Instant, ttl: Duration) -> bool {
        self.0.iter().any(|(e, at)| e == exe && now.saturating_duration_since(*at) < ttl)
    }
}

static ABSENT: Lazy<Mutex<Absent>> = Lazy::new(|| Mutex::new(Absent::default()));

// ---------------------------------------------------------------------------------------------
// Registry + processes
// ---------------------------------------------------------------------------------------------

struct Entry {
    id: String,
    exe: String,
    tooltip: String,
    promoted: bool,
    snapshot: Option<Vec<u8>>,
}

fn reg_value(key: HKEY, sub: &str, name: &str, flags: windows::Win32::System::Registry::REG_ROUTINE_FLAGS) -> Option<Vec<u8>> {
    let wsub = wide(sub);
    let wname = wide(name);
    unsafe {
        let mut size = 0u32;
        let mut kind = REG_VALUE_TYPE::default();
        RegGetValueW(key, PCWSTR(wsub.as_ptr()), PCWSTR(wname.as_ptr()), flags, Some(&mut kind), None, Some(&mut size)).ok().ok()?;
        let mut buf = vec![0u8; size as usize];
        RegGetValueW(
            key,
            PCWSTR(wsub.as_ptr()),
            PCWSTR(wname.as_ptr()),
            flags,
            Some(&mut kind),
            Some(buf.as_mut_ptr() as *mut _),
            Some(&mut size),
        )
        .ok()
        .ok()?;
        buf.truncate(size as usize);
        Some(buf)
    }
}

fn reg_string(key: HKEY, sub: &str, name: &str) -> Option<String> {
    let bytes = reg_value(key, sub, name, RRF_RT_REG_SZ)?;
    let units: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
    Some(from_wide(&units))
}

fn expand_known_folder(path: &str) -> String {
    let Some((guid, rest)) = split_known_folder(path) else { return path.to_string() };
    unsafe {
        match SHGetKnownFolderPath(&guid, KF_FLAG_DEFAULT, None) {
            Ok(p) => {
                let base = p.to_string().unwrap_or_default();
                CoTaskMemFree(Some(p.0 as *const _));
                Path::new(&base).join(rest).to_string_lossy().into_owned()
            }
            Err(_) => path.to_string(),
        }
    }
}

fn read_entries() -> Vec<Entry> {
    let mut out = Vec::new();
    let wkey = wide(SETTINGS_KEY);
    let mut key = HKEY::default();
    if unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, PCWSTR(wkey.as_ptr()), None, KEY_READ, &mut key) }.is_err() {
        return out;
    }
    let mut index = 0u32;
    loop {
        let mut name = [0u16; 128];
        let mut len = name.len() as u32;
        if unsafe { RegEnumKeyExW(key, index, Some(PWSTR(name.as_mut_ptr())), &mut len, None, None, None, None) }.is_err() {
            break;
        }
        index += 1;
        let id = from_wide(&name[..len as usize]);
        let Some(raw_exe) = reg_string(key, &id, "ExecutablePath") else { continue };
        let promoted = reg_value(key, &id, "IsPromoted", RRF_RT_REG_DWORD)
            .map(|b| b.first().copied().unwrap_or(0) != 0)
            .unwrap_or(false);
        let snapshot = reg_value(key, &id, "IconSnapshot", RRF_RT_REG_BINARY).filter(|b| b.starts_with(&[0x89, b'P', b'N', b'G']));
        let tooltip = reg_string(key, &id, "InitialTooltip").unwrap_or_default();
        out.push(Entry { id, exe: expand_known_folder(&raw_exe), tooltip, promoted, snapshot });
    }
    unsafe {
        let _ = RegCloseKey(key);
    }
    out
}

/// (pid, lower-cased image path) of every process we can query.
fn processes() -> Vec<(u32, String)> {
    let mut out = Vec::new();
    unsafe {
        if let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
            let mut ok = Process32FirstW(snap, &mut entry).is_ok();
            while ok {
                if let Some(path) = apps_enum::process_image_path(entry.th32ProcessID) {
                    out.push((entry.th32ProcessID, path.to_ascii_lowercase()));
                }
                ok = Process32NextW(snap, &mut entry).is_ok();
            }
            let _ = CloseHandle(snap);
        }
    }
    out
}

static RUNNING: Lazy<Mutex<Option<(Instant, Vec<(u32, String)>)>>> = Lazy::new(|| Mutex::new(None));

/// `processes()` cached for 2 s (the popup refreshes while open).
fn running() -> Vec<(u32, String)> {
    if let Some((at, list)) = RUNNING.lock().as_ref() {
        if at.elapsed() < Duration::from_secs(2) {
            return list.clone();
        }
    }
    let list = processes();
    *RUNNING.lock() = Some((Instant::now(), list.clone()));
    list
}

fn pids_of(exe_lower: &str) -> Vec<u32> {
    processes().into_iter().filter(|(_, p)| p == exe_lower).map(|(pid, _)| pid).collect()
}

fn own_exe() -> String {
    std::env::current_exe().map(|p| p.to_string_lossy().to_ascii_lowercase()).unwrap_or_default()
}

/// Names a tray item may carry for this app, best display name first: a short tooltip, the product
/// name, the file stem. (A tooltip that is a whole sentence is a status, not a name.)
fn candidates_for(exe: &str, tooltip: &str) -> Vec<String> {
    let mut names = Vec::new();
    let tooltip = clean_name(tooltip);
    let friendly = apps_enum::friendly_name(exe);
    if !tooltip.is_empty() && tooltip.chars().count() <= 32 {
        names.push(tooltip.clone());
    }
    names.push(friendly);
    if !tooltip.is_empty() && tooltip.chars().count() > 32 {
        names.push(tooltip);
    }
    if let Some(stem) = Path::new(exe).file_stem().and_then(|s| s.to_str()) {
        names.push(stem.to_string());
    }
    names
}

/// Names seen on real tray items (exe -> tray name), so the list shows them.
static SEEN_NAMES: Lazy<Mutex<Vec<(String, String)>>> = Lazy::new(|| Mutex::new(Vec::new()));

fn remember_name(exe: &str, name: &str) {
    let name = clean_name(name);
    if name.is_empty() {
        return;
    }
    let lower = exe.to_ascii_lowercase();
    let mut seen = SEEN_NAMES.lock();
    seen.retain(|(e, _)| *e != lower);
    seen.push((lower, name));
    if seen.len() > 64 {
        seen.remove(0);
    }
}

fn live_entries() -> Vec<Entry> {
    let running: HashSet<String> = running().into_iter().map(|(_, p)| p).collect();
    let mut seen = HashSet::new();
    read_entries()
        .into_iter()
        .filter(|e| {
            let lower = e.exe.to_ascii_lowercase();
            running.contains(&lower) && !is_shell_owned(&lower) && seen.insert(lower)
        })
        .collect()
}

// ---------------------------------------------------------------------------------------------
// Windows 10 legacy tray toolbar (TRAYDATA)
// ---------------------------------------------------------------------------------------------

const TB_GETBUTTON: u32 = 0x0417;
const TB_BUTTONCOUNT: u32 = 0x0418;
const TB_GETBUTTONTEXTW: u32 = 0x044B;

/// `TBBUTTON` (x64 layout).
#[repr(C)]
#[derive(Default, Clone, Copy)]
struct TbButton {
    i_bitmap: i32,
    id_command: i32,
    fs_state: u8,
    fs_style: u8,
    reserved: [u8; 6],
    dw_data: usize,
    i_string: isize,
}

/// The shell's per-button `TRAYDATA` (what `Shell_NotifyIcon` registered).
#[repr(C)]
#[derive(Default, Clone, Copy)]
struct TrayData {
    hwnd: usize,
    uid: u32,
    callback: u32,
    reserved: [u32; 2],
    hicon: usize,
}

#[derive(Debug, Clone)]
struct ToolbarItem {
    hwnd: isize,
    uid: u32,
    callback: u32,
    hicon: isize,
    tooltip: String,
    exe: String,
    overflow: bool,
}

struct Remote {
    process: HANDLE,
    base: *mut core::ffi::c_void,
}

impl Drop for Remote {
    fn drop(&mut self) {
        unsafe {
            let _ = VirtualFreeEx(self.process, self.base, 0, MEM_RELEASE);
            let _ = CloseHandle(self.process);
        }
    }
}

fn read_remote<T: Default + Copy>(process: HANDLE, addr: usize) -> Option<T> {
    let mut value = T::default();
    unsafe {
        ReadProcessMemory(process, addr as *const _, &mut value as *mut T as *mut _, std::mem::size_of::<T>(), None).ok()?;
    }
    Some(value)
}

fn read_remote_text(process: HANDLE, addr: usize, units: usize) -> Option<String> {
    let mut buf = vec![0u16; units];
    unsafe {
        ReadProcessMemory(process, addr as *const _, buf.as_mut_ptr() as *mut _, units * 2, None).ok()?;
    }
    Some(from_wide(&buf))
}

/// Every button of one legacy tray toolbar (Windows 10). Empty on Windows 11.
fn read_toolbar(toolbar: HWND, overflow: bool) -> Vec<ToolbarItem> {
    let mut out = Vec::new();
    unsafe {
        let count = SendMessageW(toolbar, TB_BUTTONCOUNT, None, None).0;
        if count <= 0 {
            return out;
        }
        let mut shell_pid = 0u32;
        GetWindowThreadProcessId(toolbar, Some(&mut shell_pid));
        let Ok(process) = OpenProcess(PROCESS_VM_OPERATION | PROCESS_VM_READ, false, shell_pid) else { return out };
        let base = VirtualAllocEx(process, None, 4096, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
        if base.is_null() {
            let _ = CloseHandle(process);
            return out;
        }
        let remote = Remote { process, base };
        let text_at = remote.base as usize + 256;
        for i in 0..count.min(256) {
            if SendMessageW(toolbar, TB_GETBUTTON, Some(WPARAM(i as usize)), Some(LPARAM(remote.base as isize))).0 == 0 {
                continue;
            }
            let Some(button) = read_remote::<TbButton>(remote.process, remote.base as usize) else { continue };
            if button.dw_data == 0 {
                continue;
            }
            let Some(data) = read_remote::<TrayData>(remote.process, button.dw_data) else { continue };
            if data.hwnd == 0 {
                continue;
            }
            // Tooltips are at most 128 UTF-16 units (szTip): well inside the 3.8 KB scratch area.
            let len = SendMessageW(toolbar, TB_GETBUTTONTEXTW, Some(WPARAM(button.id_command as usize)), Some(LPARAM(text_at as isize))).0;
            let tooltip = if len > 0 {
                read_remote_text(remote.process, text_at, (len as usize).min(256)).unwrap_or_default()
            } else {
                String::new()
            };
            let hwnd = HWND(data.hwnd as *mut _);
            let exe = apps_enum::process_image_path(apps_enum::window_pid(hwnd)).unwrap_or_default();
            out.push(ToolbarItem {
                hwnd: data.hwnd as isize,
                uid: data.uid,
                callback: data.callback,
                hicon: data.hicon as isize,
                tooltip,
                exe,
                overflow,
            });
        }
    }
    out
}

/// The legacy tray toolbars: TrayNotifyWnd\SysPager and the overflow window (Windows 10 only).
fn toolbar_items() -> Vec<ToolbarItem> {
    let mut out = Vec::new();
    unsafe {
        if let Ok(tray) = FindWindowW(w!("Shell_TrayWnd"), None) {
            let pager = FindWindowExW(Some(tray), None, w!("TrayNotifyWnd"), None)
                .and_then(|notify| FindWindowExW(Some(notify), None, w!("SysPager"), None));
            if let Ok(toolbar) = pager.and_then(|p| FindWindowExW(Some(p), None, w!("ToolbarWindow32"), None)) {
                out.extend(read_toolbar(toolbar, false));
            }
        }
        if let Ok(overflow) = FindWindowW(w!("NotifyIconOverflowWindow"), None) {
            if let Ok(toolbar) = FindWindowExW(Some(overflow), None, w!("ToolbarWindow32"), None) {
                out.extend(read_toolbar(toolbar, true));
            }
        }
    }
    out.retain(|t| !t.exe.is_empty() && !is_shell_owned(&t.exe.to_ascii_lowercase()));
    out
}

fn hicon_data_url(hicon: isize) -> Option<String> {
    if hicon == 0 {
        return None;
    }
    // A tray HICON is a shared USER object owned by the app: render it, never destroy it.
    let png = apps_enum::hicon_to_png(windows::Win32::UI::WindowsAndMessaging::HICON(hicon as *mut _))?;
    Some(format!("data:image/png;base64,{}", STANDARD.encode(png)))
}

// ---------------------------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------------------------

/// A window icon of one of the app's processes (`hwnd:` keys go through the icon LRU).
fn window_icon_of(pids: &HashSet<u32>) -> Option<String> {
    windows_of(pids)
        .into_iter()
        .filter(|w| w.main_like)
        .find_map(|w| apps_enum::icon_data_url(&format!("hwnd:{}", w.hwnd.0 as isize)))
}

pub fn list() -> Vec<TrayIcon> {
    let entries = live_entries();
    // Live UIA names when Windows already exposes the tray (never revealed for this).
    if let Ok(Some((names, complete))) = on_uia_thread(exposed_tray_names) {
        reconcile(&entries, &names, complete);
    }
    let toolbar = toolbar_items();
    let procs = running();
    let pids = |exe_lower: &str| procs.iter().filter(|(_, p)| p == exe_lower).map(|(pid, _)| *pid).collect::<HashSet<u32>>();
    let own = own_exe();
    let seen = SEEN_NAMES.lock().clone();
    let now = Instant::now();
    let mut listed: HashSet<String> = HashSet::new();
    let mut out = Vec::new();

    for e in entries {
        let lower = e.exe.to_ascii_lowercase();
        if ABSENT.lock().contains(&lower, now, ABSENT_TTL) {
            continue;
        }
        let tb = toolbar.iter().find(|t| t.exe.to_ascii_lowercase() == lower);
        let name = seen
            .iter()
            .find(|(exe, _)| *exe == lower)
            .map(|(_, n)| n.clone())
            .unwrap_or_else(|| candidates_for(&e.exe, &e.tooltip).into_iter().next().unwrap_or_default());
        let icon_png = apps_enum::icon_data_url(&e.exe)
            .or_else(|| tb.and_then(|t| hicon_data_url(t.hicon)))
            .or_else(|| window_icon_of(&pids(&lower)))
            .or_else(|| e.snapshot.as_ref().map(|png| format!("data:image/png;base64,{}", STANDARD.encode(png))));
        out.push(TrayIcon { id: e.id, name: clean_name(&name), is_self: lower == own, exe: e.exe, icon_png, is_hidden_overflow: !e.promoted });
        listed.insert(lower);
    }
    // Windows 10: the legacy toolbar is the source of truth.
    for t in &toolbar {
        let lower = t.exe.to_ascii_lowercase();
        if !listed.insert(lower.clone()) {
            continue;
        }
        let name = candidates_for(&t.exe, &t.tooltip).into_iter().next().unwrap_or_default();
        let icon_png = hicon_data_url(t.hicon).or_else(|| apps_enum::icon_data_url(&t.exe)).or_else(|| window_icon_of(&pids(&lower)));
        out.push(TrayIcon {
            id: format!("tb:{}:{}", t.hwnd, t.uid),
            name: clean_name(&name),
            exe: t.exe.clone(),
            icon_png,
            is_hidden_overflow: t.overflow,
            is_self: lower == own,
        });
    }
    // Taskbar-promoted icons first, then alphabetical (stable while apps come and go).
    out.sort_by(|a, b| a.is_hidden_overflow.cmp(&b.is_hidden_overflow).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    out
}

/// Live tray item names. `complete` = the overflow flyout was read too, so an entry missing from
/// `names` really has no icon (otherwise only matches count).
fn reconcile(entries: &[Entry], names: &[String], complete: bool) {
    let now = Instant::now();
    for e in entries {
        let lower = e.exe.to_ascii_lowercase();
        let candidates = candidates_for(&e.exe, &e.tooltip);
        let best = names.iter().map(|n| (match_score(&candidates, n), n)).max_by_key(|(s, _)| *s);
        match best {
            Some((score, name)) if score >= 60 => {
                ABSENT.lock().clear(&lower);
                remember_name(&e.exe, name);
            }
            _ if complete => ABSENT.lock().mark(&lower, now),
            _ => {}
        }
    }
}

// ---------------------------------------------------------------------------------------------
// UI Automation (read-only unless the item is already exposed)
// ---------------------------------------------------------------------------------------------

struct Item {
    element: IUIAutomationElement,
    name: String,
    rect: RECT,
}

fn bstr(r: windows::core::Result<windows::core::BSTR>) -> String {
    r.map(|b| b.to_string()).unwrap_or_default()
}

/// Notification icons under a shell window (Start, Search, Task View, Widgets, the clock and Quick
/// Settings are other automation ids and never match).
fn tray_items(uia: &IUIAutomation, hwnd: HWND) -> Vec<Item> {
    let mut items = Vec::new();
    unsafe {
        let Ok(root) = uia.ElementFromHandle(hwnd) else { return items };
        let Ok(cond) = uia.CreateTrueCondition() else { return items };
        let Ok(all) = root.FindAll(TreeScope_Descendants, &cond) else { return items };
        for i in 0..all.Length().unwrap_or(0) {
            let Ok(el) = all.GetElement(i) else { continue };
            if bstr(el.CurrentAutomationId()) == "NotifyItemIcon" {
                let rect = el.CurrentBoundingRectangle().unwrap_or_default();
                items.push(Item { name: bstr(el.CurrentName()), element: el, rect });
            }
        }
    }
    items
}

/// The hidden-icons flyout, when the user has it open.
fn overflow_window() -> Option<HWND> {
    let hwnd = unsafe { FindWindowW(w!("TopLevelWindowForOverflowXamlIsland"), None) }.ok()?;
    unsafe { IsWindowVisible(hwnd) }.as_bool().then_some(hwnd)
}

/// Tray items Windows currently exposes, plus whether the overflow was among them.
fn exposed_items(uia: &IUIAutomation) -> Option<(Vec<Item>, bool)> {
    let tray = unsafe { FindWindowW(w!("Shell_TrayWnd"), None) }.ok()?;
    let mut items: Vec<Item> = if unsafe { IsWindowVisible(tray) }.as_bool() { tray_items(uia, tray) } else { Vec::new() };
    let overflow = overflow_window();
    if let Some(o) = overflow {
        items.extend(tray_items(uia, o));
    }
    items.retain(|i| has_area(i.rect));
    (!items.is_empty()).then_some((items, overflow.is_some()))
}

fn exposed_tray_names() -> Result<Option<(Vec<String>, bool)>, String> {
    let uia: IUIAutomation = unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }.map_err(|e| e.to_string())?;
    Ok(exposed_items(&uia).map(|(items, complete)| (items.into_iter().map(|i| i.name).collect(), complete)))
}

/// Invoke the item if (and only if) Windows already exposes it: no cursor, no reveal.
fn silent_invoke(candidates: &[String]) -> Result<bool, String> {
    let uia: IUIAutomation = unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }.map_err(|e| e.to_string())?;
    let Some((items, _)) = exposed_items(&uia) else { return Ok(false) };
    let Some(item) = items.into_iter().map(|i| (match_score(candidates, &i.name), i)).filter(|(s, _)| *s >= 60).max_by_key(|(s, _)| *s).map(|(_, i)| i)
    else {
        return Ok(false);
    };
    unsafe {
        if let Ok(invoke) = item.element.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId) {
            if invoke.Invoke().is_ok() {
                return Ok(true);
            }
        }
        if let Ok(legacy) = item.element.GetCurrentPatternAs::<IUIAutomationLegacyIAccessiblePattern>(UIA_LegacyIAccessiblePatternId) {
            if legacy.DoDefaultAction().is_ok() {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// Run `f` on a fresh COM-MTA thread (UIA objects never leave it).
fn on_uia_thread<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    std::thread::Builder::new()
        .name("lumabar-tray-uia".into())
        .spawn(move || {
            let init = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            let out = f();
            if init.is_ok() {
                unsafe { CoUninitialize() };
            }
            out
        })
        .map_err(|e| e.to_string())?
        .join()
        .map_err(|_| "the tray worker crashed".to_string())?
}

// ---------------------------------------------------------------------------------------------
// Application windows
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct ProcWindow {
    hwnd: HWND,
    visible: bool,
    iconic: bool,
    /// Not owned by a visible window, not a tool window, titled: what a user calls "the app's
    /// window" (a hidden owner is the classic trick to keep a window off the taskbar).
    main_like: bool,
    area: i64,
}

/// Top-level windows (visible or not) of these processes. Never includes shell windows: the pids
/// come from the app's executable, and shell executables are never listed.
fn windows_of(pids: &HashSet<u32>) -> Vec<ProcWindow> {
    struct Ctx<'a> {
        pids: &'a HashSet<u32>,
        out: Vec<ProcWindow>,
    }
    unsafe extern "system" fn cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = unsafe { &mut *(lparam.0 as *mut Ctx) };
        let pid = apps_enum::window_pid(hwnd);
        if ctx.pids.contains(&pid) {
            unsafe {
                let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
                let owned = GetWindow(hwnd, GW_OWNER).is_ok_and(|o| !o.is_invalid() && IsWindowVisible(o).as_bool());
                let mut r = RECT::default();
                let _ = GetWindowRect(hwnd, &mut r);
                ctx.out.push(ProcWindow {
                    hwnd,
                    visible: IsWindowVisible(hwnd).as_bool(),
                    iconic: IsIconic(hwnd).as_bool(),
                    main_like: !owned && ex & WS_EX_TOOLWINDOW.0 == 0 && GetWindowTextLengthW(hwnd) > 0,
                    area: i64::from(r.right - r.left) * i64::from(r.bottom - r.top),
                });
            }
        }
        BOOL(1)
    }
    let mut ctx = Ctx { pids, out: Vec::new() };
    unsafe {
        let _ = EnumWindows(Some(cb), LPARAM(&mut ctx as *mut Ctx as isize));
    }
    ctx.out
}

fn bring_to_front(w: &ProcWindow) {
    unsafe {
        if !w.visible {
            let _ = ShowWindow(w.hwnd, SW_SHOW);
        }
        if w.iconic || !w.visible {
            let _ = ShowWindow(w.hwnd, SW_RESTORE);
        }
    }
    apps_enum::focus(w.hwnd);
}

/// The largest main-like window, visible ones only or hidden ones only.
fn main_window(windows: &[ProcWindow], visible: bool) -> Option<ProcWindow> {
    windows
        .iter()
        .filter(|w| w.main_like && w.visible == visible)
        .filter(|w| visible || w.area >= 200 * 120)
        // A hidden window must look like a real frame (not a 0x0 message sink).
        .filter(|w| visible || unsafe { GetWindowLongW(w.hwnd, GWL_STYLE) as u32 } & WS_CAPTION.0 != 0)
        .max_by_key(|w| (!w.iconic, w.area))
        .cloned()
}

/// What an action needs to know about its target app.
struct Target {
    exe: String,
    pids: HashSet<u32>,
    candidates: Vec<String>,
    toolbar: Option<ToolbarItem>,
}

fn open_target(t: &Target) -> Result<Outcome, String> {
    if t.pids.is_empty() {
        return Err("this app is no longer running".into());
    }
    let windows = windows_of(&t.pids);
    if let Some(w) = main_window(&windows, true) {
        bring_to_front(&w);
        return Ok(Outcome::Focused);
    }
    let candidates = t.candidates.clone();
    if on_uia_thread(move || silent_invoke(&candidates)).unwrap_or(false) {
        return Ok(Outcome::Invoked);
    }
    if let Some(tb) = &t.toolbar {
        // Classic NOTIFYICON callback: wParam = uID, lParam = mouse message.
        let hwnd = HWND(tb.hwnd as *mut _);
        unsafe {
            if PostMessageW(Some(hwnd), tb.callback, WPARAM(tb.uid as usize), LPARAM(WM_LBUTTONDOWN as isize)).is_ok()
                && PostMessageW(Some(hwnd), tb.callback, WPARAM(tb.uid as usize), LPARAM(WM_LBUTTONUP as isize)).is_ok()
            {
                return Ok(Outcome::Invoked);
            }
        }
    }
    // Packaged apps (WindowsApps) cannot be started from their image path.
    let packaged = t.exe.to_ascii_lowercase().contains("\\windowsapps\\");
    if !packaged && Path::new(&t.exe).is_file() && apps_enum::shell_open(&t.exe, None).is_ok() {
        return Ok(Outcome::Launched);
    }
    if let Some(w) = main_window(&windows, false) {
        bring_to_front(&w);
        return Ok(Outcome::Shown);
    }
    Err("this app has no window to open".into())
}

fn is_alive(pid: u32) -> bool {
    unsafe {
        match OpenProcess(PROCESS_SYNCHRONIZE, false, pid) {
            Ok(h) => {
                let alive = WaitForSingleObject(h, 0) == WAIT_TIMEOUT;
                let _ = CloseHandle(h);
                alive
            }
            Err(_) => false,
        }
    }
}

fn quit_target(t: &Target) -> Result<Outcome, String> {
    let own = std::process::id();
    let pids: HashSet<u32> = t.pids.iter().copied().filter(|p| *p != own).collect();
    if pids.is_empty() {
        return Err("this app is no longer running".into());
    }
    for w in windows_of(&pids) {
        unsafe {
            let _ = PostMessageW(Some(w.hwnd), WM_CLOSE, WPARAM(0), LPARAM(0));
        }
    }
    let start = Instant::now();
    let mut alive: HashSet<u32> = pids.clone();
    while start.elapsed() < QUIT_GRACE {
        alive.retain(|p| is_alive(*p));
        if alive.is_empty() {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let visible = windows_of(&alive).iter().filter(|w| w.visible && w.main_like).count();
    match quit_step(alive.len(), visible) {
        QuitStep::Done => Ok(Outcome::Closed),
        QuitStep::LeaveToUser => Ok(Outcome::StillOpen),
        QuitStep::Terminate => {
            let mut denied = 0;
            for pid in &alive {
                unsafe {
                    match OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, false, *pid) {
                        Ok(h) => {
                            if TerminateProcess(h, 0).is_err() {
                                denied += 1;
                            }
                            let _ = CloseHandle(h);
                        }
                        Err(_) => denied += 1,
                    }
                }
            }
            if denied > 0 && denied == alive.len() {
                Err("Windows refused to close this app (it may run as administrator)".into())
            } else {
                Ok(Outcome::Terminated)
            }
        }
    }
}

fn target_by_id(id: &str) -> Result<Target, String> {
    if let Some(rest) = id.strip_prefix("tb:") {
        let tb = toolbar_items()
            .into_iter()
            .find(|t| format!("{}:{}", t.hwnd, t.uid) == rest)
            .ok_or_else(|| "this tray app is no longer running".to_string())?;
        let lower = tb.exe.to_ascii_lowercase();
        return Ok(Target { pids: pids_of(&lower).into_iter().collect(), candidates: candidates_for(&tb.exe, &tb.tooltip), exe: tb.exe.clone(), toolbar: Some(tb) });
    }
    let e = live_entries().into_iter().find(|e| e.id == id).ok_or_else(|| "this tray app is no longer running".to_string())?;
    let lower = e.exe.to_ascii_lowercase();
    let toolbar = toolbar_items().into_iter().find(|t| t.exe.to_ascii_lowercase() == lower);
    Ok(Target { pids: pids_of(&lower).into_iter().collect(), candidates: candidates_for(&e.exe, &e.tooltip), exe: e.exe, toolbar })
}

/// Open / Settings / Quit for a tray app. lumabar's own entry is refused (the dock opens its
/// Settings modal or runs the restore-and-quit path itself).
pub fn act(id: &str, action: Action) -> Result<Outcome, String> {
    let target = target_by_id(id)?;
    if target.exe.to_ascii_lowercase() == own_exe() || target.pids.contains(&std::process::id()) {
        return Err("lumabar's own entry is handled by the dock".into());
    }
    match action {
        Action::Open | Action::Settings => open_target(&target),
        Action::Quit => {
            let out = quit_target(&target);
            *RUNNING.lock() = None;
            out
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

    #[test]
    fn known_folder_prefixes_are_split() {
        let (guid, rest) = split_known_folder(r"{6D809377-6AF0-444B-8957-A3773F02200E}\AMD\CNext\RadeonSoftware.exe").unwrap();
        assert_eq!(guid, GUID::from_u128(0x6D809377_6AF0_444B_8957_A3773F02200E));
        assert_eq!(rest, r"AMD\CNext\RadeonSoftware.exe");
        assert!(split_known_folder(r"C:\Riot Games\Riot Client\RiotClientServices.exe").is_none());
        assert!(split_known_folder(r"{nope}\x.exe").is_none());
        let expanded = expand_known_folder(r"{6D809377-6AF0-444B-8957-A3773F02200E}\Riot Vanguard\vgtray.exe");
        assert!(expanded.to_ascii_lowercase().ends_with(r"program files\riot vanguard\vgtray.exe"), "{expanded}");
    }

    #[test]
    fn tray_item_names_match_registry_entries() {
        let names = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(match_score(&names(&["Riot Client"]), "Riot Client"), 100);
        assert_eq!(match_score(&names(&["Discord", "Discord"]), " Discord"), 100);
        assert!(match_score(&names(&["AMD Software", "RadeonSoftware"]), "AMD Software: Adrenalin Edition\nMise à jour disponible") >= 80);
        assert!(match_score(&names(&["Vanguard tray notification.", "vgtray"]), "Riot Vanguard") > 0);
        assert_eq!(match_score(&names(&["Discord"]), "Riot Client"), 0);
        assert_eq!(match_score(&names(&["Discord"]), ""), 0);
    }

    #[test]
    fn tooltip_names_are_cleaned() {
        assert_eq!(clean_name("\u{202a}Microsoft 365 \u{202c}\nline two"), "Microsoft 365");
        assert_eq!(clean_name(" Discord "), "Discord");
    }

    #[test]
    fn apps_without_a_live_icon_are_hidden_for_a_while() {
        let mut absent = Absent::default();
        let t0 = Instant::now();
        let ttl = Duration::from_secs(600);
        absent.mark(r"c:\epic\launcher.exe", t0);
        assert!(absent.contains(r"c:\epic\launcher.exe", t0 + Duration::from_secs(5), ttl));
        assert!(!absent.contains(r"c:\epic\launcher.exe", t0 + Duration::from_secs(601), ttl));
        absent.clear(r"c:\epic\launcher.exe");
        assert!(!absent.contains(r"c:\epic\launcher.exe", t0, ttl));
        for i in 0..100 {
            absent.mark(&format!("c:\\x{i}.exe"), t0);
        }
        assert_eq!(absent.0.len(), 64);
    }

    #[test]
    fn quit_terminates_only_background_leftovers() {
        assert_eq!(quit_step(0, 0), QuitStep::Done);
        // A "save changes?" prompt survived WM_CLOSE: never kill the app under the user's eyes.
        assert_eq!(quit_step(1, 1), QuitStep::LeaveToUser);
        assert_eq!(quit_step(3, 0), QuitStep::Terminate);
        assert_eq!(Action::parse("quit"), Some(Action::Quit));
        assert_eq!(Action::parse("open"), Some(Action::Open));
        assert!(Action::parse("right").is_none());
    }

    #[test]
    fn shell_entries_are_not_apps() {
        assert!(is_shell_owned(r"c:\windows\explorer.exe"));
        assert!(!is_shell_owned(r"c:\users\me\appdata\local\discord\app-1.0\discord.exe"));
    }

    /// (Shell_TrayWnd visible, overflow flyout open, Win10 overflow visible, cursor).
    fn shell_state() -> (bool, bool, bool, (i32, i32)) {
        unsafe {
            let tray = FindWindowW(w!("Shell_TrayWnd"), None).is_ok_and(|h| IsWindowVisible(h).as_bool());
            let legacy = FindWindowW(w!("NotifyIconOverflowWindow"), None).is_ok_and(|h| IsWindowVisible(h).as_bool());
            let mut p = POINT::default();
            let _ = GetCursorPos(&mut p);
            (tray, overflow_window().is_some(), legacy, (p.x, p.y))
        }
    }

    /// Real enumeration on this machine: silent (the shell UI and cursor are untouched), every
    /// entry is a running non-shell app with a unique id, and a running lumabar is listed.
    #[test]
    fn real_tray_enumeration_is_silent_and_includes_lumabar() {
        let before = shell_state();
        let icons = list();
        let after = shell_state();
        for t in &icons {
            eprintln!("tray: {} | overflow={} | self={} | icon={} | {}", t.name, t.is_hidden_overflow, t.is_self, t.icon_png.is_some(), t.exe);
        }
        assert_eq!(before, after, "listing must never reveal the tray or move the cursor");
        let procs: HashSet<String> = processes().into_iter().map(|(_, p)| p).collect();
        let mut ids = HashSet::new();
        for t in &icons {
            assert!(ids.insert(t.id.clone()), "duplicate id {}", t.id);
            assert!(procs.contains(&t.exe.to_ascii_lowercase()), "{} is not running", t.exe);
            assert!(!is_shell_owned(&t.exe.to_ascii_lowercase()));
            assert!(!t.name.is_empty(), "{}", t.exe);
        }
        let lumabar_running = procs.iter().any(|p| p.ends_with("\\lumabar.exe"));
        if lumabar_running {
            assert!(icons.iter().any(|t| t.exe.to_ascii_lowercase().ends_with("\\lumabar.exe")), "a running lumabar must list itself");
        }
        // Windows 11 has no legacy toolbar; the scan must simply come back empty there.
        let _ = toolbar_items();
        assert!(act("no-such-id", Action::Open).is_err());
    }

    /// Open + Quit on a real throw-away window (a PowerShell WinForms form): the window is focused
    /// and then closed by WM_CLOSE, and neither Shell_TrayWnd nor any overflow window is shown,
    /// nor the cursor moved. Takes focus briefly: `cargo test --lib tray_icons -- --ignored`.
    #[test]
    #[ignore]
    fn open_and_quit_act_on_the_app_never_on_the_shell() {
        let title = format!("lumabar-tray-test-{}", std::process::id());
        let script = format!(
            "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.Form; $f.Text = '{title}'; $f.ShowInTaskbar = $false; [System.Windows.Forms.Application]::Run($f)"
        );
        let child = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-Command", &script])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn powershell");
        // Never leave the form behind, whatever fails below.
        struct Reap(std::process::Child);
        impl Drop for Reap {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let child = Reap(child);
        let pid = child.0.id();
        let pids: HashSet<u32> = [pid].into_iter().collect();
        let start = Instant::now();
        while main_window(&windows_of(&pids), true).is_none() && start.elapsed() < Duration::from_secs(20) {
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(main_window(&windows_of(&pids), true).is_some(), "test window never appeared");
        let exe = apps_enum::process_image_path(pid).unwrap_or_default();
        let target = Target { exe, pids: pids.clone(), candidates: vec![title.clone()], toolbar: None };

        let before = shell_state();
        assert_eq!(open_target(&target), Ok(Outcome::Focused));
        let quit = quit_target(&target);
        let after = shell_state();
        assert_eq!(quit, Ok(Outcome::Closed));
        assert_eq!((before.0, before.1, before.2), (after.0, after.1, after.2), "the tray / overflow visibility changed");
        assert!(!after.1 && !after.2, "an overflow window is showing");
        assert_eq!(before.3, after.3, "the cursor moved");
        drop(child);
    }
}
