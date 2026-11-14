//! Liner (tryliner.fun) desktop music player integration.
//!
//! Liner is an Electron app, so its media session is Chromium's: metadata can go transiently
//! empty during crossfades and transport commands are occasionally ignored by the renderer. This
//! module supplies the pieces `media_smtc` needs to paper over that with zero configuration:
//! AUMID matching, window-title metadata (`Track - Artist - Liner` / `Track · Artist`), locating
//! and focusing the player window, and launching the player when it is not running.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GW_OWNER, GetWindow, GetWindowRect, IsIconic, IsWindowVisible, SW_RESTORE, ShowWindow,
};
use windows::core::BOOL;

use super::apps_enum;

pub const APP_NAME: &str = "Liner";
const EXE_NAME: &str = "liner.exe";

/// True when an SMTC `SourceAppUserModelId` belongs to Liner (`Liner.exe`, `com.liner.desktop`,
/// `Liner`, `com.squirrel.liner.Liner`, …). Matching is per token so unrelated ids that merely
/// contain the letters (e.g. `Streamliner.exe`) are not mistaken for it.
pub fn is_liner_aumid(aumid: &str) -> bool {
    aumid
        .split(|c: char| !c.is_ascii_alphanumeric())
        .any(|token| (token.len() >= 5 && token[..5].eq_ignore_ascii_case("liner")) || token.eq_ignore_ascii_case("tryliner"))
}

fn strip_suffix_ignore_case<'a>(text: &'a str, suffix: &str) -> Option<&'a str> {
    let cut = text.len().checked_sub(suffix.len())?;
    if text.is_char_boundary(cut) && text[cut..].eq_ignore_ascii_case(suffix) { Some(&text[..cut]) } else { None }
}

/// Parse Liner's top-level window title into `(track, artist)`.
///
/// Accepts `Track - Artist - Liner`, `Track · Artist`, and the en/em-dash variants. Returns
/// `None` for titles that carry no track (empty, or just the app name). `artist` is empty when the
/// title has no separator.
pub fn parse_window_title(title: &str) -> Option<(String, String)> {
    const SEPARATORS: [&str; 5] = [" · ", " — ", " – ", " - ", " | "];
    let mut text = title.trim();
    for sep in SEPARATORS {
        if let Some(head) = strip_suffix_ignore_case(text, &format!("{sep}{APP_NAME}")) {
            text = head.trim();
            break;
        }
    }
    // A dangling separator ("- Liner", "Song -") carries no information.
    let text = text.trim_matches(|c: char| c.is_whitespace() || matches!(c, '-' | '–' | '—' | '·' | '|'));
    if text.is_empty() || text.eq_ignore_ascii_case(APP_NAME) {
        return None;
    }
    // Split on the *last* separator: " - " is far more common inside track names
    // ("Song - Remastered") than inside artist names.
    for sep in SEPARATORS {
        if let Some((track, artist)) = text.rsplit_once(sep) {
            let (track, artist) = (track.trim(), artist.trim());
            if !track.is_empty() && !artist.is_empty() {
                return Some((track.to_string(), artist.to_string()));
            }
        }
    }
    Some((text.to_string(), String::new()))
}

#[derive(Debug, Clone)]
pub struct LinerWindow {
    pub hwnd: isize,
    pub title: String,
    pub visible: bool,
    pub area: i64,
    pub exe: String,
}

struct EnumState {
    /// pid -> image path when the process is Liner, `None` otherwise (one OpenProcess per pid).
    pids: HashMap<u32, Option<String>>,
    found: Vec<LinerWindow>,
}

unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let state = unsafe { &mut *(lparam.0 as *mut EnumState) };
    let pid = apps_enum::window_pid(hwnd);
    if pid == 0 {
        return BOOL(1);
    }
    let exe = state.pids.entry(pid).or_insert_with(|| {
        apps_enum::process_image_path(pid).filter(|path| {
            Path::new(path).file_name().and_then(|n| n.to_str()).is_some_and(|n| n.eq_ignore_ascii_case(EXE_NAME))
        })
    });
    let Some(exe) = exe.clone() else { return BOOL(1) };
    unsafe {
        // Owned windows are dialogs / tool popups, never the player itself.
        if GetWindow(hwnd, GW_OWNER).is_ok_and(|owner| !owner.is_invalid()) {
            return BOOL(1);
        }
        let mut rect = RECT::default();
        let _ = GetWindowRect(hwnd, &mut rect);
        state.found.push(LinerWindow {
            hwnd: hwnd.0 as isize,
            title: apps_enum::window_title(hwnd),
            visible: IsWindowVisible(hwnd).as_bool(),
            area: i64::from(rect.right - rect.left) * i64::from(rect.bottom - rect.top),
            exe,
        });
    }
    BOOL(1)
}

/// Every unowned top-level window that belongs to a `Liner.exe` process.
pub fn windows() -> Vec<LinerWindow> {
    let mut state = EnumState { pids: HashMap::new(), found: Vec::new() };
    unsafe {
        let _ = EnumWindows(Some(enum_proc), LPARAM(&mut state as *mut EnumState as isize));
    }
    state.found
}

/// The player window: the largest visible, titled Liner window.
pub fn main_window(windows: &[LinerWindow]) -> Option<&LinerWindow> {
    windows.iter().filter(|w| w.visible && !w.title.trim().is_empty()).max_by_key(|w| w.area)
}

