//! HTTPS ICS / iCal feed fetcher & parser (Google Calendar, Outlook, iCloud private feeds).
//!
//! Supports DTSTART/DTEND with UTC, TZID (IANA + common Windows zone names), floating and
//! all-day values; RRULE expansion (DAILY / WEEKLY / MONTHLY / YEARLY with INTERVAL, COUNT,
//! UNTIL, BYDAY incl. ordinals, BYMONTHDAY); EXDATE; RECURRENCE-ID overrides; STATUS:CANCELLED.

use std::collections::{HashMap, HashSet};
use std::io::BufReader;

use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc, Weekday};
use ical::IcalParser;
use ical::property::Property;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    pub uid: String,
    pub title: String,
    pub start: String,
    pub end: String,
    pub all_day: bool,
    pub location: Option<String>,
    pub url: Option<String>,
    pub calendar: Option<String>,
}

#[derive(Debug, Clone, Copy)]
enum Zone {
    Utc,
    Named(chrono_tz::Tz),
    Local,
}

#[derive(Debug, Clone, Copy)]
struct EventTime {
    naive: NaiveDateTime,
    zone: Zone,
    all_day: bool,
}

impl EventTime {
    fn to_utc(self) -> DateTime<Utc> {
        match self.zone {
            Zone::Utc => Utc.from_utc_datetime(&self.naive),
            Zone::Named(tz) => tz
                .from_local_datetime(&self.naive)
                .earliest()
                .map(|d| d.with_timezone(&Utc))
                .unwrap_or_else(|| Utc.from_utc_datetime(&self.naive)),
            Zone::Local => Local
                .from_local_datetime(&self.naive)
                .earliest()
                .map(|d| d.with_timezone(&Utc))
                .unwrap_or_else(|| Utc.from_utc_datetime(&self.naive)),
        }
    }
    fn with_naive(self, naive: NaiveDateTime) -> EventTime {
        EventTime { naive, ..self }
    }
}

/// Windows zone names Outlook emits in TZID -> IANA.
fn windows_zone(name: &str) -> Option<&'static str> {
    Some(match name {
        "Pacific Standard Time" => "America/Los_Angeles",
        "Mountain Standard Time" => "America/Denver",
        "US Mountain Standard Time" => "America/Phoenix",
        "Central Standard Time" => "America/Chicago",
        "Eastern Standard Time" => "America/New_York",
        "Atlantic Standard Time" => "America/Halifax",
        "Alaskan Standard Time" => "America/Anchorage",
        "Hawaiian Standard Time" => "Pacific/Honolulu",
        "GMT Standard Time" => "Europe/London",
        "Greenwich Standard Time" => "Atlantic/Reykjavik",
        "W. Europe Standard Time" => "Europe/Berlin",
        "Romance Standard Time" => "Europe/Paris",
        "Central Europe Standard Time" => "Europe/Budapest",
        "Central European Standard Time" => "Europe/Warsaw",
        "E. Europe Standard Time" => "Europe/Chisinau",
        "FLE Standard Time" => "Europe/Kiev",
        "GTB Standard Time" => "Europe/Bucharest",
        "Russian Standard Time" => "Europe/Moscow",
        "Turkey Standard Time" => "Europe/Istanbul",
        "Israel Standard Time" => "Asia/Jerusalem",
        "Egypt Standard Time" => "Africa/Cairo",
        "South Africa Standard Time" => "Africa/Johannesburg",
        "Morocco Standard Time" => "Africa/Casablanca",
        "W. Central Africa Standard Time" => "Africa/Lagos",
        "Arabian Standard Time" => "Asia/Dubai",
        "Arab Standard Time" => "Asia/Riyadh",
        "India Standard Time" => "Asia/Kolkata",
        "Pakistan Standard Time" => "Asia/Karachi",
        "Bangladesh Standard Time" => "Asia/Dhaka",
        "SE Asia Standard Time" => "Asia/Bangkok",
        "China Standard Time" => "Asia/Shanghai",
        "Singapore Standard Time" => "Asia/Singapore",
        "Taipei Standard Time" => "Asia/Taipei",
        "Tokyo Standard Time" => "Asia/Tokyo",
        "Korea Standard Time" => "Asia/Seoul",
        "AUS Eastern Standard Time" => "Australia/Sydney",
        "E. Australia Standard Time" => "Australia/Brisbane",
        "Cen. Australia Standard Time" => "Australia/Adelaide",
        "W. Australia Standard Time" => "Australia/Perth",
        "New Zealand Standard Time" => "Pacific/Auckland",
        "SA Pacific Standard Time" => "America/Bogota",
        "Pacific SA Standard Time" => "America/Santiago",
        "E. South America Standard Time" => "America/Sao_Paulo",
        "Argentina Standard Time" => "America/Buenos_Aires",
        "Mexico Standard Time" | "Central Standard Time (Mexico)" => "America/Mexico_City",
        "Canada Central Standard Time" => "America/Regina",
        "UTC" | "Coordinated Universal Time" => "UTC",
        _ => return None,
    })
}

