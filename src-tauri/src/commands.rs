//! Tauri command surface. Every command returns `Result<_, String>` so the frontend gets a
//! readable error instead of a rejected promise with an opaque payload.

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;

use crate::AppState;
use crate::graphics;
use crate::providers::api_poller::{self, ProviderResult};
use crate::providers::prayer_times::{self, Mosque};
use crate::storage::db::{ScreenTimeDay, Todo};
use crate::storage::secrets;
use crate::storage::settings::Settings;
use crate::providers::accounts::{self, AccountStatus};
use crate::win32::app_search::{self, AppHit, PathHit};
use crate::win32::brightness::{self, Display};
use crate::win32::apps_enum::{self, AppEntry};
use crate::win32::audio::{self, AppAudio, AudioState};
use crate::win32::liner;
use crate::win32::tray_icons::{self, TrayIcon};
use crate::win32::media_smtc::{self, MediaCommand, MediaState};
use crate::win32::taskbar::{self, TaskbarMode};
use crate::win32::telemetry;
use crate::win32::window_manager::{self, DockLayout, HitRect};

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Settings {
    state.settings.read().clone()
}

/// Replace the settings document and apply every side effect of what changed.
#[tauri::command]
pub fn update_settings(app: AppHandle, state: State<'_, AppState>, settings: Settings) -> Result<Settings, String> {
    let previous = state.settings.read().clone();
    settings.save(&state.db)?;
    *state.settings.write() = settings.clone();

    if previous.taskbar_mode != settings.taskbar_mode {
        taskbar::apply(TaskbarMode::parse(&settings.taskbar_mode));
    }
    if previous.position != settings.position || previous.size != settings.size || previous.monitor != settings.monitor {
        window_manager::relayout_and_broadcast(&app);
    }
    if previous.launch_at_login != settings.launch_at_login {
        crate::win32::set_launch_at_login(settings.launch_at_login)?;
    }
    if previous.language != settings.language {
        crate::refresh_tray_language(&app, &settings.language);
    }
    if previous.theme != settings.theme || previous.clear_mode != settings.clear_mode {
        graphics::configure(&app, settings.uses_glass_capture());
    }
    let providers_changed = serde_json::to_value(&previous.providers).ok() != serde_json::to_value(&settings.providers).ok();
    if previous.simulation != settings.simulation || providers_changed {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move { api_poller::refresh_all(&handle).await });
    } else if previous.prayer.source != settings.prayer.source || prayer_times::config_key(&previous.prayer) != prayer_times::config_key(&settings.prayer) {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move { api_poller::refresh(&handle, "prayer").await });
    }
    app.emit("settings:changed", &settings).map_err(|e| e.to_string())?;
    Ok(settings)
}

// ---------------------------------------------------------------------------------------------
// Dock geometry & windows
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub fn get_dock_layout(app: AppHandle) -> Result<DockLayout, String> {
    window_manager::layout_windows(&app).ok_or_else(|| "no monitor available".to_string())
}

/// `rects` are physical pixels relative to the calling window. `capture_all` makes the whole
/// window interactive (used during drags and while a menu is open).
#[tauri::command]
pub fn set_hit_regions(window: WebviewWindow, rects: Vec<HitRect>, capture_all: bool, hold: bool) {
    window_manager::set_hit_regions(window, rects, capture_all, hold);
}

#[tauri::command]
pub fn overlay_ready(app: AppHandle, window: WebviewWindow) {
    let label = window.label().to_string();
    // Win32 show + SetWindowPos belong on the main thread.
    let h = app.clone();
    let _ = app.run_on_main_thread(move || window_manager::mark_overlay_ready(&h, &label));
}

#[tauri::command]
pub fn snap_dock_to_cursor(app: AppHandle) -> Result<String, String> {
    window_manager::snap_to_cursor(&app)
        .map(|edge| edge.as_str().to_string())
        .ok_or_else(|| "cursor is not over a monitor".to_string())
}

