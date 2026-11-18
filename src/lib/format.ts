// Formatting helpers shared by widgets, toasts and automations. Everything follows the active
// UI language (French by default): 24-hour times, `6h 05m` durations, `LUN 20` day badges and
// French number / currency conventions in `fr`; 12-hour times and US conventions in `en`.

import { getLang, getLocale, t } from "../i18n";

const numberCache = new Map<string, Intl.NumberFormat>();

function numberFormat(key: string, make: (locale: string) => Intl.NumberFormat): Intl.NumberFormat {
  const locale = getLocale();
  const cacheKey = `${locale}|${key}`;
  let fmt = numberCache.get(cacheKey);
  if (!fmt) {
    fmt = make(locale);
    numberCache.set(cacheKey, fmt);
  }
  return fmt;
}

export function formatMoney(value: number, currency = "USD", compact = false): string {
  const big = compact && Math.abs(value) >= 10000;
  const code = currency.toUpperCase();
  const fmt = numberFormat(`money|${code}|${big}`, (locale) => {
    const options: Intl.NumberFormatOptions = {
      style: "currency",
      currencyDisplay: "narrowSymbol",
      maximumFractionDigits: big ? 1 : 0,
      notation: big ? "compact" : "standard",
    };
    try {
      return new Intl.NumberFormat(locale, { ...options, currency: code });
    } catch {
      return new Intl.NumberFormat(locale, { ...options, currency: "USD" });
    }
  });
  return fmt.format(value);
}

export function formatCount(value: number): string {
  if (Math.abs(value) >= 10_000) {
    const digits = Math.abs(value) >= 100_000 && Math.abs(value) < 1_000_000 ? 0 : Math.abs(value) >= 10_000_000 ? 0 : 1;
    return numberFormat(`compact|${digits}`, (locale) => new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: digits })).format(value);
  }
  return numberFormat("int", (locale) => new Intl.NumberFormat(locale, { maximumFractionDigits: 0 })).format(Math.round(value));
}

export function formatSigned(value: number): string {
  const rounded = Math.round(value);
  return `${rounded >= 0 ? "+" : "−"}${formatCount(Math.abs(rounded))}`;
}

/** Whole percent: `87%` (en) / `87 %` (fr, narrow no-break space). */
export function formatPercent(value: number): string {
  const rounded = Math.round(value);
  return getLang() === "fr" ? `${rounded} %` : `${rounded}%`;
}