fn param<'a>(prop: &'a Property, name: &str) -> Option<&'a str> {
    prop.params.as_ref()?.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).and_then(|(_, v)| v.first()).map(|s| s.as_str())
}

fn zone_for(tzid: Option<&str>) -> Zone {
    let Some(raw) = tzid else { return Zone::Local };
    let id = raw.trim_matches('"').trim_start_matches('/');
    if let Ok(tz) = id.parse::<chrono_tz::Tz>() {
        return Zone::Named(tz);
    }
    if let Some(iana) = windows_zone(id) {
        if let Ok(tz) = iana.parse::<chrono_tz::Tz>() {
            return Zone::Named(tz);
        }
    }
    Zone::Local
}

fn parse_value(value: &str, tzid: Option<&str>, date_only_hint: bool) -> Option<EventTime> {
    let v = value.trim();
    if date_only_hint || v.len() == 8 {
        let date = NaiveDate::parse_from_str(&v[..8.min(v.len())], "%Y%m%d").ok()?;
        return Some(EventTime { naive: date.and_time(NaiveTime::MIN), zone: Zone::Local, all_day: true });
    }
    if let Some(stripped) = v.strip_suffix('Z') {
        let naive = NaiveDateTime::parse_from_str(stripped, "%Y%m%dT%H%M%S").ok()?;
        return Some(EventTime { naive, zone: Zone::Utc, all_day: false });
    }
    let naive = NaiveDateTime::parse_from_str(v, "%Y%m%dT%H%M%S")
        .or_else(|_| NaiveDateTime::parse_from_str(v, "%Y%m%dT%H%M"))
        .ok()?;
    Some(EventTime { naive, zone: zone_for(tzid), all_day: false })
}

fn parse_prop_time(prop: &Property) -> Option<EventTime> {
    let value = prop.value.as_deref()?;
    let date_only = param(prop, "VALUE").map(|v| v.eq_ignore_ascii_case("DATE")).unwrap_or(false);
    parse_value(value, param(prop, "TZID"), date_only)
}

/// ISO-8601 duration like "PT1H30M", "P1D", "-PT15M".
fn parse_duration(raw: &str) -> Option<Duration> {
    let (neg, body) = match raw.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, raw.trim_start_matches('+')),
    };
    let body = body.strip_prefix('P')?;
    let mut total = Duration::zero();
    let mut num = String::new();
    let mut in_time = false;
    for c in body.chars() {
        match c {
            'T' => in_time = true,
            '0'..='9' => num.push(c),
            _ => {
                let n: i64 = num.parse().ok()?;
                num.clear();
                total += match (c, in_time) {
                    ('W', _) => Duration::weeks(n),
                    ('D', _) => Duration::days(n),
                    ('H', true) => Duration::hours(n),
                    ('M', true) => Duration::minutes(n),
                    ('S', true) => Duration::seconds(n),
                    _ => return None,
                };
            }
        }
    }
    Some(if neg { -total } else { total })
}

