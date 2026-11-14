//! System volume over Windows Core Audio (WASAPI endpoint volume).
//!
//! One worker thread ("lumabar-audio", COM MTA) owns every Core Audio object (invariant 5):
//! the device enumerator, the default render endpoint's `IAudioEndpointVolume` and the two
//! callbacks. Tauri commands talk to it over a channel; it answers with the fresh state.
//!
//! * `IAudioEndpointVolumeCallback` pushes external changes (media keys, the volume flyout,
//!   Liner, the mixer) to the dock as `audio:state` immediately — nothing is polled.
//! * `IMMNotificationClient` re-binds the endpoint when the default output device changes or a
//!   device appears / disappears.
//! * Switching the default output uses the shell's `IPolicyConfig` (the interface the Sound
//!   control panel itself uses; there is no documented API for it).

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
    AUDIO_VOLUME_NOTIFICATION_DATA, DEVICE_STATE, DEVICE_STATE_ACTIVE, EDataFlow, ERole, IMMDevice, IMMDeviceEnumerator,
    IMMNotificationClient, IMMNotificationClient_Impl, MMDeviceEnumerator, eCommunications, eConsole, eMultimedia, eRender,
};
use windows::Win32::System::Com::StructuredStorage::PropVariantToStringAlloc;
use windows::Win32::System::Com::{CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoTaskMemFree, STGM_READ};
use windows::core::{GUID, PCWSTR, PWSTR, implement};

/// PKEY_Device_FriendlyName ("Speakers (Realtek(R) Audio)").
const PKEY_DEVICE_FRIENDLY_NAME: PROPERTYKEY =
    PROPERTYKEY { fmtid: GUID::from_u128(0xa45c254e_df1c_4efd_8020_67d146a850e0), pid: 14 };

/// Event context stamped on lumabar's own changes (purely informational).
const LUMABAR_CONTEXT: GUID = GUID::from_u128(0x4c554d41_4241_5200_0000_766f6c756d65);

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
        Some(Bound { endpoint, callback, device_id: device_id(&device), device_name: device_name(&device) })
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
                b.endpoint.SetMasterVolumeLevelScalar(v as f32 / 100.0, &LUMABAR_CONTEXT).map_err(|e| e.to_string())?;
            }
            Command::Step(delta) => {
                let current = b.endpoint.GetMasterVolumeLevelScalar().map(scalar_to_percent).map_err(|e| e.to_string())?;
                let next = stepped(current, delta);
                b.endpoint.SetMasterVolumeLevelScalar(next as f32 / 100.0, &LUMABAR_CONTEXT).map_err(|e| e.to_string())?;
                // Scrolling up from mute un-mutes, like the Windows flyout.
                if delta > 0 && b.endpoint.GetMute().map(|m| m.as_bool()).unwrap_or(false) {
                    b.endpoint.SetMute(false, &LUMABAR_CONTEXT).map_err(|e| e.to_string())?;
                }
            }
            Command::SetMute(muted) => {
                let target = match muted {
                    Some(m) => m,
                    None => !b.endpoint.GetMute().map(|m| m.as_bool()).unwrap_or(false),
                };
                b.endpoint.SetMute(target, &LUMABAR_CONTEXT).map_err(|e| e.to_string())?;
            }
            Command::Rebind | Command::SetDefault(_) => {}
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
            eprintln!("[lumabar] Core Audio unavailable: {err}");
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
    std::thread::Builder::new().name("lumabar-audio".into()).spawn(move || run(rx)).expect("spawn audio thread");
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
