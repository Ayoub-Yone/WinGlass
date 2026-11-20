//! Application settings, stored as one JSON document under kv key `settings`.
//! Every field has a default so older/partial documents always deserialize.

use serde::{Deserialize, Serialize};

use super::db::Db;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PreMeetingRule {
    pub enabled: bool,
    pub minutes: u32,
}
impl Default for PreMeetingRule {
    fn default() -> Self {
        Self { enabled: true, minutes: 2 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AiLimitRule {
    pub enabled: bool,
    pub threshold_percent: f64,
    /// Second, louder warning (once per reset window as well).
    pub critical_percent: f64,
    pub horizon_hours: f64,
}
impl Default for AiLimitRule {
    fn default() -> Self {
        Self { enabled: true, threshold_percent: 85.0, critical_percent: 95.0, horizon_hours: 24.0 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RevenueRule {
    pub enabled: bool,
    pub milestones: Vec<f64>,
}
impl Default for RevenueRule {
    fn default() -> Self {
        Self { enabled: true, milestones: vec![1000.0, 3000.0, 5000.0, 10000.0] }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RenewalRule {
    pub enabled: bool,
    pub hours: f64,
    pub keywords: Vec<String>,
}
impl Default for RenewalRule {
    fn default() -> Self {
        Self {
            enabled: true,
            hours: 24.0,
            keywords: ["renewal", "subscription", "billing", "renews"].iter().map(|s| s.to_string()).collect(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Automations {
    pub pre_meeting_pause: PreMeetingRule,
    pub ai_limit_warning: AiLimitRule,
    pub revenue_milestone: RevenueRule,
    pub renewal_reminder: RenewalRule,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WorldClock {
    pub label: String,
    pub time_zone: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ProviderConfig {
    pub leetcode_username: String,
    pub github_username: String,
    pub x_username: String,
    pub youtube_channel_id: String,
    pub instagram_user_id: String,
    pub gmail_address: String,
    pub api_counter_url: String,
    pub api_counter_json_path: String,
    pub api_counter_label: String,
    pub weather_latitude: f64,
    pub weather_longitude: f64,
    pub weather_city: String,
    pub weather_fahrenheit: bool,
    pub revenue_goal: f64,
    pub deepseek_budget: f64,
    pub grok_budget: f64,
    /// Read Gemini CLI / Codex CLI credentials from the user's profile when no token is set.
    pub use_local_cli_credentials: bool,
    pub poll_minutes: u32,
}
impl Default for ProviderConfig {
    fn default() -> Self {
        Self {
            leetcode_username: String::new(),
            github_username: String::new(),
            x_username: String::new(),
            youtube_channel_id: String::new(),
            instagram_user_id: String::new(),
            gmail_address: String::new(),
            api_counter_url: String::new(),
            api_counter_json_path: String::new(),
            api_counter_label: "API calls".into(),
            weather_latitude: 40.7128,
            weather_longitude: -74.0060,
            weather_city: "New York".into(),
            weather_fahrenheit: true,
            revenue_goal: 15000.0,
            deepseek_budget: 50.0,
            grok_budget: 50.0,
            use_local_cli_credentials: false,
            poll_minutes: 5,
        }
    }
}

/// « Heures de prière »: where the timetable comes from and which prayers ring.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct PrayerConfig {
    /// "mawaqit" (a mosque's own timetable) | "city" (Aladhan astronomical calculation).
    pub source: String,
    pub mosque_slug: String,
    pub mosque_name: String,
    pub city: String,
    pub latitude: f64,
    pub longitude: f64,
    /// Aladhan method id: 3 MWL (default), 12 UOIF France, 2 ISNA, 4 Umm al-Qura.
    pub method: u32,
    /// Reminder before the adhan: 0 (off), 5, 10 or 15 minutes.
    pub reminder_minutes: u32,
    /// Prayers that notify: fajr, sunrise, dhuhr, asr, maghrib, isha.
    pub alerts: Vec<String>,
    pub chime: bool,
    pub native_toasts: bool,
}
impl Default for PrayerConfig {
    fn default() -> Self {
        Self {
            source: "city".into(),
            mosque_slug: String::new(),
            mosque_name: String::new(),
            city: String::new(),
            latitude: 0.0,
            longitude: 0.0,
            method: 3,
            reminder_minutes: 10,
            alerts: ["fajr", "dhuhr", "asr", "maghrib", "isha"].map(String::from).to_vec(),
            chime: true,
            native_toasts: true,
        }
    }
}

/// Default « Clair ↔ Givré » level: clear enough for the desktop to read through the glass.
pub const DEFAULT_FROST_LEVEL: f64 = 0.32;

/// Current settings document revision.
pub const SCHEMA: u32 = 5;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub theme: String,
    pub size: String,
    pub position: String,
    pub monitor: Option<String>,
    pub taskbar_mode: String,
    pub hide_on_fullscreen: bool,
    /// « Masquer automatiquement le dock »: slide away when the cursor leaves, reveal at the screen edge.
    pub auto_hide_dock: bool,
    pub simulation: bool,
    pub do_not_disturb: bool,
    pub launch_at_login: bool,
    pub accent: String,
    /// UI language: "fr" (default) | "en".
    pub language: String,
    /// « Clair ↔ Givré »: 0.0 ultra-clear optical glass .. 1.0 deep matte frost (0.32 default).
    pub glass_frost_level: f64,
    /// « Mode Clear »: no bar background, every widget floats in its own capsule.
    pub clear_mode: bool,
    /// « Ambiance Musique »: soft glow tinted by the playing track's cover art.
    pub music_ambiance: bool,
    /// Dock corner radius in px (cards follow concentrically).
    pub dock_radius: f64,
    /// Liquid-glass refraction strength multiplier (0.5 .. 2, 1 = calibrated default).
    pub glass_refraction: f64,
    /// Settings document revision, see `Settings::parse`.
    pub schema: u32,
    pub pomodoro_focus_minutes: u32,
    pub pomodoro_break_minutes: u32,
    pub world_clocks: Vec<WorldClock>,
    pub automations: Automations,
    pub providers: ProviderConfig,
    pub prayer: PrayerConfig,
}

impl Default for WorldClock {
    fn default() -> Self {
        Self { label: "NYC".into(), time_zone: "America/New_York".into() }
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "liquid-glass".into(),
            size: "medium".into(),
            position: "bottom".into(),
            monitor: None,
            taskbar_mode: "completely_hidden".into(),
            hide_on_fullscreen: true,
            auto_hide_dock: false,
            simulation: false,
            do_not_disturb: false,
            // « Lancer au démarrage de Windows » is on for a fresh install.
            launch_at_login: true,
            accent: "#0A84FF".into(),
            language: "fr".into(),
            glass_frost_level: DEFAULT_FROST_LEVEL,
            clear_mode: false,
            music_ambiance: false,
            dock_radius: 22.0,
            glass_refraction: 1.0,
            schema: SCHEMA,
            pomodoro_focus_minutes: 25,
            pomodoro_break_minutes: 5,
            world_clocks: vec![
                WorldClock { label: "NYC".into(), time_zone: "America/New_York".into() },
                WorldClock { label: "LDN".into(), time_zone: "Europe/London".into() },
                WorldClock { label: "TYO".into(), time_zone: "Asia/Tokyo".into() },
            ],
            automations: Automations::default(),
            providers: ProviderConfig::default(),
            prayer: PrayerConfig::default(),
        }
    }
}

impl Settings {
    pub fn load(db: &Db) -> Settings {
        let Some(json) = db.kv_get("settings") else { return Settings::default() };
        let (settings, migrated) = Settings::parse(&json);
        if migrated {
            let _ = settings.save(db);
        }
        settings
    }

    /// Parse a stored document, upgrading older revisions. Returns `(settings, changed)`.
    pub fn parse(json: &str) -> (Settings, bool) {
        let Ok(mut settings) = serde_json::from_str::<Settings>(json) else { return (Settings::default(), false) };
        // `#[serde(default)]` fills a missing `schema` with the current one, so read it raw.
        let raw = serde_json::from_str::<serde_json::Value>(json).ok();
        let stored = raw.as_ref().and_then(|v| v.get("schema").and_then(|s| s.as_u64())).unwrap_or(1) as u32;
        let migrated = stored < SCHEMA;
        if stored < 2 && settings.taskbar_mode == "auto_hide" {
            // Revision 2: an auto-hidden Windows 11 taskbar still pops up over the dock when the
            // cursor touches the screen edge, so the old default becomes "completely hidden".
            // "native" (explicit choice, or set by the emergency hotkey) is left alone.
            settings.taskbar_mode = "completely_hidden".into();
        }
        if stored < 3 && settings.automations.pre_meeting_pause.minutes == 5 {
            // Revision 3: media pauses 2 minutes before a meeting (the old default was 5). A value
            // the user picked themselves is kept.
            settings.automations.pre_meeting_pause.minutes = 2;
        }
        if stored < 4 {
            // Revision 4: the 3-stop frost picker became the continuous « Clair ↔ Givré » slider, and
            // the CSS-only "ios-glass" theme gave way to the shader's Matte Liquid Glass.
            let frost = raw.as_ref().and_then(|v| v.get("glassFrost").and_then(|f| f.as_str()));
            settings.glass_frost_level = match frost {
                Some("subtle") => 0.25,
                Some("deep") => 0.9,
                _ => 0.5,
            };
            if settings.theme == "ios-glass" {
                settings.theme = "matte-glass".into();
            }
        }
        if stored < 5 && settings.glass_frost_level == 0.5 {
            // Revision 5: the default glass got clearer (0.5 -> 0.32). A level the user picked is kept.
            settings.glass_frost_level = DEFAULT_FROST_LEVEL;
        }
        settings.glass_frost_level = if settings.glass_frost_level.is_finite() { settings.glass_frost_level.clamp(0.0, 1.0) } else { DEFAULT_FROST_LEVEL };
        settings.dock_radius = if settings.dock_radius.is_finite() { settings.dock_radius.clamp(8.0, 34.0) } else { 22.0 };
        settings.glass_refraction = if settings.glass_refraction.is_finite() { settings.glass_refraction.clamp(0.5, 2.0) } else { 1.0 };
        settings.schema = SCHEMA;
        (settings, migrated)
    }

    pub fn save(&self, db: &Db) -> Result<(), String> {
        let json = serde_json::to_string(self).map_err(|e| e.to_string())?;
        db.kv_set("settings", &json).map_err(|e| e.to_string())
    }

    /// The liquid-glass backdrop is captured only while the bar itself is drawn: Mode Clear removes it.
    pub fn uses_glass_capture(&self) -> bool {
        matches!(self.theme.as_str(), "liquid-glass" | "matte-glass") && !self.clear_mode
    }

    /// Dock bar height in logical pixels for the size preset.
    pub fn dock_height(&self) -> f64 {
        match self.size.as_str() {
            "compact" => 46.0,
            "large" => 70.0,
            _ => 58.0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Settings;

    #[test]
    fn first_launch_is_french_matte_live_glass_with_hidden_taskbar() {
        let s = Settings::default();
        assert_eq!(s.language, "fr");
        assert_eq!(s.theme, "liquid-glass");
        assert_eq!(s.glass_frost_level, 0.32);
        assert!(s.launch_at_login);
        assert_eq!(s.taskbar_mode, "completely_hidden");
        assert_eq!(s.position, "bottom");
    }

    #[test]
    fn documents_from_v1_gain_the_new_defaults() {
        let v1 = r#"{"theme":"midnight","size":"large","position":"top","taskbarMode":"native"}"#;
        let s: Settings = serde_json::from_str(v1).expect("v1 settings parse");
        assert_eq!(s.theme, "midnight");
        assert_eq!(s.dock_height(), 70.0);
        assert_eq!(s.language, "fr");
        assert_eq!(s.glass_frost_level, 0.32);
    }

    #[test]
    fn old_auto_hide_default_migrates_to_completely_hidden_once() {
        let (s, changed) = Settings::parse(r#"{"theme":"liquid-glass","taskbarMode":"auto_hide"}"#);
        assert!(changed);
        assert_eq!(s.taskbar_mode, "completely_hidden");
        // An explicit "native" (e.g. after the emergency hotkey) is never overridden.
        let (s, _) = Settings::parse(r#"{"taskbarMode":"native"}"#);
        assert_eq!(s.taskbar_mode, "native");
        // A current document keeps whatever the user picked, including auto-hide.
        let current = serde_json::to_string(&Settings { taskbar_mode: "auto_hide".into(), ..Settings::default() }).unwrap();
        let (s, changed) = Settings::parse(&current);
        assert!(!changed);
        assert_eq!(s.taskbar_mode, "auto_hide");
    }

    #[test]
    fn meeting_pause_moves_to_two_minutes_and_ai_warnings_gain_a_critical_level() {
        let (s, changed) = Settings::parse(r#"{"schema":2,"automations":{"preMeetingPause":{"enabled":true,"minutes":5}}}"#);
        assert!(changed);
        assert_eq!(s.automations.pre_meeting_pause.minutes, 2);
        assert_eq!(s.automations.ai_limit_warning.threshold_percent, 85.0);
        assert_eq!(s.automations.ai_limit_warning.critical_percent, 95.0);
        // A custom lead time survives.
        let (s, _) = Settings::parse(r#"{"schema":2,"automations":{"preMeetingPause":{"enabled":true,"minutes":10}}}"#);
        assert_eq!(s.automations.pre_meeting_pause.minutes, 10);
        assert_eq!(Settings::default().automations.pre_meeting_pause.minutes, 2);
    }

    #[test]
    fn size_presets_map_to_dock_heights() {
        let mut s = Settings::default();
        for (size, height) in [("compact", 46.0), ("medium", 58.0), ("large", 70.0)] {
            s.size = size.into();
            assert_eq!(s.dock_height(), height);
        }
    }

    #[test]
    fn language_round_trips_in_camel_case() {
        let mut s = Settings::default();
        s.language = "en".into();
        s.glass_frost_level = 0.75;
        let json = serde_json::to_string(&s).expect("serialize");
        assert!(json.contains(r#""language":"en""#) && json.contains(r#""glassFrostLevel":0.75"#));
        let back: Settings = serde_json::from_str(&json).expect("parse");
        assert_eq!((back.language.as_str(), back.glass_frost_level), ("en", 0.75));
    }

    #[test]
    fn frost_presets_become_slider_levels_and_ios_glass_becomes_matte() {
        for (frost, level) in [("subtle", 0.25), ("balanced", 0.32), ("deep", 0.9)] {
            let (s, changed) = Settings::parse(&format!(r#"{{"schema":3,"theme":"ios-glass","glassFrost":"{frost}"}}"#));
            assert!(changed);
            assert_eq!((s.theme.as_str(), s.glass_frost_level), ("matte-glass", level));
            assert!(s.uses_glass_capture());
        }
        // v0.4.0's untouched 0.5 default becomes the clearer 0.32; a picked level stays.
        let (s, changed) = Settings::parse(r#"{"schema":4,"glassFrostLevel":0.5,"launchAtLogin":false}"#);
        assert!(changed);
        assert_eq!(s.glass_frost_level, 0.32);
        assert!(!s.launch_at_login, "an existing install keeps its autostart choice");
        let (s, _) = Settings::parse(r#"{"schema":4,"glassFrostLevel":0.7}"#);
        assert_eq!(s.glass_frost_level, 0.7);
        // A current document keeps its level (clamped) and theme.
        let (s, changed) = Settings::parse(r#"{"schema":5,"theme":"midnight","glassFrostLevel":3.0}"#);
        assert!(!changed);
        assert_eq!((s.theme.as_str(), s.glass_frost_level), ("midnight", 1.0));
        assert!(!s.uses_glass_capture());
    }
}