fn unescape(text: &str) -> String {
    text.replace("\\n", " ").replace("\\N", " ").replace("\\,", ",").replace("\\;", ";").replace("\\\\", "\\")
}

fn first_link(text: &str) -> Option<String> {
    let start = text.find("https://")?;
    let rest = &text[start..];
    let end = rest.find(|c: char| c.is_whitespace() || c == '<' || c == '>' || c == '"' || c == '\\').unwrap_or(rest.len());
    Some(rest[..end].to_string())
}

#[derive(Debug, Default)]
struct RRule {
    freq: String,
    interval: i64,
    count: Option<u32>,
    until: Option<DateTime<Utc>>,
    by_day: Vec<(i32, Weekday)>,
    by_month_day: Vec<i32>,
}

fn weekday(code: &str) -> Option<Weekday> {
    Some(match code {
        "MO" => Weekday::Mon,
        "TU" => Weekday::Tue,
        "WE" => Weekday::Wed,
        "TH" => Weekday::Thu,
        "FR" => Weekday::Fri,
        "SA" => Weekday::Sat,
        "SU" => Weekday::Sun,
        _ => return None,
    })
}

fn parse_rrule(raw: &str, start: &EventTime) -> Option<RRule> {
    let mut rule = RRule { interval: 1, ..Default::default() };
    for part in raw.split(';') {
        let (k, v) = part.split_once('=')?;
        match k.to_ascii_uppercase().as_str() {
            "FREQ" => rule.freq = v.to_ascii_uppercase(),
            "INTERVAL" => rule.interval = v.parse().unwrap_or(1).max(1),
            "COUNT" => rule.count = v.parse().ok(),
            "UNTIL" => {
                rule.until = parse_value(v, None, v.len() == 8).map(|t| {
                    let t = if t.all_day { t.with_naive(t.naive + Duration::days(1) - Duration::seconds(1)) } else { t };
                    let t = if matches!(t.zone, Zone::Local) && !v.ends_with('Z') { EventTime { zone: start.zone, ..t } } else { t };
                    t.to_utc()
                })
            }
            "BYDAY" => {
                for item in v.split(',') {
                    let item = item.trim();
                    if item.len() < 2 {
                        continue;
                    }
                    let (ord, code) = item.split_at(item.len() - 2);
                    if let Some(day) = weekday(code) {
                        rule.by_day.push((ord.parse::<i32>().unwrap_or(0), day));
                    }
                }
            }
            "BYMONTHDAY" => rule.by_month_day = v.split(',').filter_map(|d| d.parse().ok()).collect(),
            _ => {}
        }
    }
    if rule.freq.is_empty() { None } else { Some(rule) }
}

fn days_in_month(year: i32, month: u32) -> u32 {
    let (ny, nm) = if month == 12 { (year + 1, 1) } else { (year, month + 1) };
    NaiveDate::from_ymd_opt(ny, nm, 1).and_then(|d| d.pred_opt()).map(|d| d.day()).unwrap_or(30)
}

fn nth_weekday(year: i32, month: u32, ord: i32, day: Weekday) -> Option<NaiveDate> {
    if ord > 0 {
        let first = NaiveDate::from_ymd_opt(year, month, 1)?;
        let offset = (7 + day.num_days_from_monday() as i64 - first.weekday().num_days_from_monday() as i64) % 7;
        let date = first + Duration::days(offset + (ord as i64 - 1) * 7);
        (date.month() == month).then_some(date)
    } else {
        let last = NaiveDate::from_ymd_opt(year, month, days_in_month(year, month))?;
        let offset = (7 + last.weekday().num_days_from_monday() as i64 - day.num_days_from_monday() as i64) % 7;
        let date = last - Duration::days(offset + ((-ord) as i64 - 1) * 7);
        (date.month() == month).then_some(date)
    }
}

fn add_months(year: i32, month: u32, add: i64) -> (i32, u32) {
    let total = year as i64 * 12 + (month as i64 - 1) + add;
    ((total / 12) as i32, (total % 12) as u32 + 1)
}