/// `(track, artist)` from the running player's window title, if it shows one.
pub fn window_metadata() -> Option<(String, String)> {
    let all = windows();
    // Prefer the main window; a tray-hidden player still keeps its title up to date.
    main_window(&all)
        .and_then(|w| parse_window_title(&w.title))
        // A tray-hidden player keeps its title current, but hidden helper windows ("Default IME")
        // must not pass for a track: require an artist there.
        .or_else(|| all.iter().filter(|w| !w.visible).filter_map(|w| parse_window_title(&w.title)).find(|(_, artist)| !artist.is_empty()))
}

/// Where a Liner install can live, most specific first.
pub fn install_candidates(local: Option<&Path>, roaming: Option<&Path>, program_data: Option<&Path>, program_files: Option<&Path>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(local) = local {
        out.push(local.join("Programs").join("Liner").join("Liner.exe"));
        out.push(local.join("Liner").join("Liner.exe"));
    }
    if let Some(pf) = program_files {
        out.push(pf.join("Liner").join("Liner.exe"));
    }
    for start_menu in [roaming, program_data].into_iter().flatten() {
        let programs = start_menu.join("Microsoft").join("Windows").join("Start Menu").join("Programs");
        out.push(programs.join("Liner.lnk"));
        out.push(programs.join("Liner").join("Liner.lnk"));
    }
    out
}

fn install_target() -> Option<PathBuf> {
    let env = |name: &str| std::env::var_os(name).map(PathBuf::from);
    let (local, roaming, program_data, program_files) = (env("LOCALAPPDATA"), env("APPDATA"), env("PROGRAMDATA"), env("ProgramFiles"));
    install_candidates(local.as_deref(), roaming.as_deref(), program_data.as_deref(), program_files.as_deref())
        .into_iter()
        .find(|path| path.is_file())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenOutcome {
    Focused,
    Launched,
}

/// Bring the running player to the foreground, or start it.
///
/// A player that is running but hidden to the tray has no visible window to restore; re-running
/// the executable hands off to the existing instance, which then shows itself.
pub fn focus_or_launch() -> Result<OpenOutcome, String> {
    let all = windows();
    if let Some(window) = main_window(&all) {
        let hwnd = HWND(window.hwnd as *mut core::ffi::c_void);
        unsafe {
            if IsIconic(hwnd).as_bool() {
                let _ = ShowWindow(hwnd, SW_RESTORE);
            }
        }
        apps_enum::focus(hwnd);
        return Ok(OpenOutcome::Focused);
    }
    let target = all
        .first()
        .map(|w| PathBuf::from(&w.exe))
        .or_else(install_target)
        .ok_or_else(|| "Liner is not installed".to_string())?;
    apps_enum::shell_open(&target.to_string_lossy(), None)?;
    Ok(OpenOutcome::Launched)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_liner_app_ids() {
        for id in ["Liner.exe", "Liner", "liner", "LINER.EXE", "com.liner.desktop", "com.squirrel.liner.Liner", "fun.tryliner.Liner!App", "LinerDesktop"] {
            assert!(is_liner_aumid(id), "{id} should match");
        }
    }

    #[test]
    fn ignores_other_players() {
        for id in ["Spotify.exe", "chrome.exe", "MSEdge", "308046B0AF4A39CB", "Streamliner.exe", "Linear.exe", "", "com.airliner.app"] {
            assert!(!is_liner_aumid(id), "{id} should not match");
        }
    }

    #[test]
    fn parses_track_artist_app_title() {
        assert_eq!(parse_window_title("Midnight City - M83 - Liner"), Some(("Midnight City".into(), "M83".into())));
        assert_eq!(parse_window_title("  Nightcall — Kavinsky — Liner "), Some(("Nightcall".into(), "Kavinsky".into())));
    }

    #[test]
    fn parses_middle_dot_title() {
        assert_eq!(parse_window_title("Midnight City · M83"), Some(("Midnight City".into(), "M83".into())));
        assert_eq!(parse_window_title("Été 90 · Therapie TAXI - Liner"), Some(("Été 90".into(), "Therapie TAXI".into())));
    }

    #[test]
    fn keeps_dashes_inside_track_names() {
        assert_eq!(
            parse_window_title("Heroes - 2017 Remaster - David Bowie - Liner"),
            Some(("Heroes - 2017 Remaster".into(), "David Bowie".into()))
        );
    }

    #[test]
    fn title_without_track_is_rejected() {
        assert_eq!(parse_window_title("Liner"), None);
        assert_eq!(parse_window_title("   "), None);
        assert_eq!(parse_window_title(" - Liner"), None);
    }

    #[test]
    fn title_without_artist_keeps_track() {
        assert_eq!(parse_window_title("Intro - Liner"), Some(("Intro".into(), String::new())));
    }

    #[test]
    fn install_candidates_cover_user_install_and_start_menu() {
        let c = install_candidates(Some(Path::new(r"C:\Users\u\AppData\Local")), Some(Path::new(r"C:\Users\u\AppData\Roaming")), None, None);
        assert_eq!(c[0], PathBuf::from(r"C:\Users\u\AppData\Local\Programs\Liner\Liner.exe"));
        assert!(c.contains(&PathBuf::from(r"C:\Users\u\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Liner.lnk")));
    }

    #[test]
    fn main_window_prefers_largest_visible_titled() {
        let w = |hwnd, title: &str, visible, area| LinerWindow { hwnd, title: title.into(), visible, area, exe: String::new() };
        let all = [w(1, "", true, 900), w(2, "Liner", true, 400), w(3, "Song - A - Liner", false, 999), w(4, "Mini", true, 100)];
        assert_eq!(main_window(&all).map(|w| w.hwnd), Some(2));
        assert!(main_window(&all[..1]).is_none());
    }
}
