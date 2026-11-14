//! Notification-area apps behind the dock's « Afficher les icônes cachées » chevron.
//!
//! **Listing** never moves the cursor or reveals the taskbar: Windows 11 records every app that ever showed a tray icon
//! under `HKCU\Control Panel\NotifyIconSettings\<id>` (`ExecutablePath`, `InitialTooltip`,
//! `IsPromoted`, `IconSnapshot`). An entry is live when its executable is running; paths may start
//! with a Known Folder GUID (`{6D809377-…}\AMD\…`) which is expanded first. Icons come from the
//! executable through the bounded icon LRU, with the shell's own `IconSnapshot` PNG as fallback.
//! The list is then checked against the live UI Automation tree: whenever the tray XAML is
//! exposed (taskbar on screen, or during an activation's reveal — the overflow flyout included),
//! every `NotifyItemIcon` is read and running apps that have **no** live icon are dropped for a
//! while (`ABSENT_TTL`), so the popup shows what the native flyout would.
//!
//! **Activation** forwards to the real tray item through UI Automation. The shell only exposes the
//! tray's XAML tree while the taskbar is on screen, so the item is revealed first: the taskbar is
//! shown (`completely_hidden` mode re-hides it a few seconds later), the cursor is parked on the
//! taskbar edge (how a user reveals an auto-hidden taskbar), hidden icons come from the overflow
//! flyout (chevron `Invoke`). Left click = `InvokePattern::Invoke` (the app gets its normal
//! NIN_SELECT / click; `LegacyIAccessible::DoDefaultAction`, then a real click, as fallbacks),
//! right and double click are real clicks on the item so the app opens its own native context
//! menu (« Quitter », « Paramètres »…). The cursor is put back at once; a watcher keeps the taskbar
//! reachable while that menu is open, then closes the overflow flyout and re-hides the taskbar.
//!
//! UIA objects live only on the per-call worker thread, which initializes COM itself (invariant 5).

use std::collections::HashSet;
use std::path::Path;
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;
use windows::Win32::Foundation::{CloseHandle, HWND, POINT, RECT};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MONITOR_DEFAULTTOPRIMARY, MONITORINFO, MonitorFromWindow};
use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize};
use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS};
use windows::Win32::System::Registry::{
    HKEY, HKEY_CURRENT_USER, KEY_READ, REG_VALUE_TYPE, RRF_RT_REG_BINARY, RRF_RT_REG_DWORD, RRF_RT_REG_SZ, RegCloseKey, RegEnumKeyExW,
    RegGetValueW, RegOpenKeyExW,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationInvokePattern, IUIAutomationLegacyIAccessiblePattern,
    TreeScope_Descendants, UIA_InvokePatternId, UIA_LegacyIAccessiblePatternId,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_KEYUP, MOUSE_EVENT_FLAGS, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
    MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEINPUT, SendInput, VK_ESCAPE,
};
use windows::Win32::UI::Shell::{ABM_GETTASKBARPOS, APPBARDATA, KF_FLAG_DEFAULT, SHAppBarMessage, SHGetKnownFolderPath};
use windows::Win32::UI::WindowsAndMessaging::{
    FindWindowW, GWL_EXSTYLE, GetCursorPos, GetForegroundWindow, GetWindowLongW, GetWindowThreadProcessId, IsWindowVisible, SetCursorPos,
    WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
};
use windows::core::{GUID, PCWSTR, PWSTR, w};

use super::{apps_enum, from_wide, taskbar, wide};

