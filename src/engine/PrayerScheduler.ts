// Prayer alerts (dock window, checked every second): optional reminder N minutes before the adhan,
// then the adhan itself. Each goes to the WinGlass toast stack and, if enabled, a native Windows
// toast plus a short chime. `once` (AutomationEngine) makes every alert fire a single time.

import { getHub } from "./DataHub";
import { t } from "../i18n";
import { formatTime } from "../lib/format";
import { ipc } from "../lib/ipc";
import { prayerSlots } from "../lib/prayer";
import type { PrayerData, ToastSpec } from "../types/winglass";

/** An alert is still delivered if the dock was busy for up to a minute past its time. */
const WINDOW_MS = 60_000;

function chime(): void {
  try {
    const ctx = new AudioContext();
    void ctx.resume();
    [659.25, 987.77].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const start = ctx.currentTime + i * 0.38;
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.1, start + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 1.8);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 1.9);
    });
    window.setTimeout(() => void ctx.close(), 3000);
  } catch {
    // No audio device: the toasts are enough.
  }
}

export function startPrayerScheduler(toast: (spec: ToastSpec) => void, once: (key: string) => boolean): () => void {
  const fire = (id: string, title: string, subtitle: string, adhan: boolean) => {
    const prefs = getHub().settings?.prayer;
    toast({ id, kind: "prayer", title, subtitle, durationMs: adhan ? 20_000 : 12_000 });
    if (!prefs || getHub().settings?.doNotDisturb) return;
    if (prefs.nativeToasts) void ipc.notifyNative(title, subtitle).catch((err) => console.warn("[winglass] native toast failed", err));
    if (prefs.chime && adhan) chime();
  };

  const tick = () => {
    const prefs = getHub().settings?.prayer;
    const data = getHub().providers.prayer?.data as PrayerData | null | undefined;
    if (!prefs || !data?.days?.length) return;
    const now = Date.now();
    const place = data.name || data.city;
    for (const slot of prayerSlots(data)) {
      if (!prefs.alerts.includes(slot.key)) continue;
      const at = slot.at.getTime();
      const name = t(`prayer.${slot.key}`);
      const time = formatTime(slot.at);
      if (prefs.reminderMinutes > 0) {
        const remindAt = at - prefs.reminderMinutes * 60_000;
        if (now >= remindAt && now < remindAt + WINDOW_MS && once(`prayer:${slot.date}:${slot.key}:pre`)) {
          fire(`prayer-pre-${slot.date}-${slot.key}`, t("prayer.toast.soon", { name, minutes: prefs.reminderMinutes }), t("prayer.toast.at", { time, place }), false);
        }
      }
      if (now >= at && now < at + WINDOW_MS && once(`prayer:${slot.date}:${slot.key}:adhan`)) {
        const title = slot.key === "sunrise" ? t("prayer.toast.sunrise", { time }) : t("prayer.toast.now", { name, time });
        fire(`prayer-${slot.date}-${slot.key}`, title, place, true);
      }
    }
  };

  const timer = window.setInterval(tick, 1000);
  return () => window.clearInterval(timer);
}
