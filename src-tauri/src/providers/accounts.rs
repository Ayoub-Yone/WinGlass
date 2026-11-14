//! One-click AI account sign-in and local CLI credential auto-detection.
//!
//! lumabar never runs its own OAuth client. "Se connecter avec …" opens the provider's official
//! CLI login (`claude auth login`, `codex login`, `gemini`) in a console; the browser flow writes
//! the CLI's credential file, which lumabar watches and then reads:
//!
//! * Claude Code — `%USERPROFILE%\.claude\.credentials.json` (`claudeAiOauth.accessToken`). When the
//!   access token is expired it is refreshed with the stored `refreshToken` exactly as Claude Code
//!   does, and the rotated tokens are written back atomically so Claude Code keeps working.
//! * Codex CLI — `%USERPROFILE%\.codex\auth.json` (`tokens.access_token`).
//! * Gemini CLI — `%USERPROFILE%\.gemini\oauth_creds.json` (`access_token`).
//!
//! Tokens stay in their files (owned by the CLIs) and in this process; only metrics leave it.

use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use chrono::Utc;
use once_cell::sync::Lazy;
use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};

use crate::AppState;
use crate::storage::secrets;
use crate::win32::apps_enum;

/// Claude Code's public OAuth client (from the CLI itself) and token endpoint.
const CLAUDE_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
/// Refresh this long before the access token actually expires.
const EXPIRY_SKEW_MS: i64 = 60_000;
/// How long a launched CLI login is watched for new credentials.
const LOGIN_WATCH: Duration = Duration::from_secs(10 * 60);

pub const LOGIN_PROVIDERS: &[&str] = &["claude", "chatgpt", "gemini"];

/// Serializes refreshes: two concurrent refreshes would burn the single-use refresh token.
static REFRESH_LOCK: Lazy<tokio::sync::Mutex<()>> = Lazy::new(|| tokio::sync::Mutex::new(()));

fn home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").map(PathBuf::from)
}

pub fn credentials_path(provider: &str) -> Option<PathBuf> {
    let rel = match provider {
        "claude" => ".claude\\.credentials.json",
        "chatgpt" => ".codex\\auth.json",
        "gemini" => ".gemini\\oauth_creds.json",
        _ => return None,
    };
    home().map(|h| h.join(rel))
}

fn read_json(path: &PathBuf) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

fn str_at<'a>(v: &'a Value, pointer: &str) -> Option<&'a str> {
    v.pointer(pointer).and_then(|x| x.as_str()).filter(|s| !s.is_empty())
}

/// Write next to the original, then rename over it: a crash never leaves a half-written file.
fn write_atomic(path: &PathBuf, value: &Value) -> Result<(), String> {
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.lumabar-tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("could not write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("could not replace {}: {e}", path.display())
    })
}

// ---------------------------------------------------------------------------------------------
// Claude Code credentials
// ---------------------------------------------------------------------------------------------

/// Usable access token from a parsed credentials file, if not (nearly) expired.
pub fn claude_valid_token(creds: &Value, now_ms: i64) -> Option<String> {
    let token = str_at(creds, "/claudeAiOauth/accessToken")?;
    let expires = creds.pointer("/claudeAiOauth/expiresAt").and_then(|v| v.as_i64()).unwrap_or(i64::MAX);
    (expires - EXPIRY_SKEW_MS > now_ms).then(|| token.to_string())
}

/// Merge a token-endpoint response into the credentials file, keeping every other field.
pub fn apply_claude_refresh(creds: &mut Value, response: &Value, now_ms: i64) -> Result<String, String> {
    let access = response.get("access_token").and_then(|v| v.as_str()).ok_or("token response has no access_token")?.to_string();
    let oauth = creds
        .get_mut("claudeAiOauth")
        .and_then(|o| o.as_object_mut())
        .ok_or("credentials file has no claudeAiOauth section")?;
    oauth.insert("accessToken".into(), json!(access));
    if let Some(refresh) = response.get("refresh_token").and_then(|v| v.as_str()) {
        oauth.insert("refreshToken".into(), json!(refresh));
    }
    if let Some(secs) = response.get("expires_in").and_then(|v| v.as_i64()) {
        oauth.insert("expiresAt".into(), json!(now_ms + secs * 1000));
    }
    Ok(access)
}

