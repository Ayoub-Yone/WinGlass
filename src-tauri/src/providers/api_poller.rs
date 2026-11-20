//! HTTPS providers: AI usage limits, revenue, mail/social counters, developer stats, weather and
//! calendar. Every provider returns a `ProviderResult` with status
//! `unconfigured | ok | error | simulated`, so widgets always have a clean state to render.
//!
//! Secrets are read through DPAPI only inside this process; nothing but the parsed metrics is
//! sent to the webviews.

use std::collections::HashMap;
use std::time::Duration;

use chrono::{DateTime, Datelike, Duration as ChronoDuration, Local, NaiveDate, TimeZone, Timelike, Utc};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use reqwest::{Client, RequestBuilder};
use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};

use super::{accounts, ical_parser, prayer_times};
use crate::AppState;
use crate::storage::secrets;
use crate::storage::settings::Settings;

pub const PROVIDERS: &[&str] = &[
    "claude", "chatgpt", "gemini", "grok", "deepseek", "glm", "stripe", "polar", "dodo", "datafast", "gmail", "x",
    "youtube", "instagram", "github", "leetcode", "api_counter", "weather", "calendar", "prayer",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderResult {
    pub id: String,
    pub status: String,
    pub data: Option<Value>,
    pub error: Option<String>,
    pub fetched_at: i64,
}

impl ProviderResult {
    fn new(id: &str, status: &str, data: Option<Value>, error: Option<String>) -> Self {
        Self { id: id.into(), status: status.into(), data, error, fetched_at: Utc::now().timestamp_millis() }
    }
}

enum Outcome {
    Unconfigured(String),
    Data(Value),
}

type R<T> = Result<T, String>;

static CACHE: Lazy<Mutex<HashMap<String, ProviderResult>>> = Lazy::new(|| Mutex::new(HashMap::new()));
pub(crate) static CLIENT: Lazy<Client> = Lazy::new(|| {
    Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent(concat!("WinGlass/", env!("CARGO_PKG_VERSION"), " (Windows)"))
        .build()
        .expect("build HTTP client")
});

pub fn snapshot() -> Vec<ProviderResult> {
    CACHE.lock().values().cloned().collect()
}

struct Ctx {
    app: AppHandle,
    settings: Settings,
}

impl Ctx {
    fn secret(&self, name: &str) -> Option<String> {
        secrets::get(&self.app.state::<AppState>().db, name)
    }
    fn kv_get(&self, key: &str) -> Option<String> {
        self.app.state::<AppState>().db.kv_get(key)
    }
    fn kv_set(&self, key: &str, value: &str) {
        let _ = self.app.state::<AppState>().db.kv_set(key, value);
    }
}

// ---------------------------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------------------------

async fn send_json(req: RequestBuilder) -> R<Value> {
    let resp = req.send().await.map_err(|e| format!("network error: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let snippet: String = text.chars().take(160).collect();
        return Err(format!("HTTP {}: {}", status.as_u16(), snippet.trim()));
    }
    serde_json::from_str(&text).map_err(|e| format!("invalid JSON: {e}"))
}

fn num(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn path<'a>(v: &'a Value, p: &str) -> Option<&'a Value> {
    let mut cur = v;
    for seg in p.trim_start_matches('/').split(['.', '/']).filter(|s| !s.is_empty()) {
        cur = match cur {
            Value::Array(arr) => arr.get(seg.parse::<usize>().ok()?)?,
            Value::Object(map) => map.get(seg)?,
            _ => return None,
        };
    }
    Some(cur)
}

fn home_file(rel: &str) -> Option<Value> {
    let home = std::env::var_os("USERPROFILE")?;
    let text = std::fs::read_to_string(std::path::PathBuf::from(home).join(rel)).ok()?;
    serde_json::from_str(&text).ok()
}

fn tier(key: &str, label: &str, percent: f64, resets_at: Option<String>, window_seconds: Option<f64>) -> Value {
    json!({
        "key": key,
        "label": label,
        "percent": percent.clamp(0.0, 100.0),
        "resetsAt": resets_at,
        "windowSeconds": window_seconds,
    })
}

fn epoch_to_iso(secs: f64) -> Option<String> {
    Utc.timestamp_opt(secs as i64, 0).single().map(|d| d.to_rfc3339())
}

// ---------------------------------------------------------------------------------------------
// AI usage
// ---------------------------------------------------------------------------------------------

fn parse_claude_usage(v: &Value) -> Value {
    let mut tiers = Vec::new();
    for (key, label) in [("five_hour", "Session"), ("seven_day", "Weekly"), ("seven_day_opus", "Opus")] {
        if let Some(t) = v.get(key).filter(|t| !t.is_null()) {
            let pct = t.get("utilization").and_then(num).unwrap_or(0.0);
            let resets = t.get("resets_at").and_then(|r| r.as_str()).map(String::from);
            let window = if key == "five_hour" { 5.0 * 3600.0 } else { 7.0 * 86400.0 };
            tiers.push(tier(key, label, pct, resets, Some(window)));
        } else if key == "seven_day_opus" {
            tiers.push(tier(key, label, 0.0, None, Some(7.0 * 86400.0)));
        }
    }
    json!({ "provider": "Claude", "plan": Value::Null, "tiers": tiers })
}

async fn claude_oauth_usage(token: &str) -> R<Value> {
    send_json(
        CLIENT
            .get("https://api.anthropic.com/api/oauth/usage")
            .bearer_auth(token)
            .header("anthropic-beta", "oauth-2025-04-20"),
    )
    .await
}

async fn fetch_claude(ctx: &Ctx) -> R<Outcome> {
    if let Some(token) = ctx.secret("claude_oauth_token") {
        return Ok(Outcome::Data(parse_claude_usage(&claude_oauth_usage(&token).await?)));
    }
    if ctx.settings.providers.use_local_cli_credentials {
        // Claude Code's own sign-in (~/.claude/.credentials.json), refreshed when expired.
        if let Some(token) = accounts::claude_cli_token(&CLIENT, false).await? {
            let usage = match claude_oauth_usage(&token).await {
                // Revoked early (e.g. signed in elsewhere): rotate once and retry.
                Err(err) if err.starts_with("HTTP 401") => {
                    let fresh = accounts::claude_cli_token(&CLIENT, true).await?.ok_or(err)?;
                    claude_oauth_usage(&fresh).await?
                }
                other => other?,
            };
            return Ok(Outcome::Data(parse_claude_usage(&usage)));
        }
    }
    let Some(session) = ctx.secret("claude_session_key") else {
        return Ok(Outcome::Unconfigured("Sign in with Claude (or add a session key / OAuth token) in Settings › Accounts".into()));
    };
    let cookie = format!("sessionKey={session}");
    let orgs = send_json(CLIENT.get("https://claude.ai/api/organizations").header("Cookie", &cookie)).await?;
    let list = orgs.as_array().ok_or("unexpected organizations response")?;
    let org = list
        .iter()
        .find(|o| {
            o.get("capabilities")
                .and_then(|c| c.as_array())
                .map(|caps| caps.iter().any(|c| c.as_str() == Some("chat")))
                .unwrap_or(false)
        })
        .or_else(|| list.first())
        .and_then(|o| o.get("uuid"))
        .and_then(|u| u.as_str())
        .ok_or("no Claude organization found for this session")?;
    let usage = send_json(
        CLIENT.get(format!("https://claude.ai/api/organizations/{org}/usage")).header("Cookie", &cookie),
    )
    .await?;
    Ok(Outcome::Data(parse_claude_usage(&usage)))
}

async fn fetch_chatgpt(ctx: &Ctx) -> R<Outcome> {
    let mut token = ctx.secret("chatgpt_access_token");
    let mut account = ctx.secret("chatgpt_account_id");
    if token.is_none() && ctx.settings.providers.use_local_cli_credentials {
        if let Some(auth) = home_file(".codex\\auth.json") {
            token = path(&auth, "tokens.access_token").and_then(|v| v.as_str()).map(String::from);
            account = account.or_else(|| path(&auth, "tokens.account_id").and_then(|v| v.as_str()).map(String::from));
        }
    }
    let Some(token) = token else {
        return Ok(Outcome::Unconfigured("Sign in with ChatGPT (or add an access token) in Settings › Accounts".into()));
    };
    let mut req = CLIENT.get("https://chatgpt.com/backend-api/wham/usage").bearer_auth(token);
    if let Some(account) = account {
        req = req.header("ChatGPT-Account-Id", account);
    }
    let v = send_json(req).await?;
    let mut tiers = Vec::new();
    for key in ["primary_window", "secondary_window"] {
        let Some(w) = path(&v, &format!("rate_limit.{key}")).filter(|w| !w.is_null()) else { continue };
        let pct = w.get("used_percent").and_then(num).unwrap_or(0.0);
        let window = w.get("limit_window_seconds").and_then(num);
        let reset = w
            .get("reset_at")
            .and_then(num)
            .and_then(epoch_to_iso)
            .or_else(|| {
                w.get("reset_after_seconds")
                    .and_then(num)
                    .map(|s| (Utc::now() + ChronoDuration::seconds(s as i64)).to_rfc3339())
            });
        let label = match window {
            Some(s) if s >= 6.0 * 86400.0 => "Weekly",
            Some(s) if s <= 6.0 * 3600.0 => "5h",
            _ if key == "primary_window" => "5h",
            _ => "Weekly",
        };
        tiers.push(tier(key, label, pct, reset, window));
    }
    if tiers.is_empty() {
        return Err("usage response contained no rate-limit windows".into());
    }
    let plan = v.get("plan_type").and_then(|p| p.as_str()).map(String::from);
    Ok(Outcome::Data(json!({ "provider": "ChatGPT", "plan": plan, "tiers": tiers })))
}

async fn fetch_gemini(ctx: &Ctx) -> R<Outcome> {
    let mut token = ctx.secret("gemini_oauth_token");
    if token.is_none() && ctx.settings.providers.use_local_cli_credentials {
        if let Some(creds) = home_file(".gemini\\oauth_creds.json") {
            let expiry_ms = creds.get("expiry_date").and_then(num).unwrap_or(f64::MAX);
            if expiry_ms < Utc::now().timestamp_millis() as f64 {
                return Err("Gemini CLI token expired — run `gemini` once to refresh it".into());
            }
            token = creds.get("access_token").and_then(|t| t.as_str()).map(String::from);
        }
    }
    let Some(token) = token else {
        return Ok(Outcome::Unconfigured("Sign in with Gemini (or add an OAuth token) in Settings › Accounts".into()));
    };
    let mut project = ctx.secret("gemini_project_id");
    if project.is_none() {
        let load = send_json(
            CLIENT
                .post("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist")
                .bearer_auth(&token)
                .json(&json!({ "metadata": { "ideType": "IDE_UNSPECIFIED", "platform": "PLATFORM_UNSPECIFIED", "pluginType": "GEMINI" } })),
        )
        .await?;
        project = load.get("cloudaicompanionProject").and_then(|p| p.as_str()).map(String::from);
    }
    let body = match &project {
        Some(p) => json!({ "project": p }),
        None => json!({}),
    };
    let v = send_json(
        CLIENT.post("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota").bearer_auth(&token).json(&body),
    )
    .await?;
    let buckets = v.get("buckets").and_then(|b| b.as_array()).cloned().unwrap_or_default();
    let mut best: HashMap<&str, (f64, Option<String>)> = HashMap::new();
    for b in &buckets {
        let model = b.get("modelId").and_then(|m| m.as_str()).unwrap_or("").to_ascii_lowercase();
        let family = if model.contains("pro") {
            "pro"
        } else if model.contains("flash") {
            "flash"
        } else {
            continue;
        };
        let remaining = b.get("remainingFraction").and_then(num).unwrap_or(1.0);
        let used = (1.0 - remaining) * 100.0;
        let reset = b.get("resetTime").and_then(|r| r.as_str()).map(String::from);
        let entry = best.entry(family).or_insert((used, reset.clone()));
        if used > entry.0 {
            *entry = (used, reset);
        }
    }
    if best.is_empty() {
        return Err("quota response contained no Pro/Flash buckets".into());
    }
    let mut tiers = Vec::new();
    for (key, label) in [("pro", "Pro"), ("flash", "Flash")] {
        if let Some((used, reset)) = best.get(key) {
            tiers.push(tier(key, label, *used, reset.clone(), Some(86400.0)));
        }
    }
    Ok(Outcome::Data(json!({ "provider": "Gemini", "plan": Value::Null, "tiers": tiers })))
}

/// Balance-style providers: usage% = spent / budget, where spent = budget - remaining balance.
fn balance_tiers(provider: &str, remaining: f64, budget: f64, currency: &str) -> Value {
    let used_pct = if budget > 0.0 { ((budget - remaining) / budget * 100.0).clamp(0.0, 100.0) } else { 0.0 };
    json!({
        "provider": provider,
        "plan": Value::Null,
        "tiers": [ tier("credits", "Credits", used_pct, None, None) ],
        "balance": remaining,
        "budget": budget,
        "currency": currency,
    })
}

async fn fetch_grok(ctx: &Ctx) -> R<Outcome> {
    let (Some(key), Some(team)) = (ctx.secret("xai_management_key"), ctx.secret("xai_team_id")) else {
        return Ok(Outcome::Unconfigured("Add an xAI management key and team id".into()));
    };
    let v = send_json(
        CLIENT.get(format!("https://management-api.x.ai/v1/billing/teams/{team}/prepaid/balance")).bearer_auth(key),
    )
    .await?;
    // Balance is reported in cents; prepaid credit appears as a negative running total.
    let cents = path(&v, "total.val").and_then(num).or_else(|| v.get("total").and_then(num)).ok_or("no balance in response")?;
    let remaining = cents.abs() / 100.0;
    Ok(Outcome::Data(balance_tiers("Grok", remaining, ctx.settings.providers.grok_budget, "USD")))
}

async fn fetch_deepseek(ctx: &Ctx) -> R<Outcome> {
    let Some(key) = ctx.secret("deepseek_api_key") else {
        return Ok(Outcome::Unconfigured("Add a DeepSeek API key".into()));
    };
    let v = send_json(CLIENT.get("https://api.deepseek.com/user/balance").bearer_auth(key)).await?;
    let info = path(&v, "balance_infos.0").ok_or("no balance info")?;
    let remaining = info.get("total_balance").and_then(num).unwrap_or(0.0);
    let currency = info.get("currency").and_then(|c| c.as_str()).unwrap_or("USD").to_string();
    Ok(Outcome::Data(balance_tiers("DeepSeek", remaining, ctx.settings.providers.deepseek_budget, &currency)))
}

async fn fetch_glm(ctx: &Ctx) -> R<Outcome> {
    let Some(key) = ctx.secret("glm_api_key") else {
        return Ok(Outcome::Unconfigured("Add a Z.ai (GLM Coding Plan) API key".into()));
    };
    let url = "https://api.z.ai/api/monitor/usage/quota/limit";
    // The monitor endpoint accepts the raw key; fall back to Bearer for accounts that require it.
    let v = match send_json(CLIENT.get(url).header("Authorization", &key)).await {
        Ok(v) => v,
        Err(_) => send_json(CLIENT.get(url).bearer_auth(&key)).await?,
    };
    let limits = path(&v, "data.limits").and_then(|l| l.as_array()).cloned().unwrap_or_default();
    let mut tiers = Vec::new();
    for l in &limits {
        let kind = l.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let pct = l.get("percentage").and_then(num).unwrap_or(0.0);
        let reset = l.get("nextResetTime").and_then(num).filter(|ms| *ms > 0.0).and_then(|ms| epoch_to_iso(ms / 1000.0));
        match kind {
            "TOKENS_LIMIT" => tiers.push(tier("tokens", "5h", pct, reset, Some(5.0 * 3600.0))),
            "TIME_LIMIT" => tiers.push(tier("mcp", "MCP", pct, reset, None)),
            _ => {}
        }
    }
    if tiers.is_empty() {
        return Err(v.get("msg").and_then(|m| m.as_str()).unwrap_or("no quota limits in response").to_string());
    }
    let plan = path(&v, "data.level").and_then(|l| l.as_str()).map(String::from);
    Ok(Outcome::Data(json!({ "provider": "GLM", "plan": plan, "tiers": tiers })))
}

// ---------------------------------------------------------------------------------------------
// Revenue
// ---------------------------------------------------------------------------------------------

const ZERO_DECIMAL: &[&str] = &["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"];

/// 60 daily buckets ending today (index 59 = today), in major units.
struct Buckets {
    daily: [f64; 60],
    today: NaiveDate,
}

impl Buckets {
    fn new() -> Self {
        Self { daily: [0.0; 60], today: Local::now().date_naive() }
    }
    fn add(&mut self, at: DateTime<Utc>, amount: f64) {
        let day = at.with_timezone(&Local).date_naive();
        let age = (self.today - day).num_days();
        if (0..60).contains(&age) {
            self.daily[(59 - age) as usize] += amount;
        }
    }
    fn into_value(self, provider: &str, currency: &str, net30: Option<f64>, goal: f64) -> Value {
        let current: f64 = self.daily[30..].iter().sum();
        let previous: f64 = self.daily[..30].iter().sum();
        let delta = if previous.abs() > f64::EPSILON { (current - previous) / previous.abs() * 100.0 } else { 0.0 };
        json!({
            "provider": provider,
            "currency": currency.to_uppercase(),
            "total30d": current,
            "previous30d": previous,
            "net30d": net30.unwrap_or(current),
            "deltaPercent": delta,
            "daily": self.daily[30..].to_vec(),
            "goal": goal,
        })
    }
}

fn since_60d() -> DateTime<Utc> {
    let start = Local::now().date_naive() - ChronoDuration::days(59);
    Local
        .from_local_datetime(&start.and_hms_opt(0, 0, 0).unwrap_or_default())
        .earliest()
        .map(|d| d.with_timezone(&Utc))
        .unwrap_or_else(|| Utc::now() - ChronoDuration::days(60))
}

async fn fetch_stripe(ctx: &Ctx) -> R<Outcome> {
    let Some(key) = ctx.secret("stripe_api_key") else {
        return Ok(Outcome::Unconfigured("Add a Stripe restricted (read-only) key".into()));
    };
    let since = since_60d();
    let cutoff_30 = Utc::now() - ChronoDuration::days(30);
    let mut buckets = Buckets::new();
    let mut currency: Option<String> = None;
    let mut net30 = 0.0;
    let mut starting_after: Option<String> = None;
    for _ in 0..50 {
        let mut query: Vec<(&str, String)> = vec![("limit", "100".into()), ("created[gte]", since.timestamp().to_string())];
        if let Some(cursor) = &starting_after {
            query.push(("starting_after", cursor.clone()));
        }
        let page = send_json(CLIENT.get("https://api.stripe.com/v1/balance_transactions").bearer_auth(&key).query(&query)).await?;
        let items = page.get("data").and_then(|d| d.as_array()).cloned().unwrap_or_default();
        for tx in &items {
            let kind = tx.get("type").and_then(|t| t.as_str()).unwrap_or("");
            if !matches!(kind, "charge" | "payment" | "refund" | "payment_refund") {
                continue;
            }
            let cur = tx.get("currency").and_then(|c| c.as_str()).unwrap_or("usd").to_string();
            if currency.is_none() {
                currency = Some(cur.clone());
            }
            if currency.as_deref() != Some(cur.as_str()) {
                continue;
            }
            let divisor = if ZERO_DECIMAL.contains(&cur.as_str()) { 1.0 } else { 100.0 };
            let amount = tx.get("amount").and_then(num).unwrap_or(0.0) / divisor;
            let net = tx.get("net").and_then(num).unwrap_or(0.0) / divisor;
            let created = tx.get("created").and_then(num).unwrap_or(0.0) as i64;
            if let Some(at) = Utc.timestamp_opt(created, 0).single() {
                buckets.add(at, amount);
                if at >= cutoff_30 {
                    net30 += net;
                }
            }
        }
        let has_more = page.get("has_more").and_then(|h| h.as_bool()).unwrap_or(false);
        starting_after = items.last().and_then(|t| t.get("id")).and_then(|i| i.as_str()).map(String::from);
        if !has_more || starting_after.is_none() {
            break;
        }
    }
    Ok(Outcome::Data(buckets.into_value("Stripe", currency.as_deref().unwrap_or("usd"), Some(net30), ctx.settings.providers.revenue_goal)))
}

async fn fetch_polar(ctx: &Ctx) -> R<Outcome> {
    let Some(token) = ctx.secret("polar_access_token") else {
        return Ok(Outcome::Unconfigured("Add a Polar organization access token".into()));
    };
    let today = Local::now().date_naive();
    let start = today - ChronoDuration::days(59);
    let v = send_json(CLIENT.get("https://api.polar.sh/v1/metrics/").bearer_auth(token).query(&[
        ("start_date", start.format("%Y-%m-%d").to_string()),
        ("end_date", today.format("%Y-%m-%d").to_string()),
        ("interval", "day".to_string()),
        ("timezone", local_iana_zone()),
    ]))
    .await?;
    let periods = v.get("periods").and_then(|p| p.as_array()).cloned().unwrap_or_default();
    let mut buckets = Buckets::new();
    let mut net30 = 0.0;
    let cutoff = today - ChronoDuration::days(29);
    for p in &periods {
        let Some(ts) = p.get("timestamp").and_then(|t| t.as_str()).and_then(|t| DateTime::parse_from_rfc3339(t).ok()) else {
            continue;
        };
        // Polar reports currency amounts in cents.
        let revenue = p.get("revenue").and_then(num).unwrap_or(0.0) / 100.0;
        let net = p.get("net_revenue").and_then(num).map(|n| n / 100.0).unwrap_or(revenue);
        let day = ts.date_naive();
        let age = (today - day).num_days();
        if (0..60).contains(&age) {
            buckets.daily[(59 - age) as usize] += revenue;
        }
        if day >= cutoff {
            net30 += net;
        }
    }
    Ok(Outcome::Data(buckets.into_value("Polar", "usd", Some(net30), ctx.settings.providers.revenue_goal)))
}

async fn fetch_dodo(ctx: &Ctx) -> R<Outcome> {
    let Some(key) = ctx.secret("dodo_api_key") else {
        return Ok(Outcome::Unconfigured("Add a Dodo Payments API key".into()));
    };
    let since = since_60d().to_rfc3339();
    let mut buckets = Buckets::new();
    let mut currency: Option<String> = None;
    for page_number in 0..40 {
        let v = send_json(CLIENT.get("https://live.dodopayments.com/payments").bearer_auth(&key).query(&[
            ("created_at_gte", since.clone()),
            ("page_size", "100".to_string()),
            ("page_number", page_number.to_string()),
            ("status", "succeeded".to_string()),
        ]))
        .await?;
        let items = v.get("items").and_then(|i| i.as_array()).cloned().unwrap_or_default();
        for p in &items {
            let cur = p.get("currency").and_then(|c| c.as_str()).unwrap_or("USD").to_ascii_lowercase();
            if currency.is_none() {
                currency = Some(cur.clone());
            }
            if currency.as_deref() != Some(cur.as_str()) {
                continue;
            }
            let divisor = if ZERO_DECIMAL.contains(&cur.as_str()) { 1.0 } else { 100.0 };
            let amount = p.get("total_amount").and_then(num).unwrap_or(0.0) / divisor;
            if let Some(at) = p.get("created_at").and_then(|c| c.as_str()).and_then(|c| DateTime::parse_from_rfc3339(c).ok()) {
                buckets.add(at.with_timezone(&Utc), amount);
            }
        }
        if items.len() < 100 {
            break;
        }
    }
    Ok(Outcome::Data(buckets.into_value("Dodo Payments", currency.as_deref().unwrap_or("usd"), None, ctx.settings.providers.revenue_goal)))
}

async fn fetch_datafast(ctx: &Ctx) -> R<Outcome> {
    let Some(key) = ctx.secret("datafast_api_key") else {
        return Ok(Outcome::Unconfigured("Add a DataFast website API key (df_…)".into()));
    };
    let today = Local::now().date_naive();
    let start = today - ChronoDuration::days(59);
    let v = send_json(CLIENT.get("https://datafa.st/api/v1/analytics/timeseries").bearer_auth(key).query(&[
        ("fields", "revenue".to_string()),
        ("interval", "day".to_string()),
        ("startAt", start.format("%Y-%m-%d").to_string()),
        ("endAt", today.format("%Y-%m-%d").to_string()),
        ("limit", "100".to_string()),
        ("timezone", local_iana_zone()),
    ]))
    .await?;
    let currency = v.get("currency").and_then(|c| c.as_str()).unwrap_or("USD").to_string();
    let rows = v.get("data").and_then(|d| d.as_array()).cloned().unwrap_or_default();
    let mut buckets = Buckets::new();
    for row in &rows {
        let revenue = row.get("revenue").and_then(num).unwrap_or(0.0);
        let Some(ts) = row.get("timestamp").and_then(|t| t.as_str()) else { continue };
        let day = DateTime::parse_from_rfc3339(ts)
            .map(|d| d.date_naive())
            .or_else(|_| NaiveDate::parse_from_str(&ts[..10.min(ts.len())], "%Y-%m-%d"));
        if let Ok(day) = day {
            let age = (today - day).num_days();
            if (0..60).contains(&age) {
                buckets.daily[(59 - age) as usize] += revenue;
            }
        }
    }
    Ok(Outcome::Data(buckets.into_value("DataFast", &currency, None, ctx.settings.providers.revenue_goal)))
}

/// Best-effort IANA name for the local zone (chrono only knows the offset); falls back to UTC.
fn local_iana_zone() -> String {
    std::env::var("TZ").ok().filter(|z| z.parse::<chrono_tz::Tz>().is_ok()).unwrap_or_else(|| {
        let offset = Local::now().offset().local_minus_utc();
        if offset == 0 { "UTC".into() } else {
            // Etc/GMT zones have inverted signs and only whole hours.
            if offset % 3600 == 0 { format!("Etc/GMT{:+}", -offset / 3600) } else { "UTC".into() }
        }
    })
}

// ---------------------------------------------------------------------------------------------
// Mail & social
// ---------------------------------------------------------------------------------------------

/// Track the first value seen each local day to compute "+N today".
fn daily_delta(ctx: &Ctx, id: &str, value: f64) -> f64 {
    let key = format!("daily-first:{id}:{}", Local::now().format("%Y-%m-%d"));
    match ctx.kv_get(&key).and_then(|v| v.parse::<f64>().ok()) {
        Some(first) => value - first,
        None => {
            ctx.kv_set(&key, &value.to_string());
            0.0
        }
    }
}

fn local_midnight_epoch() -> i64 {
    let today = Local::now().date_naive();
    Local
        .from_local_datetime(&today.and_hms_opt(0, 0, 0).unwrap_or_default())
        .earliest()
        .map(|d| d.timestamp())
        .unwrap_or_else(|| Utc::now().timestamp() - 86400)
}

fn xml_tag<'a>(text: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text.find(&open)? + open.len();
    let end = text[start..].find(&close)? + start;
    Some(&text[start..end])
}

