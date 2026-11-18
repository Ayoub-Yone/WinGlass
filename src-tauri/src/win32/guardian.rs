//! Out-of-process taskbar guardian.
//!
//! In-process hooks cannot run when winglass is hard-killed (Task Manager "End task",
//! `taskkill /F`, a debugger stop, a fatal fault). The guardian is a second, windowless copy of the
//! same executable that waits on winglass's process handle; the moment winglass exits, it repairs
//! the taskbar from the persisted original state if winglass did not already restore it.

use std::os::windows::process::CommandExt;
use std::process::Command;

use windows::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
use windows::Win32::System::Threading::{
    CREATE_NO_WINDOW, DETACHED_PROCESS, INFINITE, OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject,
};

use super::taskbar;

pub const GUARDIAN_FLAG: &str = "--winglass-guardian";

/// Launch the guardian for the current process. Failure is logged, never fatal.
pub fn spawn() {
    let Ok(exe) = std::env::current_exe() else { return };
    let result = Command::new(exe)
        .arg(GUARDIAN_FLAG)
        .arg(std::process::id().to_string())
        .creation_flags(CREATE_NO_WINDOW.0 | DETACHED_PROCESS.0)
        .spawn();
    if let Err(err) = result {
        eprintln!("[winglass] could not start taskbar guardian: {err}");
    }
}

/// Guardian entry point: block until `pid` exits, then repair if needed.
pub fn run(pid: u32) {
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_SYNCHRONIZE, false, pid) else {
            // The watched process is already gone.
            taskbar::repair_from_persisted();
            return;
        };
        let waited = WaitForSingleObject(handle, INFINITE);
        let mut code = 0u32;
        let _ = windows::Win32::System::Threading::GetExitCodeProcess(handle, &mut code);
        let _ = CloseHandle(handle);
        if waited == WAIT_OBJECT_0 {
            // Exit code 0 after a logged quit is normal; anything else is a crash or a hard kill.
            super::exit_log(&format!("guardian: winglass pid {pid} ended with exit code {code:#x}"));
            taskbar::repair_from_persisted();
        }
    }
}
