pub mod app_search;
pub mod apps_enum;
pub mod audio;
pub mod dpapi;
pub mod guardian;
pub mod liner;
pub mod media_smtc;
pub mod memory;
pub mod screen_time;
pub mod sentinel;
pub mod taskbar;
pub mod telemetry;
pub mod window_manager;

use windows::Win32::Foundation::{ERROR_ALREADY_EXISTS, ERROR_FILE_NOT_FOUND, GetLastError, HANDLE};
use windows::Win32::System::Registry::{HKEY_CURRENT_USER, REG_SZ, RegDeleteKeyValueW, RegSetKeyValueW};
use windows::Win32::System::Console::SetConsoleCtrlHandler;
use windows::Win32::System::Threading::CreateMutexW;
use windows::core::{BOOL, w};

/// Keeps the named mutex handle alive for the lifetime of the process.
pub struct SingleInstanceGuard(#[allow(dead_code)] HANDLE);

// The handle is only held, never used across threads.
unsafe impl Send for SingleInstanceGuard {}
unsafe impl Sync for SingleInstanceGuard {}

/// Acquire `Global\LumabarSingleInstanceMutex`. Returns `None` when another instance owns it.
pub fn acquire_single_instance() -> Option<SingleInstanceGuard> {
    unsafe {
        let handle = CreateMutexW(None, true, w!("Global\\LumabarSingleInstanceMutex")).ok()?;
        if GetLastError() == ERROR_ALREADY_EXISTS {
            return None;
        }
        Some(SingleInstanceGuard(handle))
    }
}

unsafe extern "system" fn console_ctrl_handler(_ctrl_type: u32) -> BOOL {
    taskbar::restore();
    // FALSE: let the default handler terminate the process after we restored.
    BOOL(0)
}

/// Install every crash-path restore hook that does not depend on Tauri.
pub fn install_crash_guards() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        taskbar::restore();
        previous(info);
    }));
    unsafe {
        if let Err(err) = SetConsoleCtrlHandler(Some(console_ctrl_handler), true) {
            eprintln!("[lumabar] SetConsoleCtrlHandler failed: {err}");
        }
    }
}

static EXIT_WATCHDOG: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
const EXIT_GRACE: std::time::Duration = std::time::Duration::from_secs(3);

/// Called once the taskbar has been restored for exit: if WebView2 / COM teardown stalls, end the
/// process after `EXIT_GRACE` instead of lingering (a lingering lumabar holds the single-instance
/// mutex and blocks the next launch). Safe because restoration already happened.
pub fn arm_exit_watchdog() {
    use std::sync::atomic::Ordering;
    if EXIT_WATCHDOG.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = std::thread::Builder::new().name("lumabar-exit-watchdog".into()).spawn(|| {
        std::thread::sleep(EXIT_GRACE);
        taskbar::restore();
        unsafe {
            let _ = windows::Win32::System::Threading::TerminateProcess(windows::Win32::System::Threading::GetCurrentProcess(), 0);
        }
    });
}

/// Add/remove lumabar from `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`.
pub fn set_launch_at_login(enabled: bool) -> Result<(), String> {
    let subkey = wide("Software\\Microsoft\\Windows\\CurrentVersion\\Run");
    let value_name = wide("lumabar");
    unsafe {
        if enabled {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let command = wide(&format!("\"{}\"", exe.display()));
            let err = RegSetKeyValueW(
                HKEY_CURRENT_USER,
                windows::core::PCWSTR(subkey.as_ptr()),
                windows::core::PCWSTR(value_name.as_ptr()),
                REG_SZ.0,
                Some(command.as_ptr() as *const core::ffi::c_void),
                (command.len() * 2) as u32,
            );
            if err.is_err() {
                return Err(format!("RegSetKeyValueW failed: {err:?}"));
            }
        } else {
            let err = RegDeleteKeyValueW(
                HKEY_CURRENT_USER,
                windows::core::PCWSTR(subkey.as_ptr()),
                windows::core::PCWSTR(value_name.as_ptr()),
            );
            if err.is_err() && err != ERROR_FILE_NOT_FOUND {
                return Err(format!("RegDeleteKeyValueW failed: {err:?}"));
            }
        }
    }
    Ok(())
}

/// UTF-16, NUL-terminated.
pub fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Decode a NUL-terminated (or full) UTF-16 buffer.
pub fn from_wide(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}
