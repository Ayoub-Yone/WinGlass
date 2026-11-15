//! Display brightness (« Luminosité » tile).
//!
//! * Internal panels (laptops): WMI `root\WMI` — `WmiMonitorBrightness.CurrentBrightness` to read,
//!   `WmiMonitorBrightnessMethods.WmiSetBrightness(Timeout, Brightness)` to write.
//! * External monitors: DDC/CI through dxva2 — `GetPhysicalMonitorsFromHMONITOR`, then
//!   `GetMonitorBrightness` / `SetMonitorBrightness` (VCP 0x10) mapped onto 0–100 %.
//!
//! DDC/CI is a slow, lossy serial bus: monitors want ~50 ms between messages and drop the odd
//! reply, so reads are retried, each monitor's range is cached (a write needs no fresh read) and a
//! monitor stays listed with its last known value through a transient failure. Every call runs on
//! the caller's blocking thread under one lock (no concurrent writers on the bus). Monitors without DDC/CI support
//! (or with it disabled in their OSD) simply do not appear. COM is initialised per call on the
//! calling thread (invariant 5).

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;
use windows::Win32::Devices::Display::{
    DestroyPhysicalMonitors, GetMonitorBrightness, GetNumberOfPhysicalMonitorsFromHMONITOR, GetPhysicalMonitorsFromHMONITOR, PHYSICAL_MONITOR,
    SetMonitorBrightness,
};
use windows::Win32::Foundation::{LPARAM, RECT};
use windows::Win32::Graphics::Gdi::{EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFOEXW};
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoSetProxyBlanket, CoUninitialize, EOAC_NONE,
    RPC_C_AUTHN_LEVEL_CALL, RPC_C_IMP_LEVEL_IMPERSONATE,
};
use windows::Win32::System::Rpc::{RPC_C_AUTHN_WINNT, RPC_C_AUTHZ_NONE};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::System::Wmi::{
    IWbemClassObject, IWbemLocator, IWbemServices, WBEM_FLAG_FORWARD_ONLY, WBEM_FLAG_RETURN_IMMEDIATELY, WBEM_GENERIC_FLAG_TYPE, WBEM_INFINITE,
    WbemLocator,
};
use windows::core::{BOOL, BSTR, PCWSTR, w};

use super::from_wide;

/// One lock for every brightness call: DDC/CI must never see two writers.
static BUS: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

/// Last good reading per DDC id: (min, max, percent, when). Bounded by the number of monitors.
static KNOWN: Lazy<Mutex<std::collections::HashMap<String, (u32, u32, u32, std::time::Instant)>>> =
    Lazy::new(|| Mutex::new(std::collections::HashMap::new()));
/// A monitor that stopped answering is still listed (last value) for this long.
const KNOWN_TTL: std::time::Duration = std::time::Duration::from_secs(10 * 60);
/// DDC/CI inter-message delay (VESA recommends ≥ 40–50 ms).
const DDC_GAP: std::time::Duration = std::time::Duration::from_millis(50);
const DDC_ATTEMPTS: usize = 3;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Display {
    /// `internal` for the WMI panel, `ddc:<device>:<index>` for an external monitor.
    pub id: String,
    pub name: String,
    pub internal: bool,
    /// 0..=100
    pub percent: u32,
}

/// Raw DDC value -> percent of the monitor's own range.
pub fn to_percent(min: u32, cur: u32, max: u32) -> u32 {
    if max <= min {
        return 0;
    }
    (((cur.clamp(min, max) - min) as f64 / (max - min) as f64) * 100.0).round() as u32
}

/// Percent -> raw DDC value in the monitor's range.
pub fn from_percent(min: u32, max: u32, percent: u32) -> u32 {
    if max <= min {
        return min;
    }
    min + ((max - min) as f64 * percent.min(100) as f64 / 100.0).round() as u32
}

// ---------------------------------------------------------------------------------------------
// DDC/CI
// ---------------------------------------------------------------------------------------------

struct Physical {
    device: String,
    monitors: Vec<PHYSICAL_MONITOR>,
}

impl Drop for Physical {
    fn drop(&mut self) {
        unsafe {
            let _ = DestroyPhysicalMonitors(&self.monitors);
        }
    }
}

fn physical_monitors() -> Vec<Physical> {
    unsafe extern "system" fn cb(hmon: HMONITOR, _: HDC, _: *mut RECT, lparam: LPARAM) -> BOOL {
        let out = unsafe { &mut *(lparam.0 as *mut Vec<HMONITOR>) };
        out.push(hmon);
        BOOL(1)
    }
    let mut handles: Vec<HMONITOR> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(None, None, Some(cb), LPARAM(&mut handles as *mut _ as isize));
    }
    let mut out = Vec::new();
    for hmon in handles {
        unsafe {
            let mut info = MONITORINFOEXW::default();
            info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
            let device = if GetMonitorInfoW(hmon, &mut info as *mut _ as *mut _).as_bool() { from_wide(&info.szDevice) } else { String::new() };
            let mut count = 0u32;
            if GetNumberOfPhysicalMonitorsFromHMONITOR(hmon, &mut count).is_err() || count == 0 {
                continue;
            }
            let mut monitors = vec![PHYSICAL_MONITOR::default(); count as usize];
            if GetPhysicalMonitorsFromHMONITOR(hmon, &mut monitors).is_err() {
                continue;
            }
            out.push(Physical { device, monitors });
        }
    }
    out
}

