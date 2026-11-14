// Shared visual primitives for widgets.

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Settings2 } from "lucide-react";
import { useHitRegion } from "../lib/hitRegions";
import { ipc } from "../lib/ipc";
import { useI18n } from "../i18n";
import { usePreview } from "../lib/hooks";
import { useHub } from "../engine/DataHub";
import { clamp } from "../lib/format";
import type { ProviderId, Span } from "../types/lumabar";

export function spanCss(span: Span): CSSProperties {
  const units = span === "1x1" ? 1 : span === "2x1" ? 2 : span === "3x1" ? 3 : 0;
  const height = "calc(var(--lb-height) - 2 * var(--lb-padding))";
  if (!units) return { height };
  return { width: `calc(var(--lb-unit) * ${units} + var(--lb-gap) * ${units - 1})`, height };
}

export function WidgetCard(props: {
  span: Span;
  children: ReactNode;
  onClick?: () => void;
  className?: string;
  title?: string;
  cardRef?: RefObject<HTMLDivElement | null>;
  padded?: boolean;
}) {
  const { span, children, onClick, className = "", title, cardRef, padded = true } = props;
  return (
    <div
      ref={cardRef}
      title={title}
      onClick={onClick}
      className={`lb-card relative flex shrink-0 items-center overflow-hidden ${padded ? "px-2.5" : ""} ${className}`}
      style={spanCss(span)}
    >
      {children}
    </div>
  );
}

export function ProgressBar(props: { value: number; color?: string; height?: number; className?: string }) {
  const { value, color = "var(--lb-accent)", height = 4, className = "" } = props;
  return (
    <div className={`w-full overflow-hidden rounded-full ${className}`} style={{ height, background: "var(--lb-track)" }}>
      <div
        className="h-full rounded-full"
        style={{ width: `${clamp(value, 0, 100)}%`, background: color, transition: "width 600ms cubic-bezier(0.2, 0.8, 0.2, 1)" }}
      />
    </div>
  );
}

export function usageColor(percent: number, base = "var(--lb-green)"): string {
  if (percent >= 90) return "var(--lb-red)";
  if (percent >= 70) return "var(--lb-amber)";
  return base;
}

