// « Afficher les icônes cachées »: one rounded glass tile with a chevron (^ docked at the bottom, v at
// the top), directly left of the clock tile. No tray icon lives in the bar itself; the chevron opens
// a dark frosted card floating 10px above it with every notification-area app — lumabar included —
// in a 5-column grid of crisp icons (name tooltip on hover).
//
// Left click opens / restores the app. Right click opens lumabar's own glass menu (app icon + name,
// Ouvrir · Paramètres · Quitter). Everything acts on the application itself (win32/tray_icons.rs):
// the Windows taskbar, its tray and its overflow flyout are never shown or clicked. lumabar's own
// entry opens lumabar's Settings modal or runs the restore-taskbar-and-quit path.

import { AppWindow, ChevronDown, ChevronUp, ExternalLink, Power, Settings, type LucideIcon } from "lucide-react";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Popover } from "../components/ui";
import { getHub, useHub } from "../engine/DataHub";
import { useI18n } from "../i18n";
import { useCapture } from "../lib/hitRegions";
import { errorMessage, ipc } from "../lib/ipc";
import { usePreview } from "../lib/hooks";
import type { TrayAction, TrayIcon, WidgetProps } from "../types/lumabar";

const SAMPLE: TrayIcon[] = [
  { id: "s0", name: "WinGlass", exe: "", iconPng: null, isHiddenOverflow: true, isSelf: true },
  { id: "s1", name: "Riot Client", exe: "", iconPng: null, isHiddenOverflow: true, isSelf: false },
  { id: "s2", name: "Discord", exe: "", iconPng: null, isHiddenOverflow: true, isSelf: false },
  { id: "s3", name: "AMD Software", exe: "", iconPng: null, isHiddenOverflow: true, isSelf: false },
];

/** Card geometry (reference design): 5 columns of 30px icons, 22px gaps and padding. */
const COLUMNS = 5;
const ICON = 30;
const GAP = 22;
const PAD = 22;
const CARD_WIDTH = COLUMNS * ICON + (COLUMNS - 1) * GAP + 2 * PAD + 2;
/** While the card is open the list is refreshed this often. */
const REFRESH_MS = 3000;

const CARD_SURFACE: CSSProperties = {
  borderRadius: 22,
  // The theme's popover finish (clear glossy sheen on the liquid-glass themes).
  background: "var(--lb-menu)",
  backdropFilter: "blur(30px) saturate(160%)",
  WebkitBackdropFilter: "blur(30px) saturate(160%)",
  border: "var(--lb-border)",
  boxShadow: "0 18px 50px rgba(0, 0, 0, 0.45), 0 2px 8px rgba(0, 0, 0, 0.25), inset 0 1px 0 rgb(255 255 255 / 0.14)",
  padding: PAD,
};

/** Last list, so reopening the card is instant. */
let lastIcons: TrayIcon[] = [];

function TrayGlyph({ icon, size }: { icon: TrayIcon; size: number }) {
  return icon.iconPng ? (
    <img src={icon.iconPng} alt="" draggable={false} style={{ width: size, height: size }} />
  ) : (
    <AppWindow size={size - 2} color="rgba(255, 255, 255, 0.72)" />
  );
}

interface MenuState {
  icon: TrayIcon;
  /** Anchor: the icon's rect at the time of the right click. */
  rect: DOMRect;
}