#[tauri::command]
pub fn set_dock_position(app: AppHandle, state: State<'_, AppState>, position: String) -> Result<(), String> {
    if position != "top" && position != "bottom" {
        return Err(format!("invalid dock position '{position}'"));
    }
    let settings = {
        let mut settings = state.settings.write();
        settings.position = position;
        settings.save(&state.db)?;
        settings.clone()
    };
    window_manager::relayout_and_broadcast(&app);
    app.emit("settings:changed", &settings).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_taskbar_mode(app: AppHandle, state: State<'_, AppState>, mode: String) -> Result<(), String> {
    let parsed = TaskbarMode::parse(&mode);
    let settings = {
        let mut settings = state.settings.write();
        settings.taskbar_mode = mode;
        settings.save(&state.db)?;
        settings.clone()
    };
    taskbar::apply(parsed);
    app.emit("settings:changed", &settings).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn restore_taskbar_and_quit(app: AppHandle) {
    crate::restore_and_quit(&app, "Restaurer la barre des tâches et quitter (dock menu / tray card)");
}

/// Show the picker / settings window, creating it on demand. Async on purpose: creating a window
/// from a synchronous command deadlocks on Windows.
#[tauri::command]
pub async fn open_window(app: AppHandle, label: String, tab: Option<String>) -> Result<(), String> {
    window_manager::open_modal(&app, &label, tab.as_deref())
}

/// Destroy the picker / settings window so its WebView2 renderer does not linger in memory.
#[tauri::command]
pub async fn close_window(app: AppHandle, label: String) -> Result<(), String> {
    window_manager::close_modal(&app, &label)
}

// ---------------------------------------------------------------------------------------------
// Liquid glass
// ---------------------------------------------------------------------------------------------

/// `rect` = pill bounds in physical px relative to the dock window.
#[tauri::command]
pub fn set_glass_rect(window: WebviewWindow, rect: HitRect) -> Result<(), String> {
    let raw = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
    let mut win = RECT::default();
    unsafe { GetWindowRect(HWND(raw as *mut core::ffi::c_void), &mut win) }.map_err(|e| e.to_string())?;
    let left = win.left + rect[0].round() as i32;
    let top = win.top + rect[1].round() as i32;
    graphics::set_rect(RECT {
        left,
        top,
        right: left + rect[2].round() as i32,
        bottom: top + rect[3].round() as i32,
    });
    Ok(())
}

#[tauri::command]
pub fn get_glass_status() -> String {
    graphics::status()
}

// ---------------------------------------------------------------------------------------------
// Apps
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub async fn list_apps() -> Result<Vec<AppEntry>, String> {
    blocking(|| Ok(apps_enum::list_apps())).await
}

fn save_pins(state: &AppState, pins: Vec<apps_enum::Pin>) -> Result<(), String> {
    let json = serde_json::to_string(&pins).map_err(|e| e.to_string())?;
    state.db.kv_set("pinned_apps", &json).map_err(|e| e.to_string())?;
    apps_enum::set_pins(pins);
    Ok(())
}

/// Appends to the WinGlass pin list (dock order = list order); no-op if already pinned.
#[tauri::command]
pub async fn pin_app(state: State<'_, AppState>, target: String, name: String, icon_key: String) -> Result<(), String> {
    let lookup = target.clone();
    let exe = blocking(move || Ok(apps_enum::target_exe(&lookup))).await?;
    let mut pins = apps_enum::pins();
    let same = |p: &apps_enum::Pin| {
        p.target.eq_ignore_ascii_case(&target)
            || matches!((&p.exe, &exe), (Some(a), Some(b)) if a.eq_ignore_ascii_case(b))
    };
    if !pins.iter().any(same) {
        pins.push(apps_enum::Pin { target, name, icon_key, exe });
    }
    save_pins(&state, pins)
}

#[tauri::command]
pub fn unpin_app(state: State<'_, AppState>, target: String) -> Result<(), String> {
    let mut pins = apps_enum::pins();
    pins.retain(|p| p.target != target);
    save_pins(&state, pins)
}

#[tauri::command]
pub async fn get_app_icon(key: String) -> Result<Option<String>, String> {
    blocking(move || Ok(apps_enum::icon_data_url(&key))).await
}

/// The dock's app icons on screen, one entry per listed window (title-bar minimize genie target).
#[tauri::command]
pub fn set_dock_icon_rects(icons: Vec<(i64, [i32; 4])>) {
    use windows::Win32::Foundation::RECT;
    crate::win32::genie::set_icon_rects(
        icons.into_iter().map(|(hwnd, [left, top, right, bottom])| (hwnd as isize, RECT { left, top, right, bottom })).filter(|(_, r)| r.right > r.left && r.bottom > r.top),
    );
}

/// `icon`: the dock icon's screen rect [left, top, right, bottom] (physical px) for the genie animation.
#[tauri::command]
pub fn activate_window(hwnd: i64, icon: Option<[i32; 4]>) -> Result<(), String> {
    apps_enum::activate_window(hwnd, icon)
}

#[tauri::command]
pub async fn launch_app(path: String) -> Result<(), String> {
    blocking(move || launch_checked(&path)).await
}

/// Files dragged from Explorer onto a dock app icon: open them with that app.
#[tauri::command]
pub async fn open_files_with(path: String, files: Vec<String>) -> Result<(), String> {
    blocking(move || {
        check_target(&path)?;
        if path.to_ascii_lowercase().ends_with(".url") {
            return Err("internet shortcuts cannot open files".into());
        }
        if files.is_empty() || files.len() > 64 {
            return Err("drop between 1 and 64 files".into());
        }
        if let Some(bad) = files.iter().find(|f| !app_search::is_local_path(f) || f.contains('"') || !std::path::Path::new(f).exists()) {
            return Err(format!("{bad} is not an existing local path"));
        }
        apps_enum::open_files_with(&path, files)
    })
    .await
}

fn launch_checked(path: &str) -> Result<(), String> {
    check_target(path)?;
    apps_enum::launch(path)
}

fn check_target(path: &str) -> Result<(), String> {
    // Packaged (MSIX / Store) apps: only AUMIDs the launcher index found in the AppsFolder.
    if let Some(aumid) = path.strip_prefix(app_search::APPS_FOLDER_PREFIX) {
        if aumid.is_empty() || !app_search::is_indexed(path) {
            return Err("this app is not in the app index".into());
        }
        return Ok(());
    }
    let lower = path.to_ascii_lowercase();
    if !(lower.ends_with(".lnk") || lower.ends_with(".exe") || lower.ends_with(".url")) || !std::path::Path::new(path).exists() {
        return Err("only existing .lnk / .url / .exe targets can be launched".into());
    }
    // Internet shortcuts can point anywhere: only the ones the launcher index found on disk.
    if lower.ends_with(".url") && !app_search::is_indexed(path) {
        return Err("this internet shortcut is not in the app index".into());
    }
    Ok(())
}

/// Quick folders, https links and a small allow-list of Windows URI schemes.
#[tauri::command]
pub fn open_target(target: String) -> Result<(), String> {
    let shell = |arg: &str| apps_enum::shell_open("explorer.exe", Some(arg));
    match target.as_str() {
        "downloads" => shell("shell:Downloads"),
        "screenshots" => shell("shell:Screenshots"),
        "recent" => shell("shell:Recent"),
        "recycle-bin" => shell("shell:RecycleBinFolder"),
        "documents" => shell("shell:Personal"),
        "desktop" => shell("shell:Desktop"),
        "calendar-app" => apps_enum::shell_open("outlookcal:", None),
        t if t.starts_with("https://") || t.starts_with("http://") => apps_enum::shell_open(t, None),
        t if t.starts_with("ms-settings:") => apps_enum::shell_open(t, None),
        _ => Err(format!("target '{target}' is not allowed")),
    }
}

/// Integrated launcher: fuzzy/prefix search over Start Menu, Desktop and App Paths.
#[tauri::command]
pub async fn search_installed_apps(query: String) -> Result<Vec<AppHit>, String> {
    blocking(move || Ok(app_search::search(&query))).await
}

/// Launcher: a typed local path (« C:Projects », « %APPDATA% », « ~Documents ») and its completions.
#[tauri::command]
pub async fn complete_path(query: String) -> Result<Vec<PathHit>, String> {
    blocking(move || Ok(app_search::complete_path(&query))).await
}

/// Folder -> Explorer at it; file -> Explorer with it selected (never executed).
#[tauri::command]
pub async fn open_path(path: String) -> Result<(), String> {
    blocking(move || app_search::open_path(&path)).await
}

// ---------------------------------------------------------------------------------------------
// Display brightness (WMI panel + DDC/CI monitors)
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub async fn get_brightness() -> Result<Vec<Display>, String> {
    blocking(|| Ok(brightness::list())).await
}

#[tauri::command]
pub async fn set_brightness(id: String, percent: u32) -> Result<Display, String> {
    blocking(move || brightness::set(&id, percent.min(100))).await
}

// ---------------------------------------------------------------------------------------------
// System volume
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub fn audio_state() -> AudioState {
    audio::latest()
}

#[tauri::command]
pub async fn audio_set_volume(volume: u32) -> Result<AudioState, String> {
    blocking(move || audio::set_volume(volume)).await
}

/// Mouse wheel: relative step (±2 / ±4) applied atomically on the audio thread.
#[tauri::command]
pub async fn audio_step(delta: i32) -> Result<AudioState, String> {
    blocking(move || audio::step(delta)).await
}

/// `muted: null` toggles.
#[tauri::command]
pub async fn audio_set_mute(muted: Option<bool>) -> Result<AudioState, String> {
    blocking(move || audio::set_mute(muted)).await
}

#[tauri::command]
pub async fn audio_set_device(id: String) -> Result<AudioState, String> {
    blocking(move || audio::set_default_device(id)).await
}

/// Per-app mixer: sessions on the default output, grouped by executable.
#[tauri::command]
pub async fn get_audio_sessions() -> Result<Vec<AppAudio>, String> {
    blocking(audio::sessions).await
}

#[tauri::command]
pub async fn set_app_volume(pid: u32, volume: u8) -> Result<Vec<AppAudio>, String> {
    blocking(move || audio::set_app_volume(pid, u32::from(volume))).await
}

#[tauri::command]
pub async fn set_app_mute(pid: u32, muted: bool) -> Result<Vec<AppAudio>, String> {
    blocking(move || audio::set_app_mute(pid, muted)).await
}

// ---------------------------------------------------------------------------------------------
// Notification-area (tray) icons — behind the dock's hidden-icons chevron
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub async fn get_tray_icons() -> Result<Vec<TrayIcon>, String> {
    blocking(|| Ok(tray_icons::list())).await
}

/// `action`: "open" | "settings" | "quit" — acts on the app itself; the Windows tray and its
/// overflow are never shown or clicked.
#[tauri::command]
pub async fn tray_icon_action(id: String, action: String) -> Result<tray_icons::Outcome, String> {
    let action = tray_icons::Action::parse(&action).ok_or_else(|| format!("unknown action '{action}'"))?;
    blocking(move || tray_icons::act(&id, action)).await
}

// ---------------------------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub fn media_state() -> MediaState {
    media_smtc::latest()
}

#[tauri::command]
pub async fn media_command(action: String) -> Result<(), String> {
    let command = match action.as_str() {
        "toggle" => MediaCommand::TogglePlayPause,
        "pause" => MediaCommand::Pause,
        "play" => MediaCommand::Play,
        "next" => MediaCommand::Next,
        "previous" => MediaCommand::Previous,
        _ => return Err(format!("unknown media action '{action}'")),
    };
    blocking(move || media_smtc::send(command)).await
}

/// Used by the pre-meeting automation.
#[tauri::command]
pub async fn media_pause() -> Result<(), String> {
    blocking(|| media_smtc::send(MediaCommand::Pause)).await
}

/// Artwork click: focus the running Liner window, or launch Liner. Other sources have no
/// reliable window to target, so they are left alone.
#[tauri::command]
pub async fn media_open_source() -> Result<String, String> {
    blocking(|| {
        let state = media_smtc::latest();
        if state.available && !state.is_liner {
            return Err("only the Liner player can be focused from the dock".into());
        }
        liner::focus_or_launch().map(|outcome| match outcome {
            liner::OpenOutcome::Focused => "focused".to_string(),
            liner::OpenOutcome::Launched => "launched".to_string(),
        })
    })
    .await
}

// ---------------------------------------------------------------------------------------------
// Screen time & telemetry controls
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub fn get_screen_time(state: State<'_, AppState>, day: Option<String>) -> Result<ScreenTimeDay, String> {
    let day = day.unwrap_or_else(|| chrono::Local::now().format("%Y-%m-%d").to_string());
    state.db.screen_time_day(&day).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_radio(kind: String, on: bool) -> Result<(), String> {
    blocking(move || telemetry::set_radio(&kind, on)).await
}

#[tauri::command]
pub async fn set_hotspot(on: bool) -> Result<(), String> {
    blocking(move || telemetry::set_hotspot(on)).await
}

/// Windows-button power section ("lock" | "sleep" | "restart" | "shutdown"). The menu confirms
/// restart / shut down before calling this.
#[tauri::command]
pub async fn power_action(action: String) -> Result<(), String> {
    let action = crate::win32::power::PowerAction::parse(&action).ok_or_else(|| format!("unknown power action '{action}'"))?;
    blocking(move || crate::win32::power::run(action)).await
}

/// Win+X menu of the Windows button. Only the fixed ids below run: the webview never passes a
/// path or command line, so this cannot launch arbitrary programs.
#[tauri::command]
pub async fn open_winx_item(id: String) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{SW_HIDE, SW_SHOWNORMAL};
    let (verb, target, args, show) = match id.as_str() {
        "apps" => ("open", "ms-settings:appsfeatures", None, SW_SHOWNORMAL),
        "power-options" => ("open", "powercfg.cpl", None, SW_SHOWNORMAL),
        "eventvwr" => ("open", "eventvwr.msc", None, SW_SHOWNORMAL),
        "system" => ("open", "ms-settings:about", None, SW_SHOWNORMAL),
        "devmgmt" => ("open", "devmgmt.msc", None, SW_SHOWNORMAL),
        "network" => ("open", "ncpa.cpl", None, SW_SHOWNORMAL),
        "diskmgmt" => ("open", "diskmgmt.msc", None, SW_SHOWNORMAL),
        "compmgmt" => ("open", "compmgmt.msc", None, SW_SHOWNORMAL),
        "terminal" => ("open", "wt.exe", None, SW_SHOWNORMAL),
        "terminal-admin" => ("runas", "wt.exe", None, SW_SHOWNORMAL),
        "taskmgr" => ("open", "taskmgr.exe", None, SW_SHOWNORMAL),
        "settings" => ("open", "ms-settings:", None, SW_SHOWNORMAL),
        "explorer" => ("open", "explorer.exe", None, SW_SHOWNORMAL),
        "search" => return win_combo(0x53), // Win+S: ms-search: is not a registered protocol
        "run" => ("open", "rundll32.exe", Some("shell32.dll,#61"), SW_SHOWNORMAL),
        "signout" => ("open", "shutdown.exe", Some("/l"), SW_HIDE),
        // "Show desktop" shell object: toggles like Win+D.
        "desktop" => ("open", "explorer.exe", Some("shell:::{3080F90D-D7AD-11D9-BD98-0000947B0257}"), SW_SHOWNORMAL),
        _ => return Err(format!("unknown Win+X item '{id}'")),
    };
    blocking(move || apps_enum::shell_exec_sta(verb, target, args, show)).await
}

/// Win + `vk` through SendInput (the shell handles it whichever window has focus).
fn win_combo(vk: u16) -> Result<(), String> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, SendInput, VIRTUAL_KEY, VK_LWIN};
    let key = |k: VIRTUAL_KEY, flags: KEYBD_EVENT_FLAGS| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: k, wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    };
    let none = KEYBD_EVENT_FLAGS(0);
    let inputs = [key(VK_LWIN, none), key(VIRTUAL_KEY(vk), none), key(VIRTUAL_KEY(vk), KEYEVENTF_KEYUP), key(VK_LWIN, KEYEVENTF_KEYUP)];
    let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize == inputs.len() { Ok(()) } else { Err("the key combination could not be sent".into()) }
}

