//! Silent self-update from GitHub Releases (`latest.json`, signed with the Tauri updater key).
//!
//! One check 90 s after start, then every 6 h. A newer release is downloaded, the native taskbar is
//! restored (invariant 2), then the passive NSIS installer replaces the exe and relaunches winglass.
//! Never runs from a dev / cargo build (`debug_assertions`).

use std::time::Duration;

use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

const FIRST_CHECK: Duration = Duration::from_secs(90);
const EVERY: Duration = Duration::from_secs(6 * 3600);

pub fn start(app: AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        loop {
            if let Err(err) = check(&app).await {
                crate::win32::exit_log(&format!("update check failed: {err}"));
            }
            tokio::time::sleep(EVERY).await;
        }
    });
}

async fn check(app: &AppHandle) -> tauri_plugin_updater::Result<()> {
    let Some(update) = app.updater()?.check().await? else { return Ok(()) };
    crate::win32::exit_log(&format!("update: installing {}", update.version));
    update
        .download_and_install(|_, _| {}, || crate::win32::taskbar::restore_for_exit())
        .await
}
