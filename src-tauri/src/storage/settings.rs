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

/// Current settings document revision.
pub const SCHEMA: u32 = 3;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub theme: String,
    pub size: String,
    pub position: String,
    pub monitor: Option<String>,
    pub taskbar_mode: String,
    pub hide_on_fullscreen: bool,
    pub simulation: bool,
    pub do_not_disturb: bool,
    pub launch_at_login: bool,
    pub accent: String,
    /// UI language: "fr" (default) | "en".
    pub language: String,
    /// Liquid-glass frost intensity: "subtle" | "balanced" (default) | "deep".
    pub glass_frost: String,
    /// Liquid-glass backdrop source: "live" (default, desktop duplication) | "wallpaper".
    pub glass_backdrop: String,
    /// Settings document revision, see `Settings::parse`.
    pub schema: u32,
    pub pomodoro_focus_minutes: u32,
    pub pomodoro_break_minutes: u32,
    pub world_clocks: Vec<WorldClock>,
    pub automations: Automations,
    pub providers: ProviderConfig,
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
            simulation: false,
            do_not_disturb: false,
            launch_at_login: false,
            accent: "#0A84FF".into(),
            language: "fr".into(),
            glass_frost: "balanced".into(),
            glass_backdrop: "live".into(),
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
        let stored = serde_json::from_str::<serde_json::Value>(json)
            .ok()
            .and_then(|v| v.get("schema").and_then(|s| s.as_u64()))
            .unwrap_or(1) as u32;
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
        settings.schema = SCHEMA;
        (settings, migrated)
    }

    pub fn save(&self, db: &Db) -> Result<(), String> {
        let json = serde_json::to_string(self).map_err(|e| e.to_string())?;
        db.kv_set("settings", &json).map_err(|e| e.to_string())
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
        assert_eq!(s.glass_frost, "balanced");
        assert_eq!(s.taskbar_mode, "completely_hidden");
        assert_eq!(s.glass_backdrop, "live");
        assert_eq!(s.position, "bottom");
    }

    #[test]
    fn documents_from_v1_gain_the_new_defaults() {
        let v1 = r#"{"theme":"midnight","size":"large","position":"top","taskbarMode":"native"}"#;
        let s: Settings = serde_json::from_str(v1).expect("v1 settings parse");
        assert_eq!(s.theme, "midnight");
        assert_eq!(s.dock_height(), 70.0);
        assert_eq!(s.language, "fr");
        assert_eq!(s.glass_frost, "balanced");
    }

    #[test]
    fn old_auto_hide_default_migrates_to_completely_hidden_once() {
        let (s, changed) = Settings::parse(r#"{"theme":"liquid-glass","taskbarMode":"auto_hide"}"#);
        assert!(changed);
        assert_eq!(s.taskbar_mode, "completely_hidden");
        assert_eq!(s.glass_backdrop, "live");
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
        s.glass_frost = "deep".into();
        let json = serde_json::to_string(&s).expect("serialize");
        assert!(json.contains(r#""language":"en""#) && json.contains(r#""glassFrost":"deep""#));
        let back: Settings = serde_json::from_str(&json).expect("parse");
        assert_eq!((back.language.as_str(), back.glass_frost.as_str()), ("en", "deep"));
    }
}
