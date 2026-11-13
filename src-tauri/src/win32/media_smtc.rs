//! Windows System Media Transport Controls (GlobalSystemMediaTransportControlsSessionManager).
//!
//! A dedicated MTA thread owns every WinRT object. It polls the current session once per second,
//! emits `media:state` when anything changes, and executes transport commands sent over a channel.

use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use once_cell::sync::OnceCell;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession, GlobalSystemMediaTransportControlsSessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
};
use windows::Storage::Streams::{DataReader, InputStreamOptions};
use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx};

#[derive(Debug, Clone, Copy)]
pub enum MediaCommand {
    TogglePlayPause,
    Pause,
    Play,
    Next,
    Previous,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaState {
    pub available: bool,
    pub title: String,
    pub artist: String,
    pub album: String,
    /// "Playing" | "Paused" | "Stopped" | "Closed" | "Opened" | "Changing"
    pub status: String,
    pub source_app: String,
    pub thumbnail: Option<String>,
    pub can_next: bool,
    pub can_previous: bool,
}

struct Request {
    command: MediaCommand,
    reply: Sender<Result<(), String>>,
}

static SENDER: OnceCell<parking_lot::Mutex<Sender<Request>>> = OnceCell::new();
static LATEST: OnceCell<parking_lot::Mutex<MediaState>> = OnceCell::new();

pub fn latest() -> MediaState {
    LATEST.get().map(|m| m.lock().clone()).unwrap_or_default()
}

pub fn send(command: MediaCommand) -> Result<(), String> {
    let sender = SENDER.get().ok_or("media service not running")?.lock().clone();
    let (tx, rx) = mpsc::channel();
    sender.send(Request { command, reply: tx }).map_err(|e| e.to_string())?;
    rx.recv_timeout(Duration::from_secs(5)).map_err(|_| "media command timed out".to_string())?
}

fn status_name(status: PlaybackStatus) -> &'static str {
    match status {
        PlaybackStatus::Playing => "Playing",
        PlaybackStatus::Paused => "Paused",
        PlaybackStatus::Stopped => "Stopped",
        PlaybackStatus::Closed => "Closed",
        PlaybackStatus::Opened => "Opened",
        PlaybackStatus::Changing => "Changing",
        _ => "Unknown",
    }
}

fn read_thumbnail(session: &GlobalSystemMediaTransportControlsSession) -> Option<String> {
    let props = session.TryGetMediaPropertiesAsync().ok()?.join().ok()?;
    let reference = props.Thumbnail().ok()?;
    let stream = reference.OpenReadAsync().ok()?.join().ok()?;
    let content_type = stream.ContentType().map(|c| c.to_string()).unwrap_or_default();
    let size = stream.Size().ok()? as u32;
    if size == 0 || size > 8 * 1024 * 1024 {
        return None;
    }
    let input = stream.GetInputStreamAt(0).ok()?;
    let reader = DataReader::CreateDataReader(&input).ok()?;
    reader.SetInputStreamOptions(InputStreamOptions::ReadAhead).ok()?;
    let loaded = reader.LoadAsync(size).ok()?.join().ok()?;
    let mut bytes = vec![0u8; loaded as usize];
    reader.ReadBytes(&mut bytes).ok()?;
    let mime = if content_type.starts_with("image/") { content_type } else { "image/png".to_string() };
    Some(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

fn snapshot(
    manager: &GlobalSystemMediaTransportControlsSessionManager,
    thumb_cache: &mut Option<(String, Option<String>)>,
) -> MediaState {
    let Ok(session) = manager.GetCurrentSession() else { return MediaState::default() };
    let mut state = MediaState { available: true, ..Default::default() };
    state.source_app = session.SourceAppUserModelId().map(|s| s.to_string()).unwrap_or_default();
    if let Ok(props) = session.TryGetMediaPropertiesAsync().and_then(|op| op.join()) {
        state.title = props.Title().map(|s| s.to_string()).unwrap_or_default();
        state.artist = props.Artist().map(|s| s.to_string()).unwrap_or_default();
        state.album = props.AlbumTitle().map(|s| s.to_string()).unwrap_or_default();
    }
    if let Ok(info) = session.GetPlaybackInfo() {
        if let Ok(status) = info.PlaybackStatus() {
            state.status = status_name(status).to_string();
        }
        if let Ok(controls) = info.Controls() {
            state.can_next = controls.IsNextEnabled().unwrap_or(false);
            state.can_previous = controls.IsPreviousEnabled().unwrap_or(false);
        }
    }
    let key = format!("{}|{}|{}|{}", state.source_app, state.title, state.artist, state.album);
    match thumb_cache {
        Some((cached_key, thumb)) if *cached_key == key && thumb.is_some() => state.thumbnail = thumb.clone(),
        _ => {
            let thumb = read_thumbnail(&session);
            *thumb_cache = Some((key, thumb.clone()));
            state.thumbnail = thumb;
        }
    }
    state
}

fn execute(manager: &GlobalSystemMediaTransportControlsSessionManager, command: MediaCommand) -> Result<(), String> {
    let session = manager.GetCurrentSession().map_err(|_| "nothing is playing".to_string())?;
    let op = match command {
        MediaCommand::TogglePlayPause => session.TryTogglePlayPauseAsync(),
        MediaCommand::Pause => session.TryPauseAsync(),
        MediaCommand::Play => session.TryPlayAsync(),
        MediaCommand::Next => session.TrySkipNextAsync(),
        MediaCommand::Previous => session.TrySkipPreviousAsync(),
    };
    let accepted = op.and_then(|o| o.join()).map_err(|e| e.to_string())?;
    if accepted { Ok(()) } else { Err("the media app rejected the command".into()) }
}

fn run(app: AppHandle, rx: Receiver<Request>) {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let mut manager: Option<GlobalSystemMediaTransportControlsSessionManager> = None;
    let mut last_sent: Option<MediaState> = None;
    let mut thumb_cache: Option<(String, Option<String>)> = None;
    loop {
        if manager.is_none() {
            manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync().and_then(|op| op.join()).ok();
        }
        match rx.recv_timeout(Duration::from_millis(1000)) {
            Ok(request) => {
                let result = match &manager {
                    Some(m) => execute(m, request.command),
                    None => Err("media service unavailable".into()),
                };
                let _ = request.reply.send(result);
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        let state = match &manager {
            Some(m) => snapshot(m, &mut thumb_cache),
            None => MediaState::default(),
        };
        if last_sent.as_ref() != Some(&state) {
            if let Some(latest) = LATEST.get() {
                *latest.lock() = state.clone();
            }
            let _ = app.emit("media:state", &state);
            last_sent = Some(state);
        }
    }
}

pub fn start(app: AppHandle) {
    let (tx, rx) = mpsc::channel::<Request>();
    let _ = SENDER.set(parking_lot::Mutex::new(tx));
    let _ = LATEST.set(parking_lot::Mutex::new(MediaState::default()));
    std::thread::Builder::new()
        .name("lumabar-media".into())
        .spawn(move || run(app, rx))
        .expect("spawn media thread");
}