fn ddc_read(m: &PHYSICAL_MONITOR) -> Option<(u32, u32, u32)> {
    for attempt in 0..DDC_ATTEMPTS {
        if attempt > 0 {
            std::thread::sleep(DDC_GAP);
        }
        let (mut min, mut cur, mut max) = (0u32, 0u32, 0u32);
        let ok = unsafe { GetMonitorBrightness(m.hPhysicalMonitor, &mut min, &mut cur, &mut max) };
        if ok != 0 && max > min {
            return Some((min, cur, max));
        }
    }
    None
}

fn ddc_displays() -> Vec<Display> {
    let mut out = Vec::new();
    for (n, p) in physical_monitors().iter().enumerate() {
        for (i, m) in p.monitors.iter().enumerate() {
            let id = format!("ddc:{}:{i}", p.device);
            let percent = match ddc_read(m) {
                Some((min, cur, max)) => {
                    let percent = to_percent(min, cur, max);
                    KNOWN.lock().insert(id.clone(), (min, max, percent, std::time::Instant::now()));
                    percent
                }
                // A dropped reply: keep the monitor with its last known value.
                None => match KNOWN.lock().get(&id) {
                    Some((_, _, percent, at)) if at.elapsed() < KNOWN_TTL => *percent,
                    _ => continue,
                },
            };
            let description = { let raw = m.szPhysicalMonitorDescription; from_wide(&raw) };
            let generic = description.is_empty() || description.to_ascii_lowercase().contains("generic");
            out.push(Display { id, name: if generic { format!("#{}", n + 1) } else { description }, internal: false, percent });
        }
    }
    out
}

fn ddc_set(id: &str, percent: u32) -> Result<Display, String> {
    let rest = id.strip_prefix("ddc:").ok_or("unknown display")?;
    let (device, index) = rest.rsplit_once(':').ok_or("unknown display")?;
    let index: usize = index.parse().map_err(|_| "unknown display")?;
    let all = physical_monitors();
    let p = all.iter().find(|p| p.device == device).ok_or("this monitor is no longer connected")?;
    let m = p.monitors.get(index).ok_or("this monitor is no longer connected")?;
    let cached = KNOWN.lock().get(id).map(|(min, max, _, _)| (*min, *max));
    let (min, max) = match cached {
        Some(range) => range,
        None => ddc_read(m).map(|(min, _, max)| (min, max)).ok_or("this monitor does not answer DDC/CI (enable it in its on-screen menu)")?,
    };
    let value = from_percent(min, max, percent);
    let mut written = false;
    for attempt in 0..DDC_ATTEMPTS {
        if attempt > 0 {
            std::thread::sleep(DDC_GAP);
        }
        if unsafe { SetMonitorBrightness(m.hPhysicalMonitor, value) } != 0 {
            written = true;
            break;
        }
    }
    if !written {
        return Err("the monitor refused the brightness change".into());
    }
    // Let the monitor apply it before asking (a read straight after a write is often dropped).
    std::thread::sleep(DDC_GAP);
    let after = ddc_read(m).map(|(a, c, b)| to_percent(a, c, b)).unwrap_or(percent.min(100));
    KNOWN.lock().insert(id.to_string(), (min, max, after, std::time::Instant::now()));
    let description = { let raw = m.szPhysicalMonitorDescription; from_wide(&raw) };
    Ok(Display { id: id.to_string(), name: description, internal: false, percent: after })
}

// ---------------------------------------------------------------------------------------------
// WMI (internal panel)
// ---------------------------------------------------------------------------------------------

struct Com(bool);
impl Com {
    fn init() -> Com {
        Com(unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok())
    }
}
impl Drop for Com {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() };
        }
    }
}

fn wmi() -> Option<IWbemServices> {
    unsafe {
        let locator: IWbemLocator = CoCreateInstance(&WbemLocator, None, CLSCTX_INPROC_SERVER).ok()?;
        let services = locator.ConnectServer(&BSTR::from("ROOT\\WMI"), &BSTR::new(), &BSTR::new(), &BSTR::new(), 0, &BSTR::new(), None).ok()?;
        CoSetProxyBlanket(&services, RPC_C_AUTHN_WINNT, RPC_C_AUTHZ_NONE, None, RPC_C_AUTHN_LEVEL_CALL, RPC_C_IMP_LEVEL_IMPERSONATE, None, EOAC_NONE).ok()?;
        Some(services)
    }
}