export function Sparkline(props: { values: number[]; width: number; height: number; color?: string; fill?: boolean; max?: number }) {
  const { values, width, height, color = "var(--lb-accent)", fill = true, max } = props;
  if (values.length < 2) return <svg width={width} height={height} aria-hidden />;
  const hi = max ?? Math.max(...values, 1e-9);
  const lo = max !== undefined ? 0 : Math.min(...values, 0);
  const span = hi - lo || 1;
  const step = width / (values.length - 1);
  const pts = values.map((v, i) => [i * step, height - 1 - ((v - lo) / span) * (height - 2)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${width},${height} L0,${height} Z`;
  const gid = `spark-${Math.abs(values.length * 31 + Math.round(hi * 7))}-${width}`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden style={{ overflow: "visible" }}>
      {fill && (
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.35} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
      )}
      {fill && <path d={area} fill={`url(#${gid})`} />}
      <path d={line} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function Ring(props: { value: number; size: number; stroke?: number; color?: string; children?: ReactNode }) {
  const { value, size, stroke = 4, color = "var(--lb-accent)", children } = props;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = clamp(value, 0, 100) / 100;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--lb-track)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${c * v} ${c}`}
          style={{ transition: "stroke-dasharray 700ms cubic-bezier(0.2, 0.8, 0.2, 1)" }}
        />
      </svg>
      {children && <div className="absolute inset-0 flex items-center justify-center">{children}</div>}
    </div>
  );
}

/** Open Settings on `tab`. The window is created on demand, so the tab travels in its URL; an
 *  already-open window is told to switch by the backend. */
export function openSettings(tab = "general"): void {
  void ipc.openWindow("settings", tab);
}

/** Unconfigured / error states shared by every provider widget. */
export function ProviderState(props: {
  span: Span;
  providerId: ProviderId;
  glyph: ReactNode;
  name: string;
  status: string;
  error: string | null;
  tab?: string;
}) {
  const { span, glyph, name, status, error, tab = "accounts" } = props;
  const preview = usePreview();
  const { t } = useI18n();
  const loading = status === "loading";
  return (
    <WidgetCard span={span} onClick={preview || loading ? undefined : () => openSettings(tab)} title={error ?? undefined}>
      <div className="flex min-w-0 items-center gap-2">
        <div className="shrink-0">{glyph}</div>
        <div className="min-w-0 leading-tight">
          <div className="truncate font-semibold">{name}</div>
          <div className="flex items-center gap-1 truncate lb-muted" style={{ fontSize: "var(--lb-small)" }}>
            {loading ? (
              <span style={{ animation: "lb-pulse 1.4s ease-in-out infinite" }}>{t("common.loading")}</span>
            ) : status === "error" ? (
              <>
                <AlertTriangle size={10} className="shrink-0" style={{ color: "var(--lb-amber)" }} />
                <span className="truncate">{error ?? t("common.error")}</span>
              </>
            ) : (
              <>
                <Settings2 size={10} className="shrink-0" />
                <span className="truncate">{t("common.setup")}</span>
              </>
            )}
          </div>
        </div>
      </div>
    </WidgetCard>
  );
}

/** Popover rendered above (bottom dock) or below (top dock) its anchor, inside the dock window. */
export function Popover(props: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  width: number;
  children: ReactNode;
}) {
  const { anchor, open, onClose, width, children } = props;
  const position = useHub((s) => s.position);
  const ref = useRef<HTMLDivElement | null>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });
  useHitRegion(ref, open);

  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const r = anchor.current.getBoundingClientRect();
    const left = clamp(r.left + r.width / 2 - width / 2, 8, window.innerWidth - width - 8);
    setStyle(
      position === "bottom"
        ? { left, bottom: window.innerHeight - r.top + 10, width }
        : { left, top: r.bottom + 10, width },
    );
  }, [open, anchor, width, position]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || anchor.current?.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onBlur = () => onClose();
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlur);
    };
  }, [open, onClose, anchor]);

  if (!open) return null;
  return createPortal(
    <div
      ref={ref}
      className="lb-menu lb-pop fixed z-50 p-3"
      style={{ ...style, transformOrigin: position === "bottom" ? "bottom center" : "top center", color: "var(--lb-text)" }}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------- provider glyphs (original artwork)

function Tile(props: { bg: string; children: ReactNode; size?: number }) {
  const size = props.size ?? 22;
  return (
    <div className="flex shrink-0 items-center justify-center rounded-[7px]" style={{ width: size, height: size, background: props.bg }}>
      {props.children}
    </div>
  );
}

export function BrandGlyph(props: { id: string; size?: number }) {
  const s = props.size ?? 22;
  const inner = Math.round(s * 0.64);
  switch (props.id) {
    case "claude":
      return (
        <Tile bg="#D97757" size={s}>
          <svg width={inner} height={inner} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round">
            {Array.from({ length: 8 }, (_, i) => {
              const a = (i * Math.PI) / 4;
              return <line key={i} x1={12 + Math.cos(a) * 3} y1={12 + Math.sin(a) * 3} x2={12 + Math.cos(a) * 10} y2={12 + Math.sin(a) * 10} />;
            })}
          </svg>
        </Tile>
      );
    case "gemini":
      return (
        <Tile bg="linear-gradient(135deg,#4F8DF7,#9B72F2 60%,#D96570)" size={s}>
          <svg width={inner} height={inner} viewBox="0 0 24 24">
            <path d="M12 1.5c.6 5.6 4.9 9.9 10.5 10.5-5.6.6-9.9 4.9-10.5 10.5C11.4 16.9 7.1 12.6 1.5 12 7.1 11.4 11.4 7.1 12 1.5z" fill="#fff" />
          </svg>
        </Tile>
      );
    case "chatgpt":
      return (
        <Tile bg="#10A37F" size={s}>
          <svg width={inner} height={inner} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2">
            <path d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z" />
            <circle cx="12" cy="12" r="2.6" />
          </svg>
        </Tile>
      );
    case "grok":
      return (
        <Tile bg="#111" size={s}>
          <svg width={inner} height={inner} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round">
            <circle cx="12" cy="12" r="8" />
            <line x1="6" y1="18" x2="18" y2="6" />
          </svg>
        </Tile>
      );
    case "deepseek":
      return (
        <Tile bg="#4D6BFE" size={s}>
          <svg width={inner} height={inner} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round">
            <path d="M3 14c3-5 6-5 9 0s6 5 9 0" />
            <circle cx="17" cy="8" r="1.2" fill="#fff" />
          </svg>
        </Tile>
      );
    case "glm":
      return (
        <Tile bg="#1F2A44" size={s}>
          <svg width={inner} height={inner} viewBox="0 0 24 24" fill="none" stroke="#8AB4FF" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 6h12L6 18h12" />
          </svg>
        </Tile>
      );
    case "stripe":
      return <Letter bg="#635BFF" letter="S" size={s} />;
    case "polar":
      return (
        <Tile bg="#0B0B0F" size={s}>
          <svg width={inner} height={inner} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2">
            <circle cx="12" cy="12" r="8" />
            <ellipse cx="12" cy="12" rx="3.5" ry="8" />
          </svg>
        </Tile>
      );
    case "dodo":
      return <Letter bg="#F5B100" letter="D" size={s} color="#111" />;
    case "datafast":
      return (
        <Tile bg="#E5484D" size={s}>
          <svg width={inner} height={inner} viewBox="0 0 24 24" fill="#fff">
            <path d="M13 2L4 14h7l-1 8 9-12h-7z" />
          </svg>
        </Tile>
      );
    case "gmail":
      return (
        <Tile bg="#fff" size={s}>
          <svg width={inner} height={inner} viewBox="0 0 24 24" fill="none" strokeWidth="2.4" strokeLinejoin="round">
            <path d="M3 6.5V18h4V10l5 4 5-4v8h4V6.5l-9 6.5z" stroke="#EA4335" />
          </svg>
        </Tile>
      );
    case "x":
      return <Letter bg="#000" letter="𝕏" size={s} />;
    case "youtube":
      return (
        <Tile bg="#FF0033" size={s}>
          <svg width={inner} height={inner} viewBox="0 0 24 24" fill="#fff">
            <path d="M9 7.5v9l7.5-4.5z" />
          </svg>
        </Tile>
      );
    case "instagram":
      return (
        <Tile bg="linear-gradient(45deg,#FEDA75,#FA7E1E 30%,#D62976 60%,#962FBF 85%,#4F5BD5)" size={s}>
          <svg width={inner} height={inner} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2">
            <rect x="4" y="4" width="16" height="16" rx="5" />
            <circle cx="12" cy="12" r="3.6" />
            <circle cx="17" cy="7" r="0.8" fill="#fff" />
          </svg>
        </Tile>
      );
    case "github":
      return (
        <Tile bg="#24292F" size={s}>
          <svg width={inner} height={inner} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="10" r="6" />
            <path d="M9 21v-3.5M15 21v-3.5M9 17.5c-3 .7-4-1-4.5-2" />
          </svg>
        </Tile>
      );
    case "leetcode":
      return (
        <Tile bg="#1A1A1A" size={s}>
          <svg width={inner} height={inner} viewBox="0 0 24 24" fill="none" stroke="#FFA116" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 4L7 11.5l7 7.5" />
            <path d="M10 12h9" stroke="#B3B3B3" />
          </svg>
        </Tile>
      );
    default:
      return <Letter bg="var(--lb-card-hover)" letter={props.id.slice(0, 1).toUpperCase()} size={s} />;
  }
}

function Letter(props: { bg: string; letter: string; size: number; color?: string }) {
  return (
    <Tile bg={props.bg} size={props.size}>
      <span style={{ color: props.color ?? "#fff", fontWeight: 800, fontSize: props.size * 0.56, lineHeight: 1 }}>{props.letter}</span>
    </Tile>
  );
}
