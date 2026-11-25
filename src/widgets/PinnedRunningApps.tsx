// Pinned taskbar shortcuts + live top-level windows, with running / focused indicator dots.
// Click: launch (not running) · focus / minimize (one window) · window list (several windows).
// Middle-click: start a new instance. Hover a running app: live window previews (WindowPreviewCard).
// Drop files from Explorer on an icon: open them with that app (`open_files_with`).
// Right-click: Open / close windows · Pin to / Unpin from WinGlass. Order is stable: pins first (their saved
// order), then unpinned apps in launch order (backend `LAUNCH_ORDER`); focus only moves the indicator.

import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AppWindow as AppWindowIcon, Pin, PinOff, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ContextMenu, type MenuItem } from "../components/ContextMenu";
import { Popover } from "../components/ui";
import { WindowPreviewCard } from "../components/WindowPreviewCard";
import { getHub } from "../engine/DataHub";
import { useI18n } from "../i18n";
import { errorMessage, ipc, subscribe } from "../lib/ipc";
import { usePreview } from "../lib/hooks";
import type { AppEntry, WidgetProps } from "../types/winglass";

/** Successful icons only; misses are retried (the backend may be busy or the file still loading). */
const iconCache = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();
/** Mirrors the backend LRU bound so a long session cannot accumulate icon data URLs. */
const ICON_CACHE_LIMIT = 64;

function rememberIcon(key: string, url: string): void {
  iconCache.delete(key);
  iconCache.set(key, url);
  while (iconCache.size > ICON_CACHE_LIMIT) {
    const oldest = iconCache.keys().next().value;
    if (oldest === undefined) break;
    iconCache.delete(oldest);
  }
}