const SETTINGS_KEY: &str = r"Control Panel\NotifyIconSettings";
/// UIA tree must appear within this after the reveal.
const REVEAL_TIMEOUT: Duration = Duration::from_millis(1800);
const OVERFLOW_TIMEOUT: Duration = Duration::from_millis(1500);
/// How long `completely_hidden` leaves the revealed taskbar alone (menus, flyouts).
const REVEAL_GRACE: Duration = Duration::from_secs(5);
/// A running app the live tray tree showed without an icon stays out of the list this long.
const ABSENT_TTL: Duration = Duration::from_secs(10 * 60);
/// Longest a forwarded native menu may keep the taskbar revealed.
const MENU_WATCH_MAX: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrayIcon {
    /// NotifyIconSettings sub-key: stable across restarts.
    pub id: String,
    pub name: String,
    pub exe: String,
    /// PNG data URL (executable icon via the LRU, else the shell's tray snapshot).
    pub icon_png: Option<String>,
    /// Lives in the "hidden icons" overflow rather than on the taskbar.
    pub is_hidden_overflow: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Button {
    Left,
    Right,
    Double,
}

impl Button {
    pub fn parse(s: &str) -> Option<Button> {
        match s {
            "left" => Some(Button::Left),
            "right" => Some(Button::Right),
            "double" => Some(Button::Double),
            _ => None,
        }
    }
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
        out.push(Entry {
            id,
            exe: expand_known_folder(&raw_exe),
            tooltip,
            promoted,
            snapshot,
        });
    }
    unsafe {
        let _ = RegCloseKey(key);
    }
    out
}

static RUNNING: Lazy<Mutex<Option<(Instant, HashSet<String>)>>> = Lazy::new(|| Mutex::new(None));

/// Lower-cased image paths of every process we can query (cached 2 s).
fn running_paths() -> HashSet<String> {
    if let Some((at, set)) = RUNNING.lock().as_ref() {
        if at.elapsed() < Duration::from_secs(2) {
            return set.clone();
        }
    }
    let mut set = HashSet::new();
    unsafe {
        if let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
            let mut ok = Process32FirstW(snap, &mut entry).is_ok();
            while ok {
                if let Some(path) = apps_enum::process_image_path(entry.th32ProcessID) {
                    set.insert(path.to_ascii_lowercase());
                }
                ok = Process32NextW(snap, &mut entry).is_ok();
            }
            let _ = CloseHandle(snap);
        }
    }
    *RUNNING.lock() = Some((Instant::now(), set.clone()));
    set
}