async fn refresh_claude(path: &PathBuf, client: &reqwest::Client, force: bool) -> Result<String, String> {
    let _guard = REFRESH_LOCK.lock().await;
    // Re-read under the lock: Claude Code (or a previous call) may have refreshed meanwhile.
    let mut creds = read_json(path).ok_or("Claude Code credentials are missing — sign in again")?;
    let now = Utc::now().timestamp_millis();
    if !force {
        if let Some(token) = claude_valid_token(&creds, now) {
            return Ok(token);
        }
    }
    let refresh = str_at(&creds, "/claudeAiOauth/refreshToken").ok_or("Claude Code session expired — use « Se connecter avec Claude »")?;
    let scopes = creds
        .pointer("/claudeAiOauth/scopes")
        .and_then(|s| s.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(" "))
        .unwrap_or_else(|| "user:inference user:profile".into());
    let resp = client
        .post(CLAUDE_TOKEN_URL)
        .json(&json!({ "grant_type": "refresh_token", "refresh_token": refresh, "client_id": CLAUDE_CLIENT_ID, "scope": scopes }))
        .send()
        .await
        .map_err(|e| format!("network error: {e}"))?;
    let status = resp.status();
    let body: Value = resp.json().await.map_err(|e| format!("invalid token response: {e}"))?;
    if !status.is_success() {
        return Err(format!("Claude token refresh failed (HTTP {}) — use « Se connecter avec Claude »", status.as_u16()));
    }
    let token = apply_claude_refresh(&mut creds, &body, Utc::now().timestamp_millis())?;
    write_atomic(path, &creds)?;
    Ok(token)
}

/// Claude Code's OAuth access token, refreshed when expired. `Ok(None)` = not signed in.
pub async fn claude_cli_token(client: &reqwest::Client, force_refresh: bool) -> Result<Option<String>, String> {
    let Some(path) = credentials_path("claude") else { return Ok(None) };
    let Some(creds) = read_json(&path) else { return Ok(None) };
    if !force_refresh {
        if let Some(token) = claude_valid_token(&creds, Utc::now().timestamp_millis()) {
            return Ok(Some(token));
        }
    }
    refresh_claude(&path, client, force_refresh).await.map(Some)
}

// ---------------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    pub provider: String,
    pub connected: bool,
    /// "cli" (local CLI credentials), "manual" (a pasted secret) or "none".
    pub source: &'static str,
    pub cli_installed: bool,
    /// Plan / account hint shown next to « Connecté » (never a token).
    pub detail: Option<String>,
}

/// Do the CLI credentials carry something that can authenticate (or be refreshed)?
pub fn cli_signed_in(provider: &str, creds: &Value) -> bool {
    match provider {
        "claude" => str_at(creds, "/claudeAiOauth/refreshToken").is_some() || str_at(creds, "/claudeAiOauth/accessToken").is_some(),
        "chatgpt" => str_at(creds, "/tokens/access_token").is_some(),
        "gemini" => str_at(creds, "/refresh_token").is_some() || str_at(creds, "/access_token").is_some(),
        _ => false,
    }
}

const MANUAL_SECRETS: &[(&str, &[&str])] = &[
    ("claude", &["claude_oauth_token", "claude_session_key"]),
    ("chatgpt", &["chatgpt_access_token"]),
    ("gemini", &["gemini_oauth_token"]),
];