function fetchIcon(key: string): Promise<string | null> {
  let p = inflight.get(key);
  if (!p) {
    p = ipc
      .getAppIcon(key)
      .catch(() => null)
      .then((url) => {
        inflight.delete(key);
        if (url) rememberIcon(key, url);
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

type ScreenRect = [number, number, number, number];
/** A dock element's rect in physical screen px, given the dock window's inner position. */
function toScreen(r: DOMRect, origin: { x: number; y: number }): ScreenRect {
  const d = devicePixelRatio;
  return [origin.x + r.left * d, origin.y + r.top * d, origin.x + r.right * d, origin.y + r.bottom * d].map(Math.round) as ScreenRect;
}

/** First hover waits this long; moving to an adjacent running app while a card is open is instant. */
const PREVIEW_DELAY_MS = 200;
/** Grace period to reach the card from the icon (or slide to a neighbour) before it closes. */
const PREVIEW_GRACE_MS = 250;

function AppButton(props: {
  app: AppEntry;
  onError: (msg: string) => void;
  onHoverStart: (app: AppEntry, el: HTMLElement) => void;
  onHoverEnd: () => void;
  onDismissPreview: () => void;
  onChanged: () => void;
  dropTarget: boolean;
  /** Bumped each time files are dropped on this icon. */
  dropCount: number;
}) {
  const { app, onError, onHoverStart, onHoverEnd, onDismissPreview, onChanged, dropTarget, dropCount } = props;
  const { t } = useI18n();
  const icon = useIcon(app.iconKey);
  const [menu, setMenu] = useState(false);
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null);
  const ref = useRef<HTMLButtonElement | null>(null);
  const running = app.windows.length > 0;
  const allMinimized = running && app.windows.every((w) => w.isMinimized);

  // macOS dock motion: the icon bounces while its app opens (click or file drop), nothing else.
  const [bouncing, setBouncing] = useState(false);
  const bounceSince = useRef(0);
  const bounce = () => {
    bounceSince.current = Date.now();
    setBouncing(true);
  };
  useEffect(() => {
    if (dropCount > 0) bounce();
  }, [dropCount]);

  const launching = useRef(false);
  const launch = () => {
    const target = app.pinnedPath ?? app.exePath;
    // One launch in flight per icon: repeated clicks on a slow app no longer stack launch threads.
    if (!target || launching.current) return;
    launching.current = true;
    bounce();
    ipc
      .launchApp(target)
      .catch((e) => {
        setBouncing(false);
        onError(errorMessage(e));
      })
      .finally(() => (launching.current = false));
  };
  const imgClass = `lb-dock-img ${dropTarget ? "lb-drop-target" : ""} ${bouncing ? "lb-dock-launch" : ""}`;
  const away = getHub().position === "top" ? 1 : -1;

  /** The icon on screen (physical px): where the genie minimizes to and restores from. */
  const iconRect = async (): Promise<ScreenRect | undefined> => {
    const el = ref.current?.querySelector("[data-mag-icon]");
    const origin = await getCurrentWindow().innerPosition().catch(() => null);
    return el && origin ? toScreen(el.getBoundingClientRect(), origin) : undefined;
  };
  const activate = (hwnd: number) =>
    void iconRect()
      .then((rect) => ipc.activateWindow(hwnd, rect))
      .catch((e) => onError(errorMessage(e)));

  const click = () => {
    onDismissPreview();
    if (!running) return launch();
    if (app.windows.length === 1) return activate(app.windows[0].hwnd);
    setMenu((m) => !m);
  };

  const pinned = app.pinnedPath !== null;
  const ctxItems: MenuItem[] = [
    { id: "open", label: running ? t("apps.newWindow") : t("apps.open"), icon: AppWindowIcon, disabled: !(app.pinnedPath ?? app.exePath), onSelect: launch },
    ...(running
      ? [{
          id: "close",
          label: app.windows.length === 1 ? t("apps.closeWindow") : t("apps.closeWindows"),
          icon: X,
          onSelect: () => app.windows.forEach((w) => ipc.closeAppWindow(w.hwnd).catch((e) => onError(errorMessage(e)))),
        }]
      : []),
    pinned
      ? { id: "unpin", label: t("apps.unpin"), icon: PinOff, separatorBefore: true, onSelect: () => ipc.unpinApp(app.pinnedPath!).then(onChanged, (e) => onError(errorMessage(e))) }
      : {
          id: "pin",
          label: t("apps.pin"),
          icon: Pin,
          separatorBefore: true,
          disabled: !app.exePath,
          onSelect: () => app.exePath && ipc.pinApp(app.exePath, app.name, app.iconKey).then(onChanged, (e) => onError(errorMessage(e))),
        },
  ];

  return (
    <>
      <button
        ref={ref}
        data-mag=""
        data-mag-label={app.name}
        data-app-id={app.id}
        className="lb-icon-btn lb-focus relative flex h-full shrink-0 flex-col items-center justify-center rounded-[12px]"
        style={{ width: "calc(var(--lb-icon) + 12px)" }}
        title={app.windows.length === 1 ? app.windows[0].title : app.name}
        onClick={click}
        onPointerEnter={(e) => onHoverStart(app, e.currentTarget)}
        onPointerLeave={onHoverEnd}
        onContextMenu={(e) => {
          // Our own menu, not the dock's layout menu.
          e.preventDefault();
          e.stopPropagation();
          onDismissPreview();
          setCtx({ x: e.clientX, y: e.clientY });
        }}
        onAuxClick={(e) => {
          if (e.button === 1) launch();
        }}
      >
        <span
          data-mag-icon=""
          className="flex items-center justify-center"
          style={{ width: "var(--lb-icon)", height: "var(--lb-icon)", ["--lb-away" as string]: away }}
          // The bounce runs until the app has a window (checked once per hop, so it always lands), 10 s at most.
          onAnimationIteration={() => (running || Date.now() - bounceSince.current > 10_000) && setBouncing(false)}
        >
          {icon ? (
            <img
              src={icon}
              alt=""
              draggable={false}
              className={imgClass}
              style={{ width: "var(--lb-icon)", height: "var(--lb-icon)", opacity: allMinimized ? 0.72 : 1, imageRendering: "auto" }}
            />
          ) : (
            <AppWindowIcon style={{ width: "var(--lb-icon)", height: "var(--lb-icon)" }} className={`lb-muted ${imgClass}`} />
          )}
        </span>
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
              activate(w.hwnd);
            }}
          >
            <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: w.isActive ? "var(--lb-accent)" : "var(--lb-muted)" }} />
            <span className={`truncate ${w.isMinimized ? "lb-muted" : ""}`}>{w.title}</span>
          </button>
        ))}
        <button className="lb-card mt-1 w-full rounded-lg border-none px-2 py-1.5 text-left lb-muted" onClick={() => { setMenu(false); launch(); }}>
          {t("apps.newWindow")}
        </button>
      </Popover>
      {ctx && <ContextMenu x={ctx.x} y={ctx.y} items={ctxItems} preferUp={getHub().position === "bottom"} onClose={() => setCtx(null)} />}
    </>
  );
}