fn own_exe() -> String {
    std::env::current_exe().map(|p| p.to_string_lossy().to_ascii_lowercase()).unwrap_or_default()
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

/// Names a tray item may carry for this entry, best display name first: a short tooltip, the
/// product name, the file stem. (A tooltip that is a whole sentence is a status, not a name.)
fn candidate_names(e: &Entry) -> Vec<String> {
    let mut names = Vec::new();
    let tooltip = clean_name(&e.tooltip);
    let friendly = apps_enum::friendly_name(&e.exe);
    if !tooltip.is_empty() && tooltip.chars().count() <= 32 {
        names.push(tooltip.clone());
    }
    names.push(friendly);
    if !tooltip.is_empty() && tooltip.chars().count() > 32 {
        names.push(tooltip);
    }
    if let Some(stem) = Path::new(&e.exe).file_stem().and_then(|s| s.to_str()) {
        names.push(stem.to_string());
    }
    names
}

/// Names seen on real tray items during activations (exe -> tray name), so the list shows them.
static SEEN_NAMES: Lazy<Mutex<Vec<(String, String)>>> = Lazy::new(|| Mutex::new(Vec::new()));

fn live_entries() -> Vec<Entry> {
    let running = running_paths();
    let own = own_exe();
    let mut seen = HashSet::new();
    read_entries()
        .into_iter()
        .filter(|e| {
            let lower = e.exe.to_ascii_lowercase();
            running.contains(&lower) && lower != own && !is_shell_owned(&lower) && seen.insert(lower)
        })
        .collect()
}

pub fn list() -> Vec<TrayIcon> {
    let entries = live_entries();
    // Cheap live check when the tray XAML is already exposed (taskbar on screen); never reveals.
    if let Ok(Some((names, complete))) = on_uia_thread(exposed_tray_names) {
        reconcile(&entries, &names, complete);
    }
    let seen = SEEN_NAMES.lock().clone();
    let now = Instant::now();
    let absent = ABSENT.lock();
    let mut out: Vec<TrayIcon> = entries
        .into_iter()
        .filter(|e| !absent.contains(&e.exe.to_ascii_lowercase(), now, ABSENT_TTL))
        .map(|e| {
            let lower = e.exe.to_ascii_lowercase();
            let name = seen
                .iter()
                .find(|(exe, _)| *exe == lower)
                .map(|(_, n)| n.clone())
                .unwrap_or_else(|| candidate_names(&e).into_iter().next().unwrap_or_default());
            let icon_png = apps_enum::icon_data_url(&e.exe)
                .or_else(|| e.snapshot.as_ref().map(|png| format!("data:image/png;base64,{}", STANDARD.encode(png))));
            TrayIcon { id: e.id, name: clean_name(&name), exe: e.exe, icon_png, is_hidden_overflow: !e.promoted }
        })
        .collect();
    // Taskbar-promoted icons first, then alphabetical (stable while apps come and go).
    drop(absent);
    out.sort_by(|a, b| a.is_hidden_overflow.cmp(&b.is_hidden_overflow).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    out
}

/// Live tray item names. `complete` = the overflow flyout was read too, so an entry missing from
/// `names` really has no icon (otherwise only matches count).
fn reconcile(entries: &[Entry], names: &[String], complete: bool) {
    let now = Instant::now();
    for e in entries {
        let lower = e.exe.to_ascii_lowercase();
        let candidates = candidate_names(e);
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

/// Names on the taskbar's tray (+ the overflow flyout if it happens to be open), without revealing
/// anything. None when the tray XAML is not exposed (taskbar hidden).
fn exposed_tray_names() -> Result<Option<(Vec<String>, bool)>, String> {
    let Ok(tray) = (unsafe { FindWindowW(w!("Shell_TrayWnd"), None) }) else { return Ok(None) };
    if !unsafe { IsWindowVisible(tray) }.as_bool() {
        return Ok(None);
    }
    let uia: IUIAutomation = unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }.map_err(|e| e.to_string())?;
    let (items, chevron) = tray_items(&uia, tray);
    if chevron.is_none() && items.is_empty() {
        return Ok(None);
    }
    let mut names: Vec<String> = items.into_iter().map(|i| i.name).collect();
    let overflow = overflow_window();
    if let Some(o) = overflow {
        names.extend(tray_items(&uia, o).0.into_iter().map(|i| i.name));
    }
    Ok(Some((names, overflow.is_some())))
}

/// The hidden-icons flyout, when it is open.
fn overflow_window() -> Option<HWND> {
    let hwnd = unsafe { FindWindowW(w!("TopLevelWindowForOverflowXamlIsland"), None) }.ok()?;
    unsafe { IsWindowVisible(hwnd) }.as_bool().then_some(hwnd)
}

// ---------------------------------------------------------------------------------------------
// UI Automation activation
// ---------------------------------------------------------------------------------------------

struct Item {
    element: IUIAutomationElement,
    name: String,
    rect: RECT,
}

fn bstr(r: windows::core::Result<windows::core::BSTR>) -> String {
    r.map(|b| b.to_string()).unwrap_or_default()
}

/// Notification icons (and the overflow chevron) under a shell window.
fn tray_items(uia: &IUIAutomation, hwnd: HWND) -> (Vec<Item>, Option<IUIAutomationElement>) {
    let mut items = Vec::new();
    let mut chevron = None;
    unsafe {
        let Ok(root) = uia.ElementFromHandle(hwnd) else { return (items, None) };
        let Ok(cond) = uia.CreateTrueCondition() else { return (items, None) };
        let Ok(all) = root.FindAll(TreeScope_Descendants, &cond) else { return (items, None) };
        for i in 0..all.Length().unwrap_or(0) {
            let Ok(el) = all.GetElement(i) else { continue };
            let id = bstr(el.CurrentAutomationId());
            let class = bstr(el.CurrentClassName());
            if id == "NotifyItemIcon" {
                let rect = el.CurrentBoundingRectangle().unwrap_or_default();
                items.push(Item { name: bstr(el.CurrentName()), element: el, rect });
            } else if id == "SystemTrayIcon" && class == "SystemTray.NormalButton" && chevron.is_none() {
                // The first plain SystemTray button is « Afficher les icônes cachées ».
                chevron = Some(el);
            }
        }
    }
    (items, chevron)
}

/// The item once its rect stopped moving (two equal reads): the taskbar and the overflow flyout
/// slide in, and a click mid-animation could miss.
fn settled(timeout: Duration, mut f: impl FnMut() -> Option<Item>) -> Option<Item> {
    let mut prev: Option<RECT> = None;
    let mut last = None;
    let found = wait_for(timeout, || {
        let item = f()?;
        let stable = prev == Some(item.rect);
        prev = Some(item.rect);
        if stable { Some(item) } else {
            last = Some(item);
            None
        }
    });
    // Still moving at the deadline: the latest position beats nothing.
    found.or(last)
}

fn wait_for<T>(timeout: Duration, mut f: impl FnMut() -> Option<T>) -> Option<T> {
    let start = Instant::now();
    loop {
        if let Some(v) = f() {
            return Some(v);
        }
        if start.elapsed() >= timeout {
            return None;
        }
        std::thread::sleep(Duration::from_millis(40));
    }
}

/// The point on the taskbar's screen edge that slides an auto-hidden taskbar in.
fn reveal_point(tray: HWND) -> Option<POINT> {
    unsafe {
        let mut abd = APPBARDATA { cbSize: std::mem::size_of::<APPBARDATA>() as u32, hWnd: tray, ..Default::default() };
        SHAppBarMessage(ABM_GETTASKBARPOS, &mut abd);
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        if !GetMonitorInfoW(MonitorFromWindow(tray, MONITOR_DEFAULTTOPRIMARY), &mut info).as_bool() {
            return None;
        }
        let m = info.rcMonitor;
        let (cx, cy) = ((m.left + m.right) / 2, (m.top + m.bottom) / 2);
        Some(match abd.uEdge {
            0 => POINT { x: m.left, y: cy },
            1 => POINT { x: cx, y: m.top },
            2 => POINT { x: m.right - 1, y: cy },
            _ => POINT { x: cx, y: m.bottom - 1 },
        })
    }
}

fn mouse(flags: MOUSE_EVENT_FLAGS) -> INPUT {
    INPUT { r#type: INPUT_MOUSE, Anonymous: INPUT_0 { mi: MOUSEINPUT { dwFlags: flags, ..Default::default() } } }
}

pub fn has_area(r: RECT) -> bool {
    r.right - r.left >= 4 && r.bottom - r.top >= 4
}

fn click_at(rect: RECT, button: Button) -> Result<(), String> {
    if !has_area(rect) {
        return Err("the tray icon is not on screen".into());
    }
    let (x, y) = ((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
    unsafe {
        SetCursorPos(x, y).map_err(|e| e.to_string())?;
        std::thread::sleep(Duration::from_millis(30));
        let inputs: Vec<INPUT> = match button {
            Button::Right => vec![mouse(MOUSEEVENTF_RIGHTDOWN), mouse(MOUSEEVENTF_RIGHTUP)],
            Button::Double => vec![mouse(MOUSEEVENTF_LEFTDOWN), mouse(MOUSEEVENTF_LEFTUP), mouse(MOUSEEVENTF_LEFTDOWN), mouse(MOUSEEVENTF_LEFTUP)],
            Button::Left => vec![mouse(MOUSEEVENTF_LEFTDOWN), mouse(MOUSEEVENTF_LEFTUP)],
        };
        if SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) as usize != inputs.len() {
            return Err("SendInput was blocked (is an elevated window focused?)".into());
        }
    }
    Ok(())
}

fn press_escape() {
    let key = |flags| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VK_ESCAPE, dwFlags: flags, ..Default::default() } },
    };
    unsafe {
        SendInput(&[key(Default::default()), key(KEYEVENTF_KEYUP)], std::mem::size_of::<INPUT>() as i32);
    }
}

/// What happened, for tests and error messages.
#[derive(Debug, Clone, PartialEq)]
pub struct Located {
    pub name: String,
    pub rect: RECT,
    pub in_overflow: bool,
}

/// Reveal the tray, find the item for `candidates`, run `act` on it. Restores the cursor.
fn with_tray_item<T>(candidates: &[String], act: impl FnOnce(&Item, bool) -> Result<T, String>) -> Result<(T, Located), String> {
    let tray = unsafe { FindWindowW(w!("Shell_TrayWnd"), None) }.map_err(|_| "the Windows taskbar is not running".to_string())?;
    let uia: IUIAutomation = unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }.map_err(|e| format!("UI Automation: {e}"))?;
    let mut saved = POINT::default();
    let _ = unsafe { GetCursorPos(&mut saved) };

    taskbar::show_for_interaction(REVEAL_GRACE);
    let result = (|| {
        // Already exposed (native taskbar on screen)? Otherwise slide it in from the edge.
        let mut chevron = tray_items(&uia, tray).1;
        if chevron.is_none() {
            let p = reveal_point(tray).ok_or("cannot locate the taskbar's monitor")?;
            unsafe {
                let _ = SetCursorPos(p.x, p.y);
            }
            chevron = wait_for(REVEAL_TIMEOUT, || tray_items(&uia, tray).1);
        }
        // Only laid-out items: the overflow flyout exposes its items before its open animation has
        // placed them (empty rect), and a click there would land on the screen corner.
        let best = |items: Vec<Item>| {
            items
                .into_iter()
                .filter(|i| has_area(i.rect))
                .map(|i| (match_score(candidates, &i.name), i))
                .filter(|(s, _)| *s > 0)
                .max_by_key(|(s, _)| *s)
                .map(|(_, i)| i)
        };
        if let Some(item) = settled(Duration::from_millis(400), || best(tray_items(&uia, tray).0)) {
            let located = Located { name: item.name.clone(), rect: item.rect, in_overflow: false };
            return act(&item, false).map(|v| (v, located));
        }
        let chevron = chevron.ok_or("the notification area is not reachable (is a fullscreen app in front?)")?;
        unsafe {
            let invoke: IUIAutomationInvokePattern = chevron.GetCurrentPatternAs(UIA_InvokePatternId).map_err(|e| e.to_string())?;
            invoke.Invoke().map_err(|e| format!("could not open the hidden icons: {e}"))?;
        }
        let overflow = wait_for(OVERFLOW_TIMEOUT, || unsafe { FindWindowW(w!("TopLevelWindowForOverflowXamlIsland"), None) }.ok())
            .ok_or("the hidden icons flyout did not open")?;
        let item = settled(OVERFLOW_TIMEOUT, || best(tray_items(&uia, overflow).0));
        // Both halves of the live tree are on screen now: refresh which apps really have an icon.
        let mut names: Vec<String> = tray_items(&uia, tray).0.into_iter().map(|i| i.name).collect();
        names.extend(tray_items(&uia, overflow).0.into_iter().map(|i| i.name));
        reconcile(&live_entries(), &names, true);
        let item = item.ok_or_else(|| {
            close_overflow(&uia, tray);
            "this app has no icon in the notification area right now".to_string()
        })?;
        let located = Located { name: item.name.clone(), rect: item.rect, in_overflow: true };
        act(&item, true).map(|v| (v, located))
    })();
    unsafe {
        let _ = SetCursorPos(saved.x, saved.y);
    }
    result
}

/// Close the hidden-icons flyout by toggling the chevron (no synthetic key reaches another app
/// unless the toggle did not work).
fn close_overflow(uia: &IUIAutomation, tray: HWND) {
    if overflow_window().is_none() {
        return;
    }
    if let Some(chevron) = tray_items(uia, tray).1 {
        unsafe {
            if let Ok(invoke) = chevron.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId) {
                let _ = invoke.Invoke();
            }
        }
    }
    if wait_for(Duration::from_millis(400), || overflow_window().is_none().then_some(())).is_none() {
        press_escape();
    }
}

