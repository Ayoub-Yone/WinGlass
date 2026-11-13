//! System telemetry sampler (1 Hz) + radio / hotspot / keyboard-layout controls.

use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::Devices::Radios::{Radio, RadioAccessStatus, RadioKind, RadioState};
use windows::Networking::Connectivity::NetworkInformation;
use windows::Networking::NetworkOperators::{
    NetworkOperatorTetheringManager, TetheringOperationStatus, TetheringOperationalState,
};
use windows::Win32::Foundation::{FILETIME, HWND, LPARAM, WPARAM};
use windows::Win32::Globalization::{GetLocaleInfoW, LOCALE_SISO639LANGNAME2};
use windows::Win32::NetworkManagement::IpHelper::{FreeMibTable, GetIfTable2, MIB_IF_TABLE2};
use windows::Win32::NetworkManagement::Ndis::IfOperStatusUp;
use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoSetProxyBlanket,
    EOAC_NONE, RPC_C_AUTHN_LEVEL_CALL, RPC_C_IMP_LEVEL_IMPERSONATE,
};
use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
use windows::Win32::System::Rpc::{RPC_C_AUTHN_WINNT, RPC_C_AUTHZ_NONE};
use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
use windows::Win32::System::Threading::GetSystemTimes;
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::System::Wmi::{
    IWbemLocator, IWbemServices, WBEM_FLAG_FORWARD_ONLY, WBEM_FLAG_RETURN_IMMEDIATELY, WBEM_INFINITE, WbemLocator,
};
use windows::Win32::UI::Input::KeyboardAndMouse::GetKeyboardLayout;
use windows::Win32::UI::WindowsAndMessaging::{GetWindowThreadProcessId, PostMessageW, WM_INPUTLANGCHANGEREQUEST};
use windows::core::{BSTR, w};

