// Windows-taskbar-style hover previews above a running app icon: a frosted card with one live
// thumbnail per open window (refreshed while open). Click a thumbnail -> that window to the front
// (restored if minimized); hover × -> WM_CLOSE. The card slides between adjacent icons instead of
// re-opening. A transparent bridge under the card keeps the pointer "inside" while crossing the gap
// from the icon, since the dock window is click-through outside its hit regions.

import { X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AppIcon } from "./AppIcon";
import { useHub } from "../engine/DataHub";
import { useI18n } from "../i18n";
import { clamp } from "../lib/format";
import { useHitRegion } from "../lib/hitRegions";
import { MAG_HEADROOM } from "../lib/magnify";
import { ipc } from "../lib/ipc";
import type { AppEntry, WindowPreview } from "../types/lumabar";

/** Thumbnail box (CSS px); the backend renders at 2x for HiDPI. */
const THUMB_W = 200;
const THUMB_H = 120;
const GAP = 6;
/** Card radius 18, padding 8 -> item radius 10; item padding 6 -> image radius 4 (concentric). */
const CARD_RADIUS = 18;
const CARD_PAD = 8;
const ITEM_RADIUS = CARD_RADIUS - CARD_PAD;
const ITEM_PAD = 6;
/** Space between the icon and the card: clears the magnified icon. */
const LIFT = MAG_HEADROOM + 6;
const REFRESH_MS = 1500;

/** Last previews per app, so reopening / sliding back shows thumbnails at once. */
const cache = new Map<string, WindowPreview[]>();

export function WindowPreviewCard(props: {
  app: AppEntry;
  anchor: DOMRect;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onDone: () => void;
}) {
  const { app, anchor, onPointerEnter, onPointerLeave, onDone } = props;
  const { t } = useI18n();
  const position = useHub((s) => s.position);
  const ref = useRef<HTMLDivElement | null>(null);
  const [items, setItems] = useState<WindowPreview[]>(() => cache.get(app.id) ?? app.windows.map((w) => ({ ...w, thumbnail: null })));
  const [left, setLeft] = useState<number | null>(null);
  useHitRegion(ref, true);

  // Fresh thumbnails now and while the card stays open.
  useEffect(() => {
    setItems(cache.get(app.id) ?? app.windows.map((w) => ({ ...w, thumbnail: null })));
    let alive = true;
    let timer = 0;
    const load = () => {
      void ipc
        .getAppWindowPreviews(app.id)
        .then((list) => {
          if (!alive) return;
          cache.set(app.id, list);
          if (cache.size > 24) cache.delete(cache.keys().next().value as string);
          setItems(list);
          if (list.length === 0) onDone();
        })
        .catch(() => undefined)
        .finally(() => {
          if (alive) timer = window.setTimeout(load, REFRESH_MS);
        });
    };
    load();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
    // onDone is stable for the card's lifetime; app.windows only seeds the first paint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.id]);

  const width = items.length * THUMB_W + Math.max(0, items.length - 1) * GAP + 2 * CARD_PAD + 2 * ITEM_PAD * items.length;
  const maxWidth = window.innerWidth - 16;
  const cardWidth = Math.min(width, maxWidth);

  useLayoutEffect(() => {
    setLeft(clamp(anchor.left + anchor.width / 2 - cardWidth / 2, 8, window.innerWidth - cardWidth - 8));
  }, [anchor, cardWidth]);

  // The magnifier's name label would sit under the card.
  useEffect(() => {
    document.documentElement.dataset.preview = "on";
    return () => {
      delete document.documentElement.dataset.preview;
    };
  }, []);

  const focus = (hwnd: number) => {
    onDone();
    void ipc.focusAppWindow(hwnd).catch(() => undefined);
  };
  const close = (hwnd: number) => {
    const rest = items.filter((w) => w.hwnd !== hwnd);
    setItems(rest);
    cache.set(app.id, rest);
    if (rest.length === 0) onDone();
    void ipc.closeAppWindow(hwnd).catch(() => undefined);
  };

  const bottom = position === "bottom";
  const style: React.CSSProperties = bottom
    ? { left: left ?? 0, bottom: window.innerHeight - anchor.top, paddingBottom: LIFT }
    : { left: left ?? 0, top: anchor.bottom, paddingTop: LIFT };

  return createPortal(
    <div
      ref={ref}
      data-testid="window-preview"
      className="lb-preview fixed z-50"
      style={{ ...style, width: cardWidth, visibility: left === null ? "hidden" : "visible" }}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div
        role="group"
        aria-label={t("preview.label", { name: app.name })}
        className={`lb-preview-card lb-noscroll flex overflow-x-auto ${bottom ? "lb-preview-up" : "lb-preview-down"}`}
        style={{ gap: GAP, padding: CARD_PAD, borderRadius: CARD_RADIUS }}
      >
        {items.map((w) => (
          <div key={w.hwnd} className="lb-preview-item relative shrink-0" style={{ borderRadius: ITEM_RADIUS, padding: ITEM_PAD }} data-active={w.isActive}>
            <button
              data-testid="window-preview-item"
              className="lb-focus flex w-full flex-col gap-1.5 border-none bg-transparent p-0 text-left"
              style={{ width: THUMB_W }}
              title={w.title}
              onClick={() => focus(w.hwnd)}
            >
              <span className="flex w-full min-w-0 items-center gap-1.5 pr-6">
                <AppIcon iconKey={app.iconKey} size={14} />
                <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium">{w.title || app.name}</span>
              </span>
              <span
                className="flex items-center justify-center overflow-hidden"
                style={{ width: THUMB_W, height: THUMB_H, borderRadius: ITEM_RADIUS - ITEM_PAD, background: "rgb(0 0 0 / 0.28)" }}
              >
                {w.thumbnail ? (
                  <img src={w.thumbnail} alt="" draggable={false} className="max-h-full max-w-full object-contain" />
                ) : (
                  <span className="flex flex-col items-center gap-1.5 lb-muted">
                    <AppIcon iconKey={app.iconKey} size={36} />
                    {w.isMinimized && <span className="text-[10.5px]">{t("preview.minimized")}</span>}
                  </span>
                )}
              </span>
            </button>
            <button
              data-testid="window-preview-close"
              className="lb-preview-close lb-focus absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center border-none"
              style={{ borderRadius: 5 }}
              aria-label={t("preview.close", { title: w.title || app.name })}
              title={t("preview.close", { title: w.title || app.name })}
              onClick={(e) => {
                e.stopPropagation();
                close(w.hwnd);
              }}
            >
              <X size={13} strokeWidth={2.2} />
            </button>
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}