async fn fetch_gmail(ctx: &Ctx) -> R<Outcome> {
    if let Some(token) = ctx.secret("gmail_oauth_token") {
        let label = send_json(CLIENT.get("https://gmail.googleapis.com/gmail/v1/users/me/labels/INBOX").bearer_auth(&token)).await?;
        let unread = label.get("messagesUnread").and_then(num).unwrap_or(0.0);
        let today = send_json(
            CLIENT
                .get("https://gmail.googleapis.com/gmail/v1/users/me/messages")
                .bearer_auth(&token)
                .query(&[("q", format!("in:inbox after:{}", local_midnight_epoch())), ("maxResults", "500".into())]),
        )
        .await?;
        let today_count = today
            .get("messages")
            .and_then(|m| m.as_array())
            .map(|m| m.len() as f64)
            .or_else(|| today.get("resultSizeEstimate").and_then(num))
            .unwrap_or(0.0);
        return Ok(Outcome::Data(json!({ "unread": unread, "today": today_count, "account": ctx.settings.providers.gmail_address })));
    }
    let address = ctx.settings.providers.gmail_address.trim().to_string();
    let (Some(password), false) = (ctx.secret("gmail_app_password"), address.is_empty()) else {
        return Ok(Outcome::Unconfigured("Add a Gmail OAuth token, or your address + an app password".into()));
    };
    let resp = CLIENT
        .get("https://mail.google.com/mail/feed/atom")
        .basic_auth(&address, Some(password.replace(' ', "")))
        .send()
        .await
        .map_err(|e| format!("network error: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Gmail Atom feed returned HTTP {}", resp.status().as_u16()));
    }
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let unread = xml_tag(&text, "fullcount").and_then(|c| c.trim().parse::<f64>().ok()).unwrap_or(0.0);
    let midnight = local_midnight_epoch();
    let today_count = text
        .split("<entry>")
        .skip(1)
        .filter(|entry| {
            xml_tag(entry, "issued")
                .and_then(|d| DateTime::parse_from_rfc3339(d.trim()).ok())
                .map(|d| d.timestamp() >= midnight)
                .unwrap_or(false)
        })
        .count() as f64;
    Ok(Outcome::Data(json!({ "unread": unread, "today": today_count, "account": address })))
}

