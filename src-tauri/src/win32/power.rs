//! Windows-button power section: lock, sleep, restart, shut down. Restart and shut down are only
//! sent after the in-menu confirmation step. `LUMABAR_POWER_DRY_RUN=1` logs the action to
//! exit.log instead of running it (end-to-end checks never power the machine off).

use std::os::windows::process::CommandExt;
use std::process::Command;

use windows::Win32::System::Power::SetSuspendState;
use windows::Win32::System::Shutdown::LockWorkStation;
use windows::Win32::System::Threading::CREATE_NO_WINDOW;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PowerAction {
    Lock,
    Sleep,
    Restart,
    Shutdown,
}

impl PowerAction {
    pub fn parse(raw: &str) -> Option<PowerAction> {
        match raw {
            "lock" => Some(PowerAction::Lock),
            "sleep" => Some(PowerAction::Sleep),
            "restart" => Some(PowerAction::Restart),
            "shutdown" => Some(PowerAction::Shutdown),
            _ => None,
        }
    }

    /// `shutdown.exe` arguments (restart / shut down only). The normal session-end path runs, so
    /// WM_QUERYENDSESSION restores the taskbar before Windows goes down.
    fn shutdown_args(self) -> Option<[&'static str; 3]> {
        match self {
            PowerAction::Restart => Some(["/r", "/t", "0"]),
            PowerAction::Shutdown => Some(["/s", "/t", "0"]),
            PowerAction::Lock | PowerAction::Sleep => None,
        }
    }
}

fn dry_run() -> bool {
    std::env::var("LUMABAR_POWER_DRY_RUN").is_ok_and(|v| v == "1")
}

pub fn run(action: PowerAction) -> Result<(), String> {
    if dry_run() {
        super::exit_log(&format!("power action (dry run): {action:?}"));
        return Ok(());
    }
    if let Some(args) = action.shutdown_args() {
        return Command::new("shutdown.exe")
            .args(args)
            .creation_flags(CREATE_NO_WINDOW.0)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("shutdown.exe: {e}"));
    }
    unsafe {
        match action {
            PowerAction::Lock => LockWorkStation().map_err(|e| e.to_string()),
            // Sleep (not hibernate), wake events allowed.
            _ => {
                if SetSuspendState(false, false, false) {
                    Ok(())
                } else {
                    Err("SetSuspendState failed".into())
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::PowerAction;

    #[test]
    fn only_known_actions_parse_and_only_restart_shutdown_use_shutdown_exe() {
        assert_eq!(PowerAction::parse("lock"), Some(PowerAction::Lock));
        assert_eq!(PowerAction::parse("sleep"), Some(PowerAction::Sleep));
        assert_eq!(PowerAction::parse("hibernate"), None);
        assert_eq!(PowerAction::parse("Shutdown"), None);
        assert_eq!(PowerAction::Restart.shutdown_args(), Some(["/r", "/t", "0"]));
        assert_eq!(PowerAction::Shutdown.shutdown_args(), Some(["/s", "/t", "0"]));
        assert_eq!(PowerAction::Lock.shutdown_args(), None);
        assert_eq!(PowerAction::Sleep.shutdown_args(), None);
    }
}
