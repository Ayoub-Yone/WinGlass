// « Afficher les icônes cachées »: one compact chevron in the dock's system area (^ docked at the
// bottom, v docked at the top). No tray icon lives in the dock bar itself; the chevron opens a
// frosted grid of the background apps (Riot Client, Vanguard, AMD Software, SignalRGB, Discord…).
// Left click opens / restores the app, double click double-clicks it, right click opens the app's
// own native tray menu (« Quitter », « Paramètres »…) — all forwarded to the real tray item by the
// backend (win32/tray_icons.rs). Click outside or Escape closes the grid.

import { AppWindow, ChevronDown, ChevronUp } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Popover } from "../components/ui";
import { getHub, useHub } from "../engine/DataHub";
import { useI18n } from "../i18n";
import { errorMessage, ipc } from "../lib/ipc";
import { usePreview } from "../lib/hooks";
import type { TrayButton, TrayIcon, WidgetProps } from "../types/lumabar";

const SAMPLE: TrayIcon[] = [
  { id: "s1", name: "Riot Client", exe: "", iconPng: null, isHiddenOverflow: true },
  { id: "s2", name: "Discord", exe: "", iconPng: null, isHiddenOverflow: true },
  { id: "s3", name: "AMD Software", exe: "", iconPng: null, isHiddenOverflow: true },
];

/** Single vs double click: wait this long for a second click before sending "left". */
const DOUBLE_CLICK_MS = 260;
const CELL = 44;
const MAX_COLUMNS = 5;
/** While the grid is open the list is refreshed this often. */
const REFRESH_MS = 3000;

/** Last list, so reopening the grid is instant. */
let lastIcons: TrayIcon[] = [];

function TrayCell(props: { icon: TrayIcon; onActivate: (icon: TrayIcon, button: TrayButton) => void; onHover: (name: string | null) => void }) {
  const { icon, onActivate, onHover } = props;
  const pending = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (pending.current) window.clearTimeout(pending.current);
    },
    [],
  );
  return (
    <button
      data-testid="tray-icon"
      className="lb-icon-btn lb-focus flex items-center justify-center rounded-[10px]"
      style={{ width: CELL, height: CELL }}
      title={icon.name}
      aria-label={icon.name}
      onPointerEnter={() => onHover(icon.name)}
      onPointerLeave={() => onHover(null)}
      onClick={(e) => {
        e.stopPropagation();
        if (pending.current) {
          window.clearTimeout(pending.current);
          pending.current = null;
          onActivate(icon, "double");
          return;
        }
        pending.current = window.setTimeout(() => {
          pending.current = null;
          onActivate(icon, "left");
        }, DOUBLE_CLICK_MS);
      }}
      onContextMenu={(e) => {
        // The app's own native menu, not the dock's.
        e.preventDefault();
        e.stopPropagation();
        onActivate(icon, "right");
      }}
    >
      {icon.iconPng ? (
        <img src={icon.iconPng} alt="" draggable={false} style={{ width: 24, height: 24 }} />
      ) : (
        <AppWindow size={22} className="lb-muted" />
      )}
    </button>
  );
}

export function HiddenTrayButton({ preview: previewProp }: WidgetProps) {
  const { t } = useI18n();
  const preview = usePreview() || Boolean(previewProp);
  const position = useHub((s) => s.position);
  const anchor = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [icons, setIcons] = useState<TrayIcon[]>(lastIcons);
  const [loaded, setLoaded] = useState(lastIcons.length > 0);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (getHub().fullscreen) return Promise.resolve();
    return ipc
      .getTrayIcons()
      .then((list) => {
        lastIcons = list;
        setIcons(list);
        setLoaded(true);
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);

  // Warm once so the first open is instant, then only while the grid is open.
  useEffect(() => {
    if (preview) return;
    void load();
  }, [preview, load]);
  useEffect(() => {
    if (preview || !open) return;
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [preview, open, load]);

  const close = useCallback(() => {
    setOpen(false);
    setHovered(null);
  }, []);

  const activate = (icon: TrayIcon, button: TrayButton) => {
    if (preview || busy) return;
    // Like the native flyout: the grid gets out of the way of the app's window or menu.
    close();
    setBusy(true);
    setError(null);
    ipc
      .activateTrayIcon(icon.id, button)
      .catch((e) => setError(`${icon.name} : ${errorMessage(e)}`))
      .finally(() => {
        setBusy(false);
        void load();
      });
  };

  const list = preview ? SAMPLE : icons;
  const columns = Math.max(1, Math.min(MAX_COLUMNS, list.length));
  const width = Math.max(180, columns * (CELL + 4) + 24);
  const Chevron = position === "bottom" ? ChevronUp : ChevronDown;
  const label = t("tray.showHidden");

  return (
    <div className="flex h-full shrink-0 items-center">
      <button
        ref={anchor}
        data-testid="tray-chevron"
        className="lb-icon-btn lb-focus relative flex h-full shrink-0 items-center justify-center rounded-[10px]"
        style={{ width: 26, opacity: busy ? 0.6 : 1, transition: "opacity 120ms ease, background-color 140ms ease" }}
        title={error ?? label}
        aria-label={label}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          if (preview) return;
          setOpen((v) => !v);
        }}
      >
        <Chevron size={16} strokeWidth={2.2} className="lb-muted" style={{ transform: open ? "rotate(180deg)" : undefined, transition: "transform 160ms ease" }} />
        {error && <span className="absolute right-[3px] top-[30%] h-1.5 w-1.5 rounded-full" style={{ background: "var(--lb-amber)" }} aria-hidden />}
      </button>
      <Popover anchor={anchor} open={open} onClose={close} width={width}>
        <div data-testid="tray-panel" className="flex flex-col gap-2">
          <div className="flex items-center justify-between px-1">
            <span className="truncate font-semibold" style={{ fontSize: "var(--lb-small)" }}>
              {label}
            </span>
          </div>
          {list.length > 0 ? (
            <div className="grid justify-center gap-1" style={{ gridTemplateColumns: `repeat(${columns}, ${CELL}px)` }}>
              {list.map((icon) => (
                <TrayCell key={icon.id} icon={icon} onActivate={activate} onHover={setHovered} />
              ))}
            </div>
          ) : (
            <div className="px-1 py-2 lb-muted" style={{ fontSize: "var(--lb-small)" }}>
              {loaded ? t("tray.none") : t("tray.loading")}
            </div>
          )}
          {/* Hover tooltip: the app's name (title tooltips are unreliable on a no-activate overlay). */}
          <div data-testid="tray-hover-name" className="h-[18px] truncate px-1 text-center lb-muted" style={{ fontSize: "var(--lb-small)" }}>
            {hovered ?? (error ? error : t("tray.hint"))}
          </div>
        </div>
      </Popover>
    </div>
  );
}
