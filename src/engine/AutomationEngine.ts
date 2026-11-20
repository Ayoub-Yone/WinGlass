// Four cross-widget automation rules, driven entirely by EventBus traffic.
// Runs in the dock window; toasts are delivered to the toast window through `toast:push`.
// Each rule is individually toggleable with thresholds from Settings › Automations, and fires at
// most once per logical occurrence (dedupe keys persist across restarts).

import { bus } from "./EventBus";
import { startPrayerScheduler } from "./PrayerScheduler";
import { getHub } from "./DataHub";
import { broadcast, ipc } from "../lib/ipc";
import { formatDayTime, formatMoney, formatPercent, formatRelativeDay, formatTime } from "../lib/format";
import { getLang, t, translateDynamic } from "../i18n";
import type {
  AiUsageData,
  AutomationSettings,
  CalendarTick,
  MediaState,
  ProviderId,
  RevenueData,
  ToastSpec,
  UpcomingEvent,
} from "../types/winglass";

const FIRED_KEY = "winglass.automation.fired.v1";
const REVENUE_KEY = "winglass.automation.revenue.v1";
const BURN_KEY = "winglass.automation.burn.v1";

type Fired = Record<string, number>;
type BurnSample = { t: number; p: number; reset: string | null };

function load<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* non-fatal: dedupe falls back to in-memory */
  }
}

export const RENEWAL_REVENUE_PROVIDERS: ProviderId[] = ["stripe", "polar", "dodo"];

/** Warning level of an AI tier under the quota rule (also drives the tile highlight). */
export function aiAlertLevel(percent: number, rule: AutomationSettings["aiLimitWarning"] | null | undefined): "warn" | "critical" | null {
  if (!rule?.enabled) return null;
  if (percent >= (rule.criticalPercent ?? 95)) return "critical";
  if (percent >= rule.thresholdPercent) return "warn";
  return null;
}

export interface RuleTestResult {
  ok: boolean;
  message: string;
}

class AutomationEngineImpl {
  private fired: Fired = load<Fired>(FIRED_KEY, {});
  private lastRevenue: Record<string, number> = load(REVENUE_KEY, {});
  private burn: Record<string, BurnSample[]> = load(BURN_KEY, {});
  private media: MediaState | null = null;
  private offs: Array<() => void> = [];

  start(): () => void {
    this.pruneFired();
    this.offs.push(bus.onWithLatest("media:state", (m) => (this.media = m)));
    this.offs.push(bus.on("calendar:tick", (tick) => this.onCalendarTick(tick)));
    this.offs.push(bus.on("ai:usage", ({ providerId, data }) => this.onAiUsage(providerId, data)));
    this.offs.push(bus.on("revenue:update", ({ providerId, data }) => this.onRevenue(providerId, data)));
    this.offs.push(startPrayerScheduler((spec) => this.toast(spec), (key) => this.once(key)));
    return () => {
      this.offs.forEach((off) => off());
      this.offs = [];
    };
  }

  private get rules(): AutomationSettings | null {
    return getHub().settings?.automations ?? null;
  }

  private once(key: string): boolean {
    if (this.fired[key]) return false;
    this.fired[key] = Date.now();
    save(FIRED_KEY, this.fired);
    return true;
  }

  private pruneFired(): void {
    const cutoff = Date.now() - 45 * 86_400_000;
    for (const [k, t] of Object.entries(this.fired)) if (t < cutoff) delete this.fired[k];
    save(FIRED_KEY, this.fired);
  }

  private toast(spec: ToastSpec): void {
    bus.emit("toast:show", spec);
    if (getHub().settings?.doNotDisturb && spec.kind !== "system") return;
    void broadcast("toast:push", spec);
  }

  // -------------------------------------------------------------- Rule 1: pre-meeting music pause

  private onCalendarTick(tick: CalendarTick): void {
    const rules = this.rules;
    if (!rules) return;
    if (rules.preMeetingPause.enabled) {
      const window = rules.preMeetingPause.minutes;
      for (const up of tick.upcoming) {
        if (up.event.allDay) continue;
        if (up.minutesUntil > 0 && up.minutesUntil <= window && this.media?.status === "Playing") {
          if (this.once(`meeting:${up.event.uid}`)) this.firePreMeeting(up, window);
        }
      }
    }
    if (rules.renewalReminder.enabled) {
      const keywords = rules.renewalReminder.keywords.map((k) => k.toLowerCase()).filter(Boolean);
      const horizonMin = rules.renewalReminder.hours * 60;
      for (const up of tick.upcoming) {
        const title = up.event.title.toLowerCase();
        if (up.minutesUntil > 0 && up.minutesUntil <= horizonMin && keywords.some((k) => title.includes(k))) {
          if (this.once(`renewal:${up.event.uid}`)) this.fireRenewal(up);
        }
      }
    }
  }

