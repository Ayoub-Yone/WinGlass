//! Tauri command surface. Every command returns `Result<_, String>` so the frontend gets a
//! readable error instead of a rejected promise with an opaque payload.

use serde_json::Value;
use tauri::{AppHandle, Emitter, State, WebviewWindow};
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;

use crate::AppState;
use crate::graphics::backdrop;
use crate::providers::api_poller::{self, ProviderResult};
use crate::storage::db::{ScreenTimeDay, Todo};
use crate::storage::secrets;
use crate::storage::settings::Settings;
use crate::win32::apps_enum::{self, AppEntry};
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
    if previous.theme != settings.theme {
        backdrop::set_enabled(settings.theme == "liquid-glass");
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
    backdrop::set_rect(RECT {
        left,
        top,
        right: left + rect[2].round() as i32,
        bottom: top + rect[3].round() as i32,
    });
    Ok(())
}

#[tauri::command]
pub fn get_glass_status() -> String {
    backdrop::status()
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
    if !(lower.ends_with(".lnk") || lower.ends_with(".exe")) || !std::path::Path::new(&path).exists() {
        return Err("only existing .lnk / .exe targets can be launched".into());
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

#[tauri::command]
pub async fn windows_search(query: String) -> Result<(), String> {
    blocking(move || apps_enum::open_windows_search(&query)).await
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
pub fn get_secret_names(state: State<'_, AppState>) -> Vec<String> {
    secrets::names(&state.db)
}

// ---------------------------------------------------------------------------------------------
// Layout, notes, todos
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub fn get_layout(state: State<'_, AppState>) -> Option<Value> {
    state.db.kv_get("layout").and_then(|json| serde_json::from_str(&json).ok())
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
