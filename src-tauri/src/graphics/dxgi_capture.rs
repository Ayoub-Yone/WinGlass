//! IDXGIOutputDuplication capture of the desktop region directly behind the dock.
//!
//! * Only the dock's bounding rectangle is copied (CopySubresourceRegion into a small staging
//!   texture), never the full desktop.
//! * Idle gating: frames whose `AccumulatedFrames` is zero, that only moved the cursor, or whose
//!   dirty/move rects do not intersect the dock rect are released without any readback, so a
//!   static desktop costs no GPU copies and no IPC.
//! * The dock window is excluded from capture (WDA_EXCLUDEFROMCAPTURE) while liquid glass is on,
//!   so the shader sees what is *behind* the dock rather than the dock itself.
//! * Frames are served to WebGL through the `glass://capture?t=<seq>` URI scheme.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::Foundation::{HMODULE, HWND, RECT};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_UNKNOWN;
use windows::Win32::Graphics::Direct3D11::{
    D3D11_BOX, D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAP_READ,
    D3D11_MAPPED_SUBRESOURCE, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING, D3D11CreateDevice,
    ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_MODE_ROTATION_IDENTITY, DXGI_MODE_ROTATION_UNSPECIFIED, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, DXGI_ERROR_WAIT_TIMEOUT, DXGI_OUTDUPL_FRAME_INFO, DXGI_OUTDUPL_MOVE_RECT, DXGI_OUTPUT_DESC,
    IDXGIAdapter1, IDXGIFactory1, IDXGIOutput1, IDXGIOutputDuplication, IDXGIResource,
};
use windows::Win32::UI::WindowsAndMessaging::{SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_NONE};
use windows::core::Interface;