/// Occurrence start times (in event-local wall time) between dtstart and `window_end`.
fn expand(start: &EventTime, rule: &RRule, window_end: DateTime<Utc>) -> Vec<EventTime> {
    const MAX_ITER: usize = 20_000;
    let mut out = Vec::new();
    let time = start.naive.time();
    let date0 = start.naive.date();
    let mut emitted: u32 = 0;
    let mut push = |date: NaiveDate, out: &mut Vec<EventTime>| -> bool {
        let candidate = start.with_naive(date.and_time(time));
        if candidate.naive < start.naive {
            return true;
        }
        let utc = candidate.to_utc();
        if let Some(until) = rule.until {
            if utc > until {
                return false;
            }
        }
        if let Some(count) = rule.count {
            if emitted >= count {
                return false;
            }
        }
        if utc > window_end {
            return false;
        }
        emitted += 1;
        out.push(candidate);
        true
    };

    match rule.freq.as_str() {
        "DAILY" => {
            for i in 0..MAX_ITER {
                if !push(date0 + Duration::days(i as i64 * rule.interval), &mut out) {
                    break;
                }
            }
        }
        "WEEKLY" => {
            let days: Vec<Weekday> =
                if rule.by_day.is_empty() { vec![date0.weekday()] } else { rule.by_day.iter().map(|(_, d)| *d).collect() };
            let mut offsets: Vec<i64> = days.iter().map(|d| d.num_days_from_monday() as i64).collect();
            offsets.sort_unstable();
            offsets.dedup();
            let week0 = date0 - Duration::days(date0.weekday().num_days_from_monday() as i64);
            'weeks: for w in 0..MAX_ITER {
                let week = week0 + Duration::weeks(w as i64 * rule.interval);
                for off in &offsets {
                    if !push(week + Duration::days(*off), &mut out) {
                        break 'weeks;
                    }
                }
            }
        }
        "MONTHLY" => {
            'months: for m in 0..MAX_ITER {
                let (y, mo) = add_months(date0.year(), date0.month(), m as i64 * rule.interval);
                let mut dates: Vec<NaiveDate> = Vec::new();
                if !rule.by_month_day.is_empty() {
                    for &d in &rule.by_month_day {
                        let dim = days_in_month(y, mo) as i32;
                        let day = if d < 0 { dim + d + 1 } else { d };
                        if let Some(date) = NaiveDate::from_ymd_opt(y, mo, day.max(1) as u32) {
                            if day >= 1 && day <= dim {
                                dates.push(date);
                            }
                        }
                    }
                } else if !rule.by_day.is_empty() {
                    for &(ord, wd) in &rule.by_day {
                        if ord != 0 {
                            if let Some(date) = nth_weekday(y, mo, ord, wd) {
                                dates.push(date);
                            }
                        } else {
                            for n in 1..=5 {
                                if let Some(date) = nth_weekday(y, mo, n, wd) {
                                    dates.push(date);
                                }
                            }
                        }
                    }
                } else if let Some(date) = NaiveDate::from_ymd_opt(y, mo, date0.day()) {
                    dates.push(date);
                }
                dates.sort_unstable();
                for date in dates {
                    if !push(date, &mut out) {
                        break 'months;
                    }
                }
                if NaiveDate::from_ymd_opt(y, mo, 1).map(|d| d.and_time(time)).is_some_and(|d| {
                    start.with_naive(d).to_utc() > window_end
                }) {
                    break;
                }
            }
        }
        "YEARLY" => {
            for i in 0..MAX_ITER.min(500) {
                let year = date0.year() + (i as i64 * rule.interval) as i32;
                let Some(date) = NaiveDate::from_ymd_opt(year, date0.month(), date0.day()) else { continue };
                if !push(date, &mut out) {
                    break;
                }
            }
        }
        _ => out.push(*start),
    }
    out
}

