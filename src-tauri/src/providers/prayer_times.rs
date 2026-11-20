//! « Heures de prière »: a mosque's own Mawaqit timetable (its public page embeds the whole year as
//! `confData`, adhan + iqama) or an astronomical calculation from Aladhan by coordinates (free, no
//! key). The schedule is cached in SQLite (`kv.prayer_schedule`) so the widget and its
//! notifications keep working offline.

use std::collections::BTreeMap;

use chrono::{Duration as ChronoDuration, Local, NaiveDate, Utc};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::storage::db::Db;
use crate::storage::settings::PrayerConfig;

const CACHE_KEY: &str = "prayer_schedule";
/// A cached schedule is served without a request for this long (timetables change rarely).
const FRESH_SECS: i64 = 6 * 3600;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DayTimes {
    /// "HH:MM" local: fajr, sunrise, dhuhr, asr, maghrib, isha.
    pub times: Vec<String>,
    /// Mawaqit iqama for the 5 prayers: "+10" (minutes after the adhan) or "HH:MM".
    pub iqama: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    /// The config that produced it (see `config_key`).
    pub key: String,
    pub name: String,
    pub fetched_at: i64,
    /// "YYYY-MM-DD" (Aladhan) or "MM-DD" (Mawaqit's yearly timetable).
    pub days: BTreeMap<String, DayTimes>,
}

impl Schedule {
    pub fn day(&self, date: NaiveDate) -> Option<&DayTimes> {
        self.days
            .get(&date.format("%Y-%m-%d").to_string())
            .or_else(|| self.days.get(&date.format("%m-%d").to_string()))
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mosque {
    pub slug: String,
    pub name: String,
    pub location: String,
}

/// None while the widget is not set up.
pub fn config_key(cfg: &PrayerConfig) -> Option<String> {
    match cfg.source.as_str() {
        "mawaqit" if !cfg.mosque_slug.is_empty() => Some(format!("mawaqit:{}", cfg.mosque_slug)),
        "city" if cfg.latitude != 0.0 || cfg.longitude != 0.0 => {
            Some(format!("city:{:.4},{:.4}:{}", cfg.latitude, cfg.longitude, cfg.method))
        }
        _ => None,
    }
}

/// `https://mawaqit.net/fr/grande-mosquee-de-paris` (or the bare slug) -> `grande-mosquee-de-paris`.
pub fn mawaqit_slug(input: &str) -> Option<String> {
    let s = input.trim();
    let s = s.split(['?', '#']).next()?.trim_end_matches('/');
    let last = s.rsplit('/').next()?;
    let ok = !last.is_empty() && last.len() <= 120 && last.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    ok.then(|| last.to_ascii_lowercase())
}

fn is_hhmm(t: &str) -> bool {
    let b = t.as_bytes();
    b.len() == 5 && b[2] == b':' && b[..2].iter().chain(&b[3..]).all(u8::is_ascii_digit) && &t[..2] < "24" && &t[3..] < "60"
}

/// "06:05 (CET)" / " 06:05" -> "06:05"; anything else -> "".
fn clean_time(raw: &str) -> String {
    raw.trim().get(..5).filter(|t| is_hhmm(t)).unwrap_or("").to_string()
}

/// The `confData = {…};` object of a Mawaqit mosque page.
pub fn parse_conf_data(html: &str) -> Result<Value, String> {
    const MARK: &str = "confData = ";
    let start = html.find(MARK).ok_or("no timetable on this Mawaqit page")? + MARK.len();
    // The literal is plain JSON: let serde find where it ends.
    serde_json::Deserializer::from_str(&html[start..])
        .into_iter::<Value>()
        .next()
        .ok_or("empty Mawaqit timetable")?
        .map_err(|e| format!("unreadable Mawaqit timetable: {e}"))
}

/// Name + yearly timetable ("MM-DD" keys) from `confData`.
pub fn mawaqit_schedule(conf: &Value) -> Result<(String, BTreeMap<String, DayTimes>), String> {
    let name = conf["name"].as_str().unwrap_or("Mawaqit").trim().to_string();
    let calendar = conf["calendar"].as_array().ok_or("this mosque publishes no timetable")?;
    let iqama = conf["iqamaCalendar"].as_array();
    let mut days = BTreeMap::new();
    for (m, month) in calendar.iter().enumerate() {
        let Some(month) = month.as_object() else { continue };
        for (d, times) in month {
            let Ok(day) = d.parse::<u32>() else { continue };
            let times: Vec<String> = times.as_array().map(|a| a.iter().map(|t| clean_time(t.as_str().unwrap_or(""))).collect()).unwrap_or_default();
            if times.len() != 6 || times.iter().any(String::is_empty) {
                continue;
            }
            let iq = iqama
                .and_then(|i| i.get(m))
                .and_then(|month| month.get(d))
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.trim().to_string())).collect::<Vec<_>>())
                .filter(|v| v.len() == 5);
            days.insert(format!("{:02}-{:02}", m + 1, day), DayTimes { times, iqama: iq });
        }
    }
    if days.is_empty() { Err("this mosque publishes no timetable".into()) } else { Ok((name, days)) }
}

