//! Windows System Media Transport Controls (GlobalSystemMediaTransportControlsSessionManager).
//!
//! A dedicated MTA thread owns every WinRT object. Once per second it enumerates *all* media
//! sessions (`GetSessions()`), picks the one to show, emits `media:state` when anything changes,
//! and executes transport commands sent over a channel.
//!
//! Session choice: Windows' "current" session is frequently a background browser tab, so Liner
//! (tryliner.fun) wins whenever it has a session — playing first, then paused — before any other
//! player is considered (see `session_rank`).
//!
//! Liner is Electron/Chromium, which needs three kinds of resilience (see `win32/liner.rs`):
//! * metadata goes transiently empty during crossfades -> fall back to the player's window title,
//!   then to the last valid metadata, and keep the previous cover until the new one arrives;
//! * transport commands the renderer does not acknowledge within 250 ms (or reports as
//!   unsupported) are re-sent as hardware media keys through `SendInput`;
//! * a player with no SMTC session at all is still shown from its window title.

use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

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
use windows::Win32::UI::Input::KeyboardAndMouse::{
    INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, SendInput, VIRTUAL_KEY,
    VK_MEDIA_NEXT_TRACK, VK_MEDIA_PLAY_PAUSE, VK_MEDIA_PREV_TRACK,
};

use super::liner;

