//! Hidden top-level "sentinel" window running its own message loop.
//!
//! It owns everything that must react even when the webviews are wedged:
//! * global emergency hotkey Ctrl+Alt+Shift+R (RegisterHotKey)
//! * WM_QUERYENDSESSION / WM_ENDSESSION (logoff / shutdown) -> restore taskbar
//! * "TaskbarCreated" broadcast (Explorer restart) -> re-apply taskbar mode
//! * EVENT_SYSTEM_FOREGROUND WinEvent hook -> last external foreground window

use std::sync::atomic::{AtomicIsize, AtomicU32, Ordering};

use once_cell::sync::OnceCell;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Accessibility::{HWINEVENTHOOK, SetWinEventHook};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, RegisterHotKey,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, EVENT_SYSTEM_FOREGROUND, GetMessageW,
    MSG, RegisterClassW, RegisterWindowMessageW, TranslateMessage, WINEVENT_OUTOFCONTEXT,
    WINEVENT_SKIPOWNPROCESS, WM_ENDSESSION, WM_HOTKEY, WM_QUERYENDSESSION, WNDCLASSW,
    WM_CLOSE, WS_EX_TOOLWINDOW, WS_OVERLAPPED,
};
use windows::core::w;

use super::taskbar;

pub const HOTKEY_RESTORE_ID: i32 = 0x4C42; // "LB"

#[derive(Debug, Clone, Copy)]
pub enum SentinelEvent {
    EmergencyRestore,
    SessionEnding,
    /// WM_CLOSE (e.g. a graceful `taskkill`): restore and quit the whole app.
    CloseRequested,
    TaskbarRecreated,
    ForegroundChanged(isize),
}

type Callback = Box<dyn Fn(SentinelEvent) + Send + Sync>;

static CALLBACK: OnceCell<Callback> = OnceCell::new();
static TASKBAR_CREATED_MSG: AtomicU32 = AtomicU32::new(0);
static LAST_EXTERNAL_FOREGROUND: AtomicIsize = AtomicIsize::new(0);

/// Last foreground window that does not belong to lumabar.
pub fn last_external_foreground() -> isize {
    LAST_EXTERNAL_FOREGROUND.load(Ordering::SeqCst)
}

fn dispatch(event: SentinelEvent) {
    if let Some(cb) = CALLBACK.get() {
        cb(event);
    }
}

unsafe extern "system" fn wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_HOTKEY if wparam.0 as i32 == HOTKEY_RESTORE_ID => {
            taskbar::restore();
            dispatch(SentinelEvent::EmergencyRestore);
            LRESULT(0)
        }
        WM_QUERYENDSESSION => {
            taskbar::restore();
            dispatch(SentinelEvent::SessionEnding);
            LRESULT(1)
        }
        WM_ENDSESSION => {
            taskbar::restore();
            LRESULT(0)
        }
        WM_CLOSE => {
            taskbar::restore();
            dispatch(SentinelEvent::CloseRequested);
            LRESULT(0)
        }
        _ => {
            let created = TASKBAR_CREATED_MSG.load(Ordering::SeqCst);
            if created != 0 && msg == created {
                dispatch(SentinelEvent::TaskbarRecreated);
                return LRESULT(0);
            }
            unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
        }
    }
}

unsafe extern "system" fn foreground_hook(
    _hook: HWINEVENTHOOK,
    _event: u32,
    hwnd: HWND,
    id_object: i32,
    _id_child: i32,
    _thread: u32,
    _time: u32,
) {
    // OBJID_WINDOW == 0; WINEVENT_SKIPOWNPROCESS already filters lumabar's own windows.
    if id_object == 0 && !hwnd.is_invalid() {
        LAST_EXTERNAL_FOREGROUND.store(hwnd.0 as isize, Ordering::SeqCst);
        dispatch(SentinelEvent::ForegroundChanged(hwnd.0 as isize));
    }
}

/// Spawn the sentinel thread. If the hotkey is already owned by another program the failure is
/// logged and the rest of the sentinel (session-end + Explorer restart handling) still runs.
pub fn start(callback: Callback) {
    let _ = CALLBACK.set(callback);
    std::thread::Builder::new()
        .name("lumabar-sentinel".into())
        .spawn(|| unsafe {
            let instance = GetModuleHandleW(None).unwrap_or_default();
            let class_name = w!("LumabarSentinelWindow");
            let wc = WNDCLASSW {
                lpfnWndProc: Some(wnd_proc),
                hInstance: instance.into(),
                lpszClassName: class_name,
                ..Default::default()
            };
            RegisterClassW(&wc);
            TASKBAR_CREATED_MSG.store(RegisterWindowMessageW(w!("TaskbarCreated")), Ordering::SeqCst);

            // A real (never shown) top-level window: HWND_MESSAGE windows do not receive
            // WM_QUERYENDSESSION or broadcast messages such as TaskbarCreated.
            let hwnd = match CreateWindowExW(
                WS_EX_TOOLWINDOW,
                class_name,
                w!("lumabar sentinel"),
                WS_OVERLAPPED,
                0,
                0,
                0,
                0,
                None,
                None,
                Some(instance.into()),
                None,
            ) {
                Ok(h) => h,
                Err(err) => {
                    eprintln!("[lumabar] sentinel window creation failed: {err}");
                    return;
                }
            };

            if let Err(err) = RegisterHotKey(
                Some(hwnd),
                HOTKEY_RESTORE_ID,
                MOD_CONTROL | MOD_ALT | MOD_SHIFT | MOD_NOREPEAT,
                u32::from(b'R'),
            ) {
                eprintln!("[lumabar] could not register Ctrl+Alt+Shift+R: {err}");
            }

            SetWinEventHook(
                EVENT_SYSTEM_FOREGROUND,
                EVENT_SYSTEM_FOREGROUND,
                None,
                Some(foreground_hook),
                0,
                0,
                WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
            );

            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        })
        .expect("spawn sentinel thread");
}
