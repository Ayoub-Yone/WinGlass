mod commands;
mod graphics;
mod providers;
mod storage;
mod win32;

use parking_lot::RwLock;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};

use storage::db::Db;
use storage::settings::Settings;
use win32::sentinel::{self, SentinelEvent};
use win32::taskbar::{self, TaskbarMode};
use win32::window_manager;

pub use win32::guardian::GUARDIAN_FLAG;

/// Entry point of the out-of-process taskbar guardian (see win32/guardian.rs).
pub fn run_guardian(pid: u32) {
    win32::guardian::run(pid);
}

pub struct AppState {
    pub db: Db,
    pub settings: RwLock<Settings>,
}

/// Restore the native taskbar and exit the process.
pub fn restore_and_quit(app: &AppHandle) {
    taskbar::restore();
    app.exit(0);
}

/// Emergency hotkey: native taskbar back, persist "native" mode, dock re-centered on primary/bottom.
fn emergency_restore(app: &AppHandle) {
    taskbar::restore();
    let state = app.state::<AppState>();
    {
        let mut settings = state.settings.write();
        settings.taskbar_mode = "native".into();
        settings.position = "bottom".into();
        settings.monitor = None;
        let _ = settings.save(&state.db);
    }
    let settings = state.settings.read().clone();
    let _ = app.emit("settings:changed", &settings);
    window_manager::relayout_and_broadcast(app);
    let _ = app.emit(
        "toast:push",
        serde_json::json!({
            "id": "emergency-restore",
            "title": "Windows taskbar restored",
            "subtitle": "Ctrl + Alt + Shift + R · lumabar keeps running",
            "kind": "system",
        }),
    );
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let settings_item = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let widgets_item = MenuItem::with_id(app, "picker", "Add Widgets…", true, None::<&str>)?;
    let restore_item = MenuItem::with_id(app, "restore", "Restore Windows Taskbar", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Restore Windows Taskbar & Quit", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&widgets_item, &settings_item, &separator, &restore_item, &quit_item])?;

    let mut builder = TrayIconBuilder::with_id("lumabar-tray").tooltip("lumabar").menu(&menu);
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder
        .on_menu_event(|app, event| match event.id().as_ref() {
            "settings" => window_manager::show_centered(app, "settings"),
            "picker" => window_manager::show_centered(app, "picker"),
            "restore" => emergency_restore(app),
            "quit" => restore_and_quit(app),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

pub fn run() {
    // Invariant 4: refuse to start (and touch nothing) when another instance is running.
    let Some(instance_guard) = win32::acquire_single_instance() else {
        return;
    };

    win32::install_crash_guards();
    taskbar::init();
    win32::guardian::spawn();

    let db = Db::open().expect("open %APPDATA%\\lumabar\\lumabar.db");
    let settings = Settings::load(&db);

    let app = tauri::Builder::default()
        .manage(AppState { db, settings: RwLock::new(settings) })
        .register_asynchronous_uri_scheme_protocol("glass", |_ctx, _request, responder| {
            responder.respond(graphics::capture_response());
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::update_settings,
            commands::get_dock_layout,
            commands::set_hit_regions,
            commands::snap_dock_to_cursor,
            commands::set_dock_position,
            commands::set_taskbar_mode,
            commands::restore_taskbar_and_quit,
            commands::open_window,
            commands::hide_window,
            commands::set_glass_rect,
            commands::get_glass_status,
            commands::list_apps,
            commands::get_app_icon,
            commands::activate_window,
            commands::launch_app,
            commands::open_target,
            commands::windows_search,
            commands::media_state,
            commands::media_command,
            commands::media_pause,
            commands::get_screen_time,
            commands::set_radio,
            commands::set_hotspot,
            commands::cycle_keyboard_layout,
            commands::get_providers,
            commands::refresh_provider,
            commands::set_secret,
            commands::get_secret_names,
            commands::get_layout,
            commands::save_layout,
            commands::get_note,
            commands::save_note,
            commands::list_todos,
            commands::add_todo,
            commands::set_todo_done,
            commands::delete_todo,
            commands::clear_done_todos,
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                match window.label() {
                    // Modals are reused: hide instead of destroying.
                    "picker" | "settings" => {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                    // Closing the dock or toast overlay (Alt+F4, `taskkill`) quits, restoring
                    // the taskbar first.
                    _ => {
                        api.prevent_close();
                        restore_and_quit(window.app_handle());
                    }
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let settings = handle.state::<AppState>().settings.read().clone();

            taskbar::apply(TaskbarMode::parse(&settings.taskbar_mode));

            window_manager::layout_windows(&handle);
            for label in ["dock", "toast"] {
                if let Some(window) = handle.get_webview_window(label) {
                    window_manager::make_tool_window(&window);
                    let _ = window.set_ignore_cursor_events(true);
                    window_manager::show_no_activate(&window);
                }
            }

            let sentinel_handle = handle.clone();
            sentinel::start(Box::new(move |event| match event {
                SentinelEvent::EmergencyRestore => emergency_restore(&sentinel_handle),
                SentinelEvent::SessionEnding => taskbar::restore(),
                SentinelEvent::CloseRequested => restore_and_quit(&sentinel_handle),
                SentinelEvent::TaskbarRecreated => taskbar::reapply(),
                SentinelEvent::ForegroundChanged(hwnd) => {
                    let _ = sentinel_handle.emit_to("dock", "apps:foreground", hwnd as i64);
                }
            }));

            window_manager::start_hit_testing();
            window_manager::start_fullscreen_watch(handle.clone());
            graphics::dxgi_capture::start(handle.clone());
            graphics::dxgi_capture::set_enabled(&handle, settings.theme == "liquid-glass");
            win32::media_smtc::start(handle.clone());
            win32::screen_time::start(handle.clone());
            win32::telemetry::start(handle.clone());
            providers::api_poller::start(handle.clone());
            build_tray(&handle)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("build lumabar");

    app.run(|_app, event| {
        if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
            taskbar::restore();
        }
    });

    taskbar::restore();
    drop(instance_guard);
}
