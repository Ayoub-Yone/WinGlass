// « Heures de prière »: turns the backend's "HH:MM" schedule (today + tomorrow) into dated slots.

import type { PrayerData, PrayerKey } from "../types/winglass";

export const PRAYER_KEYS: PrayerKey[] = ["fajr", "sunrise", "dhuhr", "asr", "maghrib", "isha"];

export interface PrayerSlot {
  key: PrayerKey;
  /** Local "YYYY-MM-DD" of the day it belongs to. */
  date: string;
  at: Date;
  iqama: Date | null;
}

function localDate(date: string, hhmm: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [h, min] = hhmm.split(":").map(Number);
  return new Date(y, m - 1, d, h, min);
}

export function localDay(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Mawaqit iqama is "+10" (minutes after the adhan) or a fixed "HH:MM"; sunrise has none. */
function iqamaAt(date: string, adhan: Date, raw: string | undefined): Date | null {
  if (!raw) return null;
  if (raw.startsWith("+")) {
    const minutes = Number(raw.slice(1));
    return Number.isFinite(minutes) && minutes > 0 ? new Date(adhan.getTime() + minutes * 60_000) : null;
  }
  return /^\d{2}:\d{2}$/.test(raw) ? localDate(date, raw) : null;
}

export function prayerSlots(data: PrayerData): PrayerSlot[] {
  return data.days
    .flatMap((day) =>
      PRAYER_KEYS.map((key, i) => {
        const at = localDate(day.date, day.times[i] ?? "");
        const raw = key === "sunrise" ? undefined : day.iqama?.[i === 0 ? 0 : i - 1];
        return { key, date: day.date, at, iqama: iqamaAt(day.date, at, raw) };
      }),
    )
    .filter((s) => !Number.isNaN(s.at.getTime()));
}

/** Next adhan after `now` (sunrise is listed but is not a prayer). */
export function nextPrayer(slots: PrayerSlot[], now: number): PrayerSlot | undefined {
  return slots.find((s) => s.key !== "sunrise" && s.at.getTime() > now);
}

/** Time-of-day tint for the tile: dawn rose, midday sky, sunset amber, night indigo. */
export function prayerPhase(slots: PrayerSlot[], now: number): "dawn" | "day" | "sunset" | "night" {
  const today = localDay(now);
  const t = (key: PrayerKey) => slots.find((s) => s.date === today && s.key === key)?.at.getTime();
  const [fajr, sunrise, maghrib] = [t("fajr"), t("sunrise"), t("maghrib")];
  if (fajr === undefined || sunrise === undefined || maghrib === undefined) return "night";
  if (now >= fajr && now < sunrise + 3_600_000) return "dawn";
  if (now >= sunrise && now < maghrib - 3_600_000) return "day";
  if (now >= maghrib - 3_600_000 && now < maghrib + 2_700_000) return "sunset";
  return "night";
}

export const PHASE_TINT: Record<ReturnType<typeof prayerPhase>, string> = {
  dawn: "oklch(72% 0.09 15 / 0.30)",
  day: "oklch(72% 0.09 235 / 0.26)",
  sunset: "oklch(74% 0.12 65 / 0.30)",
  night: "oklch(45% 0.10 275 / 0.34)",
};

/** "-00:18:24" style countdown. */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}
