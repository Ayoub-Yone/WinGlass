// The Windows button at the far left of the dock, right against the app icons, and its system
// menu: connectivity tiles (Wi-Fi, Ethernet, Bluetooth), Mode Clear / Ambiance Musique / Do not
// disturb switches, lumabar and Windows settings, and power (lock, sleep, restart and shut down,
// the last two behind an in-menu confirmation). Closes on an outside click or Escape.

import {
  Bluetooth,
  ChevronRight,
  EthernetPort,
  Lock,
  Moon,
  MoonStar,
  Music2,
  PanelsTopLeft,
  Power,
  RotateCcw,
  Settings,
  SlidersHorizontal,
  Wifi,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Popover, openSettings } from "./ui";
import { useI18n } from "../i18n";
import { patchSettings, useSettings } from "../lib/hooks";
import { broadcast, errorMessage, ipc } from "../lib/ipc";
import { useRadios } from "../widgets/SystemWidgets";

/** Icons share one stroke weight across the button and the menu. */
const STROKE = 1.75;
/** Menu surface: radius 20, padding 10 -> inner tiles and rows use 20 - 10 = 10. */
const RADIUS = 20;
const PAD = 10;
const INNER = RADIUS - PAD;

const SURFACE: CSSProperties = {
  borderRadius: RADIUS,
  padding: PAD,
  background: "var(--lb-menu)",
  border: "1px solid rgb(255 255 255 / 0.12)",
  boxShadow: "inset 0 1px 0 rgb(255 255 255 / 0.08), var(--lb-shadow)",
  backdropFilter: "blur(30px) saturate(170%)",
  WebkitBackdropFilter: "blur(30px) saturate(170%)",
};

type PowerKind = "lock" | "sleep" | "restart" | "shutdown";

/** Superellipse (n = 5) tile: Apple-style continuous-curvature corners instead of circular ones. */
function squircle(x: number, y: number, s: number, n = 5, steps = 48): string {
  const a = s / 2;
  const pts: string[] = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * 2 * Math.PI;
    const c = Math.cos(t);
    const si = Math.sin(t);
    pts.push(`${(x + a + a * Math.sign(c) * Math.abs(c) ** (2 / n)).toFixed(2)},${(y + a + a * Math.sign(si) * Math.abs(si) ** (2 / n)).toFixed(2)}`);
  }
  return `M${pts.join("L")}Z`;
}

const TILE = 8.3;
const TILES = [
  [1, 1],
  [10.7, 1],
  [1, 10.7],
  [10.7, 10.7],
].map(([x, y]) => squircle(x, y, TILE));

/** The four Windows tiles, Apple-style: squircle tiles in frosted silver lit from the top, a soft
 *  top gloss, a hairline rim highlight and a fine contact shadow for relief. Follows the text
 *  color, so it turns graphite on the light theme. */
export function WindowsGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden style={{ overflow: "visible" }}>
      <defs>
        <linearGradient id="lb-win-frost" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" style={{ stopColor: "var(--lb-text)" }} />
          <stop offset="55%" style={{ stopColor: "var(--lb-text)", stopOpacity: 0.84 }} />
          <stop offset="100%" style={{ stopColor: "var(--lb-text)", stopOpacity: 0.6 }} />
        </linearGradient>
        <radialGradient id="lb-win-gloss" cx="0.5" cy="0" r="0.75">
          <stop offset="0%" stopColor="#fff" stopOpacity="0.42" />
          <stop offset="70%" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="lb-win-sheen" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#fff" stopOpacity="0.75" />
          <stop offset="35%" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      {TILES.map((d) => (
        <g key={d}>
          <path d={d} transform="translate(0 0.5)" fill="#000" fillOpacity="0.28" />
          <path d={d} fill="url(#lb-win-frost)" />
          <path d={d} fill="url(#lb-win-gloss)" />
          <path d={d} fill="none" stroke="url(#lb-win-sheen)" strokeWidth="0.55" />
        </g>
      ))}
    </svg>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="px-1.5 pb-1.5 pt-2 text-[10.5px] font-semibold uppercase tracking-[0.06em] lb-muted">{children}</div>;
}

function Tile(props: {
  icon: LucideIcon;
  label: string;
  status: string;
  on: boolean | null;
  busy?: boolean;
  onClick: () => void;
  settingsLabel: string;
  onSettings: () => void;
  testId: string;
}) {
  const { icon: Icon, label, status, on, busy, onClick, settingsLabel, onSettings, testId } = props;
  const active = on === true;
  return (
    <div
      className="relative min-w-0"
      style={{
        borderRadius: INNER,
        background: active ? "var(--lb-accent)" : "var(--lb-card)",
        color: active ? "#fff" : on === null ? "var(--lb-faint)" : "var(--lb-text)",
        boxShadow: "inset 0 0 0 1px rgb(255 255 255 / 0.06)",
        transition: "background-color 160ms ease",
        opacity: busy ? 0.65 : 1,
      }}
    >
      <button
        data-testid={testId}
        className="lb-focus flex w-full min-w-0 flex-col items-start gap-1.5 border-none bg-transparent p-2.5 pr-7 text-left"
        style={{ borderRadius: INNER, color: "inherit" }}
        aria-pressed={on === null ? undefined : active}
        aria-label={`${label} · ${status}`}
        disabled={busy}
        onClick={onClick}
      >
        <Icon size={17} strokeWidth={STROKE} />
        <span className="w-full min-w-0 leading-tight">
          <span className="block truncate text-[12px] font-semibold">{label}</span>
          <span className="block truncate text-[10.5px]" style={{ opacity: 0.78 }}>{status}</span>
        </span>
      </button>
      <button
        className="lb-icon-btn lb-focus absolute right-1 top-1 h-6 w-6"
        style={{ borderRadius: INNER - 4, color: "inherit" }}
        title={settingsLabel}
        aria-label={settingsLabel}
        onClick={onSettings}
      >
        <ChevronRight size={14} strokeWidth={STROKE} />
      </button>
    </div>
  );
}

