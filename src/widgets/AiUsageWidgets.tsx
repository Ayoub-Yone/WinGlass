// AI usage-limit trackers: Claude (Session / Weekly / Opus), ChatGPT, Gemini (Pro / Flash),
// Grok, DeepSeek, GLM. Tiles show slim green bars (amber / red near the limit) with reset times;
// clicking opens the telemetry flyout: every tier, this window's burn-rate chart with the
// projection to 100 %, the plan, and a Refresh that re-reads the provider at once.

import { AlertTriangle, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { BrandGlyph, Popover, ProgressBar, ProviderState, WidgetCard, usageColor } from "../components/ui";
import { useI18n, type I18n } from "../i18n";
import { formatMoney, formatPercent, formatResetIn, formatTime, formatWeekdayShort } from "../lib/format";
import { ipc } from "../lib/ipc";
import { useNow, usePreview, useProvider, useSettings } from "../lib/hooks";
import { aiAlertLevel } from "../engine/AutomationEngine";
import type { AiUsageData, ProviderId, UsageTier, WidgetProps } from "../types/winglass";

const GREEN = "#22C55E";
const CORAL = "#EF4444";

/** True when usage is running ahead of the elapsed share of the window by ≥15 points. */
export function aheadOfPace(tier: UsageTier, now: number): boolean {
  if (!tier.windowSeconds || !tier.resetsAt || tier.percent < 40) return false;
  const remaining = (new Date(tier.resetsAt).getTime() - now) / 1000;
  const elapsed = 1 - remaining / tier.windowSeconds;
  if (elapsed <= 0 || elapsed > 1) return false;
  return tier.percent - elapsed * 100 >= 15;
}

interface Projection {
  start: number;
  end: number;
  /** % per ms since the window opened. */
  pace: number;
  /** When the tier hits 100 % at this pace, if that is before the reset. */
  outAt: number | null;
}

/** Straight-line burn since the window opened (usage is 0 % at every reset). */
export function projection(tier: UsageTier, now: number): Projection | null {
  if (!tier.resetsAt || !tier.windowSeconds) return null;
  const end = Date.parse(tier.resetsAt);
  const start = end - tier.windowSeconds * 1000;
  if (!(now > start && now < end)) return null;
  const pace = tier.percent / (now - start);
  const outAt = pace > 0 ? now + (100 - tier.percent) / pace : null;
  return { start, end, pace, outAt: outAt !== null && outAt < end ? outAt : null };
}

const when = (ms: number) => `${formatWeekdayShort(new Date(ms))} ${formatTime(new Date(ms))}`;

function resetLabel(tier: UsageTier, now: number, long: boolean, i18n: I18n): string {
  if (!tier.resetsAt) return "";
  if (!long) return formatResetIn(tier.resetsAt, now);
  const d = new Date(tier.resetsAt);
  const hours = (d.getTime() - now) / 3_600_000;
  if (hours < 24) return i18n.t("ai.resetIn", { time: formatResetIn(tier.resetsAt, now) });
  return when(d.getTime());
}

/** The tier the burn chart follows: the longest window (weekly when there is one). */
function chartTier(tiers: UsageTier[]): UsageTier | undefined {
  return tiers.filter((t) => t.windowSeconds && t.resetsAt).sort((a, b) => (b.windowSeconds ?? 0) - (a.windowSeconds ?? 0))[0];
}

// ------------------------------------------------------------ usage history (for the chart)

type Sample = [number, number];
const historyKey = (id: ProviderId) => `wg-ai-burn-${id}`;

function readHistory(id: ProviderId): Sample[] {
  try {
    const raw = window.localStorage.getItem(historyKey(id));
    return raw ? (JSON.parse(raw) as Sample[]) : [];
  } catch {
    return [];
  }
}

/** One sample per ≥10 min (or on any change), kept for the current window only. */
function recordHistory(id: ProviderId, tier: UsageTier, now: number): void {
  const p = projection(tier, now);
  if (!p) return;
  const list = readHistory(id).filter(([t]) => t > p.start && t <= now);
  const last = list[list.length - 1];
  if (last && now - last[0] < 600_000 && last[1] === tier.percent) return;
  list.push([now, tier.percent]);
  try {
    window.localStorage.setItem(historyKey(id), JSON.stringify(list.slice(-400)));
  } catch {
    // Storage unavailable: the chart falls back to the straight line.
  }
}

function BurnChart({ id, tier, now }: { id: ProviderId; tier: UsageTier; now: number }) {
  const { t } = useI18n();
  const p = projection(tier, now);
  if (!p) return null;
  const W = 300;
  const H = 104;
  const x = (ms: number) => ((ms - p.start) / (p.end - p.start)) * W;
  const y = (pct: number) => H - (Math.min(100, Math.max(0, pct)) / 100) * (H - 8);
  const samples = readHistory(id).filter(([ts]) => ts > p.start && ts < now);
  const actual: Sample[] = [[p.start, 0], ...samples, [now, tier.percent]];
  const line = actual.map(([ts, pct], i) => `${i ? "L" : "M"}${x(ts).toFixed(1)},${y(pct).toFixed(1)}`).join(" ");
  const area = `${line} L${x(now).toFixed(1)},${H} L0,${H} Z`;
  const endPct = p.outAt ? 100 : tier.percent + p.pace * (p.end - now);
  const endX = x(p.outAt ?? p.end);
  const summary = p.outAt ? t("ai.outByPace", { when: when(p.outAt) }) : t("ai.safePace", { when: when(p.end) });
  return (
    <div className="flex flex-col gap-1">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={`${formatPercent(tier.percent)} · ${summary}`} style={{ overflow: "visible" }}>
        <defs>
          <linearGradient id={`burn-${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={GREEN} stopOpacity={0.32} />
            <stop offset="100%" stopColor={GREEN} stopOpacity={0} />
          </linearGradient>
        </defs>
        <line x1={0} x2={W} y1={y(100)} y2={y(100)} stroke="var(--lb-faint)" strokeWidth={1} strokeDasharray="2 4" />
        <text x={W} y={y(100) - 3} textAnchor="end" fontSize={9} fill="var(--lb-faint)">100%</text>
        <path d={area} fill={`url(#burn-${id})`} />
        <path d={line} fill="none" stroke={GREEN} strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" />
        <path d={`M${x(now).toFixed(1)},${y(tier.percent).toFixed(1)} L${endX.toFixed(1)},${y(endPct).toFixed(1)}`} fill="none" stroke={p.outAt ? CORAL : "var(--lb-muted)"} strokeWidth={2} strokeDasharray="4 4" strokeLinecap="round" />
        <circle cx={x(now)} cy={y(tier.percent)} r={8} fill={GREEN} opacity={0.22} />
        <circle cx={x(now)} cy={y(tier.percent)} r={3.6} fill={GREEN} />
      </svg>
      <div className="flex items-baseline gap-2 text-[11px]">
        <span className="shrink-0 tabular-nums lb-faint">{when(p.start)}</span>
        <span className="min-w-0 flex-1 truncate text-right" style={{ color: p.outAt ? CORAL : "var(--lb-muted)" }}>{summary}</span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ tile

function TierRow(props: { tier: UsageTier; now: number; long: boolean; balance?: string }) {
  const { tier, now, long, balance } = props;
  const i18n = useI18n();
  // Tier labels arrive from the backend in English; known tiers are localized by key.
  const label = i18n.td(`tier.${tier.key}`, tier.label);
  const pace = aheadOfPace(tier, now);
  const reset = balance ?? resetLabel(tier, now, long, i18n);
  return (
    <div className="flex min-w-0 items-center gap-1.5" style={{ fontSize: "var(--lb-small)", lineHeight: 1.1 }}>
      <span className="w-[44px] shrink-0 truncate lb-muted">{label}</span>
      <ProgressBar value={tier.percent} color={usageColor(tier.percent, GREEN)} height={4} className="min-w-[14px] flex-1" />
      {pace && (
        <span className="shrink-0" title={i18n.t("ai.pace")}>
          <AlertTriangle size={9} style={{ color: "var(--lb-amber)" }} />
        </span>
      )}
      {reset && <span className="shrink-0 tabular-nums lb-faint">{reset}</span>}
      <span className="w-[32px] shrink-0 whitespace-nowrap text-right font-bold tabular-nums">{formatPercent(tier.percent)}</span>
    </div>
  );
}

// ------------------------------------------------------------ flyout

function UsageDetail({ id, name, data, now, onClose }: { id: ProviderId; name: string; data: AiUsageData; now: number; onClose: () => void }) {
  const i18n = useI18n();
  const { t, td } = i18n;
  const [busy, setBusy] = useState(false);
  const chart = chartTier(data.tiers);
  const refresh = () => {
    setBusy(true);
    void ipc.refreshProvider(id).finally(() => setBusy(false));
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <BrandGlyph id={id} size={26} />
        <span className="text-[14px] font-bold">{name}</span>
        {data.plan && (
          <span className="rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize" style={{ background: "var(--lb-card-hover)" }}>
            {data.plan}
          </span>
        )}
        <span className="flex-1" />
        <button className="lb-icon-btn h-7 w-7" aria-label={t("common.close")} onClick={onClose}>
          <X size={15} strokeWidth={2.4} />
        </button>
      </div>

      <section className="flex flex-col gap-2.5">
        <h4 className="m-0 text-[10.5px] font-semibold uppercase tracking-[0.08em] lb-faint">{t("ai.section.usage")}</h4>
        {data.tiers.map((tier) => {
          const p = projection(tier, now);
          const balance = tier.key === "credits" && data.balance !== undefined ? t("ai.left", { amount: formatMoney(data.balance, data.currency ?? "USD") }) : null;
          const note = balance ?? (p?.outAt ? t("ai.outBy", { when: when(p.outAt) }) : tier.resetsAt ? t("ai.resets", { when: resetLabel(tier, now, true, i18n) }) : "");
          return (
            <div key={tier.key} className="flex flex-col gap-1">
              <div className="flex items-baseline gap-2 text-[12.5px]">
                <span className="font-semibold">{td(`tier.${tier.key}`, tier.label)}</span>
                <span className="min-w-0 flex-1 truncate text-right text-[11.5px]" style={{ color: p?.outAt ? "var(--lb-amber)" : "var(--lb-muted)" }}>
                  {note}
                </span>
                <span className="w-[38px] shrink-0 text-right font-bold tabular-nums">{formatPercent(tier.percent)}</span>
              </div>
              <ProgressBar value={tier.percent} color={usageColor(tier.percent, GREEN)} height={6} />
            </div>
          );
        })}
      </section>

      {chart && (
        <section className="flex flex-col gap-2 rounded-lg p-2.5" style={{ background: "var(--lb-card)" }}>
          <h4 className="m-0 text-[10.5px] font-semibold uppercase tracking-[0.08em] lb-faint">
            {chart.windowSeconds && chart.windowSeconds >= 6 * 86_400 ? t("ai.section.week") : t("ai.section.window")}
          </h4>
          <BurnChart id={id} tier={chart} now={now} />
        </section>
      )}

      <section className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <h4 className="m-0 text-[10.5px] font-semibold uppercase tracking-[0.08em] lb-faint">{t("ai.section.subscription")}</h4>
          <div className="truncate text-[12.5px] font-semibold capitalize">{data.plan ?? t("ai.planUnknown")}</div>
          <div className="text-[11px] lb-faint">{t("ai.sourceCaption", { name })}</div>
        </div>
        <button
          className="lb-focus flex shrink-0 items-center gap-1.5 rounded-full border-none px-3 py-1.5 text-[12px] font-semibold"
          style={{ background: "var(--lb-card-hover)", color: "var(--lb-text)" }}
          disabled={busy}
          onClick={refresh}
        >
          <RefreshCw size={12} strokeWidth={2.6} className={busy ? "animate-spin" : ""} />
          {t("ai.refresh")}
        </button>
      </section>
    </div>
  );
}

function AiUsageWidget(props: WidgetProps & { providerId: ProviderId; name: string }) {
  const { span, providerId, name } = props;
  const { t, td } = useI18n();
  const view = useProvider<AiUsageData>(providerId);
  const settings = useSettings();
  const preview = usePreview();
  const now = useNow(30_000);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const glyph = <BrandGlyph id={providerId} size={span === "1x1" ? 26 : 24} />;
  const data = view.data;

  useEffect(() => {
    const tier = data && !view.isSample ? chartTier(data.tiers) : undefined;
    if (tier) recordHistory(providerId, tier, Date.now());
  }, [data, providerId, view.isSample]);

  if (!data) {
    return <ProviderState span={span} providerId={providerId} glyph={glyph} name={name} status={view.status} error={view.error} />;
  }
  const peak = Math.max(0, ...data.tiers.map((tier) => tier.percent));
  const alert = aiAlertLevel(peak, settings?.automations.aiLimitWarning);
  const balance =
    data.balance === undefined || data.budget === undefined
      ? undefined
      : // The word only fits on the wide card; the amount alone is unambiguous next to the bar.
        span === "3x1"
        ? t("ai.left", { amount: formatMoney(data.balance, data.currency ?? "USD") })
        : formatMoney(data.balance, data.currency ?? "USD");
  const toggle = () => !preview && setOpen((o) => !o);

  let body;
  if (span === "1x1") {
    const top = [...data.tiers].sort((a, b) => b.percent - a.percent)[0];
    body = (
      <div className="flex w-full items-center gap-2">
        {glyph}
        <div className="min-w-0 flex-1 leading-tight">
          <div className="font-bold tabular-nums" style={{ fontSize: "var(--lb-large)", color: top ? usageColor(top.percent, "var(--lb-text)") : undefined }}>
            {top ? formatPercent(top.percent) : "—"}
          </div>
          <div className="truncate lb-muted" style={{ fontSize: "var(--lb-small)" }}>
            {top ? td(`tier.${top.key}`, top.label) : name}
          </div>
        </div>
      </div>
    );
  } else {
    const tiers = data.tiers.slice(0, span === "3x1" ? 3 : 2);
    body = (
      <div className="flex w-full min-w-0 items-center gap-2">
        {glyph}
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-[3px]">
          {tiers.length < 2 && (
            <div className="flex items-baseline gap-1 truncate font-semibold" style={{ fontSize: "var(--lb-small)", lineHeight: 1.1 }}>
              {name}
              {data.plan && <span className="lb-faint font-normal capitalize">{data.plan}</span>}
            </div>
          )}
          {tiers.map((tier) => (
            <TierRow key={tier.key} tier={tier} now={now} long={span === "3x1"} balance={tier.key === "credits" ? balance : undefined} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <>
      <WidgetCard span={span} cardRef={ref} alert={alert} title={view.error ?? t("ai.usage", { name })} onClick={toggle}>
        {body}
      </WidgetCard>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} width={340} testId={`ai-popover-${providerId}`}>
        <UsageDetail id={providerId} name={name} data={data} now={now} onClose={() => setOpen(false)} />
      </Popover>
    </>
  );
}

export const ClaudeWidget = (p: WidgetProps) => <AiUsageWidget {...p} providerId="claude" name="Claude" />;
export const ChatGptWidget = (p: WidgetProps) => <AiUsageWidget {...p} providerId="chatgpt" name="ChatGPT" />;
export const GeminiWidget = (p: WidgetProps) => <AiUsageWidget {...p} providerId="gemini" name="Gemini" />;
export const GrokWidget = (p: WidgetProps) => <AiUsageWidget {...p} providerId="grok" name="Grok" />;
export const DeepSeekWidget = (p: WidgetProps) => <AiUsageWidget {...p} providerId="deepseek" name="DeepSeek" />;
export const GlmWidget = (p: WidgetProps) => <AiUsageWidget {...p} providerId="glm" name="GLM" />;