pub struct Frame {
    pub seq: u64,
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

static ENABLED: AtomicBool = AtomicBool::new(false);
static FORCE_FULL: AtomicBool = AtomicBool::new(true);
static SEQ: AtomicU64 = AtomicU64::new(0);
static CAPTURE_RECT: Lazy<Mutex<Option<RECT>>> = Lazy::new(|| Mutex::new(None));
static LATEST: Lazy<Mutex<Option<Arc<Frame>>>> = Lazy::new(|| Mutex::new(None));
static STATUS: Lazy<Mutex<String>> = Lazy::new(|| Mutex::new("idle".into()));

const MAX_FPS: u64 = 30;

pub fn latest() -> Option<Arc<Frame>> {
    LATEST.lock().clone()
}

pub fn status() -> String {
    STATUS.lock().clone()
}

fn set_status(s: &str) {
    let mut status = STATUS.lock();
    if *status != s {
        *status = s.to_string();
    }
}

/// Screen-space physical rect behind the dock pill.
pub fn set_rect(rect: RECT) {
    let mut current = CAPTURE_RECT.lock();
    if *current != Some(rect) {
        *current = Some(rect);
        FORCE_FULL.store(true, Ordering::SeqCst);
    }
}

/// Toggle capture and the dock's capture exclusion together.
pub fn set_enabled(app: &AppHandle, enabled: bool) {
    let was = ENABLED.swap(enabled, Ordering::SeqCst);
    if was == enabled {
        return;
    }
    FORCE_FULL.store(true, Ordering::SeqCst);
    if let Some(dock) = app.get_webview_window("dock") {
        if let Ok(raw) = dock.hwnd() {
            let hwnd = HWND(raw.0 as *mut core::ffi::c_void);
            unsafe {
                let _ = SetWindowDisplayAffinity(hwnd, if enabled { WDA_EXCLUDEFROMCAPTURE } else { WDA_NONE });
            }
        }
    }
    if !enabled {
        *LATEST.lock() = None;
    }
}

struct Capture {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    duplication: IDXGIOutputDuplication,
    desktop: RECT,
    staging: Option<(ID3D11Texture2D, u32, u32)>,
    metadata: Vec<u8>,
}

fn contains_point(r: &RECT, x: i32, y: i32) -> bool {
    x >= r.left && x < r.right && y >= r.top && y < r.bottom
}

fn intersects(a: &RECT, b: &RECT) -> bool {
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

fn find_output(target: &RECT) -> Option<(IDXGIAdapter1, IDXGIOutput1, DXGI_OUTPUT_DESC)> {
    let cx = (target.left + target.right) / 2;
    let cy = (target.top + target.bottom) / 2;
    unsafe {
        let factory: IDXGIFactory1 = CreateDXGIFactory1().ok()?;
        let mut a = 0;
        while let Ok(adapter) = factory.EnumAdapters1(a) {
            let mut o = 0;
            while let Ok(output) = adapter.EnumOutputs(o) {
                if let Ok(desc) = output.GetDesc() {
                    if desc.AttachedToDesktop.as_bool() && contains_point(&desc.DesktopCoordinates, cx, cy) {
                        let output1: IDXGIOutput1 = output.cast().ok()?;
                        return Some((adapter, output1, desc));
                    }
                }
                o += 1;
            }
            a += 1;
        }
    }
    None
}

impl Capture {
    fn create(target: &RECT) -> Result<Capture, String> {
        let (adapter, output, desc) = find_output(target).ok_or("no DXGI output under the dock")?;
        if desc.Rotation != DXGI_MODE_ROTATION_IDENTITY && desc.Rotation != DXGI_MODE_ROTATION_UNSPECIFIED {
            return Err("rotated displays are not supported by liquid glass".into());
        }
        unsafe {
            let mut device: Option<ID3D11Device> = None;
            let mut context: Option<ID3D11DeviceContext> = None;
            D3D11CreateDevice(
                &adapter,
                D3D_DRIVER_TYPE_UNKNOWN,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )
            .map_err(|e| format!("D3D11CreateDevice: {e}"))?;
            let device = device.ok_or("no D3D11 device")?;
            let context = context.ok_or("no D3D11 context")?;
            let duplication = output.DuplicateOutput(&device).map_err(|e| format!("DuplicateOutput: {e}"))?;
            Ok(Capture { device, context, duplication, desktop: desc.DesktopCoordinates, staging: None, metadata: Vec::new() })
        }
    }

    /// Dock rect clamped to this output, in output-relative coordinates.
    fn local_rect(&self, screen: &RECT) -> Option<RECT> {
        let left = screen.left.max(self.desktop.left) - self.desktop.left;
        let top = screen.top.max(self.desktop.top) - self.desktop.top;
        let right = screen.right.min(self.desktop.right) - self.desktop.left;
        let bottom = screen.bottom.min(self.desktop.bottom) - self.desktop.top;
        if right - left < 4 || bottom - top < 4 { None } else { Some(RECT { left, top, right, bottom }) }
    }

    /// True if any dirty or move rect of the current frame touches `local`.
    fn region_changed(&mut self, info: &DXGI_OUTDUPL_FRAME_INFO, local: &RECT) -> bool {
        let size = info.TotalMetadataBufferSize as usize;
        if size == 0 {
            return false;
        }
        if self.metadata.len() < size {
            self.metadata.resize(size, 0);
        }
        unsafe {
            let mut required = 0u32;
            if self
                .duplication
                .GetFrameMoveRects(size as u32, self.metadata.as_mut_ptr() as *mut DXGI_OUTDUPL_MOVE_RECT, &mut required)
                .is_ok()
            {
                let count = required as usize / std::mem::size_of::<DXGI_OUTDUPL_MOVE_RECT>();
                let moves = std::slice::from_raw_parts(self.metadata.as_ptr() as *const DXGI_OUTDUPL_MOVE_RECT, count);
                if moves.iter().any(|m| intersects(&m.DestinationRect, local)) {
                    return true;
                }
            }
            let mut required = 0u32;
            if self
                .duplication
                .GetFrameDirtyRects(size as u32, self.metadata.as_mut_ptr() as *mut RECT, &mut required)
                .is_ok()
            {
                let count = required as usize / std::mem::size_of::<RECT>();
                let dirty = std::slice::from_raw_parts(self.metadata.as_ptr() as *const RECT, count);
                return dirty.iter().any(|d| intersects(d, local));
            }
        }
        // Metadata unreadable: be safe and refresh.
        true
    }

    fn staging_for(&mut self, w: u32, h: u32) -> Result<ID3D11Texture2D, String> {
        if let Some((tex, sw, sh)) = &self.staging {
            if *sw == w && *sh == h {
                return Ok(tex.clone());
            }
        }
        let desc = D3D11_TEXTURE2D_DESC {
            Width: w,
            Height: h,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_STAGING,
            BindFlags: 0,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            MiscFlags: 0,
        };
        let mut tex: Option<ID3D11Texture2D> = None;
        unsafe { self.device.CreateTexture2D(&desc, None, Some(&mut tex)) }.map_err(|e| format!("CreateTexture2D: {e}"))?;
        let tex = tex.ok_or("no staging texture")?;
        self.staging = Some((tex.clone(), w, h));
        Ok(tex)
    }

    fn read_region(&mut self, frame_tex: &ID3D11Texture2D, local: &RECT) -> Result<Frame, String> {
        let w = (local.right - local.left) as u32;
        let h = (local.bottom - local.top) as u32;
        let staging = self.staging_for(w, h)?;
        let region = D3D11_BOX {
            left: local.left as u32,
            top: local.top as u32,
            front: 0,
            right: local.right as u32,
            bottom: local.bottom as u32,
            back: 1,
        };
        unsafe {
            self.context.CopySubresourceRegion(&staging, 0, 0, 0, 0, frame_tex, 0, Some(&region));
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            self.context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)).map_err(|e| format!("Map: {e}"))?;
            let mut rgba = vec![0u8; (w * h * 4) as usize];
            let src = mapped.pData as *const u8;
            for y in 0..h as usize {
                let row = std::slice::from_raw_parts(src.add(y * mapped.RowPitch as usize), w as usize * 4);
                let out = &mut rgba[y * w as usize * 4..(y + 1) * w as usize * 4];
                for (dst, px) in out.chunks_exact_mut(4).zip(row.chunks_exact(4)) {
                    dst[0] = px[2];
                    dst[1] = px[1];
                    dst[2] = px[0];
                    dst[3] = 255;
                }
            }
            self.context.Unmap(&staging, 0);
            Ok(Frame { seq: SEQ.fetch_add(1, Ordering::SeqCst) + 1, width: w, height: h, rgba })
        }
    }
}