function SwitchRow(props: { icon: LucideIcon; label: string; hint: string; checked: boolean; onChange: (v: boolean) => void; testId: string }) {
  const { icon: Icon, label, hint, checked, onChange, testId } = props;
  return (
    <button
      role="switch"
      aria-checked={checked}
      data-testid={testId}
      className="lb-row lb-focus flex w-full items-center gap-2.5 border-none bg-transparent px-2 py-1.5 text-left"
      style={{ borderRadius: INNER }}
      onClick={() => onChange(!checked)}
    >
      <Icon size={16} strokeWidth={STROKE} className="shrink-0" style={{ color: checked ? "var(--lb-accent)" : "var(--lb-muted)" }} />
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate text-[12px] font-medium">{label}</span>
        <span className="block truncate text-[10.5px] lb-muted">{hint}</span>
      </span>
      <span
        aria-hidden
        className="relative h-[18px] w-[30px] shrink-0 rounded-full"
        style={{ background: checked ? "var(--lb-accent)" : "var(--lb-track)", transition: "background-color 160ms ease" }}
      >
        <span
          className="absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white"
          style={{ left: checked ? 14 : 2, transition: "left 180ms cubic-bezier(0.3, 0.9, 0.3, 1.2)" }}
        />
      </span>
    </button>
  );
}

function LinkRow(props: { icon: LucideIcon; label: string; onClick: () => void; testId: string }) {
  const { icon: Icon, label, onClick, testId } = props;
  return (
    <button
      data-testid={testId}
      className="lb-row lb-focus flex w-full items-center gap-2.5 border-none bg-transparent px-2 py-1.5 text-left"
      style={{ borderRadius: INNER }}
      onClick={onClick}
    >
      <Icon size={16} strokeWidth={STROKE} className="shrink-0 lb-muted" />
      <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{label}</span>
      <ChevronRight size={14} strokeWidth={STROKE} className="shrink-0 lb-faint" />
    </button>
  );
}

