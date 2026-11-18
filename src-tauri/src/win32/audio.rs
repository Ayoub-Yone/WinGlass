//! System volume over Windows Core Audio (WASAPI endpoint volume).
//!
//! One worker thread ("winglass-audio", COM MTA) owns every Core Audio object (invariant 5):
//! the device enumerator, the default render endpoint's `IAudioEndpointVolume` and the two
//! callbacks. Tauri commands talk to it over a channel; it answers with the fresh state.
//!
//! * `IAudioEndpointVolumeCallback` pushes external changes (media keys, the volume flyout,
//!   Liner, the mixer) to the dock as `audio:state` immediately — nothing is polled.
//! * `IMMNotificationClient` re-binds the endpoint when the default output device changes or a
//!   device appears / disappears.
//! * Switching the default output uses the shell's `IPolicyConfig` (the interface the Sound
//!   control panel itself uses; there is no documented API for it).
//! * Per-app mixer: `IAudioSessionManager2` on the default device; sessions are grouped by
//!   executable (a browser plays through several), expired sessions are dropped.

use std::sync::mpsc::{self, Receiver, Sender};
use std::time::Duration;

use once_cell::sync::{Lazy, OnceCell};
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::Win32::Foundation::PROPERTYKEY;
use windows::Win32::Media::Audio::Endpoints::{
    IAudioEndpointVolume, IAudioEndpointVolumeCallback, IAudioEndpointVolumeCallback_Impl,
};
use windows::Win32::Media::Audio::{
    AudioSessionStateActive, AudioSessionStateExpired, IAudioSessionControl2, IAudioSessionManager2, ISimpleAudioVolume,
    AUDIO_VOLUME_NOTIFICATION_DATA, DEVICE_STATE, DEVICE_STATE_ACTIVE, EDataFlow, ERole, IMMDevice, IMMDeviceEnumerator,
    IMMNotificationClient, IMMNotificationClient_Impl, MMDeviceEnumerator, eCommunications, eConsole, eMultimedia, eRender,
};
use windows::Win32::System::Com::StructuredStorage::PropVariantToStringAlloc;
use windows::Win32::System::Com::{CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoTaskMemFree, STGM_READ};
use windows::core::{GUID, Interface, PCWSTR, PWSTR, implement};

use super::apps_enum;

/// PKEY_Device_FriendlyName ("Speakers (Realtek(R) Audio)").
const PKEY_DEVICE_FRIENDLY_NAME: PROPERTYKEY =
    PROPERTYKEY { fmtid: GUID::from_u128(0xa45c254e_df1c_4efd_8020_67d146a850e0), pid: 14 };

/// Event context stamped on winglass's own changes (purely informational).
const WINGLASS_CONTEXT: GUID = GUID::from_u128(0x4c554d41_4241_5200_0000_766f6c756d65);

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioState {
    pub available: bool,
    /// Master volume, 0–100 (what the Windows flyout shows).
    pub volume: u32,
    pub muted: bool,
    pub device_id: String,
    pub device_name: String,
    pub devices: Vec<AudioDevice>,
}

impl AudioState {
    const fn unavailable() -> Self {
        AudioState { available: false, volume: 0, muted: false, device_id: String::new(), device_name: String::new(), devices: Vec::new() }
    }
}

/// One app in the per-app mixer (all of its sessions on the default device).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppAudio {
    /// Representative process id (commands address the whole group through it).
    pub pid: u32,
    pub pids: Vec<u32>,
    pub exe: String,
    /// Product name; empty for the system-sounds session (the UI labels it « Sons système »).
    pub name: String,
    pub icon_key: String,
    pub is_system: bool,
    /// Some session of the app is currently playing.
    pub active: bool,
    pub volume: u32,
    pub muted: bool,
}

/// One WASAPI session as read from the device.
#[derive(Debug, Clone, PartialEq)]
pub struct RawSession {
    pub pid: u32,
    pub exe: String,
    pub is_system: bool,
    pub active: bool,
    pub expired: bool,
    pub volume: f32,
    pub muted: bool,
}

fn group_key(r: &RawSession) -> String {
    if r.is_system {
        "::system".into()
    } else if r.exe.is_empty() {
        format!("::pid:{}", r.pid)
    } else {
        r.exe.to_ascii_lowercase()
    }
}

