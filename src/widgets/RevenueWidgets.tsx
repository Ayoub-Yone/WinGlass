// Founder revenue metrics: Stripe, Polar, Dodo Payments, DataFast.
// 1x1: 30-day total · 2x1: total + sparkline + delta · 3x1: total, goal ring, net sparkline.

import { BrandGlyph, ProviderState, Ring, Sparkline, WidgetCard } from "../components/ui";
import { useI18n } from "../i18n";
import { formatMoney, formatPercent } from "../lib/format";
import { useProvider } from "../lib/hooks";
import type { ProviderId, RevenueData, WidgetProps } from "../types/lumabar";

function Delta({ value }: { value: number }) {
  const up = value >= 0;
  return (
    <span className="font-semibold tabular-nums" style={{ color: up ? "var(--lb-green)" : "var(--lb-red)" }}>
      {up ? "▲" : "▼"} {formatPercent(Math.abs(value))}
    </span>
  );
}

function RevenueWidget(props: WidgetProps & { providerId: ProviderId; name: string }) {
  const { span, providerId, name } = props;
  const { t } = useI18n();
  const view = useProvider<RevenueData>(providerId);
  const glyph = <BrandGlyph id={providerId} size={22} />;
  if (!view.data) {
    return <ProviderState span={span} providerId={providerId} glyph={glyph} name={name} status={view.status} error={view.error} />;
  }
  const d = view.data;
  const goalPct = d.goal > 0 ? (d.total30d / d.goal) * 100 : 0;
  const color = d.deltaPercent >= 0 ? "var(--lb-green)" : "var(--lb-red)";

  const total = (
    <div className="min-w-0 leading-tight">
      <div className="font-semibold tabular-nums" style={{ fontSize: "var(--lb-large)" }}>
        {formatMoney(d.total30d, d.currency, true)}
      </div>
      <div className="truncate lb-muted" style={{ fontSize: "var(--lb-small)" }}>
        {span === "1x1" ? t("revenue.days30") : span === "3x1" ? t("revenue.providerDaysShort", { name }) : t("revenue.providerDays30", { name })}
      </div>
    </div>
  );

  if (span === "1x1") {
    return (
      <WidgetCard span={span} title={view.error ?? t("revenue.title", { name })}>
        <div className="flex min-w-0 items-center gap-2">
          {glyph}
          {total}
        </div>
      </WidgetCard>
    );
  }

  if (span === "2x1") {
    return (
      <WidgetCard span={span} title={view.error ?? t("revenue.title", { name })}>
        <div className="flex w-full items-center gap-2">
          {glyph}
          {total}
          <div className="ml-auto flex shrink-0 flex-col items-end gap-0.5" style={{ fontSize: "var(--lb-small)" }}>
            <Sparkline values={d.daily} width={58} height={16} color={color} />
            <Delta value={d.deltaPercent} />
          </div>
        </div>
      </WidgetCard>
    );
  }

  return (
    <WidgetCard span={span} title={view.error ?? t("revenue.title", { name })}>
      <div className="flex w-full items-center gap-2.5">
        {glyph}
        {total}
        <div className="flex min-w-0 items-center gap-1.5">
          <Ring value={goalPct} size={28} stroke={3.5} color="var(--lb-accent)" />
          <div className="min-w-0 leading-tight" style={{ fontSize: "var(--lb-small)" }}>
            <div className="truncate tabular-nums">
              {t("revenue.of", { current: formatMoney(d.total30d, d.currency, true), goal: formatMoney(d.goal, d.currency, true) })}
            </div>
            <div className="truncate lb-muted">{t("revenue.goal", { percent: Math.round(goalPct) })}</div>
          </div>
        </div>
        <div className="ml-auto flex shrink-0 flex-col items-end gap-0.5" style={{ fontSize: "var(--lb-small)" }}>
          <Sparkline values={d.daily} width={56} height={15} color={color} />
          <span className="tabular-nums">
            {formatMoney(d.net30d, d.currency, true)} <Delta value={d.deltaPercent} />
          </span>
        </div>
      </div>
    </WidgetCard>
  );
}

export const StripeWidget = (p: WidgetProps) => <RevenueWidget {...p} providerId="stripe" name="Stripe" />;
export const PolarWidget = (p: WidgetProps) => <RevenueWidget {...p} providerId="polar" name="Polar" />;
export const DodoWidget = (p: WidgetProps) => <RevenueWidget {...p} providerId="dodo" name="Dodo" />;
export const DataFastWidget = (p: WidgetProps) => <RevenueWidget {...p} providerId="datafast" name="DataFast" />;
