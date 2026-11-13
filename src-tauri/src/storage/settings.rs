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
        Self { enabled: true, minutes: 5 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AiLimitRule {
    pub enabled: bool,
    pub threshold_percent: f64,
    pub horizon_hours: f64,
}
impl Default for AiLimitRule {
    fn default() -> Self {
        Self { enabled: true, threshold_percent: 85.0, horizon_hours: 24.0 }
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
            taskbar_mode: "auto_hide".into(),
            hide_on_fullscreen: true,
            simulation: false,
            do_not_disturb: false,
            launch_at_login: false,
            accent: "#0A84FF".into(),
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
        db.kv_get("settings")
            .and_then(|json| serde_json::from_str::<Settings>(&json).ok())
            .unwrap_or_default()
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