/// Aladhan `/v1/calendar` month -> "YYYY-MM-DD" days.
pub fn aladhan_days(v: &Value) -> BTreeMap<String, DayTimes> {
    let mut days = BTreeMap::new();
    for entry in v["data"].as_array().into_iter().flatten() {
        let Some(date) = entry["date"]["gregorian"]["date"].as_str() else { continue };
        let Ok(date) = NaiveDate::parse_from_str(date, "%d-%m-%Y") else { continue };
        let times: Vec<String> = ["Fajr", "Sunrise", "Dhuhr", "Asr", "Maghrib", "Isha"]
            .iter()
            .map(|k| clean_time(entry["timings"][k].as_str().unwrap_or("")))
            .collect();
        if times.iter().all(|t| !t.is_empty()) {
            days.insert(date.format("%Y-%m-%d").to_string(), DayTimes { times, iqama: None });
        }
    }
    days
}

async fn get_text(client: &Client, url: &str) -> Result<String, String> {
    let resp = client.get(url).send().await.map_err(|e| format!("network error: {e}"))?;
    let status = resp.status();
    if status.as_u16() == 404 {
        return Err("not found on Mawaqit".into());
    }
    if !status.is_success() {
        return Err(format!("HTTP {}", status.as_u16()));
    }
    resp.text().await.map_err(|e| e.to_string())
}

async fn fetch_mawaqit(client: &Client, slug: &str) -> Result<(String, BTreeMap<String, DayTimes>), String> {
    let html = get_text(client, &format!("https://mawaqit.net/fr/{slug}")).await?;
    mawaqit_schedule(&parse_conf_data(&html)?)
}