fn first_object(services: &IWbemServices, query: &str) -> Option<IWbemClassObject> {
    unsafe {
        let e = services
            .ExecQuery(&BSTR::from("WQL"), &BSTR::from(query), WBEM_FLAG_FORWARD_ONLY | WBEM_FLAG_RETURN_IMMEDIATELY, None)
            .ok()?;
        let mut objects = [None];
        let mut returned = 0u32;
        if e.Next(WBEM_INFINITE, &mut objects, &mut returned).is_err() || returned == 0 {
            return None;
        }
        objects[0].take()
    }
}

fn get_u32(obj: &IWbemClassObject, name: PCWSTR) -> Option<u32> {
    let mut value = VARIANT::default();
    unsafe {
        obj.Get(name, 0, &mut value, None, None).ok()?;
    }
    u32::try_from(&value).or_else(|_| i32::try_from(&value).map(|v| v.max(0) as u32)).ok()
}

fn internal_display(services: &IWbemServices) -> Option<Display> {
    let obj = first_object(services, "SELECT CurrentBrightness FROM WmiMonitorBrightness WHERE Active = TRUE")?;
    let percent = get_u32(&obj, w!("CurrentBrightness"))?;
    Some(Display { id: "internal".into(), name: String::new(), internal: true, percent: percent.min(100) })
}

fn internal_set(percent: u32) -> Result<Display, String> {
    let services = wmi().ok_or("WMI is unavailable")?;
    let methods = first_object(&services, "SELECT * FROM WmiMonitorBrightnessMethods WHERE Active = TRUE").ok_or("this screen has no adjustable backlight")?;
    unsafe {
        let mut path = VARIANT::default();
        methods.Get(w!("__PATH"), 0, &mut path, None, None).map_err(|e| e.to_string())?;
        let path = BSTR::try_from(&path).map_err(|e| e.to_string())?;
        let mut class: Option<IWbemClassObject> = None;
        services
            .GetObject(&BSTR::from("WmiMonitorBrightnessMethods"), WBEM_GENERIC_FLAG_TYPE(0), None, Some(&mut class), None)
            .map_err(|e| e.to_string())?;
        let class = class.ok_or("WmiMonitorBrightnessMethods is missing")?;
        let mut signature: Option<IWbemClassObject> = None;
        class.GetMethod(w!("WmiSetBrightness"), 0, &mut signature, std::ptr::null_mut()).map_err(|e| e.to_string())?;
        let input = signature.ok_or("WmiSetBrightness has no parameters")?.SpawnInstance(0).map_err(|e| e.to_string())?;
        input.Put(w!("Timeout"), 0, &VARIANT::from(0u32), 0).map_err(|e| e.to_string())?;
        input.Put(w!("Brightness"), 0, &VARIANT::from(percent.min(100) as u8), 0).map_err(|e| e.to_string())?;
        services
            .ExecMethod(&path, &BSTR::from("WmiSetBrightness"), WBEM_GENERIC_FLAG_TYPE(0), None, &input, None, None)
            .map_err(|e| format!("WmiSetBrightness failed: {e}"))?;
    }
    Ok(internal_display(&services).unwrap_or(Display { id: "internal".into(), name: String::new(), internal: true, percent: percent.min(100) }))
}

// ---------------------------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------------------------

/// Every display whose brightness lumabar can change: the internal panel first, then DDC/CI monitors.
pub fn list() -> Vec<Display> {
    let _bus = BUS.lock();
    let _com = Com::init();
    let mut out = Vec::new();
    if let Some(services) = wmi() {
        out.extend(internal_display(&services));
    }
    out.extend(ddc_displays());
    out
}

pub fn set(id: &str, percent: u32) -> Result<Display, String> {
    let _bus = BUS.lock();
    let _com = Com::init();
    if id == "internal" { internal_set(percent) } else { ddc_set(id, percent) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ddc_ranges_map_onto_percent() {
        assert_eq!(to_percent(0, 50, 100), 50);
        assert_eq!(to_percent(10, 10, 110), 0);
        assert_eq!(to_percent(10, 110, 110), 100);
        assert_eq!(to_percent(0, 200, 100), 100);
        assert_eq!(to_percent(5, 5, 5), 0);
        assert_eq!(from_percent(0, 100, 37), 37);
        assert_eq!(from_percent(10, 110, 50), 60);
        assert_eq!(from_percent(0, 100, 250), 100);
        for p in [0, 1, 33, 50, 99, 100] {
            assert_eq!(to_percent(0, from_percent(0, 255, p), 255), p);
        }
    }

    /// Real displays on this machine. Writes each display's *current* value back (no visible
    /// change), proving the read/write path without altering the user's brightness.
    #[test]
    fn real_displays_round_trip_their_current_brightness() {
        let displays = list();
        for d in &displays {
            eprintln!("display: {} | {} | internal={} | {}%", d.id, d.name, d.internal, d.percent);
            assert!(d.percent <= 100);
            let after = set(&d.id, d.percent).expect("write current brightness back");
            assert!(after.percent.abs_diff(d.percent) <= 2, "{} -> {}", d.percent, after.percent);
        }
        assert!(set("ddc:nope:0", 50).is_err());
    }
}
