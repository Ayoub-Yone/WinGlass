// "Open apps" box on the right side of the dock: mini icons of every open application window
// (up to 4 — 2 in a 1x1 card — plus a "+N" badge), refreshed every second and on each foreground
// change. Clicking it opens a frosted panel listing every window with icon, app name, window title
// and focus dot: one click focuses / restores, the hover × closes (WM_CLOSE). Outside click / Esc
// dismiss it.

import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AppIcon } from "../components/AppIcon";
import { Popover, WidgetCard } from "../components/ui";
import { useI18n } from "../i18n";
import { errorMessage, ipc, subscribe } from "../lib/ipc";
import { useNow, usePreview } from "../lib/hooks";
import type { OpenApp, WidgetProps } from "../types/lumabar";

const SAMPLE: OpenApp[] = [
  { hwnd: 1, pid: 1, exe: "", name: "Explorateur de fichiers", title: "Téléchargements", isFocused: true, isMinimized: false, iconKey: "" },
  { hwnd: 2, pid: 2, exe: "", name: "Google Chrome", title: "lumabar — GitHub", isFocused: false, isMinimized: false, iconKey: "" },
  { hwnd: 3, pid: 3, exe: "", name: "Discord", title: "#general", isFocused: false, isMinimized: true, iconKey: "" },
  { hwnd: 4, pid: 4, exe: "", name: "Visual Studio Code", title: "VolumeWidget.tsx", isFocused: false, isMinimized: false, iconKey: "" },
  { hwnd: 5, pid: 5, exe: "", name: "Spotify", title: "Spotify Premium", isFocused: false, isMinimized: false, iconKey: "" },
];

/** How many mini icons fit, and how many apps are left for the "+N" badge. */
export function miniIcons(count: number, span: string): { shown: number; more: number } {
  const max = span === "1x1" ? 2 : 4;
  const shown = Math.min(count, count > max ? max - 1 : max);
  return { shown, more: count - shown };
}

function useOpenApps(enabled: boolean): [OpenApp[], () => void] {
  const [apps, setApps] = useState<OpenApp[]>([]);
  const tick = useNow(1000);
  const [bump, setBump] = useState(0);
  useEffect(() => (enabled ? subscribe("apps:foreground", () => setBump((b) => b + 1)) : undefined), [enabled]);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void ipc
      .getOpenApps()
      .then((list) => alive && setApps(list))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [enabled, tick, bump]);
  return [apps, () => setBump((b) => b + 1)];
}

export function ActiveAppsWidget({ span, preview: previewProp }: WidgetProps) {
  const { t } = useI18n();
  const preview = usePreview() || !!previewProp;
  const [live, refresh] = useOpenApps(!preview);
  const apps = preview ? SAMPLE : live;
  const ref = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { shown, more } = miniIcons(apps.length, span);

  const focusApp = (app: OpenApp) => {
    setError(null);
    ipc
      .focusAppWindow(app.hwnd)
      .then(() => setOpen(false))
      .catch((e) => setError(errorMessage(e)));
  };

  const closeApp = (app: OpenApp) => {
    setError(null);
    ipc
      .closeAppWindow(app.hwnd)
      .then(() => window.setTimeout(refresh, 350))
      .catch((e) => setError(errorMessage(e)));
  };

  return (
    <>
      <WidgetCard
        span={span}
        cardRef={ref}
        title={apps.length ? t("apps.count", { n: apps.length }) : t("apps.noneOpen")}
        onClick={() => !preview && setOpen((o) => !o)}
        className="cursor-pointer justify-center"
      >
        <div data-testid="open-apps-box" className="flex min-w-0 items-center gap-1.5">
          {apps.length === 0 && <span className="truncate lb-muted" style={{ fontSize: "var(--lb-small)" }}>{t("apps.noneOpen")}</span>}
          {apps.slice(0, shown).map((app) => (
            <span key={app.hwnd} className="relative flex shrink-0 items-center justify-center" style={{ opacity: app.isMinimized ? 0.55 : 1 }}>
              <AppIcon iconKey={app.iconKey} size={20} />
              {app.isFocused && <span className="absolute -bottom-1 h-[3px] w-2 rounded-full" style={{ background: "var(--lb-accent)" }} />}
            </span>
          ))}
          {more > 0 && (
            <span
              data-testid="open-apps-more"
              className="shrink-0 rounded-md px-1 font-semibold tabular-nums"
              style={{ fontSize: "var(--lb-small)", background: "var(--lb-track)" }}
            >
              +{more}
            </span>
          )}
        </div>
      </WidgetCard>
      <Popover anchor={ref} open={open && !preview} onClose={() => setOpen(false)} width={360}>
        <div data-testid="open-apps-panel" className="flex flex-col gap-1">
          <div className="mb-0.5 flex items-center justify-between px-1">
            <span className="font-semibold">{t("apps.title")}</span>
            <span className="lb-faint tabular-nums" style={{ fontSize: "var(--lb-small)" }}>{apps.length}</span>
          </div>
          <div className="lb-thin-scroll flex max-h-[380px] flex-col gap-0.5 overflow-y-auto">
            {apps.length === 0 && <div className="px-2 py-1.5 lb-muted">{t("apps.noneOpen")}</div>}
            {apps.map((app) => (
              <div
                key={app.hwnd}
                data-testid="open-app-row"
                data-active={app.isFocused}
                className="lb-row group flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5"
                onClick={() => focusApp(app)}
              >
                <span className="relative shrink-0" style={{ opacity: app.isMinimized ? 0.6 : 1 }}>
                  <AppIcon iconKey={app.iconKey} size={24} />
                </span>
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="block truncate font-medium">{app.name}</span>
                  <span className="block truncate lb-faint" style={{ fontSize: "var(--lb-small)" }} title={app.title}>
                    {app.isMinimized ? `${t("apps.minimized")} · ${app.title}` : app.title}
                  </span>
                </span>
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: app.isFocused ? "var(--lb-accent)" : app.isMinimized ? "transparent" : "var(--lb-faint)" }}
                />
                <button
                  data-testid="open-app-close"
                  className="lb-icon-btn h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  title={t("apps.close")}
                  aria-label={t("apps.close")}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeApp(app);
                  }}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
          {error && (
            <div className="truncate px-2" style={{ fontSize: "var(--lb-small)", color: "var(--lb-red)" }} title={error}>
              {error}
            </div>
          )}
        </div>
      </Popover>
    </>
  );
}
