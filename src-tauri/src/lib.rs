mod commands;
mod graphics;
mod i18n;
mod lru;
mod providers;
mod storage;
mod win32;

use parking_lot::RwLock;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};

use i18n::{Lang, Text, tr};
use storage::db::Db;
use storage::settings::Settings;
use win32::sentinel::{self, SentinelEvent};
use win32::taskbar::{self, TaskbarMode};
use win32::window_manager;

pub use win32::guardian::GUARDIAN_FLAG;

const TRAY_ID: &str = "lumabar-tray";

/// Entry point of the out-of-process taskbar guardian (see win32/guardian.rs).
pub fn run_guardian(pid: u32) {
    win32::guardian::run(pid);
}

pub struct AppState {
    pub db: Db,
    pub settings: RwLock<Settings>,
}

/// Restore the native taskbar and exit the process.
pub fn restore_and_quit(app: &AppHandle, reason: &str) {
    win32::exit_log(&format!("quit: {reason}"));
    taskbar::restore_for_exit();
    win32::arm_exit_watchdog();
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
    let lang = Lang::parse(&settings.language);
    let _ = app.emit("settings:changed", &settings);
    window_manager::relayout_and_broadcast(app);
    let _ = app.emit(
        "toast:push",
        serde_json::json!({
            "id": "emergency-restore",
            "title": tr(lang, Text::ToastTaskbarRestored),
            "subtitle": tr(lang, Text::ToastTaskbarRestoredSub),
            "kind": "system",
        }),
    );
}