/// Hover previews: every open window of a dock app entry with a scaled PrintWindow thumbnail.
#[tauri::command]
pub async fn get_app_window_previews(app_id: String) -> Result<Vec<crate::win32::window_previews::WindowPreview>, String> {
    blocking(move || Ok(crate::win32::window_previews::previews(&app_id))).await
}

/// Preview click: that window to the front (restored when minimized). Not `close_window`, which
/// closes winglass's own modal windows.
#[tauri::command]
pub async fn focus_app_window(hwnd: i64) -> Result<(), String> {
    blocking(move || crate::win32::window_previews::focus(hwnd)).await
}

/// Preview × button: WM_CLOSE to that app window.
#[tauri::command]
pub async fn close_app_window(hwnd: i64) -> Result<(), String> {
    blocking(move || crate::win32::window_previews::close(hwnd)).await
}

#[tauri::command]
pub fn cycle_keyboard_layout() -> Result<(), String> {
    telemetry::cycle_keyboard_layout()
}

// ---------------------------------------------------------------------------------------------
// Providers & secrets
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub fn get_providers() -> Vec<ProviderResult> {
    api_poller::snapshot()
}

#[tauri::command]
pub async fn refresh_provider(app: AppHandle, id: String) -> Result<ProviderResult, String> {
    if !api_poller::PROVIDERS.contains(&id.as_str()) {
        return Err(format!("unknown provider '{id}'"));
    }
    Ok(api_poller::refresh(&app, &id).await)
}