/// A native menu (or a topmost / tool popup of the tray app) is on screen.
fn menu_open(app_pid: Option<u32>) -> bool {
    unsafe {
        if FindWindowW(w!("#32768"), None).is_ok_and(|m| IsWindowVisible(m).as_bool()) {
            return true;
        }
        let Some(pid) = app_pid else { return false };
        let fg = GetForegroundWindow();
        if fg.is_invalid() {
            return false;
        }
        let mut fg_pid = 0u32;
        GetWindowThreadProcessId(fg, Some(&mut fg_pid));
        let ex = GetWindowLongW(fg, GWL_EXSTYLE) as u32;
        fg_pid == pid && ex & (WS_EX_TOPMOST.0 | WS_EX_TOOLWINDOW.0) != 0
    }
}

/// After a forwarded click: keep the taskbar reachable while the app's menu is open, then close
/// the overflow flyout if it lingers and hide the taskbar again (`completely_hidden`).
fn watch_interaction(app_pid: Option<u32>) {
    let _ = std::thread::Builder::new().name("lumabar-tray-menu".into()).spawn(move || {
        std::thread::sleep(Duration::from_millis(350));
        let start = Instant::now();
        while start.elapsed() < MENU_WATCH_MAX && menu_open(app_pid) {
            taskbar::extend_interaction(Duration::from_secs(2));
            std::thread::sleep(Duration::from_millis(120));
        }
        let _ = on_uia_thread(|| {
            let tray = unsafe { FindWindowW(w!("Shell_TrayWnd"), None) }.map_err(|e| e.to_string())?;
            let uia: IUIAutomation = unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }.map_err(|e| e.to_string())?;
            close_overflow(&uia, tray);
            Ok(())
        });
        taskbar::end_interaction();
    });
}

