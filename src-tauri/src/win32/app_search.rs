//! Integrated app launcher index (replaces the Windows Search / Win+S overlay).
//!
//! Sources, scanned on demand and cached for `INDEX_TTL`:
//! * Start Menu shortcuts — `%ProgramData%\…\Start Menu\Programs` and `%APPDATA%\…\Start Menu\Programs`
//!   (recursive; the sub-folder, e.g. "Riot Games", is kept as a secondary match field)
//! * Desktop shortcuts — the user's (OneDrive-aware) and the public desktop (`.lnk` + `.url`)
//! * Everything else Start's « All apps » lists, from the shell's `AppsFolder`: packaged (MSIX / Store)
//!   apps — Claude, Calculator, Photos… — and shell items with no `.lnk` such as Control Panel or the
//!   Windows Tools; they launch as `shell:AppsFolder\<id>`
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
use serde::{Deserialize, Serialize};
use windows::Win32::System::Com::{CoTaskMemFree, IBindCtx};
use windows::Win32::UI::WindowsAndMessaging::WM_APP;
use windows::Win32::System::Registry::{
    HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ, RegCloseKey, RegEnumKeyExW,
    RegGetValueW, RegOpenKeyExW,
};
use windows::Win32::UI::Shell::{
    BHID_EnumItems, FOLDERID_AppsFolder, FOLDERID_Desktop, FOLDERID_PublicDesktop, IEnumShellItems, IShellItem, KF_FLAG_DEFAULT,
    SHGetKnownFolderItem, SHGetKnownFolderPath, SIGDN, SIGDN_NORMALDISPLAY, SIGDN_PARENTRELATIVEPARSING,
};
use windows::core::{GUID, PCWSTR, PWSTR};

use super::{from_wide, wide};