/// How long Liner's renderer gets to acknowledge a transport command before media keys are sent.
const ACK_TIMEOUT: Duration = Duration::from_millis(250);
const ACK_POLL: Duration = Duration::from_millis(25);
/// How long the previous metadata / cover stay on screen while a crossfade reports nothing.
const CROSSFADE_HOLD: Duration = Duration::from_secs(6);
/// Chromium may publish the new title before the new cover: keep re-reading for this long.
const COVER_REFRESH: Duration = Duration::from_secs(4);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaCommand {
    TogglePlayPause,
    Pause,
    Play,
    Next,
    Previous,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Status {
    Playing,
    Paused,
    Stopped,
    Closed,
    Opened,
    Changing,
    #[default]
    Unknown,
}

impl Status {
    fn from_winrt(status: PlaybackStatus) -> Status {
        match status {
            PlaybackStatus::Playing => Status::Playing,
            PlaybackStatus::Paused => Status::Paused,
            PlaybackStatus::Stopped => Status::Stopped,
            PlaybackStatus::Closed => Status::Closed,
            PlaybackStatus::Opened => Status::Opened,
            PlaybackStatus::Changing => Status::Changing,
            _ => Status::Unknown,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Status::Playing => "Playing",
            Status::Paused => "Paused",
            Status::Stopped => "Stopped",
            Status::Closed => "Closed",
            Status::Opened => "Opened",
            Status::Changing => "Changing",
            Status::Unknown => "Unknown",
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaState {
    pub available: bool,
    pub title: String,
    pub artist: String,
    pub album: String,
    /// "Playing" | "Paused" | "Stopped" | "Closed" | "Opened" | "Changing" | "Unknown"
    pub status: String,
    pub source_app: String,
    /// The source is the Liner desktop player (drives the badge and artwork click).
    pub is_liner: bool,
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

// ---------------------------------------------------------------------------------------------
// Pure decision logic (unit tested)
// ---------------------------------------------------------------------------------------------

/// Lower is better. Liner playing, Liner paused, then every other player.
pub fn session_rank(aumid: &str, status: Status) -> u8 {
    match (liner::is_liner_aumid(aumid), status) {
        (true, Status::Playing) => 0,
        (true, Status::Paused) => 1,
        (false, Status::Playing) => 2,
        (false, Status::Paused) => 3,
        (true, _) => 4,
        (false, _) => 5,
    }
}

#[derive(Debug, Clone)]
pub struct Candidate {
    pub aumid: String,
    pub status: Status,
    /// This is the session Windows itself reports as current (tie-breaker within a rank).
    pub is_current: bool,
}

/// Index of the session to present, or `None` when there are no sessions.
pub fn pick_session(candidates: &[Candidate]) -> Option<usize> {
    candidates
        .iter()
        .enumerate()
        .min_by_key(|(index, c)| (session_rank(&c.aumid, c.status), !c.is_current, *index))
        .map(|(index, _)| index)
}

/// What can be observed about a session before / after a transport command.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Observed {
    pub status: Status,
    pub track: String,
    pub position: i64,
    pub updated: i64,
}

/// Did the player visibly react to `command`?
pub fn acknowledged(command: MediaCommand, before: &Observed, after: &Observed) -> bool {
    match command {
        MediaCommand::TogglePlayPause => after.status != before.status,
        MediaCommand::Pause => after.status != Status::Playing,
        MediaCommand::Play => after.status == Status::Playing,
        MediaCommand::Next | MediaCommand::Previous => after != before,
    }
}

/// Should the hardware media key be dispatched as a fallback?
///
/// `capable`: the session advertises the control. `accepted`: `Try…Async` returned true.
/// `acked`: the state change was observed within the timeout. `status`: playback status now.
/// The play/pause key is a toggle, so it is only sent when it moves towards the requested state.
pub fn needs_media_key(command: MediaCommand, capable: bool, accepted: bool, acked: bool, status: Status) -> bool {
    if capable && accepted && acked {
        return false;
    }
    match command {
        MediaCommand::Pause => status == Status::Playing,
        MediaCommand::Play => status != Status::Playing,
        MediaCommand::TogglePlayPause | MediaCommand::Next | MediaCommand::Previous => true,
    }
}

pub fn media_key_for(command: MediaCommand) -> VIRTUAL_KEY {
    match command {
        MediaCommand::TogglePlayPause | MediaCommand::Pause | MediaCommand::Play => VK_MEDIA_PLAY_PAUSE,
        MediaCommand::Next => VK_MEDIA_NEXT_TRACK,
        MediaCommand::Previous => VK_MEDIA_PREV_TRACK,
    }
}

/// Metadata to show for a Liner session: the session's own when it has a title, else the window
/// title, else the last valid metadata while it is still fresh.
pub fn resolve_metadata(
    session: (&str, &str, &str),
    window: Option<(String, String)>,
    held: Option<(&str, &str, &str)>,
) -> (String, String, String) {
    let (title, artist, album) = session;
    if !title.trim().is_empty() {
        return (title.to_string(), artist.to_string(), album.to_string());
    }
    if let Some((track, window_artist)) = window {
        let artist = if window_artist.is_empty() { artist.to_string() } else { window_artist };
        return (track, artist, album.to_string());
    }
    match held {
        Some((t, a, al)) => (t.to_string(), a.to_string(), al.to_string()),
        None => (String::new(), artist.to_string(), album.to_string()),
    }
}

// ---------------------------------------------------------------------------------------------
// WinRT plumbing
// ---------------------------------------------------------------------------------------------

fn send_media_key(key: VIRTUAL_KEY) -> Result<(), String> {
    let input = |flags| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: key, wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    };
    let inputs = [input(KEYEVENTF_EXTENDEDKEY), input(KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP)];
    let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize == inputs.len() { Ok(()) } else { Err("the media key could not be sent".into()) }
}

fn session_status(session: &GlobalSystemMediaTransportControlsSession) -> Status {
    session
        .GetPlaybackInfo()
        .and_then(|info| info.PlaybackStatus())
        .map(Status::from_winrt)
        .unwrap_or_default()
}

fn session_aumid(session: &GlobalSystemMediaTransportControlsSession) -> String {
    session.SourceAppUserModelId().map(|s| s.to_string()).unwrap_or_default()
}

fn observe(session: &GlobalSystemMediaTransportControlsSession) -> Observed {
    let track = session
        .TryGetMediaPropertiesAsync()
        .and_then(|op| op.join())
        .map(|p| format!("{}|{}", p.Title().map(|s| s.to_string()).unwrap_or_default(), p.Artist().map(|s| s.to_string()).unwrap_or_default()))
        .unwrap_or_default();
    let timeline = session.GetTimelineProperties().ok();
    Observed {
        status: session_status(session),
        track,
        position: timeline.as_ref().and_then(|t| t.Position().ok()).map(|p| p.Duration).unwrap_or(0),
        updated: timeline.as_ref().and_then(|t| t.LastUpdatedTime().ok()).map(|t| t.UniversalTime).unwrap_or(0),
    }
}

/// Every session plus the index of the one to present.
fn choose_session(manager: &GlobalSystemMediaTransportControlsSessionManager) -> Option<(GlobalSystemMediaTransportControlsSession, String)> {
    let current = manager.GetCurrentSession().ok().map(|s| session_aumid(&s));
    let mut sessions: Vec<GlobalSystemMediaTransportControlsSession> = Vec::new();
    if let Ok(list) = manager.GetSessions() {
        let count = list.Size().unwrap_or(0);
        for i in 0..count {
            if let Ok(session) = list.GetAt(i) {
                sessions.push(session);
            }
        }
    }
    // GetSessions can momentarily lag behind GetCurrentSession; never lose the current one.
    if sessions.is_empty() {
        sessions.extend(manager.GetCurrentSession().ok());
    }
    let candidates: Vec<Candidate> = sessions
        .iter()
        .map(|s| {
            let aumid = session_aumid(s);
            let is_current = current.as_deref() == Some(aumid.as_str());
            Candidate { status: session_status(s), is_current, aumid }
        })
        .collect();
    let index = pick_session(&candidates)?;
    let aumid = candidates[index].aumid.clone();
    Some((sessions.swap_remove(index), aumid))
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

struct Cover {
    source: String,
    key: String,
    data: Option<String>,
    /// Re-read until this instant even when `data` is set (title often precedes the cover).
    refresh_until: Instant,
    /// Previous track's cover, shown until the new one arrives or the hold expires.
    carried: Option<(String, Instant)>,
}

struct HeldMetadata {
    source: String,
    title: String,
    artist: String,
    album: String,
    at: Instant,
}

#[derive(Default)]
struct Poller {
    cover: Option<Cover>,
    held: Option<HeldMetadata>,
    idle_polls: u32,
    windowed: Option<MediaState>,
}

impl Poller {
    /// A running Liner that exposes no media session at all: show what its window title says.
    fn window_only_state(&mut self) -> MediaState {
        // Enumerating windows every second for players that are not running would be wasteful.
        self.idle_polls = self.idle_polls.wrapping_add(1);
        if self.idle_polls % 3 == 1 {
            self.windowed = liner::window_metadata().filter(|(_, artist)| !artist.is_empty()).map(|(title, artist)| MediaState {
                available: true,
                title,
                artist,
                status: Status::Unknown.name().to_string(),
                source_app: "Liner.exe".into(),
                is_liner: true,
                can_next: true,
                can_previous: true,
                ..Default::default()
            });
        }
        self.windowed.clone().unwrap_or_default()
    }

    fn cover_for(&mut self, session: &GlobalSystemMediaTransportControlsSession, state: &MediaState) -> Option<String> {
        let now = Instant::now();
        let key = format!("{}|{}|{}|{}", state.source_app, state.title, state.artist, state.album);
        let same_track = self.cover.as_ref().is_some_and(|c| c.key == key);
        if !same_track {
            let previous = self.cover.take();
            // Crossfade: keep the outgoing cover on screen until the incoming one is published.
            let carried = previous
                .filter(|p| state.is_liner && p.source == state.source_app)
                .and_then(|p| p.data.or(p.carried.filter(|(_, until)| *until > now).map(|(data, _)| data)))
                .map(|data| (data, now + CROSSFADE_HOLD));
            self.cover = Some(Cover { source: state.source_app.clone(), key, data: None, refresh_until: now + COVER_REFRESH, carried });
        }
        let cover = self.cover.as_mut()?;
        if cover.data.is_none() || now < cover.refresh_until {
            if let Some(fresh) = read_thumbnail(session) {
                // A cover identical to the carried one is the outgoing track's: not "arrived" yet.
                let stale = cover.carried.as_ref().is_some_and(|(old, _)| *old == fresh) && now < cover.refresh_until;
                if !stale {
                    cover.data = Some(fresh);
                    cover.carried = None;
                }
            }
        }
        cover.data.clone().or_else(|| cover.carried.as_ref().filter(|(_, until)| *until > now).map(|(data, _)| data.clone()))
    }

    fn snapshot(&mut self, manager: &GlobalSystemMediaTransportControlsSessionManager) -> MediaState {
        let Some((session, aumid)) = choose_session(manager) else {
            self.cover = None;
            return self.window_only_state();
        };
        self.idle_polls = 0;
        self.windowed = None;

        let mut state = MediaState { available: true, is_liner: liner::is_liner_aumid(&aumid), source_app: aumid, ..Default::default() };
        if let Ok(props) = session.TryGetMediaPropertiesAsync().and_then(|op| op.join()) {
            state.title = props.Title().map(|s| s.to_string()).unwrap_or_default();
            state.artist = props.Artist().map(|s| s.to_string()).unwrap_or_default();
            state.album = props.AlbumTitle().map(|s| s.to_string()).unwrap_or_default();
        }
        if let Ok(info) = session.GetPlaybackInfo() {
            if let Ok(status) = info.PlaybackStatus() {
                state.status = Status::from_winrt(status).name().to_string();
            }
            if let Ok(controls) = info.Controls() {
                state.can_next = controls.IsNextEnabled().unwrap_or(false);
                state.can_previous = controls.IsPreviousEnabled().unwrap_or(false);
            }
        }

        if state.is_liner {
            // Media keys reach Liner even when its session does not advertise the controls.
            state.can_next = true;
            state.can_previous = true;
            if state.title.trim().is_empty() {
                let now = Instant::now();
                let held = self
                    .held
                    .as_ref()
                    .filter(|h| h.source == state.source_app && now.duration_since(h.at) < CROSSFADE_HOLD)
                    .map(|h| (h.title.as_str(), h.artist.as_str(), h.album.as_str()));
                let (title, artist, album) =
                    resolve_metadata((&state.title, &state.artist, &state.album), liner::window_metadata(), held);
                state.title = title;
                state.artist = artist;
                state.album = album;
            } else {
                self.held = Some(HeldMetadata {
                    source: state.source_app.clone(),
                    title: state.title.clone(),
                    artist: state.artist.clone(),
                    album: state.album.clone(),
                    at: Instant::now(),
                });
            }
        }

        state.thumbnail = self.cover_for(&session, &state);
        state
    }
}

fn execute(manager: &GlobalSystemMediaTransportControlsSessionManager, command: MediaCommand) -> Result<(), String> {
    let Some((session, aumid)) = choose_session(manager) else {
        // No session: a running Liner still answers hardware media keys.
        if liner::windows().is_empty() {
            return Err("nothing is playing".into());
        }
        return send_media_key(media_key_for(command));
    };
    let is_liner = liner::is_liner_aumid(&aumid);
    let controls = session.GetPlaybackInfo().and_then(|info| info.Controls()).ok();
    let capable = controls
        .as_ref()
        .and_then(|c| match command {
            MediaCommand::TogglePlayPause => c.IsPlayPauseToggleEnabled(),
            MediaCommand::Pause => c.IsPauseEnabled(),
            MediaCommand::Play => c.IsPlayEnabled(),
            MediaCommand::Next => c.IsNextEnabled(),
            MediaCommand::Previous => c.IsPreviousEnabled(),
        }
        .ok())
        .unwrap_or(true);

    let before = if is_liner { observe(&session) } else { Observed::default() };
    // A capability reported as false is still attempted for other players (their flags are often
    // wrong); for Liner the media key is the more reliable path, so skip straight to it.
    let attempt = !is_liner || capable;
    let accepted = attempt
        && match command {
            MediaCommand::TogglePlayPause => session.TryTogglePlayPauseAsync(),
            MediaCommand::Pause => session.TryPauseAsync(),
            MediaCommand::Play => session.TryPlayAsync(),
            MediaCommand::Next => session.TrySkipNextAsync(),
            MediaCommand::Previous => session.TrySkipPreviousAsync(),
        }
        .and_then(|op| op.join())
        .unwrap_or(false);

    if !is_liner {
        return if accepted { Ok(()) } else { Err("the media app rejected the command".into()) };
    }

    let mut after = before.clone();
    let mut acked = false;
    if accepted {
        let deadline = Instant::now() + ACK_TIMEOUT;
        loop {
            after = observe(&session);
            acked = acknowledged(command, &before, &after);
            if acked || Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(ACK_POLL);
        }
    }
    if needs_media_key(command, capable, accepted, acked, after.status) {
        send_media_key(media_key_for(command))?;
    }
    Ok(())
}

fn run(app: AppHandle, rx: Receiver<Request>) {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let mut manager: Option<GlobalSystemMediaTransportControlsSessionManager> = None;
    let mut last_sent: Option<MediaState> = None;
    let mut poller = Poller::default();
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
            Some(m) => poller.snapshot(m),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn cand(aumid: &str, status: Status, is_current: bool) -> Candidate {
        Candidate { aumid: aumid.into(), status, is_current }
    }

    #[test]
    fn playing_liner_beats_the_current_browser_tab() {
        let sessions = [cand("chrome.exe", Status::Playing, true), cand("Spotify.exe", Status::Playing, false), cand("Liner.exe", Status::Playing, false)];
        assert_eq!(pick_session(&sessions), Some(2));
    }

    #[test]
    fn paused_liner_beats_other_playing_players() {
        let sessions = [cand("MSEdge", Status::Playing, true), cand("com.liner.desktop", Status::Paused, false)];
        assert_eq!(pick_session(&sessions), Some(1));
    }

    #[test]
    fn playing_liner_beats_paused_liner() {
        let sessions = [cand("Liner", Status::Paused, true), cand("LINER.EXE", Status::Playing, false)];
        assert_eq!(pick_session(&sessions), Some(1));
    }

    #[test]
    fn stopped_liner_yields_to_active_players() {
        let sessions = [cand("Liner.exe", Status::Stopped, false), cand("Spotify.exe", Status::Paused, false), cand("vlc.exe", Status::Playing, false)];
        assert_eq!(pick_session(&sessions), Some(2));
        assert_eq!(pick_session(&sessions[..2]), Some(1));
        assert_eq!(pick_session(&sessions[..1]), Some(0));
    }

    #[test]
    fn without_liner_the_current_session_wins_ties() {
        let sessions = [cand("chrome.exe", Status::Playing, false), cand("Spotify.exe", Status::Playing, true)];
        assert_eq!(pick_session(&sessions), Some(1));
        let paused_current = [cand("chrome.exe", Status::Playing, false), cand("Spotify.exe", Status::Paused, true)];
        assert_eq!(pick_session(&paused_current), Some(0));
    }

    #[test]
    fn no_sessions_picks_nothing() {
        assert_eq!(pick_session(&[]), None);
    }

    #[test]
    fn rank_order_is_liner_playing_liner_paused_then_others() {
        let ranks = [
            session_rank("Liner.exe", Status::Playing),
            session_rank("Liner.exe", Status::Paused),
            session_rank("Spotify.exe", Status::Playing),
            session_rank("Spotify.exe", Status::Paused),
            session_rank("Liner.exe", Status::Changing),
            session_rank("Spotify.exe", Status::Closed),
        ];
        assert!(ranks.windows(2).all(|pair| pair[0] < pair[1]), "{ranks:?}");
    }

    fn obs(status: Status, track: &str, position: i64) -> Observed {
        Observed { status, track: track.into(), position, updated: position }
    }

    #[test]
    fn acknowledgement_tracks_the_requested_state() {
        let playing = obs(Status::Playing, "a|b", 10);
        let paused = obs(Status::Paused, "a|b", 10);
        assert!(acknowledged(MediaCommand::Pause, &playing, &paused));
        assert!(!acknowledged(MediaCommand::Pause, &playing, &playing));
        assert!(acknowledged(MediaCommand::Play, &paused, &playing));
        assert!(!acknowledged(MediaCommand::Play, &paused, &paused));
        assert!(acknowledged(MediaCommand::TogglePlayPause, &playing, &paused));
        assert!(!acknowledged(MediaCommand::TogglePlayPause, &paused, &paused));
        assert!(acknowledged(MediaCommand::Next, &playing, &obs(Status::Playing, "c|d", 10)));
        assert!(acknowledged(MediaCommand::Previous, &playing, &obs(Status::Playing, "a|b", 0)));
        assert!(!acknowledged(MediaCommand::Next, &playing, &playing));
    }

    #[test]
    fn media_key_fallback_fires_only_when_unacknowledged() {
        use MediaCommand::*;
        // Acknowledged by the renderer: never double-fire.
        for command in [TogglePlayPause, Pause, Play, Next, Previous] {
            assert!(!needs_media_key(command, true, true, true, Status::Playing));
        }
        // Accepted but ignored for 250 ms.
        assert!(needs_media_key(Pause, true, true, false, Status::Playing));
        assert!(needs_media_key(Next, true, true, false, Status::Playing));
        assert!(needs_media_key(TogglePlayPause, true, true, false, Status::Paused));
        // Capability false / rejected.
        assert!(needs_media_key(Previous, false, false, false, Status::Playing));
        assert!(needs_media_key(Play, true, false, false, Status::Paused));
        // The play/pause key toggles: never send it when already in the requested state.
        assert!(!needs_media_key(Pause, false, false, false, Status::Paused));
        assert!(!needs_media_key(Play, false, false, false, Status::Playing));
    }

    #[test]
    fn media_keys_map_to_commands() {
        assert_eq!(media_key_for(MediaCommand::TogglePlayPause), VK_MEDIA_PLAY_PAUSE);
        assert_eq!(media_key_for(MediaCommand::Pause), VK_MEDIA_PLAY_PAUSE);
        assert_eq!(media_key_for(MediaCommand::Play), VK_MEDIA_PLAY_PAUSE);
        assert_eq!(media_key_for(MediaCommand::Next), VK_MEDIA_NEXT_TRACK);
        assert_eq!(media_key_for(MediaCommand::Previous), VK_MEDIA_PREV_TRACK);
    }

    #[test]
    fn crossfade_metadata_falls_back_to_window_then_held() {
        let own = resolve_metadata(("Song", "Artist", "Album"), Some(("X".into(), "Y".into())), Some(("H", "I", "J")));
        assert_eq!(own, ("Song".into(), "Artist".into(), "Album".into()));

        let window = resolve_metadata(("", "", ""), Some(("Midnight City".into(), "M83".into())), Some(("H", "I", "J")));
        assert_eq!(window, ("Midnight City".into(), "M83".into(), String::new()));

        let window_no_artist = resolve_metadata(("  ", "Session Artist", ""), Some(("Intro".into(), String::new())), None);
        assert_eq!(window_no_artist, ("Intro".into(), "Session Artist".into(), String::new()));

        let held = resolve_metadata(("", "", ""), None, Some(("Held", "Artist", "Album")));
        assert_eq!(held, ("Held".into(), "Artist".into(), "Album".into()));

        let nothing = resolve_metadata(("", "", ""), None, None);
        assert_eq!(nothing.0, "");
    }
}