async fn fetch_x(ctx: &Ctx) -> R<Outcome> {
    let user = ctx.settings.providers.x_username.trim().trim_start_matches('@').to_string();
    let (Some(token), false) = (ctx.secret("x_bearer_token"), user.is_empty()) else {
        return Ok(Outcome::Unconfigured("Add an X API bearer token and your @handle".into()));
    };
    let v = send_json(
        CLIENT
            .get(format!("https://api.x.com/2/users/by/username/{user}"))
            .bearer_auth(token)
            .query(&[("user.fields", "public_metrics")]),
    )
    .await?;
    let followers = path(&v, "data.public_metrics.followers_count").and_then(num).ok_or("no follower count in response")?;
    let delta = daily_delta(ctx, "x", followers);
    Ok(Outcome::Data(json!({ "followers": followers, "deltaToday": delta, "handle": format!("@{user}"), "metric": "followers" })))
}

async fn fetch_youtube(ctx: &Ctx) -> R<Outcome> {
    let channel = ctx.settings.providers.youtube_channel_id.trim().to_string();
    let (Some(key), false) = (ctx.secret("youtube_api_key"), channel.is_empty()) else {
        return Ok(Outcome::Unconfigured("Add a YouTube Data API key and channel id / @handle".into()));
    };
    let (param, value) = if channel.starts_with('@') { ("forHandle", channel.clone()) } else { ("id", channel.clone()) };
    let v = send_json(
        CLIENT
            .get("https://www.googleapis.com/youtube/v3/channels")
            .query(&[("part", "statistics,snippet"), (param, value.as_str()), ("key", key.as_str())]),
    )
    .await?;
    let item = path(&v, "items.0").ok_or("channel not found")?;
    let subs = path(item, "statistics.subscriberCount").and_then(num).unwrap_or(0.0);
    let title = path(item, "snippet.title").and_then(|t| t.as_str()).unwrap_or(&channel).to_string();
    let delta = daily_delta(ctx, "youtube", subs);
    Ok(Outcome::Data(json!({ "followers": subs, "deltaToday": delta, "handle": title, "metric": "subscribers" })))
}