  private firePreMeeting(up: UpcomingEvent, minutes: number): void {
    void ipc.mediaPause().catch((err) => console.warn("[winglass] media_pause failed", err));
    this.toast({
      id: `meeting-${up.event.uid}`,
      kind: "calendar",
      title: t("toast.meeting.title", { title: up.event.title, minutes }),
      subtitle: t("toast.meeting.subtitle", { time: formatTime(new Date(up.event.start)) }),
      actionLabel: t("toast.meeting.action"),
      action: { kind: "open", target: up.event.url ?? "calendar-app" },
      durationMs: 12_000,
    });
  }

  // -------------------------------------------------------------- Rule 4: subscription renewal

  private fireRenewal(up: UpcomingEvent): void {
    const start = new Date(up.event.start);
    const when = up.event.allDay ? up.startTimeFormatted : t("toast.renewal.subtitle", { time: formatTime(start) });
    // Keep or cancel: « Garder » simply acknowledges (this occurrence never fires again);
    // « Résilier » opens the subscription's page from the event, else the calendar.
    this.toast({
      id: `renewal-${up.event.uid}`,
      kind: "renewal",
      title: t("toast.renewal.title", { title: up.event.title, day: formatRelativeDay(start) }),
      subtitle: `${when} · ${t(up.event.recurring ? "toast.renewal.promptRecurring" : "toast.renewal.prompt")}`,
      actionLabel: t("toast.renewal.keep"),
      action: { kind: "dismiss" },
      secondaryLabel: t("toast.renewal.cancel"),
      secondaryAction: { kind: "open", target: up.event.url ?? "calendar-app" },
      durationMs: 20_000,
    });
  }

  // -------------------------------------------------------------- Rule 2: AI limit early warning

  private recordBurn(key: string, percent: number, reset: string | null): BurnSample[] {
    const now = Date.now();
    let samples = (this.burn[key] ?? []).filter((s) => now - s.t < 6 * 3_600_000);
    // A new window started: discard samples from the previous one.
    if (samples.length && (samples[samples.length - 1].reset !== reset || percent < samples[samples.length - 1].p - 5)) {
      samples = [];
    }
    samples.push({ t: now, p: percent, reset });
    this.burn[key] = samples.slice(-120);
    save(BURN_KEY, this.burn);
    return this.burn[key];
  }

  /** Projected depletion time (ms epoch) from the burn rate over the last ≥10 minutes. */
  private projectDepletion(samples: BurnSample[]): number | null {
    if (samples.length < 2) return null;
    const last = samples[samples.length - 1];
    const first = samples.find((s) => last.t - s.t >= 10 * 60_000) ?? null;
    if (!first) return null;
    const rate = (last.p - first.p) / (last.t - first.t); // percent per ms
    if (rate <= 0) return null;
    return last.t + (100 - last.p) / rate;
  }

  private onAiUsage(providerId: ProviderId, data: AiUsageData): void {
    const rule = this.rules?.aiLimitWarning;
    if (!rule?.enabled) return;
    for (const tier of data.tiers) {
      const key = `${providerId}:${tier.key}`;
      const samples = this.recordBurn(key, tier.percent, tier.resetsAt);
      const depletion = this.projectDepletion(samples);
      const resetAt = tier.resetsAt ? new Date(tier.resetsAt).getTime() : null;
      const hoursLeft = depletion ? (depletion - Date.now()) / 3_600_000 : null;
      const runsOutBeforeReset = depletion !== null && (resetAt === null || depletion < resetAt);
      const projected = hoursLeft !== null && hoursLeft < rule.horizonHours && runsOutBeforeReset;
      const level = aiAlertLevel(tier.percent, rule);
      if (!level && !projected) continue;
      // One toast per level (85 % then 95 %) per reset window.
      if (!this.once(`ai:${key}:${tier.resetsAt ?? "none"}:${level ?? "projected"}`)) continue;
      this.fireAiWarning(data.provider, tier.key, tier.label, tier.percent, depletion, tier.resetsAt, level === "critical");
    }
  }