export function PinnedRunningApps({ preview: previewProp }: WidgetProps) {
  const preview = usePreview() || Boolean(previewProp);
  const { t } = useI18n();
  const [apps, setApps] = useState<AppEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<{ id: string; rect: DOMRect } | null>(null);
  const hoverRef = useRef(hover);
  hoverRef.current = hover;
  const openTimer = useRef(0);
  const closeTimer = useRef(0);

  const dismissPreview = useCallback(() => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
    setHover(null);
  }, []);
  const scheduleClose = useCallback(() => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setHover(null), PREVIEW_GRACE_MS);
  }, []);
  const keepPreview = useCallback(() => window.clearTimeout(closeTimer.current), []);
  const hoverStart = useCallback(
    (app: AppEntry, el: HTMLElement) => {
      if (preview || app.windows.length === 0) return scheduleClose();
      window.clearTimeout(openTimer.current);
      window.clearTimeout(closeTimer.current);
      const show = () => setHover({ id: app.id, rect: el.getBoundingClientRect() });
      if (hoverRef.current) show();
      else openTimer.current = window.setTimeout(show, PREVIEW_DELAY_MS);
    },
    [preview, scheduleClose],
  );
  useEffect(() => () => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
  }, []);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  const hovered = hover ? apps.find((a) => a.id === hover.id && a.windows.length > 0) : undefined;

  // Where each listed window's icon sits, so a click on the window's own minimize button can run the
  // genie without a round trip (backend `set_dock_icon_rects`). Sent only when it changed; empty
  // while the dock is hidden behind a fullscreen app.
  const sentIcons = useRef("");
  useEffect(() => {
    if (preview) return;
    let alive = true;
    void getCurrentWindow()
      .innerPosition()
      .then((origin) => {
        if (!alive) return;
        const icons = getHub().fullscreen
          ? []
          : apps.flatMap((a) => {
              const el = document.querySelector(`[data-app-id="${CSS.escape(a.id)}"] [data-mag-icon]`);
              if (!el) return [];
              const rect = toScreen(el.getBoundingClientRect(), origin);
              return a.windows.map((w): [number, ScreenRect] => [w.hwnd, rect]);
            });
        const key = JSON.stringify(icons);
        if (key === sentIcons.current) return;
        sentIcons.current = key;
        void ipc.setDockIconRects(icons).catch(() => undefined);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [apps, preview]);

  // Files dragged from Explorer: Tauri's native drop handler gives real paths (HTML5 drop does not).
  const [dropId, setDropId] = useState<string | null>(null);
  const [drops, setDrops] = useState<Record<string, number>>({});
  const appsRef = useRef(apps);
  appsRef.current = apps;
  useEffect(() => {
    if (preview) return;
    const hit = (p: { x: number; y: number }) =>
      document.elementFromPoint(p.x / devicePixelRatio, p.y / devicePixelRatio)?.closest<HTMLElement>("[data-app-id]")?.dataset.appId ?? null;
    const off = getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === "leave") return setDropId(null);
      const id = hit(payload.position);
      if (payload.type !== "drop") return setDropId(id);
      setDropId(null);
      const app = appsRef.current.find((a) => a.id === id);
      const target = app && (app.pinnedPath ?? app.exePath);
      if (!app || !target || payload.paths.length === 0) return;
      setDrops((d) => ({ ...d, [app.id]: (d[app.id] ?? 0) + 1 }));
      ipc.openFilesWith(target, payload.paths).catch((e) => setError(errorMessage(e)));
    });
    return () => void off.then((f) => f());
  }, [preview]);

  useEffect(() => {
    let alive = true;
    let pending = false;
    const load = () => {
      // No 1.5 s window enumeration while hidden behind a fullscreen app.
      if (pending || getHub().fullscreen) return;
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
  }, [preview, reloadKey]);

  return (
    <div className="flex h-full shrink-0 items-center" title={error ?? undefined}>
      <div data-mag-group="apps" className="flex h-full items-center gap-[2px]">
        {apps.map((app) => (
          <AppButton key={app.id} app={app} onError={setError} onHoverStart={hoverStart} onHoverEnd={scheduleClose} onDismissPreview={dismissPreview} onChanged={reload} dropTarget={dropId === app.id} dropCount={drops[app.id] ?? 0} />
        ))}
        {apps.length === 0 && <div className="whitespace-nowrap px-2 lb-muted">{t("apps.none")}</div>}
      </div>
      {hover && hovered && (
        <WindowPreviewCard app={hovered} anchor={hover.rect} onPointerEnter={keepPreview} onPointerLeave={scheduleClose} onDone={dismissPreview} />
      )}
      <div className="lb-apps-sep mx-[calc(var(--lb-gap)+2px)] h-[55%] w-px shrink-0" style={{ background: "var(--lb-track)" }} aria-hidden />
    </div>
  );
}