#[tauri::command]
pub fn set_secret(app: AppHandle, state: State<'_, AppState>, name: String, value: String) -> Result<Vec<String>, String> {
    secrets::set(&state.db, &name, &value)?;
    let handle = app.clone();
    tauri::async_runtime::spawn(async move { api_poller::refresh_all(&handle).await });
    Ok(secrets::names(&state.db))
}

#[tauri::command]
pub fn account_status(app: AppHandle, provider: String) -> Result<AccountStatus, String> {
    if !accounts::LOGIN_PROVIDERS.contains(&provider.as_str()) {
        return Err(format!("no account for '{provider}'"));
    }
    Ok(accounts::status(&app, &provider))
}

/// « Se connecter avec … »: open the official CLI login and watch for its credentials.
#[tauri::command]
pub fn account_login(app: AppHandle, provider: String) -> Result<(), String> {
    accounts::start_login(&app, &provider)
}

#[tauri::command]
pub fn get_secret_names(state: State<'_, AppState>) -> Vec<String> {
    secrets::names(&state.db)
}

/// City auto-complete (Open-Meteo geocoding) for weather and prayer times.
#[tauri::command]
pub async fn geocode_city(query: String, language: String) -> Result<Vec<Value>, String> {
    api_poller::geocode(&query, &language).await
}