  private fireAiWarning(provider: string, tierKey: string, tierLabel: string, percent: number, depletion: number | null, resetsAt: string | null, critical = false): void {
    // Tier names come from the backend in English; known tiers are localized by key.
    const tier = translateDynamic(getLang(), `tier.${tierKey}`, tierLabel);
    let title: string;
    if (percent >= 100) title = t("toast.ai.reached", { provider, tier });
    else if (critical) title = t("toast.ai.critical", { provider, tier, percent: formatPercent(percent) });
    else if (depletion !== null) title = t("toast.ai.title", { provider, tier, when: formatDayTime(new Date(depletion)) });
    else title = t("toast.ai.titleSoon", { provider, tier });
    const reset = resetsAt ? formatDayTime(new Date(resetsAt)) : t("toast.ai.nextCycle");
    this.toast({
      id: `ai-${provider}-${tierKey}${critical ? "-critical" : ""}`,
      kind: "ai",
      title,
      subtitle: t("toast.ai.subtitle", { reset }),
      durationMs: 14_000,
    });
  }

  // -------------------------------------------------------------- Rule 3: revenue milestone

  private onRevenue(providerId: ProviderId, data: RevenueData): void {
    if (!RENEWAL_REVENUE_PROVIDERS.includes(providerId)) return;
    const rule = this.rules?.revenueMilestone;
    const previous = this.lastRevenue[providerId];
    this.lastRevenue[providerId] = data.total30d;
    save(REVENUE_KEY, this.lastRevenue);
    if (!rule?.enabled || previous === undefined) return;
    const crossed = [...rule.milestones]
      .sort((a, b) => b - a)
      .find((m) => previous < m && data.total30d >= m);
    if (crossed === undefined) return;
    // Re-arm a milestone after 30 days so a later re-crossing celebrates again.
    const bucket = Math.floor(Date.now() / (30 * 86_400_000));
    if (!this.once(`revenue:${providerId}:${crossed}:${bucket}`)) return;
    this.toast({
      id: `revenue-${providerId}-${crossed}`,
      kind: "revenue",
      title: t("toast.revenue.title", { amount: formatMoney(crossed, data.currency) }),
      subtitle: `${t("toast.revenue.subtitle")} · ${data.provider}`,
      durationMs: 12_000,
    });
  }

  // -------------------------------------------------------------- Settings › "Test" buttons

  /** Fire a rule's toast with representative data so users can verify the pipeline end-to-end. */
  test(rule: keyof AutomationSettings): RuleTestResult {
    const now = Date.now();
    switch (rule) {
      case "preMeetingPause": {
        const start = new Date(now + 5 * 60_000);
        const up: UpcomingEvent = {
          event: { uid: `test-${now}`, title: t("toast.test.sampleMeeting"), start: start.toISOString(), end: new Date(now + 35 * 60_000).toISOString(), allDay: false, location: null, url: null, calendar: null },
          minutesUntil: 5,
          startTimeFormatted: formatTime(start),
        };
        this.firePreMeeting(up, this.rules?.preMeetingPause.minutes ?? 5);
        return { ok: true, message: this.media?.status === "Playing" ? t("toast.test.meetingPaused") : t("toast.test.meeting") };
      }
      case "aiLimitWarning": {
        const tomorrow4pm = new Date();
        tomorrow4pm.setDate(tomorrow4pm.getDate() + 1);
        tomorrow4pm.setHours(16, 0, 0, 0);
        const reset = new Date(tomorrow4pm.getTime() + 41 * 3_600_000);
        reset.setHours(9, 0, 0, 0);
        this.fireAiWarning("Claude", "seven_day", "Weekly", 88, tomorrow4pm.getTime(), reset.toISOString());
        return { ok: true, message: t("toast.test.ai") };
      }
      case "revenueMilestone":
        this.toast({ id: `revenue-test-${now}`, kind: "revenue", title: t("toast.revenue.title", { amount: formatMoney(3000) }), subtitle: t("toast.revenue.subtitle"), durationMs: 10_000 });
        return { ok: true, message: t("toast.test.revenue") };
      case "renewalReminder": {
        const start = new Date(now + 20 * 3_600_000);
        this.fireRenewal({
          event: { uid: `test-renewal-${now}`, title: t("toast.test.sampleRenewal"), start: start.toISOString(), end: start.toISOString(), allDay: false, location: null, url: null, calendar: null, recurring: true },
          minutesUntil: 20 * 60,
          startTimeFormatted: formatTime(start),
        });
        return { ok: true, message: t("toast.test.renewal") };
      }
    }
  }

  /** Clear dedupe history (Settings › Automations › "Reset fired history"). */
  resetHistory(): void {
    this.fired = {};
    this.burn = {};
    save(FIRED_KEY, this.fired);
    save(BURN_KEY, this.burn);
  }
}

export const AutomationEngine = new AutomationEngineImpl();