/// Pid of a running process with this image path.
fn pid_of(exe_lower: &str) -> Option<u32> {
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?;
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut ok = Process32FirstW(snap, &mut entry).is_ok();
        let mut found = None;
        while ok {
            if apps_enum::process_image_path(entry.th32ProcessID).is_some_and(|p| p.to_ascii_lowercase() == exe_lower) {
                found = Some(entry.th32ProcessID);
                break;
            }
            ok = Process32NextW(snap, &mut entry).is_ok();
        }
        let _ = CloseHandle(snap);
        found
    }
}

fn entry_by_id(id: &str) -> Result<Entry, String> {
    live_entries().into_iter().find(|e| e.id == id).ok_or_else(|| "this tray app is no longer running".to_string())
}

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

/// Forward a click to the app's real tray icon.
pub fn activate(id: &str, button: Button) -> Result<(), String> {
    let entry = entry_by_id(id)?;
    let candidates = candidate_names(&entry);
    let exe = entry.exe.clone();
    let result = on_uia_thread(move || {
        with_tray_item(&candidates, |item, _in_overflow| match button {
            Button::Left => left_click(item),
            Button::Right | Button::Double => click_at(item.rect, button),
        })
        .map(|(_, l)| l)
    });
    match result {
        Ok(located) => {
            remember_name(&exe, &located.name);
            watch_interaction(pid_of(&exe.to_ascii_lowercase()));
            Ok(())
        }
        Err(e) => {
            taskbar::end_interaction();
            Err(e)
        }
    }
}