pub fn start(app: AppHandle) {
    std::thread::Builder::new()
        .name("lumabar-dxgi".into())
        .spawn(move || {
            let mut capture: Option<Capture> = None;
            let frame_budget = Duration::from_millis(1000 / MAX_FPS);
            loop {
                let rect = *CAPTURE_RECT.lock();
                let Some(rect) = rect.filter(|_| ENABLED.load(Ordering::SeqCst)) else {
                    capture = None;
                    set_status("idle");
                    std::thread::sleep(Duration::from_millis(200));
                    continue;
                };

                // (Re)create when missing or when the dock moved to another output.
                let stale = capture.as_ref().is_some_and(|c| {
                    let cx = (rect.left + rect.right) / 2;
                    let cy = (rect.top + rect.bottom) / 2;
                    !contains_point(&c.desktop, cx, cy)
                });
                if capture.is_none() || stale {
                    match Capture::create(&rect) {
                        Ok(c) => {
                            capture = Some(c);
                            FORCE_FULL.store(true, Ordering::SeqCst);
                            set_status("running");
                        }
                        Err(err) => {
                            set_status(&format!("error: {err}"));
                            capture = None;
                            std::thread::sleep(Duration::from_millis(1000));
                            continue;
                        }
                    }
                }
                let Some(cap) = capture.as_mut() else { continue };
                let Some(local) = cap.local_rect(&rect) else {
                    std::thread::sleep(Duration::from_millis(200));
                    continue;
                };

                let started = Instant::now();
                let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
                let mut resource: Option<IDXGIResource> = None;
                match unsafe { cap.duplication.AcquireNextFrame(100, &mut info, &mut resource) } {
                    Ok(()) => {}
                    Err(err) if err.code() == DXGI_ERROR_WAIT_TIMEOUT => continue,
                    Err(_) => {
                        // DXGI_ERROR_ACCESS_LOST (mode change, secure desktop, UAC) or similar.
                        capture = None;
                        std::thread::sleep(Duration::from_millis(250));
                        continue;
                    }
                }

                let force = FORCE_FULL.load(Ordering::SeqCst);
                let changed = force
                    || (info.AccumulatedFrames > 0 && info.LastPresentTime != 0 && cap.region_changed(&info, &local));

                if changed {
                    let texture = resource.as_ref().and_then(|r| r.cast::<ID3D11Texture2D>().ok());
                    if let Some(texture) = texture {
                        match cap.read_region(&texture, &local) {
                            Ok(frame) => {
                                let seq = frame.seq;
                                *LATEST.lock() = Some(Arc::new(frame));
                                FORCE_FULL.store(false, Ordering::SeqCst);
                                let _ = app.emit_to("dock", "glass:frame", seq);
                            }
                            Err(err) => set_status(&format!("error: {err}")),
                        }
                    }
                }
                drop(resource);
                unsafe {
                    let _ = cap.duplication.ReleaseFrame();
                }
                if changed {
                    let spent = started.elapsed();
                    if spent < frame_budget {
                        std::thread::sleep(frame_budget - spent);
                    }
                }
            }
        })
        .expect("spawn DXGI capture thread");
}