/** 21900 -> "6h 05m" (fr) / "6h 5m" (en) */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return getLang() === "fr" ? `${h}h ${m.toString().padStart(2, "0")}m` : `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/** mm:ss or h:mm:ss */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

/** "16:00" (fr) / "4:00 PM" (en) */
export function formatTime(date: Date, timeZone?: string): string {
  return getLang() === "fr"
    ? date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone })
    : date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
}

/** Hour tick for the weather strip: "16h" (fr) / "4pm" (en) */
export function formatHour(date: Date): string {
  return getLang() === "fr"
    ? `${date.getHours()}h`
    : date.toLocaleTimeString("en-US", { hour: "numeric" }).replace(" ", "").toLowerCase();
}

/** Short weekday without the trailing period French adds: "lun" / "Mon". */
export function formatWeekdayShort(date: Date): string {
  return date.toLocaleDateString(getLocale(), { weekday: "short" }).replace(/\.$/, "");
}

/** Calendar day badge: `{ weekday: "LUN", day: "20" }` / `{ weekday: "MON", day: "20" }`. */
export function formatDayBadge(date: Date): { weekday: string; day: string } {
  return { weekday: formatWeekdayShort(date).toLocaleUpperCase(getLocale()), day: String(date.getDate()) };
}

/** "20 octobre" / "October 20" */
export function formatLongDate(date: Date): string {
  return date.toLocaleDateString(getLocale(), { month: "long", day: "numeric" });
}

/** "lun. 20 oct." / "Mon, Oct 20" */
export function formatMediumDate(date: Date): string {
  return date.toLocaleDateString(getLocale(), { weekday: "short", month: "short", day: "numeric" });
}

/** Month grid title: "Novembre 2026" / "November 2026" */
export function formatMonthYear(date: Date): string {
  const text = date.toLocaleDateString(getLocale(), { month: "long", year: "numeric" });
  return text.charAt(0).toLocaleUpperCase(getLocale()) + text.slice(1);
}

/** Accessible day label: "mardi 17 novembre 2026" / "Tuesday, November 17, 2026" */
export function formatFullDate(date: Date): string {
  return date.toLocaleDateString(getLocale(), { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

/** Week starts Monday in French, Sunday in English. 0 = Sunday … 6 = Saturday. */
export function firstDayOfWeek(): number {
  return getLang() === "fr" ? 1 : 0;
}

/** Narrow weekday headers in week order: L M M J V S D / S M T W T F S. */
export function weekdayInitials(): string[] {
  const first = firstDayOfWeek();
  // 2023-01-01 was a Sunday.
  return Array.from({ length: 7 }, (_, i) =>
    new Date(2023, 0, 1 + ((first + i) % 7)).toLocaleDateString(getLocale(), { weekday: "narrow" }).toLocaleUpperCase(getLocale()),
  );
}

/** "20/10/2026" / "10/20/2026" */
export function formatNumericDate(date: Date): string {
  return date.toLocaleDateString(getLocale(), { month: "numeric", day: "numeric", year: "numeric" });
}

export function formatDateTime(date: Date): string {
  return date.toLocaleString(getLocale());
}

export function relativeDayWord(date: Date, now = new Date()): "today" | "tomorrow" | null {
  const a = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const b = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((b - a) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return null;
}

function dayWord(word: "today" | "tomorrow"): string {
  return word === "today" ? t("fmt.today") : t("fmt.tomorrow");
}

/** "Thu at 9:00 AM" / "jeu. à 09:00", "today at 4:00 PM" / "aujourd'hui à 16:00" */
export function formatDayTime(date: Date, now = new Date()): string {
  const word = relativeDayWord(date, now);
  const time = formatTime(date);
  if (word) return t("fmt.dayAtTime", { day: dayWord(word), time });
  const diffDays = (date.getTime() - now.getTime()) / 86_400_000;
  const day =
    diffDays < 6.5
      ? date.toLocaleDateString(getLocale(), { weekday: "short" })
      : date.toLocaleDateString(getLocale(), { month: "short", day: "numeric" });
  return t("fmt.dayAtTime", { day, time });
}

/** "today" / "demain" / "on Thursday" / "jeudi" */
export function formatRelativeDay(date: Date, now = new Date()): string {
  const word = relativeDayWord(date, now);
  if (word) return dayWord(word);
  return t("fmt.onWeekday", { weekday: date.toLocaleDateString(getLocale(), { weekday: "long" }) });
}

/** "In 5 min" / "Dans 5 min", "In 2h 10m", "Now", "Started 3 min ago" */
/** `short` drops the "In" / "Dans" prefix for 1x1 cards: "5 min", "2h 10m". */
export function formatCountdown(minutes: number, short = false): string {
  if (short && minutes > 0) {
    if (minutes < 60) return `${Math.max(1, Math.ceil(minutes))} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ${Math.round(minutes % 60).toString().padStart(2, "0")}m`;
    return `${Math.round(hours / 24)} ${t("fmt.unitDay")}`;
  }
  if (minutes <= 0 && minutes > -1) return t("fmt.now");
  if (minutes < 0) return t("fmt.startedAgo", { n: Math.round(-minutes) });
  if (minutes < 60) return t("fmt.inMinutes", { n: Math.max(1, Math.ceil(minutes)) });
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h < 24) return m > 0 ? t("fmt.inHoursMinutes", { h, m: getLang() === "fr" ? m.toString().padStart(2, "0") : m }) : t("fmt.inHours", { h });
  return t("fmt.inDays", { d: Math.round(h / 24) });
}

/** Compact countdown to an ISO timestamp: "2h 14m", "3d 4h" / "3j 4h" */
export function formatResetIn(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return t("fmt.nowLower");
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${getLang() === "fr" ? (minutes % 60).toString().padStart(2, "0") : minutes % 60}m`;
  return `${Math.floor(hours / 24)}${t("fmt.unitDay")} ${hours % 24}h`;
}

/** Binary units: MB/s, KB/s (en) — Mo/s, Ko/s (fr). */
export function formatBytesPerSecond(bps: number): string {
  const fr = getLang() === "fr";
  const decimal = (n: number, digits: number) => (fr ? n.toFixed(digits).replace(".", ",") : n.toFixed(digits));
  if (bps >= 1024 * 1024) return `${decimal(bps / (1024 * 1024), 1)} ${fr ? "Mo/s" : "MB/s"}`;
  if (bps >= 1024) return `${decimal(bps / 1024, 0)} ${fr ? "Ko/s" : "KB/s"}`;
  return `${Math.round(bps)} ${fr ? "o/s" : "B/s"}`;
}

export function formatGb(gb: number): string {
  const digits = gb >= 100 ? 0 : 1;
  const value = numberFormat(`gb|${digits}`, (locale) => new Intl.NumberFormat(locale, { maximumFractionDigits: digits })).format(gb);
  return `${value} ${getLang() === "fr" ? "Go" : "GB"}`;
}

/** One decimal, locale decimal separator: "11.2" / "11,2". */
export function formatDecimal(value: number, digits = 1): string {
  return numberFormat(`dec|${digits}`, (locale) => new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits })).format(value);
}

export function startTimeFormatted(start: Date, allDay: boolean, now = new Date()): string {
  const word = relativeDayWord(start, now);
  if (allDay) return word ? t("fmt.allDay", { day: dayWord(word) }) : formatMediumDate(start);
  if (word === "today") return formatTime(start);
  if (word === "tomorrow") return t("fmt.tomorrowAt", { time: formatTime(start) });
  return `${formatMediumDate(start)} · ${formatTime(start)}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function uid(prefix = "w"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
