//! Integrated app launcher index (replaces the Windows Search / Win+S overlay).
//!
//! Sources, scanned on demand and cached for `INDEX_TTL`:
//! * Start Menu shortcuts — `%ProgramData%\…\Start Menu\Programs` and `%APPDATA%\…\Start Menu\Programs`
//!   (recursive; the sub-folder, e.g. "Riot Games", is kept as a secondary match field)
//! * Desktop shortcuts — the user's (OneDrive-aware) and the public desktop (`.lnk` + `.url`)
//! * Installed executables registered under `App Paths` (HKCU + HKLM)
//!
//! Icons are not part of the index: the flyout asks `apps_enum::icon_data_url(path)` lazily, which
//! is backed by the bounded icon LRU.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::System::Registry::{
    HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ, RegCloseKey, RegEnumKeyExW,
    RegGetValueW, RegOpenKeyExW,
};
use windows::Win32::UI::Shell::{FOLDERID_Desktop, FOLDERID_PublicDesktop, KF_FLAG_DEFAULT, SHGetKnownFolderPath};
use windows::core::{GUID, PCWSTR, PWSTR};

use super::{from_wide, wide};

const INDEX_TTL: Duration = Duration::from_secs(120);
const MAX_DEPTH: usize = 6;
const MAX_ENTRIES: usize = 6000;
pub const MAX_RESULTS: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AppKind {
    Shortcut,
    App,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppHit {
    pub name: String,
    /// Launch target (.lnk / .url / .exe) — also the icon key.
    pub path: String,
    pub kind: AppKind,
    /// Start Menu sub-folder ("Riot Games"), if any.
    pub folder: Option<String>,
}

#[derive(Debug, Clone)]
struct Entry {
    hit: AppHit,
    name_f: String,
    folder_f: String,
    initials: String,
}

impl Entry {
    fn new(name: String, path: String, kind: AppKind, folder: Option<String>) -> Self {
        let name_f = fold(&name);
        let folder_f = folder.as_deref().map(fold).unwrap_or_default();
        let initials = words(&name_f).filter_map(|w| w.chars().next()).collect();
        Entry { hit: AppHit { name, path, kind, folder }, name_f, folder_f, initials }
    }
}

/// Lowercase and strip the accents found in French / European app names ("Éditeur" ~ "editeur").
pub fn fold(text: &str) -> String {
    text.chars()
        .flat_map(|c| c.to_lowercase())
        .map(|c| match c {
            'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' => 'a',
            'ç' => 'c',
            'è' | 'é' | 'ê' | 'ë' => 'e',
            'ì' | 'í' | 'î' | 'ï' => 'i',
            'ñ' => 'n',
            'ò' | 'ó' | 'ô' | 'õ' | 'ö' => 'o',
            'ù' | 'ú' | 'û' | 'ü' => 'u',
            'ý' | 'ÿ' => 'y',
            c => c,
        })
        .collect()
}

fn words(text: &str) -> impl Iterator<Item = &str> {
    text.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty())
}

/// Subsequence match ("vlrnt" in "valorant"): returns the number of skipped characters.
fn subsequence_gaps(hay: &str, needle: &str) -> Option<usize> {
    let mut gaps = 0;
    let mut chars = hay.chars();
    let mut started = false;
    for n in needle.chars() {
        loop {
            let c = chars.next()?;
            if c == n {
                started = true;
                break;
            }
            if started {
                gaps += 1;
            }
        }
    }
    Some(gaps)
}

/// Score one query token against one entry. Higher is better; `None` = no match.
fn token_score(e: &Entry, q: &str) -> Option<u32> {
    if e.name_f == q {
        return Some(1000);
    }
    if e.name_f.starts_with(q) {
        return Some(900 - (e.name_f.len() - q.len()).min(100) as u32);
    }
    if words(&e.name_f).any(|w| w.starts_with(q)) {
        return Some(760);
    }
    if e.name_f.contains(q) {
        return Some(620);
    }
    if q.len() >= 2 && e.initials.starts_with(q) {
        return Some(580);
    }
    if !e.folder_f.is_empty() {
        if e.folder_f.starts_with(q) || words(&e.folder_f).any(|w| w.starts_with(q)) {
            return Some(500);
        }
        if e.folder_f.contains(q) {
            return Some(420);
        }
    }
    if q.len() >= 3 {
        if let Some(gaps) = subsequence_gaps(&e.name_f, q) {
            if gaps <= q.len() * 2 {
                return Some(300u32.saturating_sub(gaps as u32 * 20).max(100));
            }
        }
    }
    None
}

