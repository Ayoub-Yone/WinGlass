//! Secret store: values are DPAPI-encrypted, base64-encoded, and kept in the `secrets` table.
//! Plaintext never leaves the Rust process (the frontend only learns which names are set).

use base64::Engine;
use base64::engine::general_purpose::STANDARD;

use super::db::Db;
use crate::win32::dpapi;

/// Names the settings UI is allowed to write. Anything else is rejected.
pub const KNOWN_SECRETS: &[&str] = &[
    "claude_session_key",
    "claude_oauth_token",
    "chatgpt_access_token",
    "chatgpt_account_id",
    "gemini_oauth_token",
    "gemini_project_id",
    "xai_management_key",
    "xai_team_id",
    "deepseek_api_key",
    "glm_api_key",
    "stripe_api_key",
    "polar_access_token",
    "dodo_api_key",
    "datafast_api_key",
    "github_token",
    "gmail_oauth_token",
    "gmail_app_password",
    "x_bearer_token",
    "youtube_api_key",
    "instagram_access_token",
    "api_counter_token",
    "ics_urls",
];

pub fn set(db: &Db, name: &str, value: &str) -> Result<(), String> {
    if !KNOWN_SECRETS.contains(&name) {
        return Err(format!("unknown secret '{name}'"));
    }
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return db.delete_secret(name).map_err(|e| e.to_string());
    }
    let encrypted = dpapi::protect(trimmed.as_bytes())?;
    db.put_secret_blob(name, &STANDARD.encode(encrypted)).map_err(|e| e.to_string())
}

pub fn get(db: &Db, name: &str) -> Option<String> {
    let blob = db.get_secret_blob(name)?;
    let bytes = STANDARD.decode(blob).ok()?;
    let plain = dpapi::unprotect(&bytes).ok()?;
    String::from_utf8(plain).ok().filter(|s| !s.is_empty())
}

pub fn names(db: &Db) -> Vec<String> {
    db.secret_names().unwrap_or_default()
}