pub fn status(app: &AppHandle, provider: &str) -> AccountStatus {
    let state = app.state::<AppState>();
    let use_cli = state.settings.read().providers.use_local_cli_credentials;
    let creds = credentials_path(provider).and_then(|p| read_json(&p));
    let cli = use_cli && creds.as_ref().is_some_and(|c| cli_signed_in(provider, c));
    let names = secrets::names(&state.db);
    let manual = MANUAL_SECRETS
        .iter()
        .find(|(p, _)| *p == provider)
        .is_some_and(|(_, keys)| keys.iter().any(|k| names.iter().any(|n| n == k)));
    let detail = creds.as_ref().and_then(|c| match provider {
        "claude" => str_at(c, "/claudeAiOauth/subscriptionType").map(|s| format!("Claude {s}")),
        "chatgpt" => str_at(c, "/auth_mode").map(|s| s.to_string()),
        _ => None,
    });
    AccountStatus {
        provider: provider.to_string(),
        connected: cli || manual,
        source: if manual { "manual" } else if cli { "cli" } else { "none" },
        cli_installed: find_cli(provider).is_some(),
        detail: if cli { detail } else { None },
    }
}

// ---------------------------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------------------------

/// Look for an executable on PATH (plus a couple of per-user install dirs).
fn which(names: &[&str]) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    if let Some(h) = home() {
        dirs.push(h.join(".local\\bin"));
    }
    if let Some(ad) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(ad).join("npm"));
    }
    dirs.iter().flat_map(|d| names.iter().map(move |n| d.join(n))).find(|p| p.is_file())
}

fn find_cli(provider: &str) -> Option<PathBuf> {
    match provider {
        "claude" => which(&["claude.exe", "claude.cmd"]),
        "chatgpt" => which(&["codex.exe", "codex.cmd"]),
        "gemini" => which(&["gemini.exe", "gemini.cmd"]),
        _ => None,
    }
}

/// Command line run in the login console: the installed CLI, or its official npm package via npx.
pub fn login_command(provider: &str, cli: Option<&PathBuf>, has_npx: bool) -> Option<String> {
    let (args, package) = match provider {
        "claude" => ("auth login", "@anthropic-ai/claude-code"),
        "chatgpt" => ("login", "@openai/codex"),
        // The Gemini CLI signs in on first launch ("Login with Google").
        "gemini" => ("", "@google/gemini-cli"),
        _ => return None,
    };
    let base = match cli {
        Some(path) => format!("\"{}\"", path.display()),
        None if has_npx => format!("npx -y {package}"),
        None => return None,
    };
    Some(if args.is_empty() { base } else { format!("{base} {args}") })
}

fn modified(path: &PathBuf) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// Open the provider's CLI login in a console and watch its credential file. Emits
/// `account:connected` (and refreshes the provider) once new credentials land.
pub fn start_login(app: &AppHandle, provider: &str) -> Result<(), String> {
    if !LOGIN_PROVIDERS.contains(&provider) {
        return Err(format!("no sign-in flow for '{provider}'"));
    }
    let path = credentials_path(provider).ok_or("USERPROFILE is not set")?;
    let has_npx = which(&["npx.cmd", "npx.exe"]).is_some();
    let command = login_command(provider, find_cli(provider).as_ref(), has_npx)
        .ok_or("CLI introuvable : installez Node.js (npx) ou la CLI officielle du fournisseur")?;
    let title = match provider {
        "claude" => "lumabar - Claude",
        "chatgpt" => "lumabar - ChatGPT",
        _ => "lumabar - Gemini",
    };
    apps_enum::shell_open("cmd.exe", Some(&format!("/k title {title} & {command}")))?;

    let baseline = modified(&path);
    let app = app.clone();
    let provider = provider.to_string();
    tauri::async_runtime::spawn(async move {
        let started = std::time::Instant::now();
        while started.elapsed() < LOGIN_WATCH {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let now = modified(&path);
            if now.is_none() || now == baseline {
                continue;
            }
            let Some(creds) = read_json(&path) else { continue };
            if !cli_signed_in(&provider, &creds) {
                continue;
            }
            enable_local_cli(&app);
            super::api_poller::refresh(&app, &provider).await;
            let _ = app.emit("account:connected", status(&app, &provider));
            return;
        }
    });
    Ok(())
}