use super::{from_wide, sentinel};

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RadioStatus {
    pub wifi: Option<bool>,
    pub bluetooth: Option<bool>,
    pub hotspot: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetrySample {
    pub ts: i64,
    pub cpu_percent: f64,
    pub ram_used_gb: f64,
    pub ram_total_gb: f64,
    pub ram_percent: f64,
    pub cpu_temp_c: Option<f64>,
    pub net_up_bps: f64,
    pub net_down_bps: f64,
    pub has_battery: bool,
    pub battery_percent: Option<u8>,
    pub charging: bool,
    pub disk_free_gb: f64,
    pub disk_total_gb: f64,
    pub keyboard_layout: String,
    pub radios: RadioStatus,
}

fn ft_to_u64(ft: FILETIME) -> u64 {
    ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64
}

struct CpuMeter {
    last: Option<(u64, u64)>,
}

impl CpuMeter {
    fn sample(&mut self) -> f64 {
        let (mut idle, mut kernel, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default());
        if unsafe { GetSystemTimes(Some(&mut idle), Some(&mut kernel), Some(&mut user)) }.is_err() {
            return 0.0;
        }
        let idle = ft_to_u64(idle);
        // Kernel time includes idle time.
        let total = ft_to_u64(kernel) + ft_to_u64(user);
        let pct = match self.last {
            Some((pi, pt)) if total > pt => {
                let dt = (total - pt) as f64;
                let di = idle.saturating_sub(pi) as f64;
                ((dt - di) / dt * 100.0).clamp(0.0, 100.0)
            }
            _ => 0.0,
        };
        self.last = Some((idle, total));
        pct
    }
}

struct NetMeter {
    last: Option<(Instant, u64, u64)>,
}

impl NetMeter {
    fn totals() -> Option<(u64, u64)> {
        unsafe {
            let mut table: *mut MIB_IF_TABLE2 = std::ptr::null_mut();
            if GetIfTable2(&mut table).is_err() || table.is_null() {
                return None;
            }
            let rows = std::slice::from_raw_parts((*table).Table.as_ptr(), (*table).NumEntries as usize);
            let (mut rx, mut tx) = (0u64, 0u64);
            for row in rows {
                let flags = row.InterfaceAndOperStatusFlags._bitfield;
                let hardware = flags & 0x01 != 0;
                let filter = flags & 0x02 != 0;
                // 24 = IF_TYPE_SOFTWARE_LOOPBACK
                if hardware && !filter && row.Type != 24 && row.OperStatus == IfOperStatusUp {
                    rx += row.InOctets;
                    tx += row.OutOctets;
                }
            }
            FreeMibTable(table as *const core::ffi::c_void);
            Some((rx, tx))
        }
    }

    /// (up bytes/s, down bytes/s)
    fn sample(&mut self) -> (f64, f64) {
        let Some((rx, tx)) = Self::totals() else { return (0.0, 0.0) };
        let now = Instant::now();
        let rates = match self.last {
            Some((at, prx, ptx)) => {
                let secs = now.duration_since(at).as_secs_f64().max(0.001);
                (tx.saturating_sub(ptx) as f64 / secs, rx.saturating_sub(prx) as f64 / secs)
            }
            None => (0.0, 0.0),
        };
        self.last = Some((now, rx, tx));
        rates
    }
}

fn memory() -> (f64, f64, f64) {
    let mut status = MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
    if unsafe { GlobalMemoryStatusEx(&mut status) }.is_err() {
        return (0.0, 0.0, 0.0);
    }
    let gb = 1024.0 * 1024.0 * 1024.0;
    let total = status.ullTotalPhys as f64 / gb;
    let used = (status.ullTotalPhys - status.ullAvailPhys) as f64 / gb;
    (used, total, status.dwMemoryLoad as f64)
}

fn disk() -> (f64, f64) {
    let drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
    let root = super::wide(&format!("{drive}\\"));
    let (mut free, mut total) = (0u64, 0u64);
    let ok = unsafe {
        GetDiskFreeSpaceExW(windows::core::PCWSTR(root.as_ptr()), Some(&mut free), Some(&mut total), None)
    };
    if ok.is_err() {
        return (0.0, 0.0);
    }
    let gb = 1024.0 * 1024.0 * 1024.0;
    (free as f64 / gb, total as f64 / gb)
}

fn battery() -> (bool, Option<u8>, bool) {
    let mut status = SYSTEM_POWER_STATUS::default();
    if unsafe { GetSystemPowerStatus(&mut status) }.is_err() {
        return (false, None, false);
    }
    // BatteryFlag 128 = no system battery, 255 = unknown.
    let has_battery = status.BatteryFlag != 128 && status.BatteryFlag != 255;
    let percent = if has_battery && status.BatteryLifePercent <= 100 { Some(status.BatteryLifePercent) } else { None };
    (has_battery, percent, status.ACLineStatus == 1)
}

/// ISO 639-2 code of the foreground window's input language, uppercased ("ENG", "FRA").
pub fn keyboard_layout() -> String {
    unsafe {
        let fg = HWND(sentinel::last_external_foreground() as *mut core::ffi::c_void);
        let thread = if fg.is_invalid() { 0 } else { GetWindowThreadProcessId(fg, None) };
        let hkl = GetKeyboardLayout(thread);
        let langid = (hkl.0 as usize & 0xFFFF) as u32;
        let mut buf = [0u16; 16];
        let len = GetLocaleInfoW(langid, LOCALE_SISO639LANGNAME2, Some(&mut buf));
        if len > 0 { from_wide(&buf).to_uppercase() } else { format!("{langid:04X}") }
    }
}

/// Ask the foreground app to switch to the next installed input language (like Win+Space).
pub fn cycle_keyboard_layout() -> Result<(), String> {
    let fg = HWND(sentinel::last_external_foreground() as *mut core::ffi::c_void);
    if fg.is_invalid() {
        return Err("no foreground window to switch".into());
    }
    // HKL_NEXT = 1
    unsafe { PostMessageW(Some(fg), WM_INPUTLANGCHANGEREQUEST, WPARAM(0), LPARAM(1)) }.map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------------------------
// CPU temperature via WMI (no admin needed for the perf-counter thermal zone class)
// ---------------------------------------------------------------------------------------------

struct Wmi {
    services: IWbemServices,
}

impl Wmi {
    fn connect() -> Option<Wmi> {
        unsafe {
            let locator: IWbemLocator = CoCreateInstance(&WbemLocator, None, CLSCTX_INPROC_SERVER).ok()?;
            let services = locator
                .ConnectServer(&BSTR::from("ROOT\\CIMV2"), &BSTR::new(), &BSTR::new(), &BSTR::new(), 0, &BSTR::new(), None)
                .ok()?;
            CoSetProxyBlanket(
                &services,
                RPC_C_AUTHN_WINNT,
                RPC_C_AUTHZ_NONE,
                None,
                RPC_C_AUTHN_LEVEL_CALL,
                RPC_C_IMP_LEVEL_IMPERSONATE,
                None,
                EOAC_NONE,
            )
            .ok()?;
            Some(Wmi { services })
        }
    }

    /// Highest thermal-zone temperature in °C.
    fn cpu_temperature(&self) -> Option<f64> {
        unsafe {
            let enumerator = self
                .services
                .ExecQuery(
                    &BSTR::from("WQL"),
                    &BSTR::from("SELECT HighPrecisionTemperature, Temperature FROM Win32_PerfFormattedData_Counters_ThermalZoneInformation"),
                    WBEM_FLAG_FORWARD_ONLY | WBEM_FLAG_RETURN_IMMEDIATELY,
                    None,
                )
                .ok()?;
            let mut best: Option<f64> = None;
            loop {
                let mut objects = [None];
                let mut returned = 0u32;
                let hr = enumerator.Next(WBEM_INFINITE, &mut objects, &mut returned);
                if hr.is_err() || returned == 0 {
                    break;
                }
                let Some(obj) = objects[0].take() else { break };
                let mut value = VARIANT::default();
                let mut celsius = None;
                if obj.Get(w!("HighPrecisionTemperature"), 0, &mut value, None, None).is_ok() {
                    if let Ok(tenths_kelvin) = i64::try_from(&value).or_else(|_| u32::try_from(&value).map(i64::from)) {
                        if tenths_kelvin > 0 {
                            celsius = Some(tenths_kelvin as f64 / 10.0 - 273.15);
                        }
                    }
                }
                if celsius.is_none() {
                    let mut value = VARIANT::default();
                    if obj.Get(w!("Temperature"), 0, &mut value, None, None).is_ok() {
                        if let Ok(kelvin) = i64::try_from(&value).or_else(|_| u32::try_from(&value).map(i64::from)) {
                            if kelvin > 0 {
                                celsius = Some(kelvin as f64 - 273.15);
                            }
                        }
                    }
                }
                if let Some(c) = celsius.filter(|c| (-20.0..150.0).contains(c)) {
                    best = Some(best.map_or(c, |b: f64| b.max(c)));
                }
            }
            best
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Radios & hotspot (WinRT)
// ---------------------------------------------------------------------------------------------

fn radio_states() -> (Option<bool>, Option<bool>) {
    let mut wifi = None;
    let mut bluetooth = None;
    if let Ok(radios) = Radio::GetRadiosAsync().and_then(|op| op.join()) {
        for radio in radios {
            let on = radio.State().map(|s| s == RadioState::On).unwrap_or(false);
            match radio.Kind() {
                Ok(RadioKind::WiFi) => wifi = Some(wifi.unwrap_or(false) || on),
                Ok(RadioKind::Bluetooth) => bluetooth = Some(bluetooth.unwrap_or(false) || on),
                _ => {}
            }
        }
    }
    (wifi, bluetooth)
}

fn tethering_manager() -> Option<NetworkOperatorTetheringManager> {
    let profile = NetworkInformation::GetInternetConnectionProfile().ok()?;
    NetworkOperatorTetheringManager::CreateFromConnectionProfile(&profile).ok()
}

fn hotspot_state() -> Option<bool> {
    let manager = tethering_manager()?;
    manager.TetheringOperationalState().ok().map(|s| s == TetheringOperationalState::On)
}

/// `kind`: "wifi" | "bluetooth". Must run on a thread with COM initialised (MTA).
pub fn set_radio(kind: &str, on: bool) -> Result<(), String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let wanted = match kind {
        "wifi" => RadioKind::WiFi,
        "bluetooth" => RadioKind::Bluetooth,
        _ => return Err(format!("unknown radio '{kind}'")),
    };
    let access = Radio::RequestAccessAsync().and_then(|op| op.join()).map_err(|e| e.to_string())?;
    if access != RadioAccessStatus::Allowed {
        return Err("Windows denied radio access (check Settings › Privacy › Radios)".into());
    }
    let radios = Radio::GetRadiosAsync().and_then(|op| op.join()).map_err(|e| e.to_string())?;
    let mut found = false;
    for radio in radios {
        if radio.Kind().map(|k| k == wanted).unwrap_or(false) {
            found = true;
            let target = if on { RadioState::On } else { RadioState::Off };
            let status = radio.SetStateAsync(target).and_then(|op| op.join()).map_err(|e| e.to_string())?;
            if status != RadioAccessStatus::Allowed {
                return Err("Windows refused to change the radio state".into());
            }
        }
    }
    if found { Ok(()) } else { Err(format!("no {kind} radio found")) }
}

pub fn set_hotspot(on: bool) -> Result<(), String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let manager = tethering_manager().ok_or("no internet connection profile to share")?;
    let op = if on { manager.StartTetheringAsync() } else { manager.StopTetheringAsync() };
    let result = op.and_then(|o| o.join()).map_err(|e| e.to_string())?;
    let status = result.Status().map_err(|e| e.to_string())?;
    if status == TetheringOperationStatus::Success {
        Ok(())
    } else {
        let message = result.AdditionalErrorMessage().map(|m| m.to_string()).unwrap_or_default();
        Err(if message.is_empty() { format!("hotspot operation failed ({})", status.0) } else { message })
    }
}

pub fn start(app: AppHandle) {
    std::thread::Builder::new()
        .name("lumabar-telemetry".into())
        .spawn(move || {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            }
            let wmi = Wmi::connect();
            let mut cpu = CpuMeter { last: None };
            let mut net = NetMeter { last: None };
            let mut radios = RadioStatus::default();
            let mut temp: Option<f64> = None;
            let mut disk_cache = (0.0, 0.0);
            let mut tick: u64 = 0;
            loop {
                if tick % 5 == 0 {
                    let (wifi, bluetooth) = radio_states();
                    radios = RadioStatus { wifi, bluetooth, hotspot: hotspot_state() };
                    temp = wmi.as_ref().and_then(|w| w.cpu_temperature());
                }
                if tick % 30 == 0 {
                    disk_cache = disk();
                }
                let (ram_used, ram_total, ram_pct) = memory();
                let (up, down) = net.sample();
                let (has_battery, battery_percent, charging) = battery();
                let sample = TelemetrySample {
                    ts: chrono::Utc::now().timestamp_millis(),
                    cpu_percent: cpu.sample(),
                    ram_used_gb: ram_used,
                    ram_total_gb: ram_total,
                    ram_percent: ram_pct,
                    cpu_temp_c: temp,
                    net_up_bps: up,
                    net_down_bps: down,
                    has_battery,
                    battery_percent,
                    charging,
                    disk_free_gb: disk_cache.0,
                    disk_total_gb: disk_cache.1,
                    keyboard_layout: keyboard_layout(),
                    radios: radios.clone(),
                };
                let _ = app.emit("telemetry:sample", &sample);
                tick += 1;
                std::thread::sleep(Duration::from_secs(1));
            }
        })
        .expect("spawn telemetry thread");
}