async fn fetch_instagram(ctx: &Ctx) -> R<Outcome> {
    let user = ctx.settings.providers.instagram_user_id.trim().to_string();
    let (Some(token), false) = (ctx.secret("instagram_access_token"), user.is_empty()) else {
        return Ok(Outcome::Unconfigured("Add an Instagram Graph API token and IG user id".into()));
    };
    let v = send_json(
        CLIENT
            .get(format!("https://graph.facebook.com/v21.0/{user}"))
            .query(&[("fields", "followers_count,username"), ("access_token", token.as_str())]),
    )
    .await?;
    let followers = v.get("followers_count").and_then(num).ok_or("no followers_count in response")?;
    let handle = v.get("username").and_then(|u| u.as_str()).map(|u| format!("@{u}")).unwrap_or(user);
    let delta = daily_delta(ctx, "instagram", followers);
    Ok(Outcome::Data(json!({ "followers": followers, "deltaToday": delta, "handle": handle, "metric": "followers" })))
}

// ---------------------------------------------------------------------------------------------
// Developer
// ---------------------------------------------------------------------------------------------

async fn fetch_github(ctx: &Ctx) -> R<Outcome> {
    let Some(token) = ctx.secret("github_token") else {
        return Ok(Outcome::Unconfigured("Add a GitHub token (read:user, notifications)".into()));
    };
    let username = ctx.settings.providers.github_username.trim().to_string();
    let query = if username.is_empty() {
        "query { viewer { login contributionsCollection { contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } } } } }".to_string()
    } else {
        format!(
            "query {{ user(login: \"{}\") {{ login contributionsCollection {{ contributionCalendar {{ totalContributions weeks {{ contributionDays {{ date contributionCount }} }} }} }} }} }}",
            username.replace('"', "")
        )
    };
    let v = send_json(CLIENT.post("https://api.github.com/graphql").bearer_auth(&token).json(&json!({ "query": query }))).await?;
    if let Some(err) = path(&v, "errors.0.message").and_then(|m| m.as_str()) {
        return Err(err.to_string());
    }
    let root = path(&v, "data.viewer").or_else(|| path(&v, "data.user")).ok_or("no GitHub user in response")?;
    let calendar = path(root, "contributionsCollection.contributionCalendar").ok_or("no contribution calendar")?;
    let weeks: Vec<Vec<f64>> = calendar
        .get("weeks")
        .and_then(|w| w.as_array())
        .map(|weeks| {
            weeks
                .iter()
                .map(|w| {
                    w.get("contributionDays")
                        .and_then(|d| d.as_array())
                        .map(|days| days.iter().map(|d| d.get("contributionCount").and_then(num).unwrap_or(0.0)).collect())
                        .unwrap_or_default()
                })
                .collect()
        })
        .unwrap_or_default();
    let weeks: Vec<Vec<f64>> = weeks.into_iter().rev().take(52).collect::<Vec<_>>().into_iter().rev().collect();
    let total = calendar.get("totalContributions").and_then(num).unwrap_or(0.0);

    let resp = CLIENT
        .get("https://api.github.com/notifications")
        .bearer_auth(&token)
        .header("Accept", "application/vnd.github+json")
        .query(&[("per_page", "50")])
        .send()
        .await
        .map_err(|e| format!("network error: {e}"))?;
    let more = resp.headers().get("link").and_then(|l| l.to_str().ok()).map(|l| l.contains("rel=\"next\"")).unwrap_or(false);
    let notifications = if resp.status().is_success() {
        resp.json::<Value>().await.ok().and_then(|n| n.as_array().map(|a| a.len())).unwrap_or(0)
    } else {
        0
    };
    let login = root.get("login").and_then(|l| l.as_str()).unwrap_or("");
    Ok(Outcome::Data(json!({ "login": login, "weeks": weeks, "total": total, "notifications": notifications, "notificationsMore": more })))
}