struct RawEvent {
    uid: String,
    title: String,
    start: EventTime,
    end: Option<EventTime>,
    duration: Option<Duration>,
    rrule: Option<String>,
    exdates: Vec<DateTime<Utc>>,
    recurrence_id: Option<DateTime<Utc>>,
    location: Option<String>,
    url: Option<String>,
    cancelled: bool,
}

fn to_raw(props: &[Property]) -> Option<RawEvent> {
    let mut ev = RawEvent {
        uid: String::new(),
        title: "(No title)".into(),
        start: EventTime { naive: NaiveDateTime::MIN, zone: Zone::Utc, all_day: false },
        end: None,
        duration: None,
        rrule: None,
        exdates: Vec::new(),
        recurrence_id: None,
        location: None,
        url: None,
        cancelled: false,
    };
    let mut has_start = false;
    let mut description = String::new();
    for p in props {
        let value = p.value.clone().unwrap_or_default();
        match p.name.to_ascii_uppercase().as_str() {
            "UID" => ev.uid = value,
            "SUMMARY" => ev.title = unescape(&value),
            "DTSTART" => {
                if let Some(t) = parse_prop_time(p) {
                    ev.start = t;
                    has_start = true;
                }
            }
            "DTEND" => ev.end = parse_prop_time(p),
            "DURATION" => ev.duration = parse_duration(&value),
            "RRULE" => ev.rrule = Some(value),
            "EXDATE" => {
                for part in value.split(',') {
                    let date_only = param(p, "VALUE").map(|v| v.eq_ignore_ascii_case("DATE")).unwrap_or(false);
                    if let Some(t) = parse_value(part, param(p, "TZID"), date_only) {
                        ev.exdates.push(t.to_utc());
                    }
                }
            }
            "RECURRENCE-ID" => ev.recurrence_id = parse_prop_time(p).map(|t| t.to_utc()),
            "LOCATION" => ev.location = Some(unescape(&value)).filter(|s| !s.is_empty()),
            "URL" => ev.url = Some(value).filter(|s| !s.is_empty()),
            "DESCRIPTION" => description = value,
            "STATUS" => ev.cancelled = value.eq_ignore_ascii_case("CANCELLED"),
            _ => {}
        }
    }
    if ev.url.is_none() {
        ev.url = ev.location.as_deref().and_then(first_link).or_else(|| first_link(&description));
    }
    if ev.uid.is_empty() {
        ev.uid = format!("{}-{}", ev.title, ev.start.naive);
    }
    has_start.then_some(ev)
}

/// Parse one ICS document into concrete occurrences overlapping [now - 1h, now + days].
pub fn parse_ics(text: &str, days_ahead: i64) -> Result<Vec<CalendarEvent>, String> {
    let now = Utc::now();
    let window_start = now - Duration::hours(1);
    let window_end = now + Duration::days(days_ahead);
    let mut out = Vec::new();

    for calendar in IcalParser::new(BufReader::new(text.as_bytes())) {
        let calendar = calendar.map_err(|e| format!("invalid ICS: {e}"))?;
        let cal_name = calendar
            .properties
            .iter()
            .find(|p| p.name.eq_ignore_ascii_case("X-WR-CALNAME"))
            .and_then(|p| p.value.clone());

        let raws: Vec<RawEvent> = calendar.events.iter().filter_map(|e| to_raw(&e.properties)).collect();
        let overridden: HashSet<(String, i64)> = raws
            .iter()
            .filter_map(|r| r.recurrence_id.map(|rid| (r.uid.clone(), rid.timestamp())))
            .collect();

        for raw in &raws {
            if raw.cancelled {
                continue;
            }
            let length = match (raw.end, raw.duration) {
                (Some(end), _) => end.to_utc() - raw.start.to_utc(),
                (None, Some(d)) => d,
                (None, None) if raw.start.all_day => Duration::days(1),
                _ => Duration::zero(),
            };
            let starts: Vec<EventTime> = match (&raw.rrule, raw.recurrence_id) {
                (Some(rule), None) => match parse_rrule(rule, &raw.start) {
                    Some(r) => expand(&raw.start, &r, window_end),
                    None => vec![raw.start],
                },
                _ => vec![raw.start],
            };
            let exdates: HashSet<i64> = raw.exdates.iter().map(|d| d.timestamp()).collect();
            for occ in starts {
                let start = occ.to_utc();
                let end = start + length;
                if end < window_start || start > window_end || exdates.contains(&start.timestamp()) {
                    continue;
                }
                if raw.recurrence_id.is_none() && raw.rrule.is_some() && overridden.contains(&(raw.uid.clone(), start.timestamp())) {
                    continue;
                }
                out.push(CalendarEvent {
                    uid: format!("{}@{}", raw.uid, start.timestamp()),
                    title: raw.title.clone(),
                    start: start.to_rfc3339(),
                    end: end.to_rfc3339(),
                    all_day: occ.all_day,
                    location: raw.location.clone(),
                    url: raw.url.clone(),
                    calendar: cal_name.clone(),
                });
            }
        }
    }
    Ok(out)
}