/// Group sessions by executable (expired ones dropped). Order: system sounds first, then playing
/// apps, then the rest by name. `name_of` resolves product names (version info in production).
pub fn group_sessions(raw: &[RawSession], name_of: impl Fn(&str) -> String) -> Vec<AppAudio> {
    let mut groups: Vec<(String, AppAudio)> = Vec::new();
    for r in raw.iter().filter(|r| !r.expired) {
        let key = group_key(r);
        if let Some((_, g)) = groups.iter_mut().find(|(k, _)| *k == key) {
            if !g.pids.contains(&r.pid) {
                g.pids.push(r.pid);
            }
            g.active |= r.active;
            // The group is muted only when every session is; its level is the loudest session's.
            g.muted &= r.muted;
            g.volume = g.volume.max(scalar_to_percent(r.volume));
            continue;
        }
        let name = if r.is_system { String::new() } else if r.exe.is_empty() { format!("PID {}", r.pid) } else { name_of(&r.exe) };
        groups.push((
            key,
            AppAudio {
                pid: r.pid,
                pids: vec![r.pid],
                exe: r.exe.clone(),
                name,
                icon_key: r.exe.clone(),
                is_system: r.is_system,
                active: r.active,
                volume: scalar_to_percent(r.volume),
                muted: r.muted,
            },
        ));
    }
    let mut out: Vec<AppAudio> = groups.into_iter().map(|(_, g)| g).collect();
    out.sort_by(|a, b| {
        b.is_system.cmp(&a.is_system).then(b.active.cmp(&a.active)).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    out
}

/// `scalar` (0.0–1.0) -> percentage as Windows rounds it.
pub fn scalar_to_percent(scalar: f32) -> u32 {
    (scalar.clamp(0.0, 1.0) * 100.0).round() as u32
}

/// Relative step (mouse wheel), clamped to 0–100.
pub fn stepped(current: u32, delta: i32) -> u32 {
    (current as i64 + delta as i64).clamp(0, 100) as u32
}

// ---------------------------------------------------------------------------------------------
// Worker plumbing
// ---------------------------------------------------------------------------------------------

#[derive(Debug)]
enum Command {
    SetVolume(u32),
    Step(i32),
    /// `None` toggles.
    SetMute(Option<bool>),
    SetDefault(String),
    /// Default device changed / devices added or removed (from the notification client).
    Rebind,
    /// Per-app mixer (replies on its own channel).
    Sessions(Sender<Result<Vec<AppAudio>, String>>),
    SetAppVolume(u32, u32, Sender<Result<Vec<AppAudio>, String>>),
    SetAppMute(u32, bool, Sender<Result<Vec<AppAudio>, String>>),
}

type Reply = Sender<Result<AudioState, String>>;

static TX: OnceCell<Mutex<Sender<(Command, Option<Reply>)>>> = OnceCell::new();
static LATEST: Lazy<Mutex<AudioState>> = Lazy::new(|| Mutex::new(AudioState::unavailable()));
static APP: OnceCell<AppHandle> = OnceCell::new();

pub fn latest() -> AudioState {
    LATEST.lock().clone()
}

fn publish(state: AudioState) {
    let changed = {
        let mut latest = LATEST.lock();
        let changed = *latest != state;
        *latest = state.clone();
        changed
    };
    if changed {
        if let Some(app) = APP.get() {
            let _ = app.emit("audio:state", &state);
        }
    }
}

fn request(command: Command) -> Result<AudioState, String> {
    let tx = TX.get().ok_or("the audio service is not running")?;
    let (reply_tx, reply_rx) = mpsc::channel();
    tx.lock().send((command, Some(reply_tx))).map_err(|_| "the audio service stopped".to_string())?;
    reply_rx.recv_timeout(Duration::from_secs(3)).map_err(|_| "the audio service did not answer".to_string())?
}

fn notify(command: Command) {
    if let Some(tx) = TX.get() {
        let _ = tx.lock().send((command, None));
    }
}

pub fn set_volume(volume: u32) -> Result<AudioState, String> {
    request(Command::SetVolume(volume.min(100)))
}

pub fn step(delta: i32) -> Result<AudioState, String> {
    request(Command::Step(delta.clamp(-100, 100)))
}

pub fn set_mute(muted: Option<bool>) -> Result<AudioState, String> {
    request(Command::SetMute(muted))
}

pub fn set_default_device(id: String) -> Result<AudioState, String> {
    request(Command::SetDefault(id))
}

fn request_sessions(make: impl FnOnce(Sender<Result<Vec<AppAudio>, String>>) -> Command) -> Result<Vec<AppAudio>, String> {
    let tx = TX.get().ok_or("the audio service is not running")?;
    let (reply_tx, reply_rx) = mpsc::channel();
    tx.lock().send((make(reply_tx), None)).map_err(|_| "the audio service stopped".to_string())?;
    reply_rx.recv_timeout(Duration::from_secs(3)).map_err(|_| "the audio service did not answer".to_string())?
}

pub fn sessions() -> Result<Vec<AppAudio>, String> {
    request_sessions(Command::Sessions)
}

pub fn set_app_volume(pid: u32, volume: u32) -> Result<Vec<AppAudio>, String> {
    request_sessions(|r| Command::SetAppVolume(pid, volume.min(100), r))
}

pub fn set_app_mute(pid: u32, muted: bool) -> Result<Vec<AppAudio>, String> {
    request_sessions(|r| Command::SetAppMute(pid, muted, r))
}

// ---------------------------------------------------------------------------------------------
// COM callbacks
// ---------------------------------------------------------------------------------------------

#[implement(IAudioEndpointVolumeCallback)]
struct VolumeCallback;

impl IAudioEndpointVolumeCallback_Impl for VolumeCallback_Impl {
    fn OnNotify(&self, data: *mut AUDIO_VOLUME_NOTIFICATION_DATA) -> windows::core::Result<()> {
        // Runs on a Core Audio thread: only copy the numbers and publish.
        if let Some(data) = unsafe { data.as_ref() } {
            let mut state = latest();
            state.volume = scalar_to_percent(data.fMasterVolume);
            state.muted = data.bMuted.as_bool();
            publish(state);
        }
        Ok(())
    }
}

#[implement(IMMNotificationClient)]
struct DeviceCallback;

impl IMMNotificationClient_Impl for DeviceCallback_Impl {
    fn OnDeviceStateChanged(&self, _id: &PCWSTR, _state: DEVICE_STATE) -> windows::core::Result<()> {
        notify(Command::Rebind);
        Ok(())
    }
    fn OnDeviceAdded(&self, _id: &PCWSTR) -> windows::core::Result<()> {
        notify(Command::Rebind);
        Ok(())
    }
    fn OnDeviceRemoved(&self, _id: &PCWSTR) -> windows::core::Result<()> {
        notify(Command::Rebind);
        Ok(())
    }
    fn OnDefaultDeviceChanged(&self, flow: EDataFlow, role: ERole, _id: &PCWSTR) -> windows::core::Result<()> {
        // Fired once per role; the console render role is the one the volume flyout follows.
        if flow == eRender && role == eConsole {
            notify(Command::Rebind);
        }
        Ok(())
    }
    fn OnPropertyValueChanged(&self, _id: &PCWSTR, _key: &PROPERTYKEY) -> windows::core::Result<()> {
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------------
// IPolicyConfig (default endpoint switching)
// ---------------------------------------------------------------------------------------------

#[allow(non_snake_case, dead_code, clippy::missing_safety_doc)]
mod policy {
    use windows::Win32::Foundation::PROPERTYKEY;
    use windows::Win32::Media::Audio::ERole;
    use windows::core::{GUID, HRESULT, IUnknown, IUnknown_Vtbl, PCWSTR, interface};

    /// CLSID_PolicyConfigClient.
    pub const CLSID_POLICY_CONFIG_CLIENT: GUID = GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9);

    /// Vtable order matters: every slot up to SetDefaultEndpoint must be declared.
    #[interface("f8679f50-850a-41cf-9c72-430f290290c8")]
    pub unsafe trait IPolicyConfig: IUnknown {
        pub fn GetMixFormat(&self, device: PCWSTR, format: *mut *mut core::ffi::c_void) -> HRESULT;
        pub fn GetDeviceFormat(&self, device: PCWSTR, default: i32, format: *mut *mut core::ffi::c_void) -> HRESULT;
        pub fn ResetDeviceFormat(&self, device: PCWSTR) -> HRESULT;
        pub fn SetDeviceFormat(&self, device: PCWSTR, endpoint: *mut core::ffi::c_void, mix: *mut core::ffi::c_void) -> HRESULT;
        pub fn GetProcessingPeriod(&self, device: PCWSTR, default: i32, period: *mut i64, minimum: *mut i64) -> HRESULT;
        pub fn SetProcessingPeriod(&self, device: PCWSTR, period: *mut i64) -> HRESULT;
        pub fn GetShareMode(&self, device: PCWSTR, mode: *mut core::ffi::c_void) -> HRESULT;
        pub fn SetShareMode(&self, device: PCWSTR, mode: *mut core::ffi::c_void) -> HRESULT;
        pub fn GetPropertyValue(&self, device: PCWSTR, store: i32, key: *const PROPERTYKEY, value: *mut core::ffi::c_void) -> HRESULT;
        pub fn SetPropertyValue(&self, device: PCWSTR, store: i32, key: *const PROPERTYKEY, value: *mut core::ffi::c_void) -> HRESULT;
        pub fn SetDefaultEndpoint(&self, device: PCWSTR, role: ERole) -> HRESULT;
        pub fn SetEndpointVisibility(&self, device: PCWSTR, visible: i32) -> HRESULT;
    }
}

fn set_default_endpoint(id: &str) -> Result<(), String> {
    let wid = super::wide(id);
    unsafe {
        let config: policy::IPolicyConfig =
            CoCreateInstance(&policy::CLSID_POLICY_CONFIG_CLIENT, None, CLSCTX_ALL).map_err(|e| format!("IPolicyConfig: {e}"))?;
        for role in [eConsole, eMultimedia, eCommunications] {
            config.SetDefaultEndpoint(PCWSTR(wid.as_ptr()), role).ok().map_err(|e| format!("SetDefaultEndpoint failed: {e}"))?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Endpoint access (worker thread only)
// ---------------------------------------------------------------------------------------------

fn take_pwstr(p: PWSTR) -> String {
    if p.is_null() {
        return String::new();
    }
    let s = unsafe { p.to_string().unwrap_or_default() };
    unsafe { CoTaskMemFree(Some(p.0 as *const core::ffi::c_void)) };
    s
}

fn device_id(device: &IMMDevice) -> String {
    unsafe { device.GetId().map(take_pwstr).unwrap_or_default() }
}

fn device_name(device: &IMMDevice) -> String {
    unsafe {
        let Ok(store) = device.OpenPropertyStore(STGM_READ) else { return String::new() };
        let Ok(value) = store.GetValue(&PKEY_DEVICE_FRIENDLY_NAME) else { return String::new() };
        PropVariantToStringAlloc(&value).map(take_pwstr).unwrap_or_default()
    }
}

/// Active render devices, default first flagged.
fn list_devices(enumerator: &IMMDeviceEnumerator, default_id: &str) -> Vec<AudioDevice> {
    let mut out = Vec::new();
    unsafe {
        let Ok(collection) = enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) else { return out };
        let count = collection.GetCount().unwrap_or(0);
        for i in 0..count {
            if let Ok(device) = collection.Item(i) {
                let id = device_id(&device);
                if id.is_empty() {
                    continue;
                }
                let name = device_name(&device);
                out.push(AudioDevice { is_default: id == default_id, name, id });
            }
        }
    }
    out
}

struct Bound {
    device: IMMDevice,
    endpoint: IAudioEndpointVolume,
    callback: IAudioEndpointVolumeCallback,
    device_id: String,
    device_name: String,
}

impl Drop for Bound {
    fn drop(&mut self) {
        unsafe {
            let _ = self.endpoint.UnregisterControlChangeNotify(&self.callback);
        }
    }
}

fn bind_default(enumerator: &IMMDeviceEnumerator) -> Option<Bound> {
    unsafe {
        let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole).ok()?;
        let endpoint: IAudioEndpointVolume = device.Activate(CLSCTX_ALL, None).ok()?;
        let callback: IAudioEndpointVolumeCallback = VolumeCallback.into();
        endpoint.RegisterControlChangeNotify(&callback).ok()?;
        Some(Bound { endpoint, callback, device_id: device_id(&device), device_name: device_name(&device), device })
    }
}

fn read_state(enumerator: &IMMDeviceEnumerator, bound: Option<&Bound>) -> AudioState {
    let Some(b) = bound else { return AudioState::unavailable() };
    unsafe {
        let volume = b.endpoint.GetMasterVolumeLevelScalar().map(scalar_to_percent).unwrap_or(0);
        let muted = b.endpoint.GetMute().map(|m| m.as_bool()).unwrap_or(false);
        AudioState {
            available: true,
            volume,
            muted,
            device_id: b.device_id.clone(),
            device_name: b.device_name.clone(),
            devices: list_devices(enumerator, &b.device_id),
        }
    }
}

/// Every session on the device with its volume control.
fn device_sessions(device: &IMMDevice) -> Result<Vec<(RawSession, ISimpleAudioVolume)>, String> {
    let own = std::process::id();
    let mut out = Vec::new();
    unsafe {
        let manager: IAudioSessionManager2 = device.Activate(CLSCTX_ALL, None).map_err(|e| format!("IAudioSessionManager2: {e}"))?;
        let list = manager.GetSessionEnumerator().map_err(|e| e.to_string())?;
        for i in 0..list.GetCount().unwrap_or(0) {
            let Ok(control) = list.GetSession(i) else { continue };
            let Ok(control2) = control.cast::<IAudioSessionControl2>() else { continue };
            let Ok(volume) = control.cast::<ISimpleAudioVolume>() else { continue };
            let pid = control2.GetProcessId().unwrap_or(0);
            if pid == own {
                continue;
            }
            // S_OK (0) means "this is the system sounds session"; S_FALSE (1) means it is not.
            let is_system = control2.IsSystemSoundsSession().0 == 0;
            let state = control.GetState().unwrap_or(AudioSessionStateExpired);
            let exe = if is_system { String::new() } else { apps_enum::process_image_path(pid).unwrap_or_default() };
            out.push((
                RawSession {
                    pid,
                    exe,
                    is_system,
                    active: state == AudioSessionStateActive,
                    expired: state == AudioSessionStateExpired,
                    volume: volume.GetMasterVolume().unwrap_or(1.0),
                    muted: volume.GetMute().map(|m| m.as_bool()).unwrap_or(false),
                },
                volume,
            ));
        }
    }
    Ok(out)
}

fn read_sessions(bound: Option<&Bound>) -> Result<Vec<AppAudio>, String> {
    let b = bound.ok_or("no audio output device")?;
    let raw: Vec<RawSession> = device_sessions(&b.device)?.into_iter().map(|(r, _)| r).collect();
    Ok(group_sessions(&raw, apps_enum::friendly_name))
}

/// Apply `f` to every session of the app group that `pid` belongs to.
fn for_app_group(bound: Option<&Bound>, pid: u32, f: impl Fn(&ISimpleAudioVolume) -> windows::core::Result<()>) -> Result<(), String> {
    let b = bound.ok_or("no audio output device")?;
    let sessions = device_sessions(&b.device)?;
    let target = sessions.iter().find(|(r, _)| r.pid == pid && !r.expired).map(|(r, _)| group_key(r)).ok_or("this app has no audio session")?;
    for (r, volume) in sessions.iter().filter(|(r, _)| !r.expired && group_key(r) == target) {
        f(volume).map_err(|e| format!("session {}: {e}", r.pid))?;
    }
    Ok(())
}

fn apply_session_command(bound: Option<&Bound>, command: Command) {
    match command {
        Command::Sessions(reply) => {
            let _ = reply.send(read_sessions(bound));
        }
        Command::SetAppVolume(pid, v, reply) => {
            let result = for_app_group(bound, pid, |s| unsafe { s.SetMasterVolume(v as f32 / 100.0, &WINGLASS_CONTEXT) });
            let _ = reply.send(result.and_then(|_| read_sessions(bound)));
        }
        Command::SetAppMute(pid, m, reply) => {
            let result = for_app_group(bound, pid, |s| unsafe { s.SetMute(m, &WINGLASS_CONTEXT) });
            let _ = reply.send(result.and_then(|_| read_sessions(bound)));
        }
        _ => {}
    }
}

fn apply(enumerator: &IMMDeviceEnumerator, bound: &mut Option<Bound>, command: Command) -> Result<(), String> {
    if let Command::Rebind = command {
        *bound = None;
        *bound = bind_default(enumerator);
        return Ok(());
    }
    if let Command::SetDefault(id) = &command {
        set_default_endpoint(id)?;
        *bound = None;
        *bound = bind_default(enumerator);
        return Ok(());
    }
    let b = bound.as_ref().ok_or("no audio output device")?;
    unsafe {
        match command {
            Command::SetVolume(v) => {
                b.endpoint.SetMasterVolumeLevelScalar(v as f32 / 100.0, &WINGLASS_CONTEXT).map_err(|e| e.to_string())?;
            }
            Command::Step(delta) => {
                let current = b.endpoint.GetMasterVolumeLevelScalar().map(scalar_to_percent).map_err(|e| e.to_string())?;
                let next = stepped(current, delta);
                b.endpoint.SetMasterVolumeLevelScalar(next as f32 / 100.0, &WINGLASS_CONTEXT).map_err(|e| e.to_string())?;
                // Scrolling up from mute un-mutes, like the Windows flyout.
                if delta > 0 && b.endpoint.GetMute().map(|m| m.as_bool()).unwrap_or(false) {
                    b.endpoint.SetMute(false, &WINGLASS_CONTEXT).map_err(|e| e.to_string())?;
                }
            }
            Command::SetMute(muted) => {
                let target = match muted {
                    Some(m) => m,
                    None => !b.endpoint.GetMute().map(|m| m.as_bool()).unwrap_or(false),
                };
                b.endpoint.SetMute(target, &WINGLASS_CONTEXT).map_err(|e| e.to_string())?;
            }
            Command::Rebind | Command::SetDefault(_) | Command::Sessions(_) | Command::SetAppVolume(..) | Command::SetAppMute(..) => {}
        }
    }
    Ok(())
}

fn run(rx: Receiver<(Command, Option<Reply>)>) {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let enumerator: IMMDeviceEnumerator = match unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) } {
        Ok(e) => e,
        Err(err) => {
            eprintln!("[winglass] Core Audio unavailable: {err}");
            // Keep answering so commands fail fast instead of timing out.
            for (_, reply) in rx {
                if let Some(reply) = reply {
                    let _ = reply.send(Err("Core Audio is unavailable".into()));
                }
            }
            return;
        }
    };
    let device_callback: IMMNotificationClient = DeviceCallback.into();
    unsafe {
        let _ = enumerator.RegisterEndpointNotificationCallback(&device_callback);
    }
    let mut bound = bind_default(&enumerator);
    publish(read_state(&enumerator, bound.as_ref()));
    // Core Audio DLLs and per-device property stores are loaded once at startup; return the pages.
    super::memory::request_trim(Duration::from_secs(2));

    for (command, reply) in rx {
        if matches!(command, Command::Sessions(_) | Command::SetAppVolume(..) | Command::SetAppMute(..)) {
            apply_session_command(bound.as_ref(), command);
            continue;
        }
        let result = apply(&enumerator, &mut bound, command);
        let state = read_state(&enumerator, bound.as_ref());
        publish(state.clone());
        if let Some(reply) = reply {
            let _ = reply.send(result.map(|_| state));
        }
    }
    unsafe {
        let _ = enumerator.UnregisterEndpointNotificationCallback(&device_callback);
    }
}

/// Start the audio worker. Safe to call once.
pub fn start(app: AppHandle) {
    let _ = APP.set(app);
    let (tx, rx) = mpsc::channel();
    if TX.set(Mutex::new(tx)).is_err() {
        return;
    }
    std::thread::Builder::new().name("winglass-audio".into()).spawn(move || run(rx)).expect("spawn audio thread");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_conversion_matches_the_windows_flyout() {
        assert_eq!(scalar_to_percent(0.0), 0);
        assert_eq!(scalar_to_percent(0.355), 36);
        assert_eq!(scalar_to_percent(1.0), 100);
        assert_eq!(scalar_to_percent(1.7), 100);
        assert_eq!(scalar_to_percent(-0.2), 0);
    }

    #[test]
    fn wheel_steps_are_clamped() {
        assert_eq!(stepped(50, 2), 52);
        assert_eq!(stepped(50, -4), 46);
        assert_eq!(stepped(99, 4), 100);
        assert_eq!(stepped(1, -2), 0);
        assert_eq!(stepped(0, -100), 0);
    }

    fn raw(pid: u32, exe: &str, active: bool, volume: f32, muted: bool) -> RawSession {
        RawSession { pid, exe: exe.into(), is_system: false, active, expired: false, volume, muted }
    }

    #[test]
    fn sessions_group_by_executable_and_drop_expired_ones() {
        let chrome = r"C:\Program Files\Google\Chrome\chrome.exe";
        let sessions = vec![
            raw(10, chrome, false, 0.5, true),
            raw(11, &chrome.to_uppercase(), true, 0.8, false),
            raw(20, r"C:\Apps\Discord.exe", false, 1.0, false),
            RawSession { expired: true, ..raw(30, r"C:\Apps\Old.exe", false, 1.0, false) },
            RawSession { is_system: true, ..raw(0, "", false, 0.36, false) },
        ];
        let groups = group_sessions(&sessions, |exe| if exe.contains("chrome") { "Google Chrome".into() } else { "Discord".into() });
        assert_eq!(groups.len(), 3, "{groups:#?}");
        // System sounds first, then playing apps.
        assert!(groups[0].is_system && groups[0].name.is_empty() && groups[0].volume == 36);
        let g = &groups[1];
        assert_eq!((g.name.as_str(), g.pid, g.pids.clone(), g.active, g.volume, g.muted), ("Google Chrome", 10, vec![10, 11], true, 80, false));
        assert_eq!(groups[2].name, "Discord");
        assert!(!groups.iter().any(|g| g.pids.contains(&30)));
    }

    /// Real per-app mixer on this machine: every listed app can be set to its own current level
    /// and mute state (no audible change) and reads back the same.
    #[test]
    fn wasapi_sessions_round_trip() {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let enumerator: IMMDeviceEnumerator = unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }.expect("MMDeviceEnumerator");
        let Some(bound) = bind_default(&enumerator) else {
            eprintln!("no default audio output on this machine; skipping");
            return;
        };
        let before = read_sessions(Some(&bound)).expect("enumerate sessions");
        for app in &before {
            assert!(app.is_system || !app.name.is_empty());
            for_app_group(Some(&bound), app.pid, |s| unsafe { s.SetMasterVolume(app.volume as f32 / 100.0, &WINGLASS_CONTEXT) }).expect("set app volume");
            for_app_group(Some(&bound), app.pid, |s| unsafe { s.SetMute(app.muted, &WINGLASS_CONTEXT) }).expect("set app mute");
        }
        let after = read_sessions(Some(&bound)).expect("re-enumerate");
        for app in &before {
            if let Some(again) = after.iter().find(|a| a.pid == app.pid) {
                assert_eq!((again.volume, again.muted), (app.volume, app.muted), "{}", app.name);
            }
        }
        assert!(for_app_group(Some(&bound), u32::MAX, |_| Ok(())).is_err(), "unknown pid is rejected");
    }

    /// Real WASAPI round-trip on the default output, without audibly changing anything: the
    /// current volume and mute state are written back as they are and read again.
    #[test]
    fn wasapi_endpoint_volume_round_trip() {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let enumerator: IMMDeviceEnumerator = unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }.expect("MMDeviceEnumerator");
        let Some(bound) = bind_default(&enumerator) else {
            eprintln!("no default audio output on this machine; skipping");
            return;
        };
        let before = read_state(&enumerator, Some(&bound));
        assert!(before.available && before.volume <= 100);
        assert!(!before.device_id.is_empty());
        assert!(before.devices.iter().any(|d| d.is_default && d.id == before.device_id), "default device is listed");

        let mut slot = Some(bound);
        apply(&enumerator, &mut slot, Command::SetVolume(before.volume)).expect("set volume");
        apply(&enumerator, &mut slot, Command::SetMute(Some(before.muted))).expect("set mute");
        apply(&enumerator, &mut slot, Command::Step(0)).expect("zero step");
        let after = read_state(&enumerator, slot.as_ref());
        assert_eq!((after.volume, after.muted), (before.volume, before.muted));

        // The policy-config path accepts the current default (a no-op switch).
        apply(&enumerator, &mut slot, Command::SetDefault(before.device_id.clone())).expect("set default endpoint");
        let rebound = read_state(&enumerator, slot.as_ref());
        assert_eq!(rebound.device_id, before.device_id);
    }
}
