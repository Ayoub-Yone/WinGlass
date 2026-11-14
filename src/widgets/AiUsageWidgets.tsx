// AI usage-limit trackers: Claude (Session / Weekly / Opus), ChatGPT, Gemini (Pro / Flash),
// Grok, DeepSeek, GLM. Bars escalate green → amber → red, show reset countdowns, and flag tiers
// whose burn pace would exhaust them before the window resets.

import { AlertTriangle } from "lucide-react";
import { BrandGlyph, ProgressBar, ProviderState, WidgetCard, usageColor } from "../components/ui";
import { useI18n, type I18n } from "../i18n";
import { formatMoney, formatPercent, formatResetIn, formatTime, formatWeekdayShort } from "../lib/format";
import { useNow, useProvider } from "../lib/hooks";
import type { AiUsageData, ProviderId, UsageTier, WidgetProps } from "../types/lumabar";

const TIER_BASE: Record<string, string> = {
  five_hour: "var(--lb-green)",
  seven_day: "var(--lb-amber)",
  seven_day_opus: "var(--lb-purple)",
  primary_window: "var(--lb-green)",
  secondary_window: "var(--lb-amber)",
  pro: "#4F8DF7",
  flash: "var(--lb-green)",
  tokens: "var(--lb-green)",
  mcp: "var(--lb-purple)",
  credits: "var(--lb-accent)",
};

/** True when usage is running ahead of the elapsed share of the window by ≥15 points. */
export function aheadOfPace(tier: UsageTier, now: number): boolean {
  if (!tier.windowSeconds || !tier.resetsAt || tier.percent < 40) return false;
  const remaining = (new Date(tier.resetsAt).getTime() - now) / 1000;
  const elapsed = 1 - remaining / tier.windowSeconds;
  if (elapsed <= 0 || elapsed > 1) return false;
  return tier.percent - elapsed * 100 >= 15;
}

function resetLabel(tier: UsageTier, now: number, long: boolean, i18n: I18n): string {
  if (!tier.resetsAt) return "";
  if (!long) return formatResetIn(tier.resetsAt, now);
  const d = new Date(tier.resetsAt);
  const hours = (d.getTime() - now) / 3_600_000;
  if (hours < 24) return i18n.t("ai.resetIn", { time: formatResetIn(tier.resetsAt, now) });
  return `${formatWeekdayShort(d)} ${formatTime(d)}`;
}

function TierRow(props: { tier: UsageTier; now: number; long: boolean; balance?: string }) {
  const { tier, now, long, balance } = props;
  const i18n = useI18n();
  // Tier labels arrive from the backend in English; known tiers are localized by key.
  const label = i18n.td(`tier.${tier.key}`, tier.label);
  const color = usageColor(tier.percent, TIER_BASE[tier.key] ?? "var(--lb-green)");
  const pace = aheadOfPace(tier, now);
  const reset = balance ?? resetLabel(tier, now, long, i18n);
  return (
    <div className="flex min-w-0 items-center gap-1.5" style={{ fontSize: "var(--lb-small)", lineHeight: 1.1 }}>
      <span className="w-[42px] shrink-0 truncate lb-muted">{label}</span>
      <ProgressBar value={tier.percent} color={color} height={4} className="min-w-[30px] flex-1" />
      {pace && (
        <span title={i18n.t("ai.pace")}>
          <AlertTriangle size={9} style={{ color: "var(--lb-amber)" }} />
        </span>
      )}
      {reset && <span className="shrink-0 tabular-nums lb-faint">{reset}</span>}
      <span className="w-[32px] shrink-0 whitespace-nowrap text-right font-semibold tabular-nums">{formatPercent(tier.percent)}</span>
    </div>
  );
}

function AiUsageWidget(props: WidgetProps & { providerId: ProviderId; name: string }) {
  const { span, providerId, name } = props;
  const { t, td } = useI18n();
  const view = useProvider<AiUsageData>(providerId);
  const now = useNow(30_000);
  const glyph = <BrandGlyph id={providerId} size={span === "1x1" ? 26 : 22} />;

  if (!view.data) {
    return <ProviderState span={span} providerId={providerId} glyph={glyph} name={name} status={view.status} error={view.error} />;
  }
  const data = view.data;
  const balance =
    data.balance === undefined || data.budget === undefined
      ? undefined
      : // The word only fits on the wide card; the amount alone is unambiguous next to the bar.
        span === "3x1"
        ? t("ai.left", { amount: formatMoney(data.balance, data.currency ?? "USD") })
        : formatMoney(data.balance, data.currency ?? "USD");

  if (span === "1x1") {
    const top = [...data.tiers].sort((a, b) => b.percent - a.percent)[0];
    return (
      <WidgetCard span={span} title={view.error ?? t("ai.usage", { name })}>
        <div className="flex w-full items-center gap-2">
          {glyph}
          <div className="min-w-0 flex-1 leading-tight">
            <div className="font-semibold tabular-nums" style={{ fontSize: "var(--lb-large)", color: top ? usageColor(top.percent, "var(--lb-text)") : undefined }}>
              {top ? formatPercent(top.percent) : "—"}
            </div>
            <div className="truncate lb-muted" style={{ fontSize: "var(--lb-small)" }}>
              {top ? td(`tier.${top.key}`, top.label) : name}
            </div>
          </div>
        </div>
      </WidgetCard>
    );
  }

  const tiers = data.tiers.slice(0, 3);
  return (
    <WidgetCard span={span} title={view.error ?? t("ai.usage", { name })}>
      <div className="flex w-full min-w-0 items-center gap-2">
        {glyph}
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-[2px]">
          {tiers.length < 3 && (
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
    </WidgetCard>
  );
}

export const ClaudeWidget = (p: WidgetProps) => <AiUsageWidget {...p} providerId="claude" name="Claude" />;
export const ChatGptWidget = (p: WidgetProps) => <AiUsageWidget {...p} providerId="chatgpt" name="ChatGPT" />;
export const GeminiWidget = (p: WidgetProps) => <AiUsageWidget {...p} providerId="gemini" name="Gemini" />;
export const GrokWidget = (p: WidgetProps) => <AiUsageWidget {...p} providerId="grok" name="Grok" />;
export const DeepSeekWidget = (p: WidgetProps) => <AiUsageWidget {...p} providerId="deepseek" name="DeepSeek" />;
export const GlmWidget = (p: WidgetProps) => <AiUsageWidget {...p} providerId="glm" name="GLM" />;