function SystemMenuBody({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const settings = useSettings();
  const { state, toggle, busy, last } = useRadios();
  const [confirm, setConfirm] = useState<"restart" | "shutdown" | null>(null);
  const firstRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    firstRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }, []);

  const settingsPage = (uri: string) => {
    onClose();
    void ipc.openTarget(uri).catch(() => undefined);
  };

  const power = (kind: PowerKind) => {
    onClose();
    ipc.powerAction(kind).catch((err) => {
      void broadcast("toast:push", { id: `power-${kind}`, kind: "system", title: t("sysmenu.failed", { action: t(`sysmenu.${kind}`) }), subtitle: errorMessage(err) });
    });
  };

  const networkType = last?.networkType ?? "disconnected";
  const wifi = state("wifi");
  const wifiStatus = wifi === null ? t("sysmenu.unavailable") : networkType === "wifi" ? (last?.networkAdapter ? `${t("sysmenu.connected")} · ${last.networkAdapter}` : t("sysmenu.connected")) : wifi ? t("sysmenu.on") : t("sysmenu.off");
  const ethernet = networkType === "ethernet";
  const bluetooth = state("bluetooth");

  const powerItems: { kind: PowerKind; icon: LucideIcon }[] = [
    { kind: "lock", icon: Lock },
    { kind: "sleep", icon: MoonStar },
    { kind: "restart", icon: RotateCcw },
    { kind: "shutdown", icon: Power },
  ];

  return (
    <div role="dialog" aria-label={t("sysmenu.title")} data-testid="system-menu">
      <div ref={firstRef}>
        <SectionLabel>{t("sysmenu.connectivity")}</SectionLabel>
        <div className="grid grid-cols-3 gap-1.5">
          <Tile
            testId="sysmenu-wifi"
            icon={wifi === false ? WifiOff : Wifi}
            label={t("sysmenu.wifi")}
            status={wifiStatus}
            on={wifi}
            busy={busy === "wifi"}
            onClick={() => void toggle("wifi")}
            settingsLabel={t("sysmenu.openSettings", { label: t("sysmenu.wifi") })}
            onSettings={() => settingsPage("ms-settings:network-wifi")}
          />
          <Tile
            testId="sysmenu-ethernet"
            icon={EthernetPort}
            label={t("sysmenu.ethernet")}
            status={ethernet ? t("sysmenu.connected") : t("sysmenu.disconnected")}
            on={ethernet}
            onClick={() => settingsPage("ms-settings:network-ethernet")}
            settingsLabel={t("sysmenu.openSettings", { label: t("sysmenu.ethernet") })}
            onSettings={() => settingsPage("ms-settings:network-ethernet")}
          />
          <Tile
            testId="sysmenu-bluetooth"
            icon={Bluetooth}
            label={t("sysmenu.bluetooth")}
            status={bluetooth === null ? t("sysmenu.unavailable") : bluetooth ? t("sysmenu.on") : t("sysmenu.off")}
            on={bluetooth}
            busy={busy === "bluetooth"}
            onClick={() => void toggle("bluetooth")}
            settingsLabel={t("sysmenu.openSettings", { label: t("sysmenu.bluetooth") })}
            onSettings={() => settingsPage("ms-settings:bluetooth")}
          />
        </div>
      </div>

      <SectionLabel>{t("sysmenu.appearance")}</SectionLabel>
      <SwitchRow
        testId="sysmenu-clear"
        icon={PanelsTopLeft}
        label={t("sysmenu.clear")}
        hint={t("sysmenu.clearHint")}
        checked={settings?.clearMode ?? false}
        onChange={(v) => void patchSettings((s) => ({ ...s, clearMode: v }))}
      />
      <SwitchRow
        testId="sysmenu-ambiance"
        icon={Music2}
        label={t("sysmenu.ambiance")}
        hint={t("sysmenu.ambianceHint")}
        checked={settings?.musicAmbiance ?? false}
        onChange={(v) => void patchSettings((s) => ({ ...s, musicAmbiance: v }))}
      />
      <SwitchRow
        testId="sysmenu-dnd"
        icon={Moon}
        label={t("sysmenu.dnd")}
        hint={t("sysmenu.dndHint")}
        checked={settings?.doNotDisturb ?? false}
        onChange={(v) => void patchSettings((s) => ({ ...s, doNotDisturb: v }))}
      />

      <SectionLabel>{t("sysmenu.settings")}</SectionLabel>
      <LinkRow
        testId="sysmenu-lumabar-settings"
        icon={SlidersHorizontal}
        label={t("sysmenu.lumabarSettings")}
        onClick={() => {
          onClose();
          openSettings("general");
        }}
      />
      <LinkRow testId="sysmenu-windows-settings" icon={Settings} label={t("sysmenu.windowsSettings")} onClick={() => settingsPage("ms-settings:")} />

      <div className="mx-1.5 mb-1 mt-2 h-px" style={{ background: "var(--lb-track)" }} />
      {confirm ? (
        <div data-testid="sysmenu-confirm" className="px-1.5 pb-1 pt-1.5" role="alertdialog" aria-label={t(`sysmenu.${confirm}`)}>
          <div className="pb-2.5 text-[12px] leading-snug">{confirm === "restart" ? t("sysmenu.confirmRestart") : t("sysmenu.confirmShutdown")}</div>
          <div className="flex items-center justify-end gap-3">
            <button data-testid="sysmenu-confirm-cancel" className="lb-focus border-none bg-transparent px-1 py-1 text-[12px] lb-muted" onClick={() => setConfirm(null)} autoFocus>
              {t("sysmenu.cancel")}
            </button>
            <button
              data-testid="sysmenu-confirm-ok"
              className="lb-focus border-none px-3 py-1.5 text-[12px] font-semibold"
              style={{ borderRadius: INNER - 2, background: "var(--lb-red)", color: "#fff" }}
              onClick={() => power(confirm)}
            >
              {t(`sysmenu.${confirm}`)}
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-1" aria-label={t("sysmenu.power")} role="group">
          {powerItems.map(({ kind, icon: Icon }) => (
            <button
              key={kind}
              data-testid={`sysmenu-${kind}`}
              title={kind === "sleep" ? t("sysmenu.sleepFull") : undefined}
              aria-label={kind === "sleep" ? t("sysmenu.sleepFull") : undefined}
              className="lb-row lb-focus flex min-w-0 flex-col items-center gap-1 border-none bg-transparent px-1 py-2"
              style={{ borderRadius: INNER, color: kind === "shutdown" ? "var(--lb-red)" : "var(--lb-text)" }}
              onClick={() => (kind === "restart" || kind === "shutdown" ? setConfirm(kind) : power(kind))}
            >
              <Icon size={17} strokeWidth={STROKE} />
              <span className="w-full truncate text-center text-[10.5px]">{t(`sysmenu.${kind}`)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function WindowsButton() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button
        ref={ref}
        data-testid="windows-button"
        data-no-drag
        className="lb-winbtn lb-focus flex shrink-0 items-center justify-center"
        title={t("sysmenu.button")}
        aria-label={t("sysmenu.button")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <WindowsGlyph size={18} />
      </button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} width={330} surface={SURFACE} testId="system-menu-popover">
        <SystemMenuBody onClose={() => setOpen(false)} />
      </Popover>
    </>
  );
}