/// Signing in through a CLI implies reading its credentials.
fn enable_local_cli(app: &AppHandle) {
    let state = app.state::<AppState>();
    let settings = {
        let mut s = state.settings.write();
        if s.providers.use_local_cli_credentials {
            return;
        }
        s.providers.use_local_cli_credentials = true;
        let _ = s.save(&state.db);
        s.clone()
    };
    let _ = app.emit("settings:changed", &settings);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn creds(expires_at: i64) -> Value {
        json!({ "claudeAiOauth": {
            "accessToken": "old-access", "refreshToken": "old-refresh", "expiresAt": expires_at,
            "scopes": ["user:inference", "user:profile"], "subscriptionType": "max", "rateLimitTier": "default_claude_max_20x"
        }})
    }

    #[test]
    fn valid_tokens_are_used_until_shortly_before_expiry() {
        let now = 1_700_000_000_000;
        assert_eq!(claude_valid_token(&creds(now + 3_600_000), now).as_deref(), Some("old-access"));
        assert_eq!(claude_valid_token(&creds(now + 30_000), now), None, "inside the refresh skew");
        assert_eq!(claude_valid_token(&creds(now - 1), now), None);
        assert_eq!(claude_valid_token(&json!({}), now), None);
    }

    #[test]
    fn refresh_response_rotates_tokens_and_keeps_other_fields() {
        let now = 1_700_000_000_000;
        let mut c = creds(now - 1);
        let token = apply_claude_refresh(&mut c, &json!({ "access_token": "new-access", "refresh_token": "new-refresh", "expires_in": 28800 }), now).unwrap();
        assert_eq!(token, "new-access");
        assert_eq!(c.pointer("/claudeAiOauth/accessToken").unwrap(), "new-access");
        assert_eq!(c.pointer("/claudeAiOauth/refreshToken").unwrap(), "new-refresh");
        assert_eq!(c.pointer("/claudeAiOauth/expiresAt").unwrap().as_i64(), Some(now + 28_800_000));
        assert_eq!(c.pointer("/claudeAiOauth/subscriptionType").unwrap(), "max");
        assert_eq!(c.pointer("/claudeAiOauth/scopes/1").unwrap(), "user:profile");
        // A response without a rotated refresh token keeps the old one.
        let mut c2 = creds(now - 1);
        apply_claude_refresh(&mut c2, &json!({ "access_token": "a2", "expires_in": 60 }), now).unwrap();
        assert_eq!(c2.pointer("/claudeAiOauth/refreshToken").unwrap(), "old-refresh");
        assert!(apply_claude_refresh(&mut json!({}), &json!({ "access_token": "x" }), now).is_err());
        assert!(apply_claude_refresh(&mut creds(0), &json!({ "error": "invalid_grant" }), now).is_err());
    }

    #[test]
    fn atomic_write_replaces_the_file() {
        let dir = std::env::temp_dir().join(format!("lumabar-accounts-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".credentials.json");
        std::fs::write(&path, "{}").unwrap();
        write_atomic(&path, &creds(5)).unwrap();
        assert_eq!(read_json(&path).unwrap(), creds(5));
        assert!(!path.with_extension("json.lumabar-tmp").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sign_in_detection_per_cli_format() {
        assert!(cli_signed_in("claude", &creds(0)));
        assert!(cli_signed_in("chatgpt", &json!({ "tokens": { "access_token": "a" } })));
        assert!(!cli_signed_in("chatgpt", &json!({ "OPENAI_API_KEY": null })));
        assert!(cli_signed_in("gemini", &json!({ "refresh_token": "r" })));
        assert!(!cli_signed_in("gemini", &json!({ "access_token": "" })));
        assert!(!cli_signed_in("grok", &json!({ "access_token": "a" })));
    }

    #[test]
    fn login_commands_use_the_official_clis() {
        let exe = PathBuf::from(r"C:\Users\me\.local\bin\claude.exe");
        assert_eq!(login_command("claude", Some(&exe), false).unwrap(), r#""C:\Users\me\.local\bin\claude.exe" auth login"#);
        assert_eq!(login_command("chatgpt", None, true).unwrap(), "npx -y @openai/codex login");
        assert_eq!(login_command("gemini", None, true).unwrap(), "npx -y @google/gemini-cli");
        assert!(login_command("chatgpt", None, false).is_none());
        assert!(login_command("stripe", None, true).is_none());
    }
}