const INDEX_TTL: Duration = Duration::from_secs(60);
const MAX_DEPTH: usize = 6;
const MAX_ENTRIES: usize = 6000;
pub const MAX_RESULTS: usize = 8;
/// Launch target / icon key prefix of packaged apps: `shell:AppsFolder\Claude_pzs8sxrjxfjjc!Claude`.
pub const APPS_FOLDER_PREFIX: &str = "shell:AppsFolder\\";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AppKind {
    Shortcut,
    /// MSIX / Store app from the shell AppsFolder.
    Packaged,
    App,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppHit {
    pub name: String,
    /// Launch target (.lnk / .url / .exe / `shell:AppsFolder\<AUMID>`) — also the icon key.
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
    // Shortcuts and packaged apps are what the Start Menu shows; App Paths entries are a fallback.
    if matches!(e.hit.kind, AppKind::Shortcut | AppKind::Packaged) {
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

/// Executables inside an installed MSIX package (`C:\Program Files\WindowsApps\<pkg>\…`): helpers
/// such as `claude-ssh-proxy.exe` that packages register under App Paths. The app itself is
/// indexed from the AppsFolder; execution aliases (`%LOCALAPPDATA%\Microsoft\WindowsApps`) are kept.
fn is_package_internal(path: &str) -> bool {
    path.to_ascii_lowercase().contains("\\program files\\windowsapps\\")
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
        if !path.to_ascii_lowercase().ends_with(".exe") || is_package_internal(&path) || !Path::new(&path).exists() {
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

fn shell_display_name(item: &IShellItem, kind: SIGDN) -> Option<String> {
    unsafe {
        let p = item.GetDisplayName(kind).ok()?;
        let s = p.to_string().ok();
        CoTaskMemFree(Some(p.0 as *const core::ffi::c_void));
        s.filter(|s| !s.trim().is_empty())
    }
}

/// `(display name, parsing id)` of every item in the shell AppsFolder (what Start lists under
/// « All apps »). Desktop apps that also have a `.lnk` are deduplicated by name in `build_index`.
fn scan_apps_folder() -> Vec<(String, String)> {
    super::apps_enum::with_com(|| {
        let mut out = Vec::new();
        unsafe {
            let Ok(folder) = SHGetKnownFolderItem::<IShellItem>(&FOLDERID_AppsFolder, KF_FLAG_DEFAULT, None) else { return out };
            let Ok(items) = folder.BindToHandler::<_, IEnumShellItems>(None::<&IBindCtx>, &BHID_EnumItems) else { return out };
            while out.len() < MAX_ENTRIES {
                let mut batch: [Option<IShellItem>; 32] = Default::default();
                let mut fetched = 0u32;
                if items.Next(&mut batch, Some(&mut fetched)).is_err() || fetched == 0 {
                    break;
                }
                for item in batch.iter().take(fetched as usize).flatten() {
                    let (Some(name), Some(aumid)) = (shell_display_name(item, SIGDN_NORMALDISPLAY), shell_display_name(item, SIGDN_PARENTRELATIVEPARSING))
                    else {
                        continue;
                    };
                    out.push((name, aumid));
                }
            }
        }
        out
    })
    .unwrap_or_default()
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
    for (name, aumid) in scan_apps_folder() {
        let name_f = fold(&name);
        if is_noise(&name_f) || !seen.insert(name_f) {
            continue;
        }
        out.push(Entry::new(name, format!("{APPS_FOLDER_PREFIX}{aumid}"), AppKind::Packaged, None));
    }
    scan_app_paths(HKEY_CURRENT_USER, &mut out, &mut seen);
    scan_app_paths(HKEY_LOCAL_MACHINE, &mut out, &mut seen);
    out
}

static INDEX: Lazy<Mutex<Option<(Instant, Arc<Vec<Entry>>)>>> = Lazy::new(|| Mutex::new(None));

static REFRESHING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn rebuild() -> Arc<Vec<Entry>> {
    // Build outside the lock: a slow disk must not block concurrent searches on the old index.
    let fresh = Arc::new(build_index());
    *INDEX.lock() = Some((Instant::now(), fresh.clone()));
    fresh
}

/// Stale-while-revalidate: an expired index is still answered at once while a background thread
/// rescans, so newly installed apps show up without ever making a keystroke wait.
fn index() -> Arc<Vec<Entry>> {
    let cached = INDEX.lock().clone();
    match cached {
        Some((at, entries)) => {
            if at.elapsed() >= INDEX_TTL && !REFRESHING.swap(true, std::sync::atomic::Ordering::SeqCst) {
                let _ = std::thread::Builder::new().name("winglass-app-index".into()).spawn(|| {
                    rebuild();
                    REFRESHING.store(false, std::sync::atomic::Ordering::SeqCst);
                    super::memory::request_trim(Duration::from_secs(2));
                });
            }
            entries
        }
        None => rebuild(),
    }
}

// ---------------------------------------------------------------------------------------------
// Live index: SQLite snapshot + shell change notifications
// ---------------------------------------------------------------------------------------------

type IndexListener = Box<dyn Fn(&[AppHit]) + Send + Sync>;
static LISTENER: once_cell::sync::OnceCell<IndexListener> = once_cell::sync::OnceCell::new();
const WM_APPS_CHANGED: u32 = WM_APP + 0x41;
const DEBOUNCE_TIMER: usize = 1;
const DEBOUNCE_MS: u32 = 800;

fn keys(entries: &[Entry]) -> Vec<(&str, &str)> {
    let mut k: Vec<_> = entries.iter().map(|e| (e.hit.path.as_str(), e.hit.name.as_str())).collect();
    k.sort_unstable();
    k
}

/// Rescan and tell the listener when the set of apps differs from what was indexed before.
fn reconcile() {
    let before = INDEX.lock().as_ref().map(|(_, entries)| entries.clone());
    let after = rebuild();
    if before.is_none_or(|b| keys(&b) != keys(&after)) {
        if let Some(listener) = LISTENER.get() {
            listener(&after.iter().map(|e| e.hit.clone()).collect::<Vec<_>>());
        }
    }
    // Walking thousands of shortcuts and registry keys leaves the working set inflated.
    super::memory::request_trim(Duration::from_secs(2));
}

/// Seed the index from the last snapshot (the first search is instant), reconcile it against disk
/// in the background, then keep it live: shell notifications on both Start Menu `Programs` folders
/// (interrupt level, ReadDirectoryChangesW underneath) and on the AppsFolder (Store / winget MSIX
/// installs and removals), debounced 800 ms. `on_change` gets the new list only when it changed.
pub fn start(snapshot: Vec<AppHit>, on_change: impl Fn(&[AppHit]) + Send + Sync + 'static) {
    let _ = LISTENER.set(Box::new(on_change));
    if !snapshot.is_empty() {
        let seeded = snapshot.into_iter().map(|h| Entry::new(h.name, h.path, h.kind, h.folder)).collect();
        *INDEX.lock() = Some((Instant::now(), Arc::new(seeded)));
    }
    let _ = std::thread::Builder::new().name("winglass-app-watch".into()).spawn(|| {
        reconcile();
        watch_loop();
    });
}

fn watch_loop() {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{COINIT_APARTMENTTHREADED, CoInitializeEx};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::Shell::{
        FOLDERID_CommonPrograms, FOLDERID_Programs, SHCNE_CREATE, SHCNE_DELETE, SHCNE_MKDIR, SHCNE_RENAMEFOLDER, SHCNE_RENAMEITEM,
        SHCNE_RMDIR, SHCNE_UPDATEDIR, SHCNRF_InterruptLevel, SHCNRF_NewDelivery, SHCNRF_SOURCE, SHCNRF_ShellLevel, SHChangeNotifyEntry,
        SHChangeNotifyRegister, SHGetKnownFolderIDList,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DispatchMessageW, GetMessageW, HWND_MESSAGE, MSG, RegisterClassW, TranslateMessage, WINDOW_EX_STYLE,
        WINDOW_STYLE, WNDCLASSW,
    };
    use windows::core::w;
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let instance = GetModuleHandleW(None).unwrap_or_default();
        let class = w!("WinGlassAppIndexWatch");
        RegisterClassW(&WNDCLASSW { lpfnWndProc: Some(watch_proc), hInstance: instance.into(), lpszClassName: class, ..Default::default() });
        let hwnd: HWND = match CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            class,
            w!(""),
            WINDOW_STYLE::default(),
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            Some(instance.into()),
            None,
        ) {
            Ok(h) => h,
            Err(err) => {
                eprintln!("[winglass] app index watcher window failed: {err}");
                return;
            }
        };
        // The PIDLs stay allocated for the life of the process: the registration refers to them.
        let entries: Vec<SHChangeNotifyEntry> = [&FOLDERID_AppsFolder, &FOLDERID_Programs, &FOLDERID_CommonPrograms]
            .into_iter()
            .filter_map(|id| SHGetKnownFolderIDList(id, KF_FLAG_DEFAULT.0 as u32, None).ok())
            .map(|pidl| SHChangeNotifyEntry { pidl, fRecursive: true.into() })
            .collect();
        let events = SHCNE_CREATE.0 | SHCNE_DELETE.0 | SHCNE_RENAMEITEM.0 | SHCNE_UPDATEDIR.0 | SHCNE_MKDIR.0 | SHCNE_RMDIR.0 | SHCNE_RENAMEFOLDER.0;
        let sources = SHCNRF_SOURCE(SHCNRF_ShellLevel.0 | SHCNRF_InterruptLevel.0 | SHCNRF_NewDelivery.0);
        if SHChangeNotifyRegister(hwnd, sources, events as i32, WM_APPS_CHANGED, entries.len() as i32, entries.as_ptr()) == 0 {
            // The 60 s stale-while-revalidate rescan still picks new apps up.
            eprintln!("[winglass] SHChangeNotifyRegister failed; app index falls back to its TTL");
            return;
        }
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

unsafe extern "system" fn watch_proc(
    hwnd: windows::Win32::Foundation::HWND,
    msg: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::Foundation::{HANDLE, LRESULT};
    use windows::Win32::UI::Shell::Common::ITEMIDLIST;
    use windows::Win32::UI::Shell::{SHChangeNotification_Lock, SHChangeNotification_Unlock};
    use windows::Win32::UI::WindowsAndMessaging::{DefWindowProcW, KillTimer, SetTimer, WM_TIMER};
    unsafe {
        match msg {
            WM_APPS_CHANGED => {
                // New delivery: the event sits in shared memory until it is unlocked.
                let mut pidls: *mut *mut ITEMIDLIST = std::ptr::null_mut();
                let mut event = 0i32;
                let lock = SHChangeNotification_Lock(HANDLE(wparam.0 as *mut _), lparam.0 as u32, Some(&mut pidls), Some(&mut event));
                if !lock.is_invalid() {
                    let _ = SHChangeNotification_Unlock(lock);
                }
                // An installer writes many shortcuts in a burst: rescan once it settles.
                SetTimer(Some(hwnd), DEBOUNCE_TIMER, DEBOUNCE_MS, None);
                LRESULT(0)
            }
            WM_TIMER if wparam.0 == DEBOUNCE_TIMER => {
                let _ = KillTimer(Some(hwnd), DEBOUNCE_TIMER);
                reconcile();
                LRESULT(0)
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }
}

pub fn search(query: &str) -> Vec<AppHit> {
    rank(&index(), query, MAX_RESULTS)
}

// ---------------------------------------------------------------------------------------------
// Local paths typed in the search bar (« C:\Projects », « %APPDATA% », « ~\Documents »)
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PathHit {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    /// The typed path itself (not a completion).
    pub exact: bool,
}

const MAX_PATH_HITS: usize = 6;

/// Expand `%VAR%` and a leading `~` with the given environment lookup.
pub fn expand_path(query: &str, env: impl Fn(&str) -> Option<String>) -> String {
    let q = query.trim().trim_matches('"');
    let q = match q.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with(['\\', '/']) => format!("{}{rest}", env("USERPROFILE").unwrap_or_else(|| "~".into())),
        _ => q.to_string(),
    };
    let mut out = String::new();
    let mut rest = q.as_str();
    while let Some(start) = rest.find('%') {
        let Some(len) = rest[start + 1..].find('%') else { break };
        let name = &rest[start + 1..start + 1 + len];
        out.push_str(&rest[..start]);
        match env(name) {
            Some(value) if !name.is_empty() => out.push_str(&value),
            _ => out.push_str(&rest[start..start + len + 2]),
        }
        rest = &rest[start + len + 2..];
    }
    out.push_str(rest);
    out.replace('/', "\\")
}

/// A local absolute path (`C:\…`, `C:`), never a network share: listing `\\server\…` could hang
/// the launcher on an unreachable host.
pub fn is_local_path(expanded: &str) -> bool {
    let b = expanded.as_bytes();
    b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b.len() == 2 || b[2] == b'\\')
}

/// Whether the query is meant as a path at all (decided before touching the file system).
pub fn looks_like_path(query: &str) -> bool {
    let q = query.trim();
    q.starts_with('~') || q.starts_with('%') || is_local_path(&q.replace('/', "\\"))
}

/// The folder itself when it exists, then children of the folder being typed whose names start
/// with the last segment (folders first).
pub fn complete_path(query: &str) -> Vec<PathHit> {
    if !looks_like_path(query) {
        return Vec::new();
    }
    let expanded = expand_path(query, |k| std::env::var(k).ok());
    if !is_local_path(&expanded) {
        return Vec::new();
    }
    let mut full = expanded.clone();
    if full.len() == 2 {
        full.push('\\');
    }
    let mut out = Vec::new();
    let as_path = Path::new(&full);
    let (dir, prefix) = if full.ends_with('\\') {
        if as_path.is_dir() {
            out.push(PathHit { path: full.clone(), name: full.clone(), is_dir: true, exact: true });
        }
        (as_path.to_path_buf(), String::new())
    } else {
        if as_path.is_dir() || as_path.is_file() {
            out.push(PathHit { path: full.clone(), name: display_name(as_path), is_dir: as_path.is_dir(), exact: true });
        }
        (as_path.parent().map(Path::to_path_buf).unwrap_or_default(), as_path.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default())
    };
    if as_path.is_dir() && !full.ends_with('\\') {
        // An exact folder: its own entry is enough (children appear once a "\" is typed).
        return out;
    }
    if let Ok(read) = std::fs::read_dir(&dir) {
        let mut children: Vec<PathHit> = read
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                let lower = name.to_lowercase();
                if !lower.starts_with(&prefix) || name.starts_with('$') {
                    return None;
                }
                let is_dir = e.file_type().ok()?.is_dir();
                Some(PathHit { path: e.path().to_string_lossy().into_owned(), name, is_dir, exact: false })
            })
            .filter(|h| !out.iter().any(|o| o.path.eq_ignore_ascii_case(&h.path)))
            .collect();
        children.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        out.extend(children);
    }
    out.truncate(MAX_PATH_HITS);
    out
}

fn display_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.to_string_lossy().into_owned())
}

/// Folder -> Explorer at that folder; file -> Explorer with the file selected (never executed).
pub fn open_path(path: &str) -> Result<(), String> {
    let expanded = expand_path(path, |k| std::env::var(k).ok());
    if !is_local_path(&expanded) {
        return Err("only local paths can be opened".into());
    }
    let p = Path::new(&expanded);
    if p.is_dir() {
        super::apps_enum::shell_open("explorer.exe", Some(&format!("\"{expanded}\"")))
    } else if p.is_file() {
        super::apps_enum::shell_open("explorer.exe", Some(&format!("/select,\"{expanded}\"")))
    } else {
        Err(format!("{expanded} does not exist"))
    }
}

/// True when `path` is something the index produced (the launcher only launches those).
pub fn is_indexed(path: &str) -> bool {
    let wanted = path.to_ascii_lowercase();
    index().iter().any(|e| e.hit.path.to_ascii_lowercase() == wanted)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typed_paths_expand_and_stay_local() {
        let env = |k: &str| match k {
            "USERPROFILE" => Some(r"C:\Users\me".to_string()),
            "APPDATA" => Some(r"C:\Users\me\AppData\Roaming".to_string()),
            _ => None,
        };
        assert_eq!(expand_path(r"~\Documents", env), r"C:\Users\me\Documents");
        assert_eq!(expand_path("~", env), r"C:\Users\me");
        assert_eq!(expand_path(r"%APPDATA%\winglass", env), r"C:\Users\me\AppData\Roaming\winglass");
        assert_eq!(expand_path(r"%NOPE%\x", env), r"%NOPE%\x");
        assert_eq!(expand_path("c:/Projects/winglass", env), r"c:\Projects\winglass");
        assert_eq!(expand_path("\"C:\\Program Files\"", env), r"C:\Program Files");
        assert!(looks_like_path(r"C:\Projects") && looks_like_path("C:") && looks_like_path("d:/x") && looks_like_path("~\\x") && looks_like_path("%TEMP%"));
        assert!(!looks_like_path("discord") && !looks_like_path("riot client") && !looks_like_path(r"\\server\share") && !looks_like_path("c:x"));
        assert!(!is_local_path(r"\\server\share"));
        assert!(open_path(r"\\server\share").is_err());
    }

    #[test]
    fn real_paths_complete_folders_first() {
        let root = std::env::temp_dir().join(format!("winglass-path-{}", std::process::id()));
        std::fs::create_dir_all(root.join("Projects")).unwrap();
        std::fs::create_dir_all(root.join("Photos")).unwrap();
        std::fs::write(root.join("plan.txt"), b"x").unwrap();
        std::fs::write(root.join("other.txt"), b"x").unwrap();
        let base = root.to_string_lossy().to_string();
        let names = |q: &str| complete_path(q).into_iter().map(|h| (h.name, h.is_dir)).collect::<Vec<_>>();
        assert_eq!(names(&format!(r"{base}\p")), vec![("Photos".into(), true), ("Projects".into(), true), ("plan.txt".into(), false)]);
        // An exact folder is offered on its own; typing "\" lists what is inside.
        assert_eq!(names(&format!(r"{base}\Projects")), vec![("Projects".into(), true)]);
        let inside = complete_path(&format!(r"{base}\"));
        assert!(inside[0].is_dir && inside[0].exact && inside.len() == 5 && inside[1..].iter().all(|h| !h.exact), "{inside:?}");
        assert!(complete_path(&format!(r"{base}\Projects"))[0].exact);
        assert!(complete_path(&format!(r"{base}\p")).iter().all(|h| !h.exact));
        assert!(complete_path("discord").is_empty());
        assert!(open_path(&format!(r"{base}\missing")).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

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
            let packaged = hit.path.starts_with(APPS_FOLDER_PREFIX);
            assert!(packaged || lower.ends_with(".lnk") || lower.ends_with(".url") || lower.ends_with(".exe"), "{}", hit.path);
        }
    }

    #[test]
    fn packaged_apps_rank_like_start_menu_shortcuts() {
        let mut f = fixture();
        f.push(Entry::new("Claude".into(), format!("{APPS_FOLDER_PREFIX}Claude_pzs8sxrjxfjjc!Claude"), AppKind::Packaged, None));
        f.push(Entry::new("Calculatrice".into(), format!("{APPS_FOLDER_PREFIX}Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"), AppKind::Packaged, None));
        let hits = rank(&f, "claude", 3);
        assert_eq!(names(&hits), vec!["Claude"]);
        assert_eq!(hits[0].kind, AppKind::Packaged);
        assert_eq!(names(&rank(&f, "cla", 3))[0], "Claude");
        assert_eq!(names(&rank(&f, "calc", 3))[0], "Calculatrice");
        assert!(is_package_internal(r"C:\Program Files\WindowsApps\Claude_5.11492.5.0_x64__pzs8sxrjxfjjc\app\resources\claude-ssh-proxy.exe"));
        assert!(!is_package_internal(r"C:\Users\me\AppData\Local\Microsoft\WindowsApps\wt.exe"));
        assert!(!is_package_internal(r"C:\Program Files\Google\Chrome\Application\chrome.exe"));
    }

    /// Every Windows 10/11 desktop ships packaged apps (Settings, Calculator…): the AppsFolder scan
    /// must find them with `PackageFamilyName!AppId` AUMIDs, and they must land in the index.
    #[test]
    fn real_apps_folder_lists_packaged_apps() {
        let packaged = scan_apps_folder();
        assert!(!packaged.is_empty(), "AppsFolder exposes packaged apps");
        assert!(packaged.iter().all(|(name, id)| !name.is_empty() && !id.is_empty()));
        assert!(packaged.iter().any(|(_, id)| id.contains('!')), "Store apps are listed");
        let index = build_index();
        assert!(index.iter().any(|e| e.hit.kind == AppKind::Packaged && e.hit.path.starts_with(APPS_FOLDER_PREFIX)));
    }
}

#[cfg(test)]
mod control_panel_probe {
    use super::*;

    /// Shell items with no `.lnk` (Control Panel) are indexed and found by their localized name.
    #[test]
    fn control_panel_is_in_the_index() {
        let entries = build_index();
        let cp = entries.iter().find(|e| e.hit.path.eq_ignore_ascii_case(&format!("{APPS_FOLDER_PREFIX}Microsoft.Windows.ControlPanel")));
        let cp = cp.expect("Control Panel is listed in the AppsFolder");
        let hits = rank(&entries, &cp.hit.name, MAX_RESULTS);
        assert!(hits.iter().any(|h| h.path == cp.hit.path), "{} is searchable", cp.hit.name);
        eprintln!("control panel: {} -> {}", cp.hit.name, cp.hit.path);
        eprintln!("index size: {}", entries.len());
    }
}
