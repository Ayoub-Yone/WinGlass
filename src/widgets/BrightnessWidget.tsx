// « Luminosité »: screen brightness for the laptop panel (WMI) and external monitors (DDC/CI),
// see win32/brightness.rs. Wheel over the tile: ±5 % on every display; click: one slider per
// display. DDC/CI is slow, so writes are coalesced per display (one in flight, latest value next).

import { Sun, SunDim } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Popover, WidgetCard } from "../components/ui";
import { getHub } from "../engine/DataHub";
import { useI18n } from "../i18n";
import { formatPercent } from "../lib/format";
import { errorMessage, ipc } from "../lib/ipc";
import { usePreview } from "../lib/hooks";
import type { BrightnessDisplay, WidgetProps } from "../types/lumabar";

const SAMPLE: BrightnessDisplay[] = [{ id: "internal", name: "", internal: true, percent: 70 }];
const WHEEL_STEP = 5;

/** One write in flight per display; the newest requested value is sent next. */
function useCoalescedWriter(onResult: (d: BrightnessDisplay) => void, onError: (e: string) => void) {
  const state = useRef(new Map<string, { busy: boolean; next: number | null }>());
  return useCallback(
    (id: string, percent: number) => {
      const s = state.current.get(id) ?? { busy: false, next: null };
      state.current.set(id, s);
      if (s.busy) {
        s.next = percent;
        return;
      }
      const send = (value: number) => {
        s.busy = true;
        ipc
          .setBrightness(id, value)
          .then(onResult)
          .catch((e) => onError(errorMessage(e)))
          .finally(() => {
            s.busy = false;
            if (s.next !== null) {
              const v = s.next;
              s.next = null;
              send(v);
            }
          });
      };
      send(percent);
    },
    [onResult, onError],
  );
}

export function BrightnessWidget({ span, preview: previewProp }: WidgetProps) {
  const { t } = useI18n();
  const preview = usePreview() || Boolean(previewProp);
  const [displays, setDisplays] = useState<BrightnessDisplay[] | null>(preview ? SAMPLE : null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const card = useRef<HTMLDivElement | null>(null);
  const latest = useRef(displays);
  latest.current = displays;

  const load = useCallback(() => {
    if (preview || getHub().fullscreen) return;
    ipc
      .getBrightness()
      .then((list) => {
        setDisplays(list);
        setError(null);
      })
      .catch((e) => setError(errorMessage(e)));
  }, [preview]);

  useEffect(() => {
    load();
    // Brightness also changes from the keyboard / monitor buttons: re-read now and then.
    const timer = window.setInterval(load, 60_000);
    return () => window.clearInterval(timer);
  }, [load]);
  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const onResult = useCallback((d: BrightnessDisplay) => setDisplays((list) => list?.map((x) => (x.id === d.id ? { ...x, percent: d.percent } : x)) ?? list), []);
  const write = useCoalescedWriter(onResult, setError);

  const setOne = (id: string, percent: number) => {
    const p = Math.max(0, Math.min(100, Math.round(percent)));
    setDisplays((list) => list?.map((x) => (x.id === id ? { ...x, percent: p } : x)) ?? list);
    if (!preview) write(id, p);
  };

  // Native non-passive wheel listener: the wheel changes brightness instead of scrolling the dock.
  useEffect(() => {
    const el = card.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const step = e.deltaY < 0 ? WHEEL_STEP : -WHEEL_STEP;
      const next = (latest.current ?? []).map((d) => ({ ...d, percent: Math.max(0, Math.min(100, d.percent + step)) }));
      latest.current = next;
      setDisplays(next);
      if (!preview) next.forEach((d) => write(d.id, d.percent));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [write, preview]);

  const list = displays ?? [];
  const main = list[0];
  const label = (d: BrightnessDisplay, i: number) => (d.internal ? t("brightness.internal") : list.length > 1 || !d.name || d.name.startsWith("#") ? t("brightness.monitor", { n: i + 1 - (list[0]?.internal ? 1 : 0) }) : d.name);
  const Icon = main && main.percent < 40 ? SunDim : Sun;

  return (
    <>
      <WidgetCard span={span} cardRef={card} title={error ?? t("widget.brightness.name")} onClick={() => !preview && list.length > 0 && setOpen((o) => !o)}>
        <div data-testid="brightness-tile" className="flex w-full min-w-0 items-center gap-2">
          <Icon size={18} className="shrink-0" style={{ color: "var(--lb-amber)" }} />
          {span === "1x1" ? (
            <div className="min-w-0 leading-tight">
              <div className="font-semibold tabular-nums" style={{ fontSize: "var(--lb-large)" }}>
                {main ? formatPercent(main.percent) : "—"}
              </div>
              <div className="truncate lb-muted" style={{ fontSize: "var(--lb-small)" }}>
                {main ? t("brightness.short") : displays ? t("brightness.none") : t("brightness.short")}
              </div>
            </div>
          ) : (
            <div className="flex min-w-0 flex-1 items-center gap-2">
              {main ? (
                <>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={main.percent}
                    aria-label={t("widget.brightness.name")}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => list.forEach((d) => setOne(d.id, Number(e.target.value)))}
                    className="min-w-0 flex-1"
                    style={{ accentColor: "var(--lb-amber)" }}
                  />
                  <span className="w-[38px] shrink-0 text-right font-semibold tabular-nums">{formatPercent(main.percent)}</span>
                </>
              ) : (
                <span className="truncate lb-muted" style={{ fontSize: "var(--lb-small)" }}>
                  {displays ? t("brightness.none") : "—"}
                </span>
              )}
            </div>
          )}
        </div>
      </WidgetCard>
      <Popover anchor={card} open={open && !preview} onClose={() => setOpen(false)} width={300}>
        <div data-testid="brightness-popover" className="flex flex-col gap-3">
          <div className="font-semibold">{t("widget.brightness.name")}</div>
          {list.map((d, i) => (
            <div key={d.id} className="flex flex-col gap-1">
              <div className="flex justify-between gap-2" style={{ fontSize: "var(--lb-small)" }}>
                <span className="truncate">{label(d, i)}</span>
                <span className="shrink-0 tabular-nums lb-muted">{formatPercent(d.percent)}</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={d.percent}
                data-testid="brightness-slider"
                aria-label={label(d, i)}
                onChange={(e) => setOne(d.id, Number(e.target.value))}
                style={{ accentColor: "var(--lb-amber)" }}
              />
            </div>
          ))}
          <div className="lb-faint" style={{ fontSize: "calc(var(--lb-small) - 1px)" }}>
            {t("brightness.hint")}
          </div>
          {error && (
            <div className="truncate" style={{ fontSize: "var(--lb-small)", color: "var(--lb-red)" }} title={error}>
              {error}
            </div>
          )}
        </div>
      </Popover>
    </>
  );
}