fn current_streak(calendar: &Value) -> u32 {
    let map: HashMap<String, f64> = match calendar {
        Value::String(s) => serde_json::from_str::<HashMap<String, Value>>(s)
            .map(|m| m.into_iter().filter_map(|(k, v)| num(&v).map(|n| (k, n))).collect())
            .unwrap_or_default(),
        Value::Object(o) => o.iter().filter_map(|(k, v)| num(v).map(|n| (k.clone(), n))).collect(),
        _ => HashMap::new(),
    };
    let active: std::collections::HashSet<NaiveDate> = map
        .iter()
        .filter(|(_, c)| **c > 0.0)
        .filter_map(|(k, _)| k.parse::<i64>().ok())
        .filter_map(|ts| Utc.timestamp_opt(ts, 0).single().map(|d| d.date_naive()))
        .collect();
    let mut day = Utc::now().date_naive();
    if !active.contains(&day) {
        day -= ChronoDuration::days(1);
    }
    let mut streak = 0;
    while active.contains(&day) {
        streak += 1;
        day -= ChronoDuration::days(1);
    }
    streak
}

async fn fetch_leetcode(ctx: &Ctx) -> R<Outcome> {
    let user = ctx.settings.providers.leetcode_username.trim().to_string();
    if user.is_empty() {
        return Ok(Outcome::Unconfigured("Set your LeetCode username".into()));
    }
    let query = "query userStats($username: String!) { matchedUser(username: $username) { submitStatsGlobal { acSubmissionNum { difficulty count } } userCalendar { streak totalActiveDays submissionCalendar } } }";
    let v = send_json(
        CLIENT
            .post("https://leetcode.com/graphql")
            .header("Referer", "https://leetcode.com")
            .json(&json!({ "query": query, "variables": { "username": user } })),
    )
    .await?;
    let matched = path(&v, "data.matchedUser").filter(|m| !m.is_null()).ok_or("LeetCode user not found")?;
    let mut counts: HashMap<String, f64> = HashMap::new();
    for item in path(matched, "submitStatsGlobal.acSubmissionNum").and_then(|a| a.as_array()).cloned().unwrap_or_default() {
        if let (Some(d), Some(c)) = (item.get("difficulty").and_then(|d| d.as_str()), item.get("count").and_then(num)) {
            counts.insert(d.to_string(), c);
        }
    }
    let streak = path(matched, "userCalendar.submissionCalendar").map(current_streak).unwrap_or(0);
    let max_streak = path(matched, "userCalendar.streak").and_then(num).unwrap_or(0.0);
    Ok(Outcome::Data(json!({
        "username": user,
        "solved": counts.get("All").copied().unwrap_or(0.0),
        "easy": counts.get("Easy").copied().unwrap_or(0.0),
        "medium": counts.get("Medium").copied().unwrap_or(0.0),
        "hard": counts.get("Hard").copied().unwrap_or(0.0),
        "streak": streak,
        "maxStreak": max_streak,
    })))
}

