//! 1 s foreground sampler -> hourly aggregates in SQLite.
//!
//! For browsers the active tab's domain is read from the address bar through UI Automation
//! (cached per window+title so the UIA tree walk only happens when the tab changes).

use std::collections::HashMap;
use std::path::Path;
use std::time::{Duration, Instant};

use chrono::{Local, Timelike};
use tauri::{AppHandle, Manager};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx};
use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, TreeScope_Descendants, UIA_ControlTypePropertyId, UIA_EditControlTypeId,
    UIA_ValueValuePropertyId,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

use super::apps_enum::{process_image_path, window_pid, window_title};
use crate::AppState;

const IDLE_CUTOFF_MS: u32 = 5 * 60 * 1000;
const FLUSH_EVERY: Duration = Duration::from_secs(15);
const BROWSERS: &[&str] = &["chrome", "msedge", "firefox", "brave", "opera", "vivaldi", "arc", "zen", "librewolf"];

fn idle_ms() -> u32 {
    let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    unsafe {
        if GetLastInputInfo(&mut info).as_bool() { GetTickCount().wrapping_sub(info.dwTime) } else { 0 }
    }
}

/// "https://www.github.com/foo" / "github.com/foo" -> "github.com"
pub fn domain_from_url(raw: &str) -> Option<String> {
    let text = raw.trim();
    if text.is_empty() || text.contains(' ') {
        return None;
    }
    let without_scheme = text.split_once("://").map(|(_, rest)| rest).unwrap_or(text);
    let host = without_scheme.split(['/', '?', '#']).next()?.split('@').next_back()?;
    let host = host.split(':').next()?.trim_start_matches("www.").to_ascii_lowercase();
    if host.contains('.') && host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') {
        Some(host)
    } else {
        None
    }
}

fn browser_url(automation: &IUIAutomation, hwnd: HWND) -> Option<String> {
    unsafe {
        let root = automation.ElementFromHandle(hwnd).ok()?;
        let condition = automation
            .CreatePropertyCondition(UIA_ControlTypePropertyId, &VARIANT::from(UIA_EditControlTypeId.0))
            .ok()?;
        let edit = root.FindFirst(TreeScope_Descendants, &condition).ok()?;
        let value = edit.GetCurrentPropertyValue(UIA_ValueValuePropertyId).ok()?;
        let text = windows::core::BSTR::try_from(&value).ok()?.to_string();
        if text.is_empty() { None } else { Some(text) }
    }
}

fn app_label(exe: &str) -> String {
    Path::new(exe)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown".into())
}

pub fn start(app: AppHandle) {
    std::thread::Builder::new()
        .name("winglass-screentime".into())
        .spawn(move || {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            }
            let automation: Option<IUIAutomation> =
                unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok() };
            let mut pending: HashMap<(String, u32, String, String), i64> = HashMap::new();
            let mut domain_cache: HashMap<(isize, String), Option<String>> = HashMap::new();
            let mut last_flush = Instant::now();
            let mut last_prune = Instant::now() - Duration::from_secs(3600);

            loop {
                std::thread::sleep(Duration::from_secs(1));

                let fg = unsafe { GetForegroundWindow() };
                if !fg.is_invalid() && idle_ms() < IDLE_CUTOFF_MS {
                    let pid = window_pid(fg);
                    if let Some(exe) = process_image_path(pid) {
                        let label = app_label(&exe);
                        let lower = label.to_ascii_lowercase();
                        // Our own windows never count, whatever the executable is called (winglass.exe / WinGlass.exe).
                        if lower != "lockapp" && pid != std::process::id() {
                            let mut domain = String::new();
                            if BROWSERS.contains(&lower.as_str()) {
                                if let Some(automation) = &automation {
                                    let title = window_title(fg);
                                    let key = (fg.0 as isize, title);
                                    let cached = domain_cache
                                        .entry(key)
                                        .or_insert_with(|| browser_url(automation, fg).and_then(|u| domain_from_url(&u)));
                                    if let Some(d) = cached {
                                        domain = d.clone();
                                    }
                                    if domain_cache.len() > 512 {
                                        domain_cache.clear();
                                    }
                                }
                            }
                            let now = Local::now();
                            let day = now.format("%Y-%m-%d").to_string();
                            *pending.entry((day, now.hour(), label, domain)).or_insert(0) += 1;
                        }
                    }
                }

                if last_flush.elapsed() >= FLUSH_EVERY && !pending.is_empty() {
                    let entries: Vec<(String, u32, String, String, i64)> =
                        pending.drain().map(|((d, h, a, dm), s)| (d, h, a, dm, s)).collect();
                    let db = &app.state::<AppState>().db;
                    if let Err(err) = db.add_screen_time(&entries) {
                        eprintln!("[winglass] screen time flush failed: {err}");
                    }
                    last_flush = Instant::now();
                }
                if last_prune.elapsed() >= Duration::from_secs(3600) {
                    let _ = app.state::<AppState>().db.prune_screen_time(60);
                    last_prune = Instant::now();
                }
            }
        })
        .expect("spawn screen time sampler");
}
