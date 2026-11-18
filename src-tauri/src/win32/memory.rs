//! Physical working-set trimming.
//!
//! winglass runs 24/7 and is idle almost all of the time, so pages touched during startup or while
//! a modal was open are handed back to Windows: right after startup, whenever the picker / settings
//! window is destroyed, and every five minutes. Trimmed pages stay on the standby list and fault
//! back in cheaply if they are needed again.
//!
//! The host process is trimmed with `SetProcessWorkingSetSizeEx(-1, -1)`; its WebView2 child
//! processes (where most of the memory lives) with `EmptyWorkingSet`.

use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

use once_cell::sync::OnceCell;
use parking_lot::Mutex;
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Memory::{SETPROCESSWORKINGSETSIZEEX_FLAGS, SetProcessWorkingSetSizeEx};
use windows::Win32::System::ProcessStatus::EmptyWorkingSet;
use windows::Win32::System::Threading::{GetCurrentProcess, GetCurrentProcessId, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA};

pub const PERIODIC_TRIM: Duration = Duration::from_secs(5 * 60);
pub const STARTUP_TRIM_DELAY: Duration = Duration::from_secs(10);
/// WebView2 needs a moment to tear a destroyed window's renderer down before trimming pays off.
pub const WINDOW_CLOSE_TRIM_DELAY: Duration = Duration::from_millis(1500);

static REQUESTS: OnceCell<Mutex<Sender<Duration>>> = OnceCell::new();

/// Release this process's unused physical pages back to Windows.
pub fn trim_own_working_set() -> bool {
    // (SIZE_T)-1 for both limits asks the memory manager to empty the working set. The pseudo
    // handle from GetCurrentProcess already carries PROCESS_SET_QUOTA; no quota-limit flags apply.
    unsafe { SetProcessWorkingSetSizeEx(GetCurrentProcess(), usize::MAX, usize::MAX, SETPROCESSWORKINGSETSIZEEX_FLAGS(0)).is_ok() }
}

/// `(pid, parent pid)` of every running process.
fn process_table() -> Vec<(u32, u32)> {
    let mut out = Vec::new();
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return out };
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                out.push((entry.th32ProcessID, entry.th32ParentProcessID));
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
    }
    out
}

/// All transitive children of `root` in a `(pid, parent)` table.
pub fn descendants(table: &[(u32, u32)], root: u32) -> Vec<u32> {
    let mut found: Vec<u32> = Vec::new();
    let mut frontier = vec![root];
    while let Some(parent) = frontier.pop() {
        for &(pid, ppid) in table {
            if ppid == parent && pid != root && pid != 0 && !found.contains(&pid) {
                found.push(pid);
                frontier.push(pid);
            }
        }
    }
    found
}

/// Trim the WebView2 process tree hosted by this process. Returns how many were trimmed.
fn trim_child_working_sets() -> usize {
    let children = descendants(&process_table(), unsafe { GetCurrentProcessId() });
    let mut trimmed = 0;
    for pid in children {
        unsafe {
            if let Ok(handle) = OpenProcess(PROCESS_SET_QUOTA | PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                if EmptyWorkingSet(handle).is_ok() {
                    trimmed += 1;
                }
                let _ = CloseHandle(handle);
            }
        }
    }
    trimmed
}

pub fn trim_now() {
    trim_own_working_set();
    trim_child_working_sets();
}

/// Ask for a trim `delay` from now (coalesced with any trim already pending sooner).
pub fn request_trim(delay: Duration) {
    if let Some(sender) = REQUESTS.get() {
        let _ = sender.lock().send(delay);
    }
}

/// Start the trimmer: once after startup settles, on request, and every five minutes.
pub fn start() {
    let (tx, rx) = mpsc::channel::<Duration>();
    if REQUESTS.set(Mutex::new(tx)).is_err() {
        return;
    }
    std::thread::Builder::new()
        .name("winglass-memory".into())
        .spawn(move || {
            let mut due = Instant::now() + STARTUP_TRIM_DELAY;
            loop {
                let wait = due.saturating_duration_since(Instant::now());
                match rx.recv_timeout(wait) {
                    Ok(delay) => due = due.min(Instant::now() + delay),
                    Err(RecvTimeoutError::Timeout) => {
                        trim_now();
                        due = Instant::now() + PERIODIC_TRIM;
                    }
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
        })
        .expect("spawn memory trimmer");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn descendants_follow_the_whole_tree() {
        let table = [(10, 1), (11, 10), (12, 10), (13, 11), (20, 2), (21, 20), (10, 10)];
        let mut found = descendants(&table, 10);
        found.sort_unstable();
        assert_eq!(found, vec![11, 12, 13]);
        assert!(descendants(&table, 99).is_empty());
    }

    #[test]
    fn descendants_survive_pid_cycles() {
        // Recycled pids can make a stale parent link point "forward"; must not loop forever.
        let table = [(5, 6), (6, 5)];
        assert_eq!(descendants(&table, 5), vec![6]);
    }

    #[test]
    fn trimming_this_process_succeeds() {
        assert!(trim_own_working_set());
    }
}
