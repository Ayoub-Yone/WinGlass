// Screen Time: total foreground time today + hourly histogram; popover lists top apps / domains.

import { Hourglass } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Popover, WidgetCard } from "../components/ui";
import { useI18n } from "../i18n";
import { formatDuration } from "../lib/format";
import { ipc } from "../lib/ipc";
import { usePreview } from "../lib/hooks";
import type { ScreenTimeDay, WidgetProps } from "../types/lumabar";

const SAMPLE: ScreenTimeDay = {
  day: "",
  totalSeconds: 21_900,
  hourly: [0, 0, 0, 0, 0, 0, 0, 0, 1800, 3000, 3300, 2400, 1200, 2700, 3200, 2600, 1100, 600, 0, 0, 0, 0, 0, 0],
  topApps: [
    { app: "Code", domain: null, seconds: 9200 },
    { app: "chrome", domain: "github.com", seconds: 4100 },
    { app: "Figma", domain: null, seconds: 3300 },
  ],
};

export function ScreenTimeWidget({ span }: WidgetProps) {
  const preview = usePreview();
  const { t, lang } = useI18n();
  const [data, setData] = useState<ScreenTimeDay | null>(preview ? SAMPLE : null);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      ipc
        .getScreenTime()
        .then((d) => alive && setData(preview && d.totalSeconds === 0 ? SAMPLE : d))
        .catch(() => undefined);
    void load();
    const t = window.setInterval(load, 30_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [preview]);

  const hourly = data?.hourly ?? new Array<number>(24).fill(0);
  const currentHour = new Date().getHours();
  // 3x1 shows the whole day; smaller spans show the 12 hours leading up to now.
  const offset = span === "3x1" ? 0 : Math.max(0, currentHour - 11);
  const visible = span === "3x1" ? hourly : hourly.slice(offset, offset + 12);
  const max = Math.max(3600, ...visible);
  const hourSuffix = lang === "fr" ? " h" : ":00";

  return (
    <>
      <WidgetCard span={span} cardRef={ref} title={t("widget.screen-time.name")} onClick={() => !preview && setOpen((o) => !o)}>
        <div className="flex h-full w-full items-center gap-2">
          <Hourglass size={18} className="shrink-0" style={{ color: "var(--lb-accent)" }} />
          <div className="min-w-0 shrink-0 leading-tight">
            <div className="whitespace-nowrap lb-muted" style={{ fontSize: "var(--lb-small)" }}>
              {span === "1x1" ? t("screenTime.short") : t("screenTime.label")}
            </div>
            <div className="font-semibold tabular-nums" style={{ fontSize: "var(--lb-large)" }}>
              {data ? formatDuration(data.totalSeconds) : "—"}
            </div>
          </div>
          {span !== "1x1" && (
            <div className="flex h-[62%] min-w-0 flex-1 items-end gap-[2px]">
              {visible.map((v, i) => (
                <div
                  key={i}
                  className="flex-1 rounded-[2px]"
                  title={`${i + offset}${hourSuffix} · ${formatDuration(v)}`}
                  style={{
                    height: `${Math.max(6, (v / max) * 100)}%`,
                    background: i + offset === currentHour ? "var(--lb-accent)" : v > 0 ? "var(--lb-muted)" : "var(--lb-track)",
                    opacity: v > 0 ? 1 : 0.6,
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </WidgetCard>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} width={280}>
        <div className="mb-2 flex items-baseline justify-between">
          <span className="font-semibold">{t("common.today")}</span>
          <span className="tabular-nums lb-muted">{data ? formatDuration(data.totalSeconds) : "—"}</span>
        </div>
        {data && data.topApps.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            {data.topApps.map((a) => (
              <div key={`${a.app}-${a.domain ?? ""}`} className="flex flex-col gap-0.5">
                <div className="flex justify-between gap-2">
                  <span className="truncate">{a.domain ?? a.app}</span>
                  <span className="shrink-0 tabular-nums lb-muted">{formatDuration(a.seconds)}</span>
                </div>
                <div className="h-[3px] rounded-full" style={{ background: "var(--lb-track)" }}>
                  <div className="h-full rounded-full" style={{ width: `${(a.seconds / data.topApps[0].seconds) * 100}%`, background: "var(--lb-accent)" }} />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="lb-muted">{t("screenTime.empty")}</div>
        )}
        <div className="mt-2 lb-faint" style={{ fontSize: "var(--lb-small)" }}>
          {t("screenTime.local")}
        </div>
      </Popover>
    </>
  );
}