function TrayMenu(props: { menu: MenuState; onAction: (icon: TrayIcon, action: TrayAction) => void; onClose: () => void }) {
  const { menu, onAction, onClose } = props;
  const { t } = useI18n();
  const position = useHub((s) => s.position);
  const ref = useRef<HTMLDivElement | null>(null);
  const width = 228;
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden", width });
  useCapture(true);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = el.offsetHeight;
    const r = menu.rect;
    const left = Math.min(Math.max(8, r.left + r.width / 2 - width / 2), window.innerWidth - width - 8);
    const top = position === "bottom" ? Math.max(8, r.top - h - 10) : Math.min(window.innerHeight - h - 8, r.bottom + 10);
    setStyle({ left, top, width });
  }, [menu, position]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const t0 = window.setTimeout(() => {
      document.addEventListener("pointerdown", onDown, true);
      document.addEventListener("contextmenu", onDown as unknown as EventListener, true);
    }, 0);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.clearTimeout(t0);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("contextmenu", onDown as unknown as EventListener, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const items: { action: TrayAction; label: string; icon: LucideIcon; danger?: boolean }[] = [
    { action: "open", label: t("tray.open"), icon: ExternalLink },
    { action: "settings", label: t("tray.settings"), icon: Settings },
    { action: "quit", label: t("tray.quit"), icon: Power, danger: true },
  ];

  return createPortal(
    <div
      ref={ref}
      role="menu"
      data-testid="tray-menu"
      className="lb-menu lb-pop fixed z-[100] p-1.5"
      style={{ ...style, borderRadius: 14, color: "var(--lb-text)" }}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div data-testid="tray-menu-header" className="flex items-center gap-2.5 px-2.5 pb-2 pt-1.5">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center">
          <TrayGlyph icon={menu.icon} size={22} />
        </span>
        <span className="min-w-0 flex-1 truncate font-semibold" title={menu.icon.name}>
          {menu.icon.name}
        </span>
      </div>
      <div className="mx-2 mb-1 h-px" style={{ background: "var(--lb-track)" }} />
      {items.map((item) => (
        <button
          key={item.action}
          role="menuitem"
          data-testid={`tray-menu-${item.action}`}
          className="lb-menu-row flex h-[30px] w-full items-center gap-2.5 rounded-[8px] border-none bg-transparent px-2.5 text-left"
          style={{ color: item.danger ? "var(--lb-red)" : "inherit" }}
          onClick={() => {
            onClose();
            onAction(menu.icon, item.action);
          }}
        >
          <item.icon size={14} className="shrink-0 opacity-80" />
          <span className="flex-1 truncate">{item.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}

export function HiddenTrayButton({ preview: previewProp }: WidgetProps) {
  const { t } = useI18n();
  const preview = usePreview() || Boolean(previewProp);
  const position = useHub((s) => s.position);
  const anchor = useRef<HTMLButtonElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [icons, setIcons] = useState<TrayIcon[]>(lastIcons);
  const [loaded, setLoaded] = useState(lastIcons.length > 0);
  const [error, setError] = useState<string | null>(null);
  const [tip, setTip] = useState<{ name: string; x: number; y: number } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);

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

  // Warm once so the first open is instant, then refresh only while the card is open.
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

  const closeCard = useCallback(() => {
    setOpen(false);
    setTip(null);
  }, []);
  const closeMenu = useCallback(() => setMenu(null), []);

  const run = (icon: TrayIcon, action: TrayAction) => {
    if (preview) return;
    setError(null);
    if (icon.isSelf) {
      if (action === "quit") void ipc.restoreTaskbarAndQuit();
      else void ipc.openWindow("settings").catch((e) => setError(errorMessage(e)));
      return;
    }
    ipc
      .trayIconAction(icon.id, action)
      .then((outcome) => {
        if (outcome === "stillOpen") setError(t("tray.stillOpen", { name: icon.name }));
      })
      .catch((e) => setError(`${icon.name} : ${errorMessage(e)}`))
      .finally(() => {
        if (action === "quit") void load();
      });
  };

  const list = preview ? SAMPLE : icons;
  const Chevron = position === "bottom" ? ChevronUp : ChevronDown;
  const label = t("tray.showHidden");

  return (
    <div className="flex h-full shrink-0 items-center">
      <button
        ref={anchor}
        data-testid="tray-chevron"
        className="lb-card lb-tray-chevron lb-focus relative flex h-full shrink-0 items-center justify-center border-none"
        style={{ width: "calc(var(--lb-icon) + 10px)", ["--lb-chevron-nudge" as string]: position === "bottom" ? "-1px" : "1px" }}
        title={error ?? label}
        aria-label={label}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          if (preview) return;
          setMenu(null);
          setOpen((v) => !v);
        }}
      >
        <Chevron size={17} strokeWidth={2.2} className="lb-muted" />
        {error && <span className="absolute right-[5px] top-[6px] h-1.5 w-1.5 rounded-full" style={{ background: "var(--lb-amber)" }} aria-hidden />}
      </button>
      <Popover anchor={anchor} open={open} onClose={closeCard} width={CARD_WIDTH} surface={CARD_SURFACE} testId="tray-card">
        <div data-testid="tray-panel" className="relative">
          {list.length > 0 ? (
            <div
              ref={gridRef}
              data-testid="tray-grid"
              className="grid justify-items-center"
              style={{ gridTemplateColumns: `repeat(${COLUMNS}, 1fr)`, gap: GAP }}
            >
              {list.map((icon) => (
                <button
                  key={icon.id}
                  data-testid="tray-icon"
                  data-self={icon.isSelf ? "" : undefined}
                  className="lb-tray-cell lb-focus flex items-center justify-center border-none bg-transparent p-0"
                  style={{ width: ICON, height: ICON }}
                  aria-label={icon.name}
                  onPointerEnter={(e) => {
                    const el = e.currentTarget;
                    setTip({ name: icon.name, x: el.offsetLeft + el.offsetWidth / 2, y: el.offsetTop });
                  }}
                  onPointerLeave={() => setTip(null)}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeCard();
                    run(icon, "open");
                  }}
                  onContextMenu={(e) => {
                    // lumabar's own menu for the app — never the Windows tray.
                    e.preventDefault();
                    e.stopPropagation();
                    const rect = e.currentTarget.getBoundingClientRect();
                    closeCard();
                    setMenu({ icon, rect });
                  }}
                >
                  <TrayGlyph icon={icon} size={ICON} />
                </button>
              ))}
            </div>
          ) : (
            <div className="py-1 text-center" style={{ fontSize: "var(--lb-small)", color: "rgba(255, 255, 255, 0.6)" }}>
              {loaded ? t("tray.none") : t("tray.loading")}
            </div>
          )}
          {tip && (
            <div data-testid="tray-tooltip" className="lb-tray-tip" style={{ left: tip.x, top: tip.y }}>
              {tip.name}
            </div>
          )}
        </div>
      </Popover>
      {menu && <TrayMenu menu={menu} onAction={run} onClose={closeMenu} />}
    </div>
  );
}
