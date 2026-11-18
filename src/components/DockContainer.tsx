// The floating capsule: horizontal wheel scrolling with inertia, pointer drag-and-drop reordering
// with spring transitions (persisted to SQLite), vertical drag to snap between the top and bottom
// screen edges, fullscreen slide-away, liquid-glass backdrop, and the right-click menu.

import {
  Languages,
  Layers,
  LayoutGrid,
  Maximize2,
  Palette,
  PanelBottom,
  PanelTop,
  Power,
  Ruler,
  Settings as SettingsIcon,
  Trash2,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { LiquidGlassCanvas } from "./LiquidGlassCanvas";
import { WindowsButton } from "./SystemMenu";
import { openSettings } from "./ui";
import { getHub, useHub } from "../engine/DataHub";
import { SIZE_ORDER, SIZES, THEMES, THEME_ORDER, frostPreset } from "../engine/ThemeEngine";
import { LANGUAGES, useI18n } from "../i18n";
import { pushCapture, useHitRegion } from "../lib/hitRegions";
import { GLASS_BULGE, MAG_HEADROOM, attachMagnifier } from "../lib/magnify";
import { patchSettings, useSettings } from "../lib/hooks";
import { ipc, subscribe } from "../lib/ipc";
import { clamp } from "../lib/format";
import { useAmbientColors } from "../lib/useAmbient";
import { getWidget, sanitizeLayout, widgetName } from "../widgets/WidgetRegistry";
import type { LayoutItem, Span } from "../types/lumabar";

const SPRING = "transform 280ms cubic-bezier(0.2, 0.9, 0.3, 1.15)";

type Drag =
  | {
      kind: "reorder";
      id: string;
      from: number;
      to: number;
      dx: number;
      rects: DOMRect[];
      settling: boolean;
    }
  | { kind: "snap"; dy: number; screenY: number };

/** Same rule as the backend's snap_to_cursor: upper half of the monitor -> top edge. */
function edgeForScreenY(screenY: number): "top" | "bottom" {
  const scr = window.screen as Screen & { availTop?: number };
  const top = scr.availTop ?? 0;
  return screenY < top + scr.height / 2 ? "top" : "bottom";
}

interface Pending {
  x: number;
  y: number;
  pointerId: number;
  itemId: string | null;
  started: boolean;
  release: (() => void) | null;
}

function swallowNextClick(): void {
  const stop = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener("click", stop, { capture: true, once: true });
  window.setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 400);
}