async fn fetch_aladhan(client: &Client, cfg: &PrayerConfig) -> Result<BTreeMap<String, DayTimes>, String> {
    let today = Local::now().date_naive();
    let next = today + ChronoDuration::days(32);
    let mut days = BTreeMap::new();
    for month in [today, next] {
        let url = format!(
            "https://api.aladhan.com/v1/calendar/{}/{}",
            month.format("%Y"),
            month.format("%-m")
        );
        let resp = client
            .get(url)
            .query(&[
                ("latitude", cfg.latitude.to_string()),
                ("longitude", cfg.longitude.to_string()),
                ("method", cfg.method.to_string()),
            ])
            .send()
            .await
            .map_err(|e| format!("network error: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("Aladhan HTTP {}", resp.status().as_u16()));
        }
        let v: Value = resp.json().await.map_err(|e| format!("invalid JSON: {e}"))?;
        days.extend(aladhan_days(&v));
    }
    if days.is_empty() { Err("Aladhan returned no timings".into()) } else { Ok(days) }
}

fn cached(db: &Db) -> Option<Schedule> {
    serde_json::from_str(&db.kv_get(CACHE_KEY)?).ok()
}

/// Today's and tomorrow's times for the widget. `Ok(None)` = not set up yet.
pub async fn load(client: &Client, db: &Db, cfg: &PrayerConfig) -> Result<Option<Value>, String> {
    let Some(key) = config_key(cfg) else { return Ok(None) };
    let today = Local::now().date_naive();
    let tomorrow = today + ChronoDuration::days(1);
    let cache = cached(db).filter(|c| c.key == key);
    let covers = |s: &Schedule| s.day(today).is_some() && s.day(tomorrow).is_some();

    let fresh = cache.as_ref().filter(|c| Utc::now().timestamp() - c.fetched_at < FRESH_SECS && covers(c));
    if let Some(schedule) = fresh {
        return Ok(Some(view(schedule, cfg, today, false)));
    }
    let fetched = match cfg.source.as_str() {
        "mawaqit" => fetch_mawaqit(client, &cfg.mosque_slug).await,
        _ => fetch_aladhan(client, cfg).await.map(|days| (cfg.city.clone(), days)),
    };
    match fetched {
        Ok((name, days)) => {
            let schedule = Schedule { key, name, fetched_at: Utc::now().timestamp(), days };
            if let Ok(json) = serde_json::to_string(&schedule) {
                let _ = db.kv_set(CACHE_KEY, &json);
            }
            Ok(Some(view(&schedule, cfg, today, false)))
        }
        // Offline: the cached timetable is still right for today.
        Err(err) => match cache.filter(|c| c.day(today).is_some()) {
            Some(schedule) => Ok(Some(view(&schedule, cfg, today, true))),
            None => Err(err),
        },
    }
}

fn view(schedule: &Schedule, cfg: &PrayerConfig, today: NaiveDate, offline: bool) -> Value {
    let days: Vec<Value> = [today, today + ChronoDuration::days(1)]
        .iter()
        .filter_map(|d| schedule.day(*d).map(|t| json!({ "date": d.format("%Y-%m-%d").to_string(), "times": t.times, "iqama": t.iqama })))
        .collect();
    let name = if schedule.name.is_empty() { cfg.mosque_name.clone() } else { schedule.name.clone() };
    json!({ "source": cfg.source, "name": name, "city": cfg.city, "method": cfg.method, "days": days, "offline": offline })
}

/// Same shape as `load`, around the clock so the countdown is always live (simulation mode).
pub fn simulate(cfg: &PrayerConfig) -> Value {
    let now = Local::now();
    let at = |mins: i64| (now + ChronoDuration::minutes(mins)).format("%H:%M").to_string();
    // Next prayer (Asr) 18 minutes away, the rest spread around it, never across midnight issues
    // for the countdown (tomorrow repeats today).
    let times = vec![at(-500), at(-410), at(-160), at(18), at(150), at(240)];
    let day = |d: NaiveDate| json!({ "date": d.format("%Y-%m-%d").to_string(), "times": times, "iqama": ["+20", "+10", "+10", "+5", "+10"] });
    let today = now.date_naive();
    let name = if cfg.mosque_name.is_empty() { "Mosquée (simulation)".to_string() } else { cfg.mosque_name.clone() };
    json!({ "source": "mawaqit", "name": name, "city": cfg.city, "method": cfg.method, "days": [day(today), day(today + ChronoDuration::days(1))], "offline": false })
}

/// Mosque search: Mawaqit's search API when it answers, else a pasted mosque link / slug.
pub async fn search(client: &Client, query: &str) -> Result<Vec<Mosque>, String> {
    let q = query.trim();
    if q.chars().count() < 2 {
        return Ok(Vec::new());
    }
    if !q.contains("mawaqit.net") {
        if let Ok(resp) = client.get("https://mawaqit.net/api/2.0/mosque/search").query(&[("word", q)]).send().await {
            if resp.status().is_success() {
                if let Ok(Value::Array(list)) = resp.json::<Value>().await {
                    return Ok(list
                        .iter()
                        .filter_map(|m| {
                            Some(Mosque {
                                slug: m["slug"].as_str()?.to_string(),
                                name: m["name"].as_str()?.trim().to_string(),
                                location: m["localisation"].as_str().or(m["label"].as_str()).unwrap_or("").trim().to_string(),
                            })
                        })
                        .take(12)
                        .collect());
                }
            }
        }
        if !q.contains('-') {
            return Err("mawaqit-search-locked".into());
        }
    }
    let slug = mawaqit_slug(q).ok_or("mawaqit-search-locked")?;
    let html = get_text(client, &format!("https://mawaqit.net/fr/{slug}")).await?;
    let conf = parse_conf_data(&html)?;
    let name = conf["name"].as_str().unwrap_or(&slug).trim().to_string();
    let location = conf["localisation"].as_str().or(conf["label"].as_str()).unwrap_or("").trim().to_string();
    Ok(vec![Mosque { slug, name, location }])
}

/// Today's timetable of one mosque (adhan + iqama).
pub async fn mawaqit_today(client: &Client, slug: &str) -> Result<Value, String> {
    let slug = mawaqit_slug(slug).ok_or("invalid Mawaqit mosque")?;
    let (name, days) = fetch_mawaqit(client, &slug).await?;
    let today = Local::now().date_naive();
    let key = today.format("%m-%d").to_string();
    let day = days.get(&key).ok_or("no timetable for today")?;
    Ok(json!({ "name": name, "date": today.format("%Y-%m-%d").to_string(), "times": day.times, "iqama": day.iqama }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_from_link_or_bare() {
        assert_eq!(mawaqit_slug("https://mawaqit.net/fr/grande-mosquee-de-paris").as_deref(), Some("grande-mosquee-de-paris"));
        assert_eq!(mawaqit_slug("mawaqit.net/en/Mosquee-X/?a=1").as_deref(), Some("mosquee-x"));
        assert_eq!(mawaqit_slug("bad slug!"), None);
    }

    #[test]
    fn times_are_cleaned() {
        assert_eq!(clean_time("06:05 (CET)"), "06:05");
        assert_eq!(clean_time("25:00"), "");
        assert_eq!(clean_time("6:5"), "");
    }

    #[test]
    fn conf_data_to_yearly_schedule() {
        let html = r#"<script>var x = 1; let confData = {"name":" Test ","calendar":[{"1":["06:29","08:07","12:41","14:43","17:08","18:35"],"2":["bad"]}],"iqamaCalendar":[{"1":["+8","+8","+8","+0","19:00"]}]};
        let other = {};</script>"#;
        let (name, days) = mawaqit_schedule(&parse_conf_data(html).unwrap()).unwrap();
        assert_eq!(name, "Test");
        assert_eq!(days.len(), 1);
        let day = &days["01-01"];
        assert_eq!(day.times[1], "08:07");
        assert_eq!(day.iqama.as_ref().unwrap()[4], "19:00");
        let schedule = Schedule { key: "k".into(), name, fetched_at: 0, days };
        assert!(schedule.day(NaiveDate::from_ymd_opt(2031, 1, 1).unwrap()).is_some());
    }

    #[test]
    fn aladhan_month() {
        let v = json!({ "data": [{ "timings": { "Fajr": "06:05 (CET)", "Sunrise": "07:15 (CET)", "Dhuhr": "12:13 (CET)", "Asr": "14:44 (CET)", "Maghrib": "17:09 (CET)", "Isha": "18:19 (CET)" }, "date": { "gregorian": { "date": "01-11-2026" } } }] });
        let days = aladhan_days(&v);
        assert_eq!(days["2026-11-01"].times, vec!["06:05", "07:15", "12:13", "14:44", "17:09", "18:19"]);
    }

    #[test]
    fn unconfigured_has_no_key() {
        assert_eq!(config_key(&PrayerConfig::default()), None);
        let cfg = PrayerConfig { source: "mawaqit".into(), mosque_slug: "m".into(), ..Default::default() };
        assert_eq!(config_key(&cfg).as_deref(), Some("mawaqit:m"));
    }
}
