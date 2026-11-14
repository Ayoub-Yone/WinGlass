//! Tauri command surface. Every command returns `Result<_, String>` so the frontend gets a
//! readable error instead of a rejected promise with an opaque payload.

use serde_json::Value;
use tauri::{AppHandle, Emitter, State, WebviewWindow};
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;

use crate::AppState;
use crate::graphics;
use crate::providers::api_poller::{self, ProviderResult};
use crate::storage::db::{ScreenTimeDay, Todo};
use crate::storage::secrets;
use crate::storage::settings::Settings;
use crate::providers::accounts::{self, AccountStatus};
use crate::win32::app_search::{self, AppHit};
use crate::win32::apps_enum::{self, AppEntry};
use crate::win32::audio::{self, AudioState};
use crate::win32::liner;
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
    if previous.theme != settings.theme || previous.glass_backdrop != settings.glass_backdrop {
        graphics::configure(&app, settings.theme == "liquid-glass", &settings.glass_backdrop);
    }
    let providers_changed = serde_json::to_value(&previous.providers).ok() != serde_json::to_value(&settings.providers).ok();
    if previous.simulation != settings.simulation || providers_changed {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move { api_poller::refresh_all(&handle).await });
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
pub fn set_hit_regions(window: WebviewWindow, rects: Vec<HitRect>, capture_all: bool) {
    window_manager::set_hit_regions(window, rects, capture_all);
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
    crate::restore_and_quit(&app);
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

#[tauri::command]
pub async fn get_app_icon(key: String) -> Result<Option<String>, String> {
    blocking(move || Ok(apps_enum::icon_data_url(&key))).await
}

#[tauri::command]
pub fn activate_window(hwnd: i64) -> Result<(), String> {
    apps_enum::activate_window(hwnd)
}

#[tauri::command]
pub fn launch_app(path: String) -> Result<(), String> {
    let lower = path.to_ascii_lowercase();
    if !(lower.ends_with(".lnk") || lower.ends_with(".exe") || lower.ends_with(".url")) || !std::path::Path::new(&path).exists() {
        return Err("only existing .lnk / .url / .exe targets can be launched".into());
    }
    // Internet shortcuts can point anywhere: only the ones the launcher index found on disk.
    if lower.ends_with(".url") && !app_search::is_indexed(&path) {
        return Err("this internet shortcut is not in the app index".into());
    }
    apps_enum::shell_open(&path, None)
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

// ---------------------------------------------------------------------------------------------
// Layout, notes, todos
// ---------------------------------------------------------------------------------------------

/// Widgets introduced after a layout was first saved, added once (removing them afterwards sticks).
const LAYOUT_MIGRATIONS: &[(&str, &str, &str)] = &[("layout_migration_volume", "volume", "1x1")];

/// Insert `widget_id` before the clock (or at the end) unless the layout already has it.
pub fn add_widget_once(layout: &mut Vec<Value>, widget_id: &str, span: &str) -> bool {
    if layout.iter().any(|item| item.get("widgetId").and_then(|w| w.as_str()) == Some(widget_id)) {
        return false;
    }
    let item = serde_json::json!({ "instanceId": format!("{widget_id}-default"), "widgetId": widget_id, "span": span });
    let at = layout.iter().position(|i| i.get("widgetId").and_then(|w| w.as_str()) == Some("clock")).unwrap_or(layout.len());
    layout.insert(at, item);
    true
}

#[tauri::command]
pub fn get_layout(state: State<'_, AppState>) -> Option<Value> {
    let mut layout: Value = state.db.kv_get("layout").and_then(|json| serde_json::from_str(&json).ok())?;
    if let Some(items) = layout.as_array_mut() {
        let mut changed = false;
        for (flag, widget, span) in LAYOUT_MIGRATIONS {
            if state.db.kv_get(flag).is_none() {
                changed |= add_widget_once(items, widget, span);
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
        assert!(add_widget_once(&mut layout, "volume", "1x1"));
        assert_eq!(layout[1]["widgetId"], "volume");
        assert_eq!(layout[2]["widgetId"], "clock");
        assert!(!add_widget_once(&mut layout, "volume", "1x1"));
        assert_eq!(layout.len(), 3);
        let mut no_clock: Vec<Value> = Vec::new();
        assert!(add_widget_once(&mut no_clock, "volume", "1x1"));
        assert_eq!(no_clock[0]["instanceId"], "volume-default");
    }
}