fn entry_score(e: &Entry, tokens: &[String]) -> Option<u32> {
    let mut total = 0;
    for t in tokens {
        total += token_score(e, t)?;
    }
    // Shortcuts are what the Start Menu shows; App Paths entries are a fallback.
    if e.hit.kind == AppKind::Shortcut {
        total += 5;
    }
    Some(total)
}

fn rank(entries: &[Entry], query: &str, limit: usize) -> Vec<AppHit> {
    let tokens: Vec<String> = words(&fold(query.trim())).map(String::from).collect();
    if tokens.is_empty() {
        return Vec::new();
    }
    let mut scored: Vec<(u32, &Entry)> = entries.iter().filter_map(|e| entry_score(e, &tokens).map(|s| (s, e))).collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.hit.name.len().cmp(&b.1.hit.name.len())).then_with(|| a.1.name_f.cmp(&b.1.name_f)));
    scored.into_iter().take(limit).map(|(_, e)| e.hit.clone()).collect()
}

// ---------------------------------------------------------------------------------------------
// Index building
// ---------------------------------------------------------------------------------------------

/// Shortcuts that are not apps.
fn is_noise(name_f: &str) -> bool {
    const NOISE: &[&str] = &[
        "uninstall", "desinstall", "readme", "read me", "release notes", "license", "licence", "documentation", "help", "aide",
        "website", "site web", "manual", "changelog",
    ];
    NOISE.iter().any(|n| name_f.contains(n))
}

fn scan_dir(root: &Path, dir: &Path, depth: usize, out: &mut Vec<Entry>, seen: &mut HashSet<String>) {
    if depth > MAX_DEPTH || out.len() >= MAX_ENTRIES {
        return;
    }
    let Ok(read) = std::fs::read_dir(dir) else { return };
    for item in read.flatten() {
        let path = item.path();
        let Ok(kind) = item.file_type() else { continue };
        if kind.is_dir() {
            scan_dir(root, &path, depth + 1, out, seen);
            continue;
        }
        let ext = path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase());
        if !matches!(ext.as_deref(), Some("lnk") | Some("url")) {
            continue;
        }
        let Some(name) = path.file_stem().and_then(|s| s.to_str()).map(str::to_string) else { continue };
        let name_f = fold(&name);
        if is_noise(&name_f) || !seen.insert(name_f) {
            continue;
        }
        // Top-level folder below the scan root ("Riot Games"), not the root itself.
        let folder = path
            .parent()
            .and_then(|p| p.strip_prefix(root).ok())
            .and_then(|rel| rel.components().next())
            .and_then(|c| c.as_os_str().to_str())
            .map(str::to_string);
        out.push(Entry::new(name, path.to_string_lossy().into_owned(), AppKind::Shortcut, folder));
    }
}

fn known_folder(id: &GUID) -> Option<PathBuf> {
    unsafe {
        let p: PWSTR = SHGetKnownFolderPath(id, KF_FLAG_DEFAULT, None).ok()?;
        let s = p.to_string().ok();
        CoTaskMemFree(Some(p.0 as *const core::ffi::c_void));
        s.map(PathBuf::from)
    }
}

fn reg_string(key: HKEY, subkey: &str) -> Option<String> {
    let wsub = wide(subkey);
    let mut buf = vec![0u16; 1024];
    let mut size = (buf.len() * 2) as u32;
    let err = unsafe {
        RegGetValueW(
            key,
            PCWSTR(wsub.as_ptr()),
            PCWSTR::null(),
            RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ,
            None,
            Some(buf.as_mut_ptr() as *mut core::ffi::c_void),
            Some(&mut size),
        )
    };
    if err.is_err() {
        return None;
    }
    Some(from_wide(&buf))
}