/// Invoke, else LegacyIAccessible's default action, else a real click.
fn left_click(item: &Item) -> Result<(), String> {
    unsafe {
        if let Ok(invoke) = item.element.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId) {
            if invoke.Invoke().is_ok() {
                return Ok(());
            }
        }
        if let Ok(legacy) = item.element.GetCurrentPatternAs::<IUIAutomationLegacyIAccessiblePattern>(UIA_LegacyIAccessiblePatternId) {
            if legacy.DoDefaultAction().is_ok() {
                return Ok(());
            }
        }
    }
    click_at(item.rect, Button::Left)
}

/// Reveal and find an entry's tray item without clicking it (closes the flyout again). Test probe.
#[cfg(test)]
pub fn locate(id: &str) -> Result<Located, String> {
    let entry = entry_by_id(id)?;
    let candidates = candidate_names(&entry);
    on_uia_thread(move || {
        let out = with_tray_item(&candidates, |_, _| Ok(())).map(|(_, l)| l);
        if let Ok(tray) = unsafe { FindWindowW(w!("Shell_TrayWnd"), None) } {
            if let Ok(uia) = unsafe { CoCreateInstance::<_, IUIAutomation>(&CUIAutomation, None, CLSCTX_INPROC_SERVER) } {
                close_overflow(&uia, tray);
            }
        }
        taskbar::end_interaction();
        out
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_folder_prefixes_are_split() {
        let (guid, rest) = split_known_folder(r"{6D809377-6AF0-444B-8957-A3773F02200E}\AMD\CNext\RadeonSoftware.exe").unwrap();
        assert_eq!(guid, GUID::from_u128(0x6D809377_6AF0_444B_8957_A3773F02200E));
        assert_eq!(rest, r"AMD\CNext\RadeonSoftware.exe");
        assert!(split_known_folder(r"C:\Riot Games\Riot Client\RiotClientServices.exe").is_none());
        assert!(split_known_folder(r"{nope}\x.exe").is_none());
        // ProgramFilesX64 really expands.
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
        // Better candidates win.
        let riot = names(&["Riot Client"]);
        assert!(match_score(&riot, "Riot Client") > match_score(&riot, "Riot Vanguard"));
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
        assert!(!absent.contains(r"c:\discord\discord.exe", t0, ttl));
        // Seen again in the live tree: back in the list at once.
        absent.clear(r"c:\epic\launcher.exe");
        assert!(!absent.contains(r"c:\epic\launcher.exe", t0, ttl));
        // Bounded.
        for i in 0..100 {
            absent.mark(&format!("c:\\x{i}.exe"), t0);
        }
        assert_eq!(absent.0.len(), 64);
    }

    #[test]
    fn items_without_a_layout_are_never_clicked() {
        assert!(!has_area(RECT::default()));
        assert!(has_area(RECT { left: 1800, top: 1040, right: 1832, bottom: 1072 }));
        assert!(click_at(RECT::default(), Button::Right).is_err());
    }

    #[test]
    fn shell_entries_are_not_apps() {
        assert!(is_shell_owned(r"c:\windows\explorer.exe"));
        assert!(!is_shell_owned(r"c:\users\me\appdata\local\discord\app-1.0\discord.exe"));
    }

    /// Real enumeration on this machine: every entry is a running, non-shell, non-lumabar
    /// executable with a unique id and an icon.
    #[test]
    fn real_tray_enumeration_lists_running_apps_only() {
        let icons = list();
        for t in &icons {
            eprintln!("tray: {} | overflow={} | {}", t.name, t.is_hidden_overflow, t.exe);
        }
        let running = running_paths();
        let mut ids = HashSet::new();
        for t in &icons {
            assert!(ids.insert(t.id.clone()), "duplicate id {}", t.id);
            assert!(running.contains(&t.exe.to_ascii_lowercase()), "{} is not running", t.exe);
            assert!(!is_shell_owned(&t.exe.to_ascii_lowercase()));
            assert!(!t.name.is_empty(), "{}", t.exe);
            assert!(t.icon_png.as_deref().is_some_and(|u| u.starts_with("data:image/png;base64,")), "{} has no icon", t.exe);
        }
        assert!(Button::parse("right") == Some(Button::Right) && Button::parse("middle").is_none());
        assert!(activate("no-such-id", Button::Left).is_err());
    }

    /// Reveals the real notification area (moves the cursor to the taskbar edge and back, opens and
    /// closes the hidden-icons flyout). Run explicitly: `cargo test --lib tray_icons -- --ignored`.
    #[test]
    #[ignore]
    fn real_tray_items_are_located_through_ui_automation() {
        let icons = list();
        assert!(!icons.is_empty(), "no tray app running");
        let mut found = 0;
        for t in &icons {
            match locate(&t.id) {
                Ok(l) => {
                    found += 1;
                    eprintln!("{} -> '{}' overflow={} rect={:?}", t.name, l.name.lines().next().unwrap_or(""), l.in_overflow, l.rect);
                    assert!(l.rect.right > l.rect.left && l.rect.bottom > l.rect.top);
                }
                Err(e) => eprintln!("{}: {e}", t.name),
            }
        }
        assert!(found > 0, "no tray item could be located");
    }
}
