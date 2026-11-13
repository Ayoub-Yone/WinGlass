// Formatting helpers shared by widgets, toasts and automations.

const moneyCache = new Map<string, Intl.NumberFormat>();

export function formatMoney(value: number, currency = "USD", compact = false): string {
  const key = `${currency}|${compact}`;
  let fmt = moneyCache.get(key);
  if (!fmt) {
    try {
      fmt = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: currency.toUpperCase(),
        maximumFractionDigits: compact && Math.abs(value) >= 10000 ? 1 : 0,
        notation: compact && Math.abs(value) >= 10000 ? "compact" : "standard",
      });
    } catch {
      fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
    }
    moneyCache.set(key, fmt);
  }
  return fmt.format(value);
}

export function formatCount(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (Math.abs(value) >= 10_000) return `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1)}K`;
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}

export function formatSigned(value: number): string {
  const rounded = Math.round(value);
  return `${rounded >= 0 ? "+" : "−"}${formatCount(Math.abs(rounded))}`;
}

/** 21900 -> "6h 5m" */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
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

export function formatTime(date: Date, timeZone?: string): string {
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
}

/** "Thu at 9:00 AM", "today at 4:00 PM", "tomorrow at 4:00 PM" */
export function formatDayTime(date: Date, now = new Date()): string {
  const day = relativeDayWord(date, now);
  const time = formatTime(date);
  if (day) return `${day} at ${time}`;
  const diffDays = (date.getTime() - now.getTime()) / 86_400_000;
  const label =
    diffDays < 6.5
      ? date.toLocaleDateString("en-US", { weekday: "short" })
      : date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${label} at ${time}`;
}

export function relativeDayWord(date: Date, now = new Date()): "today" | "tomorrow" | null {
  const a = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const b = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((b - a) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return null;
}

/** "In 5 min", "In 2h 10m", "Now", "Started 3 min ago" */
export function formatCountdown(minutes: number): string {
  if (minutes <= 0 && minutes > -1) return "Now";
  if (minutes < 0) return `Started ${Math.round(-minutes)} min ago`;
  if (minutes < 60) return `In ${Math.max(1, Math.ceil(minutes))} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h < 24) return m > 0 ? `In ${h}h ${m}m` : `In ${h}h`;
  return `In ${Math.round(h / 24)}d`;
}

/** Compact countdown to an ISO timestamp: "2h 14m", "3d 4h" */
export function formatResetIn(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "now";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function formatBytesPerSecond(bps: number): string {
  if (bps >= 1024 * 1024) return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
  if (bps >= 1024) return `${(bps / 1024).toFixed(0)} KB/s`;
  return `${Math.round(bps)} B/s`;
}

export function formatGb(gb: number): string {
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: gb >= 100 ? 0 : 1 }).format(gb)} GB`;
}

export function startTimeFormatted(start: Date, allDay: boolean, now = new Date()): string {
  if (allDay) {
    const word = relativeDayWord(start, now);
    return word ? `All day ${word}` : start.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  }
  const word = relativeDayWord(start, now);
  if (word === "today") return formatTime(start);
  if (word === "tomorrow") return `Tomorrow · ${formatTime(start)}`;
  return `${start.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} · ${formatTime(start)}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function uid(prefix = "w"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