async fn fetch_api_counter(ctx: &Ctx) -> R<Outcome> {
    let url = ctx.settings.providers.api_counter_url.trim().to_string();
    if url.is_empty() {
        return Ok(Outcome::Unconfigured("Set a JSON endpoint URL for the API counter".into()));
    }
    if !url.starts_with("https://") && !url.starts_with("http://localhost") && !url.starts_with("http://127.0.0.1") {
        return Err("the API counter URL must be https:// (or localhost)".into());
    }
    let mut req = CLIENT.get(&url);
    if let Some(token) = ctx.secret("api_counter_token") {
        req = req.bearer_auth(token);
    }
    let resp = req.send().await.map_err(|e| format!("network error: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("HTTP {}", status.as_u16()));
    }
    let value = match serde_json::from_str::<Value>(&text) {
        Ok(json) => {
            let p = ctx.settings.providers.api_counter_json_path.trim();
            let target = if p.is_empty() { Some(&json) } else { path(&json, p) };
            target.and_then(num).ok_or_else(|| format!("no number at path '{p}'"))?
        }
        Err(_) => text.trim().parse::<f64>().map_err(|_| "response is neither JSON nor a number".to_string())?,
    };
    let delta = daily_delta(ctx, "api_counter", value);
    Ok(Outcome::Data(json!({ "value": value, "deltaToday": delta, "label": ctx.settings.providers.api_counter_label })))
}

// ---------------------------------------------------------------------------------------------
// Weather (Open-Meteo, no key) & calendar
// ---------------------------------------------------------------------------------------------

async fn fetch_weather(ctx: &Ctx) -> R<Outcome> {
    let p = &ctx.settings.providers;
    let unit = if p.weather_fahrenheit { "fahrenheit" } else { "celsius" };
    let v = send_json(CLIENT.get("https://api.open-meteo.com/v1/forecast").query(&[
        ("latitude", p.weather_latitude.to_string()),
        ("longitude", p.weather_longitude.to_string()),
        ("hourly", "temperature_2m,weather_code,precipitation_probability".to_string()),
        ("current", "temperature_2m,weather_code,is_day".to_string()),
        ("daily", "weather_code,temperature_2m_max,temperature_2m_min".to_string()),
        ("temperature_unit", unit.to_string()),
        ("timezone", "auto".to_string()),
        ("forecast_days", "7".to_string()),
    ]))
    .await?;
    let times = path(&v, "hourly.time").and_then(|t| t.as_array()).cloned().unwrap_or_default();
    let temps = path(&v, "hourly.temperature_2m").and_then(|t| t.as_array()).cloned().unwrap_or_default();
    let codes = path(&v, "hourly.weather_code").and_then(|t| t.as_array()).cloned().unwrap_or_default();
    let precip = path(&v, "hourly.precipitation_probability").and_then(|t| t.as_array()).cloned().unwrap_or_default();
    let now_local = path(&v, "current.time").and_then(|t| t.as_str()).unwrap_or("").to_string();
    let now_hour = now_local.get(..13).unwrap_or("");
    let start = times.iter().position(|t| t.as_str().map(|s| s.get(..13).unwrap_or("") >= now_hour).unwrap_or(false)).unwrap_or(0);
    let hourly: Vec<Value> = (start..(start + 12).min(times.len()))
        .map(|i| {
            json!({
                "time": times[i],
                "temp": temps.get(i).and_then(num),
                "code": codes.get(i).and_then(num),
                "precip": precip.get(i).and_then(num),
            })
        })
        .collect();
    let daily_times = path(&v, "daily.time").and_then(|t| t.as_array()).cloned().unwrap_or_default();
    let daily: Vec<Value> = daily_times
        .iter()
        .enumerate()
        .map(|(i, date)| {
            json!({
                "date": date,
                "code": path(&v, &format!("daily.weather_code.{i}")).and_then(num),
                "high": path(&v, &format!("daily.temperature_2m_max.{i}")).and_then(num),
                "low": path(&v, &format!("daily.temperature_2m_min.{i}")).and_then(num),
            })
        })
        .collect();
    Ok(Outcome::Data(json!({
        "city": p.weather_city,
        "unit": if p.weather_fahrenheit { "F" } else { "C" },
        "current": path(&v, "current.temperature_2m").and_then(num),
        "code": path(&v, "current.weather_code").and_then(num),
        "isDay": path(&v, "current.is_day").and_then(num).map(|d| d > 0.0).unwrap_or(true),
        "high": path(&v, "daily.temperature_2m_max.0").and_then(num),
        "low": path(&v, "daily.temperature_2m_min.0").and_then(num),
        "hourly": hourly,
        "daily": daily,
    })))
}

/// Open-Meteo geocoding (free, no key): city auto-complete for weather and prayer times.
pub async fn geocode(query: &str, language: &str) -> R<Vec<Value>> {
    let q = query.trim();
    if q.chars().count() < 2 {
        return Ok(Vec::new());
    }
    let lang = if language == "en" { "en" } else { "fr" };
    let v = send_json(CLIENT.get("https://geocoding-api.open-meteo.com/v1/search").query(&[
        ("name", q),
        ("count", "8"),
        ("language", lang),
        ("format", "json"),
    ]))
    .await?;
    Ok(v["results"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| {
            Some(json!({
                "name": r["name"].as_str()?,
                "country": r["country"].as_str().unwrap_or(""),
                "admin": r["admin1"].as_str().unwrap_or(""),
                "latitude": r["latitude"].as_f64()?,
                "longitude": r["longitude"].as_f64()?,
            }))
        })
        .collect())
}

const LOCAL_EVENTS_KEY: &str = "calendar_local_events";

/// Events added from the calendar flyout's quick-add bar (kept in SQLite, merged into every feed).
pub fn local_events(db: &crate::storage::db::Db) -> Vec<Value> {
    db.kv_get(LOCAL_EVENTS_KEY).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

pub fn save_local_events(db: &crate::storage::db::Db, events: &[Value]) -> R<()> {
    let json = serde_json::to_string(events).map_err(|e| e.to_string())?;
    db.kv_set(LOCAL_EVENTS_KEY, &json).map_err(|e| e.to_string())
}

async fn fetch_calendar(ctx: &Ctx) -> R<Outcome> {
    let local = local_events(&ctx.app.state::<AppState>().db);
    let Some(urls) = ctx.secret("ics_urls") else {
        if !local.is_empty() {
            return Ok(Outcome::Data(json!({ "events": local })));
        }
        return Ok(Outcome::Unconfigured("Add a private ICS / iCal feed URL in Settings › Calendar".into()));
    };
    let events = ical_parser::fetch_all(&CLIENT, &urls).await?;
    let mut events = serde_json::to_value(events).map_err(|e| e.to_string())?;
    if let Some(list) = events.as_array_mut() {
        list.extend(local);
    }
    Ok(Outcome::Data(json!({ "events": events })))
}

async fn fetch_prayer(ctx: &Ctx) -> R<Outcome> {
    let db = &ctx.app.state::<AppState>().db;
    match prayer_times::load(&CLIENT, db, &ctx.settings.prayer).await? {
        Some(data) => Ok(Outcome::Data(data)),
        None => Ok(Outcome::Unconfigured("Choose a Mawaqit mosque or a city".into())),
    }
}

// ---------------------------------------------------------------------------------------------
// Simulation (offline testing). Values drift with time so automations can be exercised.
// ---------------------------------------------------------------------------------------------

fn wave(period_secs: f64, phase: f64) -> f64 {
    let t = Utc::now().timestamp() as f64;
    ((t / period_secs) * std::f64::consts::TAU + phase).sin()
}

fn sim_reset(hours: i64) -> Option<String> {
    Some((Utc::now() + ChronoDuration::hours(hours)).with_minute(0).unwrap_or_else(Utc::now).to_rfc3339())
}

fn sim_revenue(provider: &str, base: f64, goal: f64) -> Value {
    let mut b = Buckets::new();
    let today = b.today;
    for i in 0..60 {
        let day = today - ChronoDuration::days(59 - i);
        let weekday_boost = if day.weekday().number_from_monday() <= 5 { 1.15 } else { 0.75 };
        let trend = if i >= 30 { 1.31 } else { 1.0 };
        let noise = ((i as f64 * 1.7).sin() + 1.2) / 2.2;
        b.daily[i as usize] = (base / 30.0) * weekday_boost * trend * (0.7 + 0.6 * noise) / 1.31;
    }
    // Nudge the 30-day total so it straddles the $3,000 milestone over time (rule 3 testing).
    let total: f64 = b.daily[30..].iter().sum();
    let target = base + 60.0 * wave(1800.0, 0.0);
    let scale = if total > 0.0 { target / total } else { 1.0 };
    for v in b.daily[30..].iter_mut() {
        *v *= scale;
    }
    b.into_value(provider, "usd", Some(target * 0.97), goal)
}

fn simulate(id: &str, settings: &Settings) -> Option<Value> {
    let goal = settings.providers.revenue_goal;
    Some(match id {
        "claude" => json!({ "provider": "Claude", "plan": "Max", "tiers": [
            tier("five_hour", "Session", 46.0 + 20.0 * wave(3600.0, 0.3), sim_reset(2), Some(18000.0)),
            tier("seven_day", "Weekly", 86.0 + 3.0 * wave(7200.0, 1.0), Some((Utc::now() + ChronoDuration::days(2)).to_rfc3339()), Some(604800.0)),
            tier("seven_day_opus", "Opus", 31.0 + 6.0 * wave(5400.0, 2.0), Some((Utc::now() + ChronoDuration::days(2)).to_rfc3339()), Some(604800.0)),
        ]}),
        "chatgpt" => json!({ "provider": "ChatGPT", "plan": "plus", "tiers": [
            tier("primary_window", "5h", 38.0 + 15.0 * wave(2400.0, 0.0), sim_reset(3), Some(18000.0)),
            tier("secondary_window", "Weekly", 54.0, Some((Utc::now() + ChronoDuration::days(4)).to_rfc3339()), Some(604800.0)),
        ]}),
        "gemini" => json!({ "provider": "Gemini", "plan": Value::Null, "tiers": [
            tier("pro", "Pro", 62.0 + 8.0 * wave(3000.0, 0.5), sim_reset(9), Some(86400.0)),
            tier("flash", "Flash", 18.0 + 5.0 * wave(3000.0, 1.5), sim_reset(9), Some(86400.0)),
        ]}),
        "grok" => balance_tiers("Grok", 21.4, settings.providers.grok_budget, "USD"),
        "deepseek" => balance_tiers("DeepSeek", 37.9, settings.providers.deepseek_budget, "USD"),
        "glm" => json!({ "provider": "GLM", "plan": "pro", "tiers": [
            tier("tokens", "5h", 24.0 + 10.0 * wave(2000.0, 0.0), sim_reset(4), Some(18000.0)),
            tier("mcp", "MCP", 12.0, Some((Utc::now() + ChronoDuration::days(12)).to_rfc3339()), None),
        ]}),
        "stripe" => sim_revenue("Stripe", 3012.0, goal),
        "polar" => sim_revenue("Polar", 8551.0, goal),
        "dodo" => sim_revenue("Dodo Payments", 1180.0, goal),
        "datafast" => sim_revenue("DataFast", 2980.0, goal),
        "gmail" => json!({ "unread": 4, "today": 9, "account": "you@example.com" }),
        "x" => json!({ "followers": 12480 + (wave(900.0, 0.0) * 8.0) as i64, "deltaToday": 37, "handle": "@winglass", "metric": "followers" }),
        "youtube" => json!({ "followers": 48210, "deltaToday": 112, "handle": "winglass", "metric": "subscribers" }),
        "instagram" => json!({ "followers": 9031, "deltaToday": 14, "handle": "@winglass", "metric": "followers" }),
        "github" => {
            let weeks: Vec<Vec<f64>> = (0..52)
                .map(|w| (0..7).map(|d| {
                    let x = ((w * 7 + d) as f64 * 12.9898).sin() * 43758.5453;
                    let r = x - x.floor();
                    if r < 0.28 { 0.0 } else { (r * 14.0).floor() }
                }).collect())
                .collect();
            let total: f64 = weeks.iter().flatten().sum();
            json!({ "login": "octocat", "weeks": weeks, "total": total, "notifications": 7, "notificationsMore": false })
        }
        "leetcode" => json!({ "username": "winglass", "solved": 412, "easy": 160, "medium": 210, "hard": 42, "streak": 14, "maxStreak": 61 }),
        "api_counter" => json!({ "value": 128400 + (Utc::now().timestamp() % 3600), "deltaToday": 2314, "label": settings.providers.api_counter_label }),
        "weather" => {
            let now = Local::now();
            let hourly: Vec<Value> = (0..12).map(|i| {
                let t = now + ChronoDuration::hours(i);
                json!({ "time": t.format("%Y-%m-%dT%H:00").to_string(), "temp": 36.0 - (i as f64 * 0.3).round(), "code": if i < 4 { 1 } else { 3 }, "precip": i * 5 })
            }).collect();
            let daily: Vec<Value> = (0..7).map(|i| {
                let d = now + ChronoDuration::days(i);
                let code = [1, 2, 3, 61, 1, 0, 2][i as usize];
                json!({ "date": d.format("%Y-%m-%d").to_string(), "code": code, "high": 38 - i % 3, "low": 29 - i % 2 })
            }).collect();
            json!({ "city": settings.providers.weather_city, "unit": if settings.providers.weather_fahrenheit { "F" } else { "C" }, "current": 36, "code": 1, "isDay": true, "high": 38, "low": 29, "hourly": hourly, "daily": daily })
        }
        "calendar" => {
            // Anchor the meeting to the current 20-minute block so it is always 0-20 minutes away.
            let now = Utc::now();
            let block = now.timestamp() / 1200;
            let meeting = Utc.timestamp_opt((block + 1) * 1200 - 120, 0).single().unwrap_or(now);
            let meeting = if meeting <= now { meeting + ChronoDuration::minutes(20) } else { meeting };
            let renewal = now + ChronoDuration::hours(20);
            let lunch = now + ChronoDuration::hours(3);
            json!({ "events": [
                { "uid": format!("sim-design-{block}"), "title": "Design review", "start": meeting.to_rfc3339(), "end": (meeting + ChronoDuration::minutes(30)).to_rfc3339(), "allDay": false, "location": "Zoom", "url": "https://calendar.google.com", "calendar": "Work" },
                { "uid": "sim-lunch", "title": "Lunch with Sam", "start": lunch.to_rfc3339(), "end": (lunch + ChronoDuration::hours(1)).to_rfc3339(), "allDay": false, "location": Value::Null, "url": Value::Null, "calendar": "Personal" },
                { "uid": "sim-renewal", "title": "Figma subscription renewal", "start": renewal.to_rfc3339(), "end": (renewal + ChronoDuration::minutes(15)).to_rfc3339(), "allDay": false, "location": Value::Null, "url": "https://www.figma.com/settings", "calendar": "Billing", "recurring": true },
            ]})
        }
        "prayer" => prayer_times::simulate(&settings.prayer),
        _ => return None,
    })
}

// ---------------------------------------------------------------------------------------------
// Dispatch & polling
// ---------------------------------------------------------------------------------------------

async fn fetch_one(ctx: &Ctx, id: &str) -> R<Outcome> {
    match id {
        "claude" => fetch_claude(ctx).await,
        "chatgpt" => fetch_chatgpt(ctx).await,
        "gemini" => fetch_gemini(ctx).await,
        "grok" => fetch_grok(ctx).await,
        "deepseek" => fetch_deepseek(ctx).await,
        "glm" => fetch_glm(ctx).await,
        "stripe" => fetch_stripe(ctx).await,
        "polar" => fetch_polar(ctx).await,
        "dodo" => fetch_dodo(ctx).await,
        "datafast" => fetch_datafast(ctx).await,
        "gmail" => fetch_gmail(ctx).await,
        "x" => fetch_x(ctx).await,
        "youtube" => fetch_youtube(ctx).await,
        "instagram" => fetch_instagram(ctx).await,
        "github" => fetch_github(ctx).await,
        "leetcode" => fetch_leetcode(ctx).await,
        "api_counter" => fetch_api_counter(ctx).await,
        "weather" => fetch_weather(ctx).await,
        "calendar" => fetch_calendar(ctx).await,
        "prayer" => fetch_prayer(ctx).await,
        other => Err(format!("unknown provider '{other}'")),
    }
}

const WEATHER_CACHE_KEY: &str = "weather_cache";

pub async fn refresh(app: &AppHandle, id: &str) -> ProviderResult {
    let settings = app.state::<AppState>().settings.read().clone();
    let result = if settings.simulation {
        match simulate(id, &settings) {
            Some(mut data) => {
                // Quick-added events show in simulation too.
                if let (true, Some(list)) = (id == "calendar", data["events"].as_array_mut()) {
                    list.extend(local_events(&app.state::<AppState>().db));
                }
                ProviderResult::new(id, "simulated", Some(data), None)
            }
            None => ProviderResult::new(id, "error", None, Some(format!("unknown provider '{id}'"))),
        }
    } else {
        let ctx = Ctx { app: app.clone(), settings };
        match fetch_one(&ctx, id).await {
            Ok(Outcome::Data(data)) => ProviderResult::new(id, "ok", Some(data), None),
            Ok(Outcome::Unconfigured(hint)) => ProviderResult::new(id, "unconfigured", None, Some(hint)),
            Err(err) => {
                // Keep showing the last good data alongside the error (weather: even after a
                // restart while offline, from SQLite).
                let previous = CACHE.lock().get(id).and_then(|p| p.data.clone()).or_else(|| {
                    (id == "weather").then(|| ctx.kv_get(WEATHER_CACHE_KEY)).flatten().and_then(|s| serde_json::from_str(&s).ok())
                });
                ProviderResult::new(id, "error", previous, Some(err))
            }
        }
    };
    if id == "weather" && result.status == "ok" {
        if let Some(data) = result.data.as_ref().and_then(|d| serde_json::to_string(d).ok()) {
            let _ = app.state::<AppState>().db.kv_set(WEATHER_CACHE_KEY, &data);
        }
    }
    CACHE.lock().insert(id.to_string(), result.clone());
    let _ = app.emit("provider:update", &result);
    result
}

/// Sequential on purpose: unconfigured providers return instantly, and serial requests keep
/// winglass a polite API citizen.
pub async fn refresh_all(app: &AppHandle) {
    for id in PROVIDERS {
        refresh(app, id).await;
    }
}

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut minute: u64 = 0;
        refresh_all(&app).await;
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            minute += 1;
            let (poll, simulation) = {
                let s = app.state::<AppState>().settings.read().clone();
                (s.providers.poll_minutes.max(1) as u64, s.simulation)
            };
            // Simulation refreshes every minute so drifting values exercise the automations.
            if simulation || minute % poll == 0 {
                refresh_all(&app).await;
            } else if minute % 30 == 0 {
                refresh(&app, "weather").await;
            }
        }
    });
}