/// Mawaqit mosques matching `query` (or the mosque behind a pasted mawaqit.net link).
#[tauri::command]
pub async fn search_mawaqit_mosques(query: String) -> Result<Vec<Mosque>, String> {
    prayer_times::search(&api_poller::CLIENT, &query).await
}

/// Today's adhan + iqama times of one Mawaqit mosque.
#[tauri::command]
pub async fn fetch_mawaqit_timings(mosque_slug: String) -> Result<Value, String> {
    prayer_times::mawaqit_today(&api_poller::CLIENT, &mosque_slug).await
}

/// Native Windows toast (prayer alerts). Respects winglass's own « Ne pas déranger ».
#[tauri::command]
pub fn notify_native(app: AppHandle, state: State<'_, AppState>, title: String, body: String) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    if state.settings.read().do_not_disturb {
        return Ok(());
    }
    app.notification().builder().title(title).body(body).show().map_err(|e| e.to_string())
}

/// Quick-add from the calendar flyout: a local event saved in SQLite and merged into the feed.
#[tauri::command]
pub async fn add_local_event(app: AppHandle, title: String, start: String, end: String) -> Result<(), String> {
    let title = title.trim();
    if title.is_empty() || title.chars().count() > 200 {
        return Err("invalid event title".into());
    }
    let parse = |s: &str| chrono::DateTime::parse_from_rfc3339(s).map_err(|_| format!("invalid date '{s}'"));
    let (from, to) = (parse(&start)?, parse(&end)?);
    if to <= from {
        return Err("the event must end after it starts".into());
    }
    {
        let db = &app.state::<AppState>().db;
        let mut events = api_poller::local_events(db);
        events.push(serde_json::json!({
            "uid": format!("local-{}", chrono::Utc::now().timestamp_millis()),
            "title": title,
            "start": from.to_rfc3339(),
            "end": to.to_rfc3339(),
            "allDay": false,
            "location": null,
            "url": null,
            "calendar": "WinGlass",
        }));
        // Past events are pruned so the list stays small.
        let cutoff = chrono::Utc::now() - chrono::Duration::days(30);
        events.retain(|e| e["end"].as_str().and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()).is_some_and(|d| d > cutoff));
        api_poller::save_local_events(db, &events)?;
    }
    api_poller::refresh(&app, "calendar").await;
    Ok(())
}