/// Fetch every configured feed (newline / comma separated; webcal:// accepted) and merge.
pub async fn fetch_all(client: &reqwest::Client, urls: &str) -> Result<Vec<CalendarEvent>, String> {
    let mut events = Vec::new();
    let mut errors = Vec::new();
    let mut seen: HashMap<String, ()> = HashMap::new();
    for raw in urls.split(['\n', ',']).map(str::trim).filter(|s| !s.is_empty()) {
        let url = if let Some(rest) = raw.strip_prefix("webcal://") { format!("https://{rest}") } else { raw.to_string() };
        if !url.starts_with("https://") {
            errors.push("only https:// (or webcal://) feeds are allowed".to_string());
            continue;
        }
        if seen.insert(url.clone(), ()).is_some() {
            continue;
        }
        match client.get(&url).send().await {
            Ok(resp) if resp.status().is_success() => match resp.text().await {
                Ok(text) => match parse_ics(&text, 14) {
                    Ok(mut list) => events.append(&mut list),
                    Err(e) => errors.push(e),
                },
                Err(e) => errors.push(e.to_string()),
            },
            Ok(resp) => errors.push(format!("feed returned HTTP {}", resp.status().as_u16())),
            Err(e) => errors.push(e.to_string()),
        }
    }
    if events.is_empty() && !errors.is_empty() {
        return Err(errors.join("; "));
    }
    events.sort_by(|a, b| a.start.cmp(&b.start));
    events.truncate(100);
    Ok(events)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weekly_rrule_expands() {
        let start = (Utc::now() - Duration::days(7)).format("%Y%m%dT%H%M%SZ").to_string();
        let ics = format!(
            "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:a\r\nSUMMARY:Standup\r\nDTSTART:{start}\r\nDURATION:PT15M\r\nRRULE:FREQ=WEEKLY;COUNT=10\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
        );
        let events = parse_ics(&ics, 14).unwrap();
        assert!(events.len() >= 2, "expected at least two upcoming occurrences, got {}", events.len());
        assert!(events.iter().all(|e| e.title == "Standup"));
    }

    #[test]
    fn tzid_and_all_day() {
        let tomorrow = (Local::now() + Duration::days(1)).format("%Y%m%d").to_string();
        let ics = format!(
            "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:b\r\nSUMMARY:Netflix subscription renewal\r\nDTSTART;VALUE=DATE:{tomorrow}\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:c\r\nSUMMARY:Review\r\nDTSTART;TZID=Pacific Standard Time:{tomorrow}T090000\r\nDTEND;TZID=Pacific Standard Time:{tomorrow}T100000\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
        );
        let events = parse_ics(&ics, 14).unwrap();
        assert_eq!(events.len(), 2);
        assert!(events.iter().any(|e| e.all_day));
    }

    #[test]
    fn durations() {
        assert_eq!(parse_duration("PT1H30M"), Some(Duration::minutes(90)));
        assert_eq!(parse_duration("P1D"), Some(Duration::days(1)));
        assert_eq!(parse_duration("-PT15M"), Some(Duration::minutes(-15)));
    }
}
