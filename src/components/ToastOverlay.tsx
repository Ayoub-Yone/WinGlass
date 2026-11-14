// Floating glass toast stack, 12px above (bottom dock) or below (top dock) the dock.
// The toast window is click-through except over a card: each card registers a hit region, so the
// cursor only becomes "solid" while hovering an active toast. Auto-dismiss pauses on hover.

import { CalendarDays, Info, RefreshCcw, Sparkles, TrendingUp, X, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useHub } from "../engine/DataHub";
import { useI18n } from "../i18n";
import { useHitRegion } from "../lib/hitRegions";
import { ipc, subscribe } from "../lib/ipc";
import type { ToastSpec } from "../types/lumabar";

const MAX_VISIBLE = 3;
const DEFAULT_DURATION = 8000;

const KIND: Record<NonNullable<ToastSpec["kind"]>, { icon: LucideIcon; color: string }> = {
  calendar: { icon: CalendarDays, color: "var(--lb-red)" },
  ai: { icon: Sparkles, color: "#D97757" },
  revenue: { icon: TrendingUp, color: "var(--lb-green)" },
  renewal: { icon: RefreshCcw, color: "var(--lb-amber)" },
  system: { icon: Info, color: "var(--lb-accent)" },
};

interface LiveToast extends ToastSpec {
  key: string;
  leaving: boolean;
}

function ToastCard(props: { toast: LiveToast; fromBelow: boolean; onDismiss: (key: string) => void }) {
  const { toast, fromBelow, onDismiss } = props;
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement | null>(null);
  const remaining = useRef(toast.durationMs ?? DEFAULT_DURATION);
  const startedAt = useRef(Date.now());
  const timer = useRef<number | null>(null);
  const [hover, setHover] = useState(false);
  useHitRegion(ref, !toast.leaving);

  const clear = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
  };

  useEffect(() => {
    if (hover || toast.leaving) {
      clear();
      return;
    }
    startedAt.current = Date.now();
    timer.current = window.setTimeout(() => onDismiss(toast.key), remaining.current);
    return () => {
      remaining.current = Math.max(1200, remaining.current - (Date.now() - startedAt.current));
      clear();
    };
  }, [hover, toast.leaving, toast.key, onDismiss]);

  const kind = KIND[toast.kind ?? "system"];
  const Icon = kind.icon;

  const runAction = () => {
    const action = toast.action;
    if (action?.kind === "open") void ipc.openTarget(action.target).catch(() => undefined);
    if (action?.kind === "window") void ipc.openWindow(action.label);
    onDismiss(toast.key);
  };

  return (
    <div
      ref={ref}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      data-toast={toast.id}
      className="lb-menu relative flex w-full items-center gap-3 rounded-[18px] py-3 pl-3.5 pr-9"
      style={{
        color: "var(--lb-text)",
        animation: `${fromBelow ? "lb-toast-in-up" : "lb-toast-in-down"} 260ms cubic-bezier(0.2, 0.9, 0.3, 1.1)`,
        opacity: toast.leaving ? 0 : 1,
        transform: toast.leaving ? `translateY(${fromBelow ? 10 : -10}px) scale(0.97)` : undefined,
        transition: "opacity 200ms ease, transform 200ms ease",
      }}
      role="status"
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px]" style={{ background: "var(--lb-card)" }}>
        <Icon size={18} style={{ color: kind.color }} />
      </div>
      <div className="min-w-0 flex-1 leading-snug">
        <div className="truncate text-[13.5px] font-semibold" title={toast.title}>{toast.title}</div>
        {toast.subtitle && <div className="truncate text-[12px] lb-muted">{toast.subtitle}</div>}
      </div>
      {toast.actionLabel && (
        <button
          className="lb-focus shrink-0 whitespace-nowrap rounded-full border-none px-3 py-1 text-[12px] font-semibold"
          style={{ background: "var(--lb-card-hover)" }}
          onClick={runAction}
        >
          {toast.actionLabel}
        </button>
      )}
      <button className="lb-icon-btn absolute right-2 top-2 h-5 w-5" onClick={() => onDismiss(toast.key)} aria-label={t("common.dismiss")}>
        <X size={12} />
      </button>
    </div>
  );
}

export function ToastOverlay() {
  const position = useHub((s) => s.position);
  const [toasts, setToasts] = useState<LiveToast[]>([]);

  const dismiss = useCallback((key: string) => {
    setToasts((list) => list.map((t) => (t.key === key ? { ...t, leaving: true } : t)));
    window.setTimeout(() => setToasts((list) => list.filter((t) => t.key !== key)), 220);
  }, []);

  useEffect(
    () =>
      subscribe("toast:push", (spec) => {
        setToasts((list) => {
          // Replace an existing toast with the same id instead of stacking duplicates.
          const rest = list.filter((t) => t.id !== spec.id);
          const next = [...rest, { ...spec, key: `${spec.id}-${Date.now()}`, leaving: false }];
          return next.slice(-MAX_VISIBLE);
        });
      }),
    [],
  );

  const fromBelow = position === "bottom";
  return (
    <div
      className="flex h-full w-full gap-2 px-2"
      style={{
        flexDirection: fromBelow ? "column" : "column-reverse",
        justifyContent: "flex-end",
        paddingBottom: fromBelow ? 2 : 0,
        paddingTop: fromBelow ? 0 : 2,
      }}
    >
      {toasts.map((t) => (
        <ToastCard key={t.key} toast={t} fromBelow={fromBelow} onDismiss={dismiss} />
      ))}
    </div>
  );
}
