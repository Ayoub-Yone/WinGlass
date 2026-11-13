// Pinned taskbar shortcuts + live top-level windows, with running / focused indicator dots.
// Click: launch (not running) · focus / minimize (one window) · window list (several windows).
// Middle-click: start a new instance.

import { AppWindow as AppWindowIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Popover } from "../components/ui";
import { errorMessage, ipc, subscribe } from "../lib/ipc";
import { usePreview } from "../lib/hooks";
import type { AppEntry, WidgetProps } from "../types/lumabar";

/** Successful icons only; misses are retried (the backend may be busy or the file still loading). */
const iconCache = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();

function fetchIcon(key: string): Promise<string | null> {
  let p = inflight.get(key);
  if (!p) {
    p = ipc
      .getAppIcon(key)
      .catch(() => null)
      .then((url) => {
        inflight.delete(key);
        if (url) iconCache.set(key, url);
        return url;
      });
    inflight.set(key, p);
  }
  return p;
}

function useIcon(key: string): string | null {
  const [src, setSrc] = useState<string | null>(() => iconCache.get(key) ?? null);
  useEffect(() => {
    const cached = iconCache.get(key);
    if (cached) {
      setSrc(cached);
      return;
    }
    let alive = true;
    let attempts = 0;
    let timer = 0;
    const attempt = () => {
      attempts += 1;
      void fetchIcon(key).then((url) => {
        if (!alive) return;
        if (url) setSrc(url);
        else if (attempts < 4) timer = window.setTimeout(attempt, 2500 * attempts);
      });
    };
    attempt();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [key]);
  return src;
}

function AppButton({ app, onError }: { app: AppEntry; onError: (msg: string) => void }) {
  const icon = useIcon(app.iconKey);
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLButtonElement | null>(null);
  const running = app.windows.length > 0;
  const allMinimized = running && app.windows.every((w) => w.isMinimized);

  const launch = () => {
    const target = app.pinnedPath ?? app.exePath;
    if (target) ipc.launchApp(target).catch((e) => onError(errorMessage(e)));
  };

  const click = () => {
    if (!running) return launch();
    if (app.windows.length === 1) {
      ipc.activateWindow(app.windows[0].hwnd).catch((e) => onError(errorMessage(e)));
      return;
    }
    setMenu((m) => !m);
  };

  return (
    <>
      <button
        ref={ref}
        className="lb-icon-btn lb-focus relative flex h-full shrink-0 flex-col items-center justify-center rounded-[12px]"
        style={{ width: "calc(var(--lb-icon) + 12px)" }}
        title={app.windows.length === 1 ? app.windows[0].title : app.name}
        onClick={click}
        onAuxClick={(e) => {
          if (e.button === 1) launch();
        }}
      >
        {icon ? (
          <img
            src={icon}
            alt=""
            draggable={false}
            style={{ width: "var(--lb-icon)", height: "var(--lb-icon)", opacity: allMinimized ? 0.72 : 1, imageRendering: "auto" }}
          />
        ) : (
          <AppWindowIcon style={{ width: "var(--lb-icon)", height: "var(--lb-icon)" }} className="lb-muted" />
        )}
        <span
          className="absolute bottom-[2px] left-1/2 h-[3px] -translate-x-1/2 rounded-full"
          style={{
            width: app.isActive ? 14 : running ? 4 : 0,
            background: app.isActive ? "var(--lb-accent)" : "var(--lb-muted)",
            opacity: running ? 1 : 0,
            transition: "width 220ms cubic-bezier(0.2, 0.9, 0.3, 1.2), opacity 160ms ease",
          }}
        />
      </button>
      <Popover anchor={ref} open={menu} onClose={() => setMenu(false)} width={260}>
        <div className="mb-1 truncate px-1 font-semibold">{app.name}</div>
        {app.windows.map((w) => (
          <button
            key={w.hwnd}
            className="lb-card flex w-full items-center gap-2 rounded-lg border-none px-2 py-1.5 text-left"
            onClick={() => {
              setMenu(false);
              ipc.activateWindow(w.hwnd).catch((e) => onError(errorMessage(e)));
            }}
          >
            <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: w.isActive ? "var(--lb-accent)" : "var(--lb-muted)" }} />
            <span className={`truncate ${w.isMinimized ? "lb-muted" : ""}`}>{w.title}</span>
          </button>
        ))}
        <button className="lb-card mt-1 w-full rounded-lg border-none px-2 py-1.5 text-left lb-muted" onClick={() => { setMenu(false); launch(); }}>
          New window
        </button>
      </Popover>
    </>
  );
}

export function PinnedRunningApps({ preview: previewProp }: WidgetProps) {
  const preview = usePreview() || Boolean(previewProp);
  const [apps, setApps] = useState<AppEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let pending = false;
    const load = () => {
      if (pending) return;
      pending = true;
      ipc
        .listApps()
        .then((list) => alive && setApps(preview ? list.slice(0, 5) : list))
        .catch((e) => alive && setError(errorMessage(e)))
        .finally(() => (pending = false));
    };
    load();
    const timer = window.setInterval(load, 1500);
    const off = subscribe("apps:foreground", () => window.setTimeout(load, 60));
    return () => {
      alive = false;
      window.clearInterval(timer);
      off();
    };
  }, [preview]);

  return (
    <div className="flex h-full shrink-0 items-center" title={error ?? undefined}>
      <div className="flex h-full items-center gap-[2px]">
        {apps.map((app) => (
          <AppButton key={app.id} app={app} onError={setError} />
        ))}
        {apps.length === 0 && <div className="px-2 lb-muted">No apps</div>}
      </div>
      <div className="mx-[calc(var(--lb-gap)+2px)] h-[55%] w-px shrink-0" style={{ background: "var(--lb-track)" }} aria-hidden />
    </div>
  );
}