#[tauri::command]
pub async fn delete_local_event(app: AppHandle, uid: String) -> Result<(), String> {
    {
        let db = &app.state::<AppState>().db;
        let mut events = api_poller::local_events(db);
        events.retain(|e| e["uid"].as_str() != Some(uid.as_str()));
        api_poller::save_local_events(db, &events)?;
    }
    api_poller::refresh(&app, "calendar").await;
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Layout, notes, todos
// ---------------------------------------------------------------------------------------------

/// Widgets introduced after a layout was first saved, added once (removing them afterwards sticks).
/// (kv flag, widget, span, insert before the first of these widgets present — else at the end)
const LAYOUT_MIGRATIONS: &[(&str, &str, &str, &[&str])] = &[
    ("layout_migration_volume", "volume", "1x1", &["clock"]),
    ("layout_migration_hidden_tray", "hidden-tray", "auto", &["clock"]),
];

/// Widgets removed once from existing layouts (re-adding them from the picker sticks).
/// Wi-Fi / Bluetooth / Focus now live in the Windows-button system menu.
const LAYOUT_REMOVALS: &[(&str, &str)] = &[("layout_remove_quick_toggles", "quick-toggles")];

/// Remove every instance of `widget_id`; true when the layout changed.
pub fn remove_widget(layout: &mut Vec<Value>, widget_id: &str) -> bool {
    let before = layout.len();
    layout.retain(|i| i.get("widgetId").and_then(|w| w.as_str()) != Some(widget_id));
    layout.len() != before
}

/// Widgets repositioned once (kv flag, widget, put just before this widget).
const LAYOUT_MOVES: &[(&str, &str, &str)] = &[
    // The hidden-icons chevron sits directly left of the clock / date tile.
    ("layout_move_hidden_tray_by_clock", "hidden-tray", "clock"),
];

/// Move `widget_id` directly before `anchor` when both are present; true when the layout changed.
pub fn move_widget_before(layout: &mut Vec<Value>, widget_id: &str, anchor: &str) -> bool {
    let pos = |l: &Vec<Value>, id: &str| l.iter().position(|i| i.get("widgetId").and_then(|w| w.as_str()) == Some(id));
    let (Some(from), Some(to)) = (pos(layout, widget_id), pos(layout, anchor)) else { return false };
    if from + 1 == to {
        return false;
    }
    let item = layout.remove(from);
    let to = pos(layout, anchor).unwrap_or(layout.len());
    layout.insert(to, item);
    true
}

/// Widgets that no longer exist (the open-apps box, the always-visible tray strip): dropped from
/// stored layouts.
const RETIRED_WIDGETS: &[&str] = &["open-apps", "system-tray"];

/// Remove retired widgets; true when the layout changed.
pub fn drop_retired(layout: &mut Vec<Value>) -> bool {
    let before = layout.len();
    layout.retain(|i| !i.get("widgetId").and_then(|w| w.as_str()).is_some_and(|w| RETIRED_WIDGETS.contains(&w)));
    layout.len() != before
}

/// Insert `widget_id` before the first `anchors` widget present (or at the end) unless the layout
/// already has it.
pub fn add_widget_once(layout: &mut Vec<Value>, widget_id: &str, span: &str, anchors: &[&str]) -> bool {
    if layout.iter().any(|item| item.get("widgetId").and_then(|w| w.as_str()) == Some(widget_id)) {
        return false;
    }
    let item = serde_json::json!({ "instanceId": format!("{widget_id}-default"), "widgetId": widget_id, "span": span });
    let id_of = |i: &Value| i.get("widgetId").and_then(|w| w.as_str()).map(str::to_string);
    let at = anchors
        .iter()
        .find_map(|a| layout.iter().position(|i| id_of(i).as_deref() == Some(*a)))
        .unwrap_or(layout.len());
    layout.insert(at, item);
    true
}

#[tauri::command]
pub fn get_layout(state: State<'_, AppState>) -> Option<Value> {
    let mut layout: Value = state.db.kv_get("layout").and_then(|json| serde_json::from_str(&json).ok())?;
    if let Some(items) = layout.as_array_mut() {
        let mut changed = drop_retired(items);
        for (flag, widget) in LAYOUT_REMOVALS {
            if state.db.kv_get(flag).is_none() {
                changed |= remove_widget(items, widget);
                let _ = state.db.kv_set(flag, "1");
            }
        }
        for (flag, widget, span, anchors) in LAYOUT_MIGRATIONS {
            if state.db.kv_get(flag).is_none() {
                changed |= add_widget_once(items, widget, span, anchors);
                let _ = state.db.kv_set(flag, "1");
            }
        }
        for (flag, widget, anchor) in LAYOUT_MOVES {
            if state.db.kv_get(flag).is_none() {
                changed |= move_widget_before(items, widget, anchor);
                let _ = state.db.kv_set(flag, "1");
            }
        }
        if changed {
            if let Ok(json) = serde_json::to_string(&layout) {
                let _ = state.db.kv_set("layout", &json);
            }
        }
    }
    Some(layout)
}

#[tauri::command]
pub fn save_layout(app: AppHandle, window: WebviewWindow, state: State<'_, AppState>, layout: Value) -> Result<(), String> {
    if !layout.is_array() {
        return Err("layout must be an array".into());
    }
    let json = serde_json::to_string(&layout).map_err(|e| e.to_string())?;
    state.db.kv_set("layout", &json).map_err(|e| e.to_string())?;
    app.emit("layout:changed", serde_json::json!({ "source": window.label(), "layout": layout }))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_note(state: State<'_, AppState>, id: String) -> String {
    state.db.get_note(&id)
}

#[tauri::command]
pub fn save_note(state: State<'_, AppState>, id: String, content: String) -> Result<(), String> {
    state.db.save_note(&id, &content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_todos(state: State<'_, AppState>, list: String) -> Result<Vec<Todo>, String> {
    state.db.list_todos(&list).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_todo(state: State<'_, AppState>, list: String, text: String) -> Result<Vec<Todo>, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("todo text is empty".into());
    }
    state.db.add_todo(&list, text).map_err(|e| e.to_string())?;
    state.db.list_todos(&list).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_todo_done(state: State<'_, AppState>, list: String, id: i64, done: bool) -> Result<Vec<Todo>, String> {
    state.db.set_todo_done(id, done).map_err(|e| e.to_string())?;
    state.db.list_todos(&list).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_todo(state: State<'_, AppState>, list: String, id: i64) -> Result<Vec<Todo>, String> {
    state.db.delete_todo(id).map_err(|e| e.to_string())?;
    state.db.list_todos(&list).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_done_todos(state: State<'_, AppState>, list: String) -> Result<Vec<Todo>, String> {
    state.db.clear_done_todos(&list).map_err(|e| e.to_string())?;
    state.db.list_todos(&list).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn volume_widget_is_added_once_before_the_clock() {
        let mut layout: Vec<Value> = serde_json::from_str(r#"[{"instanceId":"a","widgetId":"apps","span":"auto"},{"instanceId":"c","widgetId":"clock","span":"1x1"}]"#).unwrap();
        assert!(add_widget_once(&mut layout, "volume", "1x1", &["clock"]));
        assert_eq!(layout[1]["widgetId"], "volume");
        assert_eq!(layout[2]["widgetId"], "clock");
        assert!(!add_widget_once(&mut layout, "volume", "1x1", &["clock"]));
        assert_eq!(layout.len(), 3);
        // The hidden-icons chevron lands just left of the volume widget.
        assert!(add_widget_once(&mut layout, "hidden-tray", "auto", &["volume", "clock"]));
        assert_eq!(layout[1]["widgetId"], "hidden-tray");
        assert_eq!(layout[2]["widgetId"], "volume");
        let mut no_clock: Vec<Value> = Vec::new();
        assert!(add_widget_once(&mut no_clock, "volume", "1x1", &["clock"]));
        assert_eq!(no_clock[0]["instanceId"], "volume-default");
    }

    #[test]
    fn hidden_tray_chevron_moves_next_to_the_clock_once() {
        let ids = |l: &Vec<Value>| l.iter().filter_map(|i| i["widgetId"].as_str().map(str::to_string)).collect::<Vec<_>>();
        let mut layout: Vec<Value> = serde_json::from_str(r#"[{"widgetId":"weather"},{"widgetId":"hidden-tray"},{"widgetId":"volume"},{"widgetId":"clock"}]"#).unwrap();
        assert!(move_widget_before(&mut layout, "hidden-tray", "clock"));
        assert_eq!(ids(&layout), ["weather", "volume", "hidden-tray", "clock"]);
        assert!(!move_widget_before(&mut layout, "hidden-tray", "clock"));
        // Clock first, or one of them missing.
        let mut first: Vec<Value> = serde_json::from_str(r#"[{"widgetId":"clock"},{"widgetId":"hidden-tray"}]"#).unwrap();
        assert!(move_widget_before(&mut first, "hidden-tray", "clock"));
        assert_eq!(ids(&first), ["hidden-tray", "clock"]);
        let mut none: Vec<Value> = serde_json::from_str(r#"[{"widgetId":"hidden-tray"}]"#).unwrap();
        assert!(!move_widget_before(&mut none, "hidden-tray", "clock"));
    }

    #[test]
    fn retired_widgets_are_dropped_from_stored_layouts() {
        let mut layout: Vec<Value> = serde_json::from_str(r#"[{"widgetId":"apps"},{"widgetId":"open-apps"},{"widgetId":"system-tray"},{"widgetId":"volume"}]"#).unwrap();
        assert!(drop_retired(&mut layout));
        let ids: Vec<&str> = layout.iter().filter_map(|i| i["widgetId"].as_str()).collect();
        assert_eq!(ids, ["apps", "volume"]);
        assert!(!drop_retired(&mut layout));
    }
}