export function DockContainer() {
  const settings = useSettings();
  const i18n = useI18n();
  const { t } = i18n;
  const position = useHub((s) => s.position);
  const fullscreen = useHub((s) => s.fullscreen);
  const [layout, setLayout] = useState<LayoutItem[] | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [instant, setInstant] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; instanceId: string | null } | null>(null);
  const [glassActive, setGlassActive] = useState(false);

  const pillRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Magnification: label pill + a hit region that also covers the headroom while icons are grown.
  const magLabelRef = useRef<HTMLDivElement | null>(null);
  const headroomRef = useRef<HTMLDivElement | null>(null);
  const [magnifying, setMagnifying] = useState(false);
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const pending = useRef<Pending | null>(null);
  const scrollTarget = useRef<number | null>(null);
  const scrollAnim = useRef(0);

  useHitRegion(pillRef, !fullscreen);
  useHitRegion(headroomRef, !fullscreen && magnifying);

  const theme = THEMES[settings?.theme ?? "ios-glass"];
  const size = SIZES[settings?.size ?? "medium"];
  // Mode Clear: no bar surface (and no glass capture), every widget floats in its own capsule.
  const clear = settings?.clearMode ?? false;
  const glass = theme.usesGlassShader && !clear;
  const ambient = useAmbientColors(settings?.musicAmbiance ?? false);

  useEffect(() => {
    if (clear) setGlassActive(false);
  }, [clear]);

  // ------------------------------------------------------------ layout load / sync / persist

  useEffect(() => {
    void ipc.getLayout().then((stored) => {
      const clean = sanitizeLayout(stored);
      setLayout(clean);
      if (!stored) void ipc.saveLayout(clean);
    });
    return subscribe("layout:changed", ({ source, layout: next }) => {
      if (source !== "dock") setLayout(sanitizeLayout(next));
    });
  }, []);

  const persist = useCallback((next: LayoutItem[]) => {
    setLayout(next);
    void ipc.saveLayout(next);
  }, []);

  // ------------------------------------------------------------ liquid glass capture rect

  useEffect(() => {
    if (!glass) return;
    const pill = pillRef.current;
    if (!pill) return;
    const report = () => {
      const dpr = window.devicePixelRatio || 1;
      const r = pill.getBoundingClientRect();
      // Nothing is captured while hidden behind a fullscreen app.
      if (getHub().fullscreen) return;
      void ipc.setGlassRect([r.left * dpr, r.top * dpr, r.width * dpr, r.height * dpr]).catch(() => undefined);
    };
    const ro = new ResizeObserver(report);
    ro.observe(pill);
    report();
    const off = subscribe("dock:layout", () => window.setTimeout(report, 50));
    const t = window.setInterval(report, 2000);
    return () => {
      ro.disconnect();
      off();
      window.clearInterval(t);
    };
  }, [glass, position, settings?.size]);

  // ------------------------------------------------------------ wheel -> horizontal scroll with inertia

  const onWheel = (e: React.WheelEvent) => {
    const el = scrollRef.current;
    if (!el || el.scrollWidth <= el.clientWidth + 1) return;
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    const max = el.scrollWidth - el.clientWidth;
    const base = scrollTarget.current ?? el.scrollLeft;
    scrollTarget.current = clamp(base + delta, 0, max);
    if (scrollAnim.current) return;
    const step = () => {
      const target = scrollTarget.current;
      if (target === null) {
        scrollAnim.current = 0;
        return;
      }
      const diff = target - el.scrollLeft;
      if (Math.abs(diff) < 0.5) {
        el.scrollLeft = target;
        scrollTarget.current = null;
        scrollAnim.current = 0;
        return;
      }
      el.scrollLeft += diff * 0.2;
      scrollAnim.current = requestAnimationFrame(step);
    };
    scrollAnim.current = requestAnimationFrame(step);
  };

  // ------------------------------------------------------------ pointer: reorder & edge snap

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || drag) return;
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, [data-no-drag]")) return;
    const itemEl = target.closest<HTMLElement>("[data-instance]");
    pending.current = { x: e.clientX, y: e.clientY, pointerId: e.pointerId, itemId: itemEl?.dataset.instance ?? null, started: false, release: null };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = pending.current;
    if (!p || !layout) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;

    if (!p.started) {
      const horizontal = Math.abs(dx) > 6 && Math.abs(dx) > Math.abs(dy) * 1.2;
      const vertical = Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx);
      if (!horizontal && !vertical) return;
      p.started = true;
      p.release = pushCapture();
      pillRef.current?.setPointerCapture(e.pointerId);
      if (horizontal && p.itemId) {
        const rects = layout.map((it) => itemRefs.current.get(it.instanceId)?.getBoundingClientRect() ?? new DOMRect());
        const from = layout.findIndex((it) => it.instanceId === p.itemId);
        setDrag({ kind: "reorder", id: p.itemId, from, to: from, dx, rects, settling: false });
      } else if (vertical) {
        setDrag({ kind: "snap", dy, screenY: e.screenY });
      } else {
        // Horizontal drag on the pill background: nothing to reorder.
        p.release();
        pending.current = null;
      }
      return;
    }

    setDrag((d) => {
      if (!d) return d;
      if (d.kind === "snap") return { ...d, dy, screenY: e.screenY };
      if (d.settling) return d;
      const dragged = d.rects[d.from];
      const center = dragged.left + dragged.width / 2 + dx;
      let to = 0;
      d.rects.forEach((r, i) => {
        if (i !== d.from && r.left + r.width / 2 < center) to += 1;
      });
      return { ...d, dx, to };
    });
  };

  const finishPointer = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = pending.current;
    pending.current = null;
    if (!p?.started) return;
    swallowNextClick();
    try {
      pillRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* capture already released */
    }
    const current = drag;
    if (current?.kind === "snap") {
      setDrag(null);
      p.release?.();
      if (Math.abs(current.dy) > 40) void ipc.snapDockToCursor().catch(() => undefined);
      return;
    }
    if (current?.kind === "reorder" && layout) {
      const { from, to, rects } = current;
      const width = rects[from].width;
      const finalLeft = to > from ? rects[to].right - width : to < from ? rects[to].left : rects[from].left;
      setDrag({ ...current, dx: finalLeft - rects[from].left, settling: true });
      window.setTimeout(() => {
        const next = [...layout];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        setInstant(true);
        setDrag(null);
        if (from !== to) persist(next);
        requestAnimationFrame(() => requestAnimationFrame(() => setInstant(false)));
        p.release?.();
      }, 190);
      return;
    }
    p.release?.();
    setDrag(null);
  };

  const itemStyle = (index: number, id: string): CSSProperties => {
    if (!drag || drag.kind !== "reorder") return { transition: instant ? "none" : SPRING };
    if (id === drag.id) {
      return {
        transform: `translateX(${drag.dx}px) scale(${drag.settling ? 1 : 1.04})`,
        transition: drag.settling ? "transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1)" : "none",
        zIndex: 10,
        filter: drag.settling ? undefined : "drop-shadow(0 6px 14px rgba(0,0,0,0.35))",
      };
    }
    const shift = drag.rects[drag.from].width + size.gap;
    let offset = 0;
    if (drag.from < drag.to && index > drag.from && index <= drag.to) offset = -shift;
    if (drag.from > drag.to && index >= drag.to && index < drag.from) offset = shift;
    return { transform: `translateX(${offset}px)`, transition: SPRING };
  };

  // ------------------------------------------------------------ context menu

  const menuItems = (instanceId: string | null): MenuItem[] => {
    const items: MenuItem[] = [];
    const inst = instanceId ? layout?.find((l) => l.instanceId === instanceId) : undefined;
    const def = inst ? getWidget(inst.widgetId) : undefined;
    if (inst && def && layout) {
      const name = widgetName(def, i18n);
      if (def.sizes.length > 1) {
        items.push({
          id: "size",
          label: t("menu.widgetSize", { name }),
          icon: Maximize2,
          submenu: def.sizes.map((s: Span) => ({
            id: `size-${s}`,
            label: s,
            checked: inst.span === s,
            onSelect: () => persist(layout.map((l) => (l.instanceId === inst.instanceId ? { ...l, span: s } : l))),
          })),
        });
      }
      items.push({
        id: "remove",
        label: t("menu.removeWidget", { name }),
        icon: Trash2,
        danger: true,
        onSelect: () => persist(layout.filter((l) => l.instanceId !== inst.instanceId)),
      });
    }
    items.push(
      { id: "add", label: t("menu.addWidgets"), icon: LayoutGrid, separatorBefore: items.length > 0, onSelect: () => void ipc.openWindow("picker") },
      {
        id: "style",
        label: t("menu.style"),
        icon: Palette,
        submenu: THEME_ORDER.map((id) => ({
          id: `theme-${id}`,
          label: t(`theme.${id}.name`),
          checked: settings?.theme === id,
          onSelect: () => void patchSettings((s) => ({ ...s, theme: id })),
        })),
      },
      {
        id: "dock-size",
        label: t("menu.size"),
        icon: Ruler,
        submenu: SIZE_ORDER.map((sz) => ({
          id: `dock-size-${sz}`,
          label: t(`size.${sz}`),
          checked: settings?.size === sz,
          onSelect: () => void patchSettings((s) => ({ ...s, size: sz })),
        })),
      },
      {
        id: "position",
        label: t("menu.position"),
        icon: Layers,
        submenu: [
          { id: "pos-bottom", label: t("menu.bottom"), icon: PanelBottom, checked: position === "bottom", onSelect: () => void ipc.setDockPosition("bottom") },
          { id: "pos-top", label: t("menu.top"), icon: PanelTop, checked: position === "top", onSelect: () => void ipc.setDockPosition("top") },
        ],
      },
      {
        id: "language",
        label: t("menu.language"),
        icon: Languages,
        submenu: LANGUAGES.map((l) => ({
          id: `lang-${l.id}`,
          label: l.label,
          checked: i18n.lang === l.id,
          onSelect: () => void patchSettings((s) => ({ ...s, language: l.id })),
        })),
      },
      { id: "automations", label: t("menu.automations"), icon: Zap, onSelect: () => openSettings("automations") },
      { id: "settings", label: t("menu.settings"), icon: SettingsIcon, onSelect: () => openSettings("general") },
      { id: "quit", label: t("menu.quit"), icon: Power, danger: true, separatorBefore: true, onSelect: () => void ipc.restoreTaskbarAndQuit() },
    );
    return items;
  };

  const positionRef = useRef(position);
  positionRef.current = position;
  // The glass capsule swells over the hovered icon only while the shader is live; elsewhere the
  // icons must fit the rigid capsule.
  const bulgeRef = useRef(0);
  bulgeRef.current = glass && glassActive ? GLASS_BULGE : 0;
  useEffect(() => {
    const pill = pillRef.current;
    if (!pill) return;
    return attachMagnifier(pill, {
      edge: () => positionRef.current,
      bulge: () => bulgeRef.current,
      label: magLabelRef.current,
      onActiveChange: setMagnifying,
    });
  }, []);

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const itemEl = (e.target as HTMLElement).closest<HTMLElement>("[data-instance]");
    setMenu({ x: e.clientX, y: e.clientY, instanceId: itemEl?.dataset.instance ?? null });
  };

  // ------------------------------------------------------------ render

  const hidden = fullscreen;
  const snapDy = drag?.kind === "snap" ? drag.dy : 0;
  const ambientVars = Object.fromEntries([0, 1, 2].map((i) => [`--lb-amb-${i + 1}`, ambient[i] ?? ambient[0] ?? "transparent"]));
  const pillStyle: CSSProperties = {
    ...ambientVars,
    height: "var(--lb-height)",
    padding: "var(--lb-padding)",
    maxWidth: "100%",
    transform: hidden ? `translateY(${position === "bottom" ? 150 : -150}%)` : `translateY(${snapDy}px)`,
    opacity: hidden ? 0 : 1,
    transition:
      drag?.kind === "snap"
        ? "none"
        : "transform 320ms cubic-bezier(0.3, 0.9, 0.3, 1), opacity 240ms ease, background-color 220ms ease, border-color 220ms ease, box-shadow 220ms ease, --lb-amb-1 600ms ease, --lb-amb-2 600ms ease, --lb-amb-3 600ms ease",
    background: glass ? (glassActive ? "transparent" : "rgba(22, 22, 26, 0.72)") : undefined,
    // The shader paints its own rim light; the CSS border is only for the fallback surface.
    borderColor: glass && glassActive ? "transparent" : undefined,
    backdropFilter: theme.usesGlassShader ? "none" : undefined,
  };

  const snapTarget = drag?.kind === "snap" && Math.abs(drag.dy) > 40 ? edgeForScreenY(drag.screenY) : null;

  return (
    <div
      className="flex h-full w-full justify-center"
      style={{
        alignItems: position === "bottom" ? "flex-end" : "flex-start",
        paddingBottom: position === "bottom" ? "10px" : 0,
        paddingTop: position === "top" ? "10px" : 0,
      }}
    >
      <div
        ref={pillRef}
        className={`lb-pill relative flex items-center${clear ? " lb-clear" : ""}`}
        data-ambient={ambient.length > 0 ? "on" : "off"}
        style={pillStyle}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishPointer}
        onPointerCancel={finishPointer}
        onContextMenu={onContextMenu}
      >
        {glass && <LiquidGlassCanvas radius={size.radius} frost={frostPreset(settings?.glassFrost)} onActiveChange={setGlassActive} />}
        {/* Ambiance Musique: diffuse cover-tinted light inside the bar (fades out with no music). */}
        <div aria-hidden className="lb-ambient" />
        <div
          ref={headroomRef}
          aria-hidden
          className="pointer-events-none absolute inset-x-0"
          style={{ top: -MAG_HEADROOM, bottom: -MAG_HEADROOM }}
        />
        <WindowsButton />
        <div ref={magLabelRef} className="lb-mag-label" style={position === "bottom" ? { bottom: `calc(100% + ${MAG_HEADROOM}px)` } : { top: `calc(100% + ${MAG_HEADROOM}px)` }} />
        {/* Vertical headroom inside the horizontal scroller so magnified icons are not clipped. */}
        <div
          ref={scrollRef}
          className="lb-noscroll relative flex min-w-0 items-center overflow-x-auto"
          style={{ gap: "var(--lb-gap)", height: `calc(100% + ${2 * MAG_HEADROOM}px)`, paddingBlock: MAG_HEADROOM, marginBlock: -MAG_HEADROOM }}
        >
          {(layout ?? []).map((item, index) => {
            const def = getWidget(item.widgetId);
            if (!def) return null;
            const Component = def.component;
            return (
              <div
                key={item.instanceId}
                data-instance={item.instanceId}
                data-widget={item.widgetId}
                ref={(el) => {
                  if (el) itemRefs.current.set(item.instanceId, el);
                  else itemRefs.current.delete(item.instanceId);
                }}
                className="relative flex h-full shrink-0 items-center"
                style={itemStyle(index, item.instanceId)}
              >
                <Component instance={item} span={item.span} />
              </div>
            );
          })}
          {layout && layout.length === 0 && (
            <button className="lb-card flex h-full items-center gap-2 border-none px-4" onClick={() => void ipc.openWindow("picker")}>
              <LayoutGrid size={15} /> {t("dock.addWidgets")}
            </button>
          )}
        </div>
        {snapTarget && snapTarget !== position && (
          <div
            className="lb-menu pointer-events-none absolute left-1/2 -translate-x-1/2 whitespace-nowrap px-3 py-1.5"
            style={position === "bottom" ? { bottom: "calc(100% + 10px)" } : { top: "calc(100% + 10px)" }}
          >
            {snapTarget === "top" ? t("dock.releaseTop") : t("dock.releaseBottom")}
          </div>
        )}
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.instanceId)}
          preferUp={position === "bottom"}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
