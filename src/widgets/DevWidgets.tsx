// Developer widgets: GitHub contribution heatmap + notifications, LeetCode, custom API counter.

import { Activity } from "lucide-react";
import { BrandGlyph, ProviderState, WidgetCard } from "../components/ui";
import { useI18n } from "../i18n";
import { formatCount, formatSigned } from "../lib/format";
import { ipc } from "../lib/ipc";
import { usePreview, useProvider } from "../lib/hooks";
import type { ApiCounterData, GithubData, LeetcodeData, WidgetProps } from "../types/winglass";

const GREENS = ["var(--lb-track)", "#0E4429", "#006D32", "#26A641", "#39D353"];

function level(count: number, max: number): number {
  if (count <= 0) return 0;
  const q = count / Math.max(1, max);
  if (q > 0.75) return 4;
  if (q > 0.5) return 3;
  if (q > 0.25) return 2;
  return 1;
}

export function GithubWidget({ span }: WidgetProps) {
  const { t } = useI18n();
  const view = useProvider<GithubData>("github");
  const preview = usePreview();
  const glyph = <BrandGlyph id="github" size={22} />;
  if (!view.data) return <ProviderState span={span} providerId="github" glyph={glyph} name="GitHub" status={view.status} error={view.error} />;
  const d = view.data;
  const weeks = span === "3x1" ? d.weeks.slice(-48) : span === "2x1" ? d.weeks.slice(-26) : d.weeks.slice(-10);
  const max = Math.max(1, ...d.weeks.flat());
  return (
    <WidgetCard
      span={span}
      title={view.error ?? t("github.contributions", { count: formatCount(d.total) })}
      onClick={() => !preview && void ipc.openTarget(d.notifications > 0 ? "https://github.com/notifications" : `https://github.com/${d.login}`)}
    >
      <div className="flex h-full w-full items-center gap-2">
        <div className="relative shrink-0">
          {glyph}
          {d.notifications > 0 && (
            <span
              className="absolute -right-1.5 -top-1.5 min-w-[15px] rounded-full px-1 text-center font-bold text-white"
              style={{ background: "var(--lb-accent)", fontSize: 9, lineHeight: "15px" }}
            >
              {d.notificationsMore ? "50+" : d.notifications}
            </span>
          )}
        </div>
        <div className="grid h-[calc(100%-8px)] min-w-0 flex-1 grid-flow-col gap-[1.5px]" style={{ gridTemplateRows: "repeat(7, 1fr)" }}>
          {weeks.flatMap((week, w) =>
            Array.from({ length: 7 }, (_, day) => {
              const count = week[day] ?? 0;
              return (
                <div
                  key={`${w}-${day}`}
                  className="aspect-square rounded-[1.5px]"
                  style={{ background: week[day] === undefined ? "transparent" : GREENS[level(count, max)] }}
                />
              );
            }),
          )}
        </div>
      </div>
    </WidgetCard>
  );
}

export function LeetcodeWidget({ span }: WidgetProps) {
  const { t } = useI18n();
  const view = useProvider<LeetcodeData>("leetcode");
  const preview = usePreview();
  const glyph = <BrandGlyph id="leetcode" size={22} />;
  if (!view.data) {
    return <ProviderState span={span} providerId="leetcode" glyph={glyph} name="LeetCode" status={view.status} error={view.error} tab="integrations" />;
  }
  const d = view.data;
  const total = Math.max(1, d.easy + d.medium + d.hard);
  return (
    <WidgetCard span={span} title={view.error ?? `${d.username} · ${formatCount(d.solved)} ${t("leetcode.solved")} · ${t("leetcode.streak", { count: d.streak })}`} onClick={() => !preview && void ipc.openTarget(`https://leetcode.com/u/${d.username}/`)}>
      <div className="flex w-full min-w-0 items-center gap-2">
        {glyph}
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate font-semibold tabular-nums">
            {formatCount(d.solved)}{span !== "1x1" && <span className="font-normal lb-muted"> {t("leetcode.solved")}</span>}
          </div>
          <div className="truncate tabular-nums" style={{ fontSize: "var(--lb-small)", color: "#FFA116" }}>
            🔥 {span === "1x1" ? d.streak : t("leetcode.streak", { count: d.streak })}
          </div>
        </div>
        {span !== "1x1" && (
          <div className="flex h-[5px] w-[44px] shrink-0 overflow-hidden rounded-full" title={t("leetcode.breakdown", { easy: d.easy, medium: d.medium, hard: d.hard })}>
            <div style={{ width: `${(d.easy / total) * 100}%`, background: "#00B8A3" }} />
            <div style={{ width: `${(d.medium / total) * 100}%`, background: "#FFC01E" }} />
            <div style={{ width: `${(d.hard / total) * 100}%`, background: "#FF375F" }} />
          </div>
        )}
      </div>
    </WidgetCard>
  );
}

export function ApiCounterWidget({ span }: WidgetProps) {
  const { t } = useI18n();
  const view = useProvider<ApiCounterData>("api_counter");
  const glyph = (
    <div className="flex h-[22px] w-[22px] items-center justify-center rounded-[7px]" style={{ background: "var(--lb-accent)" }}>
      <Activity size={13} color="#fff" />
    </div>
  );
  if (!view.data) {
    return <ProviderState span={span} providerId="api_counter" glyph={glyph} name={t("widget.api-counter.name")} status={view.status} error={view.error} tab="integrations" />;
  }
  const d = view.data;
  return (
    <WidgetCard span={span} title={view.error ?? d.label}>
      <div className="flex min-w-0 items-center gap-2">
        {glyph}
        <div className="min-w-0 leading-tight">
          <div className="font-semibold tabular-nums" style={{ fontSize: "var(--lb-large)" }}>
            {formatCount(d.value)}
          </div>
          <div className="truncate" style={{ fontSize: "var(--lb-small)" }}>
            <span className="lb-muted">{span === "1x1" ? "" : `${d.label} · `}</span>
            <span style={{ color: "var(--lb-green)" }}>{formatSigned(d.deltaToday)}</span>
          </div>
        </div>
      </div>
    </WidgetCard>
  );
}