fn tray_menu(app: &AppHandle, lang: Lang) -> tauri::Result<Menu<tauri::Wry>> {
    let settings_item = MenuItem::with_id(app, "settings", tr(lang, Text::TraySettings), true, None::<&str>)?;
    let widgets_item = MenuItem::with_id(app, "picker", tr(lang, Text::TrayAddWidgets), true, None::<&str>)?;
    let restore_item = MenuItem::with_id(app, "restore", tr(lang, Text::TrayRestore), true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", tr(lang, Text::TrayRestoreQuit), true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    Menu::with_items(app, &[&widgets_item, &settings_item, &separator, &restore_item, &quit_item])
}

fn build_tray(app: &AppHandle, lang: Lang) -> tauri::Result<()> {
    let menu = tray_menu(app, lang)?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID).tooltip("lumabar").menu(&menu);
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder
        .on_menu_event(|app, event| match event.id().as_ref() {
            // Menu events arrive on the main thread, where creating a window is safe.
            label @ ("settings" | "picker") => {
                if let Err(err) = window_manager::open_modal(app, label, None) {
                    eprintln!("[lumabar] {err}");
                }
            }
            "restore" => emergency_restore(app),
            "quit" => restore_and_quit(app, "tray menu « Quitter »"),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

/// Re-label the tray menu after a language switch.
pub fn refresh_tray_language(app: &AppHandle, language: &str) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    match tray_menu(app, Lang::parse(language)) {
        Ok(menu) => {
            let _ = tray.set_menu(Some(menu));
        }
        Err(err) => eprintln!("[lumabar] could not rebuild the tray menu: {err}"),
    }
}

pub fn run() {
    // Invariant 4: refuse to start (and touch nothing) when another instance is running.
    let Some(instance_guard) = win32::acquire_single_instance() else {
        return;
    };

    win32::install_crash_guards();
    taskbar::init();
    win32::guardian::spawn();

    // lumabar's async work is a handful of HTTPS polls and short blocking commands: two workers
    // are plenty, and far cheaper than Tokio's default of one thread (and stack) per logical core.
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .max_blocking_threads(8)
        .thread_name("lumabar-async")
        .enable_all()
        .build()
        .expect("build the async runtime");
    tauri::async_runtime::set(runtime.handle().clone());

    let db = Db::open().expect(r"open %APPDATA%\lumabar\lumabar.db");
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
            commands::close_window,
            commands::set_glass_rect,
            commands::get_glass_status,
            commands::list_apps,
            commands::get_app_icon,
            commands::activate_window,
            commands::launch_app,
            commands::open_target,
            commands::search_installed_apps,
            commands::audio_state,
            commands::audio_set_volume,
            commands::audio_step,
            commands::audio_set_mute,
            commands::audio_set_device,
            commands::get_audio_sessions,
            commands::set_app_volume,
            commands::set_app_mute,
            commands::get_tray_icons,
            commands::tray_icon_action,
            commands::complete_path,
            commands::open_path,
            commands::get_brightness,
            commands::set_brightness,
            commands::account_status,
            commands::account_login,
            commands::media_state,
            commands::media_command,
            commands::media_pause,
            commands::media_open_source,
            commands::get_screen_time,
            commands::set_radio,
            commands::set_hotspot,
            commands::power_action,
            commands::get_app_window_previews,
            commands::focus_app_window,
            commands::close_app_window,
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
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                // Picker / settings are created on demand and simply close (their webview is
                // destroyed with them). Closing the dock or toast overlay (Alt+F4, `taskkill`)
                // quits, restoring the taskbar first.
                if window_manager::modal_spec(window.label(), Lang::Fr).is_none() {
                    api.prevent_close();
                    restore_and_quit(window.app_handle(), &format!("close requested on the {} window (Alt+F4 / WM_CLOSE / taskkill)", window.label()));
                }
            }
            WindowEvent::Destroyed => {
                if window_manager::modal_spec(window.label(), Lang::Fr).is_some() {
                    window_manager::on_modal_destroyed(window.label());
                }
            }
            _ => {}
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let settings = handle.state::<AppState>().settings.read().clone();

            taskbar::apply(TaskbarMode::parse(&settings.taskbar_mode));

            window_manager::layout_windows(&handle);
            for label in ["dock", "toast"] {
                if let Some(window) = handle.get_webview_window(label) {
                    window_manager::prepare_overlay(&window);
                    window_manager::show_no_activate(&window);
                }
            }

            let sentinel_handle = handle.clone();
            sentinel::start(Box::new(move |event| match event {
                SentinelEvent::EmergencyRestore => emergency_restore(&sentinel_handle),
                SentinelEvent::SessionEnding => {
                    win32::exit_log("session ending (logoff / shutdown)");
                    taskbar::restore();
                }
                SentinelEvent::CloseRequested => restore_and_quit(&sentinel_handle, "WM_CLOSE on the sentinel (graceful taskkill)"),
                SentinelEvent::TaskbarRecreated => taskbar::reapply(),
                SentinelEvent::ForegroundChanged(hwnd) => {
                    // Alt+Tab / Win key out of a fullscreen game: re-evaluate the dock right now.
                    window_manager::notify_foreground_changed();
                    let _ = sentinel_handle.emit_to("dock", "apps:foreground", hwnd as i64);
                }
            }));

            window_manager::start_hit_testing();
            window_manager::start_fullscreen_watch(handle.clone());
            graphics::start(handle.clone());
            graphics::configure(&handle, settings.uses_glass_capture(), &settings.glass_backdrop);
            win32::memory::start();
            win32::media_smtc::start(handle.clone());
            win32::audio::start(handle.clone());
            win32::app_search::warm();
            win32::screen_time::start(handle.clone());
            win32::telemetry::start(handle.clone());
            providers::api_poller::start(handle.clone());
            build_tray(&handle, Lang::parse(&settings.language))?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("build lumabar");

    app.run(|_app, event| {
        if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
            if matches!(event, RunEvent::Exit) {
                win32::exit_log("run loop exit");
            }
            taskbar::restore_for_exit();
            win32::arm_exit_watchdog();
        }
    });

    taskbar::restore();
    runtime.shutdown_background();
    drop(instance_guard);
}