/// `"C:\Program Files\App\app.exe"` / `%ProgramFiles%\…` -> plain path.
pub fn clean_app_path(raw: &str) -> String {
    let trimmed = raw.trim().trim_matches('"').trim();
    let mut out = String::with_capacity(trimmed.len());
    let mut rest = trimmed;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) => {
                let var = &after[..end];
                match std::env::var(var) {
                    Ok(v) => out.push_str(&v),
                    Err(_) => {
                        out.push('%');
                        out.push_str(var);
                        out.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            None => {
                out.push_str(&rest[start..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

fn scan_app_paths(hive: HKEY, out: &mut Vec<Entry>, seen: &mut HashSet<String>) {
    let base = wide("SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths");
    let mut key = HKEY::default();
    if unsafe { RegOpenKeyExW(hive, PCWSTR(base.as_ptr()), None, KEY_READ, &mut key) }.is_err() {
        return;
    }
    let mut index = 0u32;
    loop {
        let mut name = [0u16; 260];
        let mut len = name.len() as u32;
        let err = unsafe { RegEnumKeyExW(key, index, Some(PWSTR(name.as_mut_ptr())), &mut len, None, None, None, None) };
        if err.is_err() {
            break;
        }
        index += 1;
        let exe_name = from_wide(&name[..len as usize]);
        let Some(raw) = reg_string(key, &exe_name) else { continue };
        let path = clean_app_path(&raw);
        if !path.to_ascii_lowercase().ends_with(".exe") || !Path::new(&path).exists() {
            continue;
        }
        let stem = Path::new(&exe_name).file_stem().and_then(|s| s.to_str()).unwrap_or(&exe_name).to_string();
        let name_f = fold(&stem);
        if is_noise(&name_f) || !seen.insert(name_f) {
            continue;
        }
        out.push(Entry::new(stem, path, AppKind::App, None));
    }
    unsafe {
        let _ = RegCloseKey(key);
    }
}

fn build_index() -> Vec<Entry> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(pd) = std::env::var_os("ProgramData") {
        roots.push(PathBuf::from(pd).join("Microsoft\\Windows\\Start Menu\\Programs"));
    }
    if let Some(ad) = std::env::var_os("APPDATA") {
        roots.push(PathBuf::from(ad).join("Microsoft\\Windows\\Start Menu\\Programs"));
    }
    for root in &roots {
        scan_dir(root, root, 0, &mut out, &mut seen);
    }
    for desktop in [known_folder(&FOLDERID_Desktop), known_folder(&FOLDERID_PublicDesktop)].into_iter().flatten() {
        // Desktop: top level only (no folder label).
        scan_dir(&desktop, &desktop, MAX_DEPTH, &mut out, &mut seen);
    }
    scan_app_paths(HKEY_CURRENT_USER, &mut out, &mut seen);
    scan_app_paths(HKEY_LOCAL_MACHINE, &mut out, &mut seen);
    out
}

static INDEX: Lazy<Mutex<Option<(Instant, Arc<Vec<Entry>>)>>> = Lazy::new(|| Mutex::new(None));

fn index() -> Arc<Vec<Entry>> {
    if let Some((at, entries)) = INDEX.lock().as_ref() {
        if at.elapsed() < INDEX_TTL {
            return entries.clone();
        }
    }
    // Build outside the lock: a slow disk must not block concurrent searches on the old index.
    let fresh = Arc::new(build_index());
    *INDEX.lock() = Some((Instant::now(), fresh.clone()));
    fresh
}

/// Build the index in the background so the first keystroke is instant.
pub fn warm() {
    let _ = std::thread::Builder::new().name("lumabar-app-index".into()).spawn(|| {
        let _ = index();
        // Walking thousands of shortcuts and registry keys leaves the working set inflated.
        super::memory::request_trim(Duration::from_secs(2));
    });
}

pub fn search(query: &str) -> Vec<AppHit> {
    rank(&index(), query, MAX_RESULTS)
}

/// True when `path` is something the index produced (the launcher only launches those).
pub fn is_indexed(path: &str) -> bool {
    let wanted = path.to_ascii_lowercase();
    index().iter().any(|e| e.hit.path.to_ascii_lowercase() == wanted)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Vec<Entry> {
        vec![
            Entry::new("Client Riot".into(), r"C:\SM\Riot Games\Client Riot.lnk".into(), AppKind::Shortcut, Some("Riot Games".into())),
            Entry::new("VALORANT".into(), r"C:\SM\Riot Games\VALORANT.lnk".into(), AppKind::Shortcut, Some("Riot Games".into())),
            Entry::new("League of Legends".into(), r"C:\SM\Riot Games\League of Legends.lnk".into(), AppKind::Shortcut, Some("Riot Games".into())),
            Entry::new("Visual Studio Code".into(), r"C:\SM\Visual Studio Code\Visual Studio Code.lnk".into(), AppKind::Shortcut, Some("Visual Studio Code".into())),
            Entry::new("Éditeur du Registre".into(), r"C:\SM\Outils\Éditeur du Registre.lnk".into(), AppKind::Shortcut, Some("Outils".into())),
            Entry::new("Discord".into(), r"C:\SM\Discord Inc\Discord.lnk".into(), AppKind::Shortcut, Some("Discord Inc".into())),
            Entry::new("chrome".into(), r"C:\Program Files\Google\Chrome\chrome.exe".into(), AppKind::App, None),
        ]
    }

    fn names(hits: &[AppHit]) -> Vec<&str> {
        hits.iter().map(|h| h.name.as_str()).collect()
    }

    #[test]
    fn riot_finds_every_riot_game_with_the_client_first() {
        let hits = rank(&fixture(), "riot", MAX_RESULTS);
        assert_eq!(names(&hits), vec!["Client Riot", "VALORANT", "League of Legends"]);
    }

    #[test]
    fn prefix_word_initials_accents_and_fuzzy_matching() {
        let f = fixture();
        assert_eq!(names(&rank(&f, "val", 3))[0], "VALORANT");
        assert_eq!(names(&rank(&f, "legends", 3))[0], "League of Legends");
        assert_eq!(names(&rank(&f, "vsc", 3))[0], "Visual Studio Code");
        assert_eq!(names(&rank(&f, "editeur", 3))[0], "Éditeur du Registre");
        assert_eq!(names(&rank(&f, "ÉDIT", 3))[0], "Éditeur du Registre");
        assert_eq!(names(&rank(&f, "vlrnt", 3))[0], "VALORANT");
        assert_eq!(names(&rank(&f, "studio code", 3)), vec!["Visual Studio Code"]);
        assert_eq!(names(&rank(&f, "chr", 3)), vec!["chrome"]);
        assert!(rank(&f, "zzzz", 3).is_empty());
        assert!(rank(&f, "   ", 3).is_empty());
    }

    #[test]
    fn noise_shortcuts_are_filtered() {
        assert!(is_noise(&fold("Uninstall Discord")));
        assert!(is_noise(&fold("Désinstaller VLC")));
        assert!(!is_noise(&fold("VALORANT")));
    }

    #[test]
    fn app_paths_values_are_unquoted_and_expanded() {
        assert_eq!(clean_app_path("\"C:\\A B\\app.exe\""), "C:\\A B\\app.exe");
        let windir = std::env::var("WINDIR").unwrap_or_default();
        assert_eq!(clean_app_path("%WINDIR%\\notepad.exe"), format!("{windir}\\notepad.exe"));
        assert_eq!(clean_app_path("%NOPE_NOT_SET%\\x.exe"), "%NOPE_NOT_SET%\\x.exe");
    }

    /// The real index on this machine: built, non-empty, and every hit launchable.
    #[test]
    fn real_index_returns_launchable_targets() {
        let entries = build_index();
        assert!(!entries.is_empty(), "the Start Menu has shortcuts");
        for hit in rank(&entries, "a", MAX_RESULTS) {
            let lower = hit.path.to_ascii_lowercase();
            assert!(lower.ends_with(".lnk") || lower.ends_with(".url") || lower.ends_with(".exe"), "{}", hit.path);
        }
    }
}
