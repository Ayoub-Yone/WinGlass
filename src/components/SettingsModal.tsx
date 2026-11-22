// Settings: a floating frosted sidebar (search + grouped navigation) next to a dark bento canvas.
// Appearance (themes, Clair ↔ Givré, radius / refraction dials), dock & taskbar, widgets (weather,
// prayer times, clocks), accounts / API keys (DPAPI-encrypted), calendar feeds, integrations,
// automations and advanced. With « Ambiance Musique » on, the window takes the playing cover's
// colours like the dock does.

import {
  AlertTriangle,
  CalendarDays,
  Check,
  CheckCircle2,
  Coffee,
  KeyRound,
  LayoutGrid,
  LogIn,
  Lock,
  Minus,
  Monitor,
  Palette,
  Plug,
  Plus,
  Power,
  RefreshCw,
  Search,
  Settings2,
  SlidersHorizontal,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { BrandGlyph } from "./ui";
import { LANGUAGES, useI18n, type TranslationKey } from "../i18n";
import { AI_PROVIDERS, useHub } from "../engine/DataHub";
import { DEFAULT_FROST_LEVEL, SIZE_ORDER, SIZES, THEMES, THEME_ORDER } from "../engine/ThemeEngine";
import { patchSettings, useSettings } from "../lib/hooks";
import { clamp, formatPercent } from "../lib/format";
import { broadcast, errorMessage, ipc, subscribe } from "../lib/ipc";
import { useAmbientColors } from "../lib/useAmbient";
import { CitySearch } from "../widgets/WeatherWidget";
import { PRAYER_METHODS, PrayerAlertControls, PrayerPlacePicker } from "../widgets/PrayerTimesWidget";
import type { AccountStatus, AutomationSettings, Language, ProviderId, Settings, TaskbarMode } from "../types/winglass";

type Tab = "general" | "appearance" | "widgets" | "calendar" | "accounts" | "integrations" | "automations" | "advanced";

const NAV: Array<{ group: TranslationKey; items: Array<{ id: Tab; label: TranslationKey; icon: LucideIcon }> }> = [
  { group: "settings.group.general", items: [{ id: "general", label: "settings.tab.general", icon: Settings2 }] },
  { group: "settings.group.appearance", items: [{ id: "appearance", label: "settings.tab.appearance", icon: Palette }] },
  {
    group: "settings.group.widgets",
    items: [
      { id: "widgets", label: "settings.tab.widgets", icon: LayoutGrid },
      { id: "calendar", label: "settings.tab.calendar", icon: CalendarDays },
    ],
  },
  {
    group: "settings.group.integrations",
    items: [
      { id: "accounts", label: "settings.tab.accounts", icon: KeyRound },
      { id: "integrations", label: "settings.tab.integrations", icon: Plug },
    ],
  },
  {
    group: "settings.group.system",
    items: [
      { id: "automations", label: "settings.tab.automations", icon: Zap },
      { id: "advanced", label: "settings.tab.advanced", icon: SlidersHorizontal },
    ],
  },
];
const TABS = NAV.flatMap((g) => g.items);

/** Dark obsidian tokens: the canvas stays dark whatever the dock theme is. */
const CANVAS_TOKENS = {
  "--lb-text": "#F3F4F6",
  "--lb-muted": "rgb(235 235 245 / 0.62)",
  "--lb-faint": "rgb(235 235 245 / 0.38)",
  "--lb-card": "rgb(255 255 255 / 0.05)",
  "--lb-card-hover": "rgb(255 255 255 / 0.10)",
  "--lb-track": "rgb(255 255 255 / 0.08)",
  "--lb-menu": "rgb(24 26 32 / 0.97)",
  "--lb-border": "1px solid rgb(255 255 255 / 0.10)",
} as Record<string, string>;

const TOGGLE_ON = "#34C759";

// ---------------------------------------------------------------- form primitives

/** Bento card: 20 px radius, hairline border, soft top highlight. Rows inside sit on hairlines. */
function Section(props: { title: string; description?: string; children: ReactNode; span?: 1 | 2; aside?: ReactNode }) {
  return (
    <section
      className="flex min-w-0 flex-col rounded-[20px] p-4"
      style={{
        gridColumn: props.span === 1 ? "span 1" : "1 / -1",
        background: "linear-gradient(180deg, rgb(255 255 255 / 0.055), rgb(255 255 255 / 0.03))",
        border: "1px solid rgb(255 255 255 / 0.08)",
        boxShadow: "inset 0 1px 0 rgb(255 255 255 / 0.06)",
      }}
    >
      <div className="mb-1 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="m-0 text-[13px] font-semibold">{props.title}</h3>
          {props.description && <p className="m-0 mt-0.5 text-[11.5px] lb-muted">{props.description}</p>}
        </div>
        {props.aside}
      </div>
      <div className="flex flex-col gap-1.5">{props.children}</div>
    </section>
  );
}

function Bento({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3">{children}</div>;
}

const SUPPORT_URL = "https://ko-fi.com/ayoubyone";

function Row(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4 border-0 border-t border-solid py-2.5 first:border-t-0" style={{ borderColor: "rgb(255 255 255 / 0.06)" }}>
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px]" style={{ overflowWrap: "anywhere" }}>{props.label}</div>
        {props.hint && <div className="text-[11px] lb-muted">{props.hint}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{props.children}</div>
    </div>
  );
}

function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      className="lb-focus relative h-[26px] w-[44px] shrink-0 rounded-full border-none p-0"
      style={{ background: props.checked ? TOGGLE_ON : "rgb(255 255 255 / 0.14)", transition: "background 180ms" }}
      onClick={() => props.onChange(!props.checked)}
    >
      <span
        className="absolute top-[3px] h-[20px] w-[20px] rounded-full bg-white"
        style={{ left: props.checked ? 21 : 3, boxShadow: "0 2px 6px rgb(0 0 0 / 0.3)", transition: "left 200ms cubic-bezier(0.3, 0.9, 0.3, 1.2)" }}
      />
    </button>
  );
}

function Segmented<T extends string>(props: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void }) {
  return (
    <div className="flex rounded-full p-[3px]" role="radiogroup" style={{ background: "rgb(255 255 255 / 0.07)" }}>
      {props.options.map((o) => {
        const active = props.value === o.value;
        return (
          <button
            key={o.value}
            role="radio"
            aria-checked={active}
            className="lb-focus whitespace-nowrap rounded-full border-none px-3 py-1 text-[12px]"
            style={{
              background: active ? "rgb(255 255 255 / 0.16)" : "transparent",
              fontWeight: active ? 600 : 450,
              color: active ? "var(--lb-text)" : "var(--lb-muted)",
              boxShadow: active ? "inset 0 1px 0 rgb(255 255 255 / 0.12)" : undefined,
            }}
            onClick={() => props.onChange(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Text/number input that commits on blur or Enter (avoids a settings write per keystroke). */
function CommitInput(props: { value: string | number; onCommit: (v: string) => void; type?: "text" | "number"; width?: number; placeholder?: string }) {
  const [draft, setDraft] = useState(String(props.value));
  useEffect(() => setDraft(String(props.value)), [props.value]);
  const commit = () => draft !== String(props.value) && props.onCommit(draft);
  return (
    <input
      type={props.type ?? "text"}
      value={draft}
      placeholder={props.placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
      className="lb-focus rounded-lg border-none px-2.5 py-1.5 text-[12px] outline-none"
      style={{ background: "var(--lb-track)", width: props.width ?? 200, color: "var(--lb-text)" }}
    />
  );
}

const update = (mutate: (s: Settings) => Settings) => void patchSettings(mutate);

/**
 * Spatial-style radial dial: a 270° arc with a glowing value stroke, a knob, the live readout in
 * the centre and − / + steppers. Drag the arc, use the arrow keys, or the steppers.
 */
function RadialDial(props: { label: string; value: number; min: number; max: number; step: number; format: (v: number) => string; onChange: (v: number) => void; disabled?: boolean }) {
  const { label, value, min, max, step, format, onChange, disabled } = props;
  const svgRef = useRef<SVGSVGElement | null>(null);
  const SIZE = 156;
  const R = 60;
  const C = SIZE / 2;
  const START = 135;
  const SWEEP = 270;
  const frac = clamp((value - min) / (max - min), 0, 1);
  const polar = (deg: number) => [C + R * Math.cos((deg * Math.PI) / 180), C + R * Math.sin((deg * Math.PI) / 180)];
  const arc = (from: number, to: number) => {
    const [x1, y1] = polar(from);
    const [x2, y2] = polar(to);
    return `M${x1.toFixed(2)} ${y1.toFixed(2)} A${R} ${R} 0 ${to - from > 180 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
  };
  const end = START + SWEEP * frac;
  const [kx, ky] = polar(end);
  const set = (v: number) => {
    const next = clamp(Math.round(v / step) * step, min, max);
    if (next !== value) onChange(Number(next.toFixed(4)));
  };
  const fromPointer = (e: ReactPointerEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const angle = (Math.atan2(e.clientY - rect.top - rect.height / 2, e.clientX - rect.left - rect.width / 2) * 180) / Math.PI;
    let rel = (angle - START + 360) % 360;
    // The 90° gap at the bottom snaps to the nearer end.
    if (rel > SWEEP) rel = rel - SWEEP < (360 - SWEEP) / 2 ? SWEEP : 0;
    set(min + (rel / SWEEP) * (max - min));
  };
  const onKey = (e: ReactKeyboardEvent) => {
    const delta = e.key === "ArrowUp" || e.key === "ArrowRight" ? step : e.key === "ArrowDown" || e.key === "ArrowLeft" ? -step : 0;
    if (e.key === "Home") set(min);
    else if (e.key === "End") set(max);
    else if (delta) set(value + delta);
    else return;
    e.preventDefault();
  };
  return (
    <div className="flex flex-col items-center gap-1" style={{ opacity: disabled ? 0.45 : 1 }}>
      <svg
        ref={svgRef}
        width={SIZE}
        height={SIZE - 18}
        viewBox={`0 0 ${SIZE} ${SIZE - 18}`}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={format(value)}
        aria-disabled={disabled}
        className="lb-focus cursor-pointer touch-none rounded-full"
        onKeyDown={disabled ? undefined : onKey}
        onPointerDown={(e) => {
          if (disabled) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          fromPointer(e);
        }}
        onPointerMove={(e) => !disabled && e.currentTarget.hasPointerCapture(e.pointerId) && fromPointer(e)}
      >
        <path d={arc(START, START + SWEEP)} fill="none" stroke="rgb(255 255 255 / 0.08)" strokeWidth={10} strokeLinecap="round" />
        {frac > 0.001 && (
          <path d={arc(START, end)} fill="none" stroke="var(--set-accent)" strokeWidth={10} strokeLinecap="round" style={{ filter: "drop-shadow(0 0 6px color-mix(in oklch, var(--set-accent) 70%, transparent))", transition: "stroke 600ms ease" }} />
        )}
        <circle cx={kx} cy={ky} r={7} fill="#fff" stroke="var(--set-accent)" strokeWidth={2.5} />
        <text x={C} y={C - 2} textAnchor="middle" fontSize={26} fontWeight={650} fill="var(--lb-text)" style={{ fontVariantNumeric: "tabular-nums" }}>
          {format(value)}
        </text>
        <text x={C} y={C + 16} textAnchor="middle" fontSize={10.5} fill="var(--lb-muted)">
          {label}
        </text>
      </svg>
      <div className="flex items-center gap-2">
        {[
          { icon: Minus, delta: -step, aria: `${label} −` },
          { icon: Plus, delta: step, aria: `${label} +` },
        ].map(({ icon: Icon, delta, aria }) => (
          <button
            key={aria}
            className="lb-focus flex h-8 w-8 items-center justify-center rounded-full border-none"
            style={{ background: "rgb(255 255 255 / 0.08)", color: "var(--lb-text)" }}
            aria-label={aria}
            disabled={disabled}
            onClick={() => set(value + delta)}
          >
            <Icon size={14} strokeWidth={2.6} />
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- tabs

function GeneralTab({ s }: { s: Settings }) {
  const { t, lang } = useI18n();
  const taskbarOptions: Array<{ value: TaskbarMode; label: string }> = [
    { value: "auto_hide", label: t("settings.taskbar.autoHide") },
    { value: "completely_hidden", label: t("settings.taskbar.hidden") },
    { value: "native", label: t("settings.taskbar.keep") },
  ];
  return (
    <Bento>
      <Section title={t("settings.dock")} description={t("settings.dockDesc")}>
        <Row label={t("settings.position")}>
          <Segmented
            value={s.position}
            options={[
              { value: "bottom", label: t("menu.bottom") },
              { value: "top", label: t("menu.top") },
            ]}
            onChange={(position) => void ipc.setDockPosition(position)}
          />
        </Row>
        <Row label={t("settings.visibility")} hint={t("settings.autoHideDockHint")}>
          <Segmented
            value={s.autoHideDock ? "auto" : "always"}
            options={[
              { value: "always", label: t("settings.alwaysVisible") },
              { value: "auto", label: t("settings.autoHideShort") },
            ]}
            onChange={(v) => update((x) => ({ ...x, autoHideDock: v === "auto" }))}
          />
        </Row>
        <Row label={t("settings.hideFullscreen")} hint={t("settings.hideFullscreenHint")}>
          <Toggle label={t("settings.hideFullscreen")} checked={s.hideOnFullscreen} onChange={(v) => update((x) => ({ ...x, hideOnFullscreen: v }))} />
        </Row>
        <Row label={t("settings.launchAtLogin")}>
          <Toggle label={t("settings.launchAtLogin")} checked={s.launchAtLogin} onChange={(v) => update((x) => ({ ...x, launchAtLogin: v }))} />
        </Row>
      </Section>
      <Section span={1} title={t("settings.taskbar")} description={t("settings.taskbarDesc")}>
        <div className="pt-1">
          <Segmented value={s.taskbarMode} options={taskbarOptions} onChange={(mode) => void ipc.setTaskbarMode(mode)} />
        </div>
        <p className="m-0 text-[11px] lb-muted">
          {s.taskbarMode === "completely_hidden" ? t("settings.taskbar.hintHidden") : s.taskbarMode === "auto_hide" ? t("settings.taskbar.hintAutoHide") : t("settings.taskbar.hintKeep")}
        </p>
      </Section>
      <Section span={1} title={t("settings.language")} description={t("settings.languageHint")}>
        <div className="pt-1">
          <Segmented<Language> value={lang} options={LANGUAGES.map((l) => ({ value: l.id, label: l.label }))} onChange={(language) => update((x) => ({ ...x, language }))} />
        </div>
      </Section>
      <Section title={t("settings.support")}>
        <Row label={t("settings.supportLabel")} hint={t("settings.supportHint")}>
          <button className="lb-focus flex items-center gap-1 rounded-full border-none px-3 py-1 text-[12px]" style={{ background: "var(--lb-track)", color: "var(--lb-text)" }} onClick={() => void ipc.openTarget(SUPPORT_URL)}>
            <Coffee size={12} /> Ko-fi
          </button>
        </Row>
      </Section>
    </Bento>
  );
}

function AppearanceTab({ s }: { s: Settings }) {
  const { t } = useI18n();
  const glassTheme = THEMES[s.theme]?.usesGlassShader ?? false;
  const frostLevel = Math.round((s.glassFrostLevel ?? DEFAULT_FROST_LEVEL) * 100);
  const frostKey = frostLevel < 34 ? "frost.clear" : frostLevel < 67 ? "frost.balanced" : "frost.frosted";
  const frostName = t(frostKey);
  return (
    <Bento>
      <Section title={t("settings.glassCard")} description={t(`theme.${s.theme}.desc`)}>
        <div className="flex flex-wrap items-start gap-2 py-2" role="radiogroup" aria-label={t("settings.surface")}>
          {THEME_ORDER.map((id) => {
            const tokens = THEMES[id];
            const active = s.theme === id;
            return (
              <button key={id} role="radio" aria-checked={active} className="lb-focus flex w-[82px] flex-col items-center gap-1.5 rounded-xl border-none bg-transparent p-0" onClick={() => update((x) => ({ ...x, theme: id }))}>
                <span
                  className="block h-11 w-11 rounded-full"
                  style={{
                    background: tokens.usesGlassShader
                      ? `radial-gradient(circle at 32% 28%, rgb(255 255 255 / 0.55), transparent 42%), linear-gradient(${tokens.surface}, ${tokens.surface}), linear-gradient(135deg in oklch, rgb(120 160 255), rgb(255 140 190))`
                      : `radial-gradient(circle at 32% 28%, rgb(255 255 255 / 0.35), transparent 45%), ${tokens.surface}`,
                    border: tokens.border,
                    outline: active ? "2px solid var(--set-accent)" : "2px solid transparent",
                    outlineOffset: 3,
                    transition: "outline-color 200ms",
                  }}
                />
                <span className="w-full truncate text-center text-[11px]" style={{ fontWeight: active ? 650 : 450, color: active ? "var(--lb-text)" : "var(--lb-muted)" }}>
                  {t(`theme.${id}.name`)}
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex flex-col gap-1 border-0 border-t border-solid pt-3" style={{ borderColor: "rgb(255 255 255 / 0.06)", opacity: glassTheme ? 1 : 0.5 }}>
          <div className="flex items-baseline gap-2 text-[12.5px]">
            <span className="flex-1">{t("settings.frost")}</span>
            <span className="text-[12px] font-semibold tabular-nums">{glassTheme ? `${frostName} · ${formatPercent(frostLevel)}` : t("settings.frostHint")}</span>
          </div>
          <input
            type="range"
            data-testid="frost-slider"
            min={0}
            max={100}
            step={1}
            value={frostLevel}
            disabled={!glassTheme}
            aria-label={t("settings.frost")}
            aria-valuetext={`${frostName}, ${formatPercent(frostLevel)}`}
            onChange={(e) => {
              const glassFrostLevel = Number(e.target.value) / 100;
              update((x) => ({ ...x, glassFrostLevel }));
            }}
            style={{ accentColor: "var(--set-accent)" }}
          />
          <div className="flex justify-between text-[10.5px] lb-muted">
            <span>{t("frost.clear")}</span>
            <span>{t("frost.frosted")}</span>
          </div>
        </div>
      </Section>
      <Section span={1} title={t("settings.dockRadius")} description={t("settings.dockRadiusHint")}>
        <div className="flex justify-center pt-1">
          <RadialDial label={t("settings.radius")} value={s.dockRadius ?? 22} min={8} max={34} step={1} format={(v) => `${Math.round(v)}px`} onChange={(dockRadius) => update((x) => ({ ...x, dockRadius }))} />
        </div>
      </Section>
      <Section span={1} title={t("settings.refraction")} description={glassTheme ? t("settings.refractionHint") : t("settings.frostHint")}>
        <div className="flex justify-center pt-1">
          <RadialDial
            label={t("settings.intensity")}
            value={Math.round((s.glassRefraction ?? 1) * 100)}
            min={50}
            max={200}
            step={5}
            disabled={!glassTheme}
            format={(v) => formatPercent(v)}
            onChange={(v) => update((x) => ({ ...x, glassRefraction: v / 100 }))}
          />
        </div>
      </Section>
      <Section title={t("settings.surface")} description={t("settings.surfaceDesc")}>
        <Row label={t("sysmenu.ambiance")} hint={t("settings.ambianceHintUi")}>
          <Toggle label={t("sysmenu.ambiance")} checked={s.musicAmbiance} onChange={(v) => update((x) => ({ ...x, musicAmbiance: v }))} />
        </Row>
        <Row label={t("sysmenu.clear")} hint={t("settings.clearHint")}>
          <Toggle label={t("sysmenu.clear")} checked={s.clearMode} onChange={(v) => update((x) => ({ ...x, clearMode: v }))} />
        </Row>
        <Row label={t("settings.dockHeight")} hint={`${SIZES[s.size].height}px`}>
          <Segmented value={s.size} options={SIZE_ORDER.map((id) => ({ value: id, label: t(`size.${id}`) }))} onChange={(size) => update((x) => ({ ...x, size }))} />
        </Row>
        <Row label={t("settings.accent")}>
          <input type="color" aria-label={t("settings.accent")} value={s.accent} onChange={(e) => update((x) => ({ ...x, accent: e.target.value }))} className="h-7 w-10 cursor-pointer rounded border-none bg-transparent" />
        </Row>
      </Section>
    </Bento>
  );
}

function WidgetsTab({ s }: { s: Settings }) {
  const { t } = useI18n();
  const p = s.providers;
  const [weatherSearch, setWeatherSearch] = useState(false);
  const [prayerSearch, setPrayerSearch] = useState(false);
  const num = (v: string, fallback: number) => (Number.isFinite(Number(v)) && v.trim() !== "" ? Number(v) : fallback);
  const prayerPlace = s.prayer.source === "mawaqit" ? s.prayer.mosqueName || s.prayer.mosqueSlug : s.prayer.city;
  const methodLabel = PRAYER_METHODS.find((m) => m.id === s.prayer.method)?.label ?? String(s.prayer.method);
  return (
    <Bento>
      <Section
        span={1}
        title={t("settings.weather")}
        description={t("settings.weatherDesc")}
        aside={
          <button className="lb-focus shrink-0 rounded-full border-none px-2.5 py-1 text-[11.5px] font-semibold" style={{ background: "var(--lb-track)", color: "var(--set-accent)" }} onClick={() => setWeatherSearch((v) => !v)}>
            {weatherSearch ? t("common.done") : t("weather.change")}
          </button>
        }
      >
        {weatherSearch ? (
          <CitySearch onDone={() => setWeatherSearch(false)} />
        ) : (
          <>
            <Row label={p.weatherCity || "—"} hint={`${p.weatherLatitude.toFixed(2)}, ${p.weatherLongitude.toFixed(2)}`}>
              <span />
            </Row>
            <Row label={t("settings.units")}>
              <Segmented value={p.weatherFahrenheit ? "f" : "c"} options={[{ value: "c", label: "°C" }, { value: "f", label: "°F" }]} onChange={(v) => update((x) => ({ ...x, providers: { ...x.providers, weatherFahrenheit: v === "f" } }))} />
            </Row>
          </>
        )}
      </Section>
      <Section
        span={1}
        title={t("prayer.name")}
        description={prayerPlace ? `${prayerPlace}${s.prayer.source === "city" ? ` · ${methodLabel}` : " · Mawaqit"}` : t("prayer.setup")}
        aside={
          <button className="lb-focus shrink-0 rounded-full border-none px-2.5 py-1 text-[11.5px] font-semibold" style={{ background: "var(--lb-track)", color: "var(--set-accent)" }} onClick={() => setPrayerSearch((v) => !v)}>
            {prayerSearch ? t("common.done") : t("weather.change")}
          </button>
        }
      >
        {prayerSearch ? <PrayerPlacePicker prefs={s.prayer} onDone={() => setPrayerSearch(false)} /> : <div className="pt-1"><PrayerAlertControls prefs={s.prayer} /></div>}
      </Section>
      <Section title={t("settings.worldClocks")} description={t("settings.worldClocksDesc")}>
        {s.worldClocks.map((c, i) => (
          <Row key={i} label={t("settings.clockN", { n: i + 1 })}>
            <CommitInput width={70} value={c.label} onCommit={(v) => update((x) => ({ ...x, worldClocks: x.worldClocks.map((w, j) => (j === i ? { ...w, label: v.slice(0, 4).toUpperCase() } : w)) }))} />
            <CommitInput width={170} value={c.timeZone} onCommit={(v) => update((x) => ({ ...x, worldClocks: x.worldClocks.map((w, j) => (j === i ? { ...w, timeZone: v.trim() } : w)) }))} />
          </Row>
        ))}
      </Section>
      <Section title={t("settings.pomodoro")}>
        <Row label={t("settings.pomodoroMinutes")}>
          <CommitInput type="number" width={70} value={s.pomodoroFocusMinutes} onCommit={(v) => update((x) => ({ ...x, pomodoroFocusMinutes: Math.max(1, Math.round(num(v, 25))) }))} />
          <CommitInput type="number" width={70} value={s.pomodoroBreakMinutes} onCommit={(v) => update((x) => ({ ...x, pomodoroBreakMinutes: Math.max(1, Math.round(num(v, 5))) }))} />
        </Row>
      </Section>
    </Bento>
  );
}

interface SecretField {
  name: string;
  label: TranslationKey;
  hint?: string;
}

interface AccountSpec {
  id: ProviderId;
  name: string;
  fields: SecretField[];
  note?: TranslationKey;
  /** One-click sign-in through the provider's official CLI. */
  signIn?: AccountStatus["provider"];
}

const AI_ACCOUNTS: AccountSpec[] = [
  {
    id: "claude",
    name: "Claude",
    fields: [
      { name: "claude_session_key", label: "account.claude.session", hint: "sk-ant-sid…" },
      { name: "claude_oauth_token", label: "account.claude.oauth" },
    ],
    note: "account.claude.note",
    signIn: "claude",
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    fields: [
      { name: "chatgpt_access_token", label: "account.chatgpt.token" },
      { name: "chatgpt_account_id", label: "account.chatgpt.account" },
    ],
    note: "account.chatgpt.note",
    signIn: "chatgpt",
  },
  {
    id: "gemini",
    name: "Gemini",
    fields: [
      { name: "gemini_oauth_token", label: "account.gemini.token" },
      { name: "gemini_project_id", label: "account.gemini.project" },
    ],
    signIn: "gemini",
  },
  { id: "grok", name: "Grok (xAI)", fields: [{ name: "xai_management_key", label: "account.grok.key" }, { name: "xai_team_id", label: "account.grok.team" }] },
  { id: "deepseek", name: "DeepSeek", fields: [{ name: "deepseek_api_key", label: "account.apiKey" }] },
  { id: "glm", name: "GLM (Z.ai)", fields: [{ name: "glm_api_key", label: "account.glm.key" }] },
];

const OTHER_ACCOUNTS: AccountSpec[] = [
  { id: "stripe", name: "Stripe", fields: [{ name: "stripe_api_key", label: "account.stripe.key", hint: "rk_live_…" }] },
  { id: "polar", name: "Polar", fields: [{ name: "polar_access_token", label: "account.polar.token" }] },
  { id: "dodo", name: "Dodo Payments", fields: [{ name: "dodo_api_key", label: "account.apiKey" }] },
  { id: "datafast", name: "DataFast", fields: [{ name: "datafast_api_key", label: "account.datafast.key", hint: "df_…" }] },
  { id: "gmail", name: "Gmail", fields: [{ name: "gmail_oauth_token", label: "account.gmail.oauth" }, { name: "gmail_app_password", label: "account.gmail.appPassword" }] },
  { id: "x", name: "X", fields: [{ name: "x_bearer_token", label: "account.x.token" }] },
  { id: "youtube", name: "YouTube", fields: [{ name: "youtube_api_key", label: "account.youtube.key" }] },
  { id: "instagram", name: "Instagram", fields: [{ name: "instagram_access_token", label: "account.instagram.token" }] },
  { id: "github", name: "GitHub", fields: [{ name: "github_token", label: "account.github.token" }] },
];

function SecretInput({ field, isSet, onSaved }: { field: SecretField; isSet: boolean; onSaved: (names: string[]) => void }) {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const save = async (v: string) => {
    setStatus("saving");
    try {
      onSaved(await ipc.setSecret(field.name, v));
      setValue("");
      setStatus("saved");
      window.setTimeout(() => setStatus("idle"), 1500);
    } catch (err) {
      setError(errorMessage(err));
      setStatus("error");
    }
  };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="w-[230px] shrink-0 truncate text-[12px] lb-muted" title={t(field.label)}>{t(field.label)}</span>
        <input
          type="password"
          value={value}
          placeholder={isSet ? t("settings.secret.stored") : field.hint ?? t("settings.secret.paste")}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && value && void save(value)}
          className="lb-focus min-w-0 flex-1 rounded-lg border-none px-2.5 py-1.5 text-[12px] outline-none"
          style={{ background: "var(--lb-track)" }}
        />
        <button
          className="lb-focus rounded-lg border-none px-2.5 py-1.5 text-[12px] font-semibold"
          style={{ background: "var(--lb-accent)", color: "#fff", opacity: value ? 1 : 0.5 }}
          disabled={!value || status === "saving"}
          onClick={() => void save(value)}
        >
          {status === "saved" ? <Check size={13} /> : t("common.save")}
        </button>
        {isSet && (
          <button className="lb-icon-btn h-7 w-7" title={t("common.remove")} onClick={() => void save("")}>
            <X size={13} />
          </button>
        )}
      </div>
      {status === "error" && <div className="text-[11px]" style={{ color: "var(--lb-red)" }}>{error}</div>}
    </div>
  );
}

function ProviderBadge({ id }: { id: ProviderId }) {
  const { t } = useI18n();
  const result = useHub((s) => s.providers[id]);
  const [busy, setBusy] = useState(false);
  const status = result?.status ?? "loading";
  const color = status === "ok" ? "var(--lb-green)" : status === "error" ? "var(--lb-amber)" : status === "simulated" ? "var(--lb-purple)" : "var(--lb-faint)";
  const label = status === "loading" ? "…" : t(`settings.status.${status}`);
  return (
    <div className="flex items-center gap-1.5">
      <span className="flex items-center gap-1 text-[11px]" style={{ color }} title={result?.error ?? undefined}>
        {status === "ok" ? <CheckCircle2 size={12} /> : status === "error" ? <AlertTriangle size={12} /> : null}
        {label}
      </span>
      <button
        className="lb-icon-btn h-6 w-6"
        title={t("settings.refreshNow")}
        onClick={() => {
          setBusy(true);
          void ipc.refreshProvider(id).finally(() => setBusy(false));
        }}
      >
        <RefreshCw size={11} className={busy ? "animate-spin" : ""} />
      </button>
    </div>
  );
}

const SIGN_IN_LABEL: Record<AccountStatus["provider"], TranslationKey> = {
  claude: "account.signIn.claude",
  chatgpt: "account.signIn.chatgpt",
  gemini: "account.signIn.gemini",
};

/** « Se connecter avec … »: opens the official CLI sign-in, then shows « Connecté » once the
 *  credentials it writes are picked up (`account:connected`). */
function SignIn({ provider, names }: { provider: AccountStatus["provider"]; names: string[] }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settings = useSettings();
  const useCli = settings?.providers.useLocalCliCredentials;
  const providerStatus = useHub((s) => s.providers[provider]?.status);

  useEffect(() => {
    let alive = true;
    void ipc.accountStatus(provider).then((st) => alive && setStatus(st)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [provider, names, useCli, providerStatus]);

  useEffect(
    () =>
      subscribe("account:connected", (st) => {
        if (st.provider !== provider) return;
        setStatus(st);
        setWaiting(false);
      }),
    [provider],
  );

  const signIn = () => {
    setError(null);
    setWaiting(true);
    ipc.accountLogin(provider).catch((e) => {
      setWaiting(false);
      setError(errorMessage(e));
    });
  };

  const connected = !!status?.connected;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <button
          data-testid={`sign-in-${provider}`}
          className="lb-focus flex items-center gap-1.5 rounded-lg border-none px-3 py-1.5 text-[12px] font-semibold"
          style={connected ? { background: "var(--lb-track)", color: "var(--lb-text)" } : { background: "var(--lb-accent)", color: "#fff" }}
          disabled={waiting}
          onClick={signIn}
        >
          {waiting ? <RefreshCw size={13} className="animate-spin" /> : <LogIn size={13} />}
          {t(SIGN_IN_LABEL[provider])}
        </button>
        {connected && (
          <span data-testid={`connected-${provider}`} className="flex min-w-0 items-center gap-1 text-[12px] font-semibold" style={{ color: "var(--lb-green)" }}>
            <CheckCircle2 size={13} className="shrink-0" />
            <span className="truncate">
              {t("account.connected")}
              <span className="font-normal lb-faint">
                {" · "}
                {status?.detail ? `${status.detail} · ` : ""}
                {status?.source === "manual" ? t("account.viaManual") : t("account.viaCli")}
              </span>
            </span>
          </span>
        )}
      </div>
      <div className="text-[11px] lb-faint">
        {waiting ? t("account.waiting") : t("account.signInHint")}
        {status && !status.cliInstalled && !connected ? ` ${t("account.viaNpx")}` : ""}
      </div>
      {error && <div className="text-[11px]" style={{ color: "var(--lb-red)" }}>{error}</div>}
      <div className="mt-1 text-[11px] lb-muted">{t("account.manualFields")}</div>
    </div>
  );
}

function AccountCard({ spec, names, setNames }: { spec: AccountSpec; names: string[]; setNames: (n: string[]) => void }) {
  const { t } = useI18n();
  const error = useHub((s) => s.providers[spec.id]?.error);
  const status = useHub((s) => s.providers[spec.id]?.status);
  return (
    <div className="flex flex-col gap-2 rounded-lg p-3" style={{ background: "var(--lb-card)" }}>
      <div className="flex items-center gap-2">
        <BrandGlyph id={spec.id} size={22} />
        <span className="flex-1 font-semibold">{spec.name}</span>
        <ProviderBadge id={spec.id} />
      </div>
      {spec.signIn && <SignIn provider={spec.signIn} names={names} />}
      {spec.fields.map((f) => (
        <SecretInput key={f.name} field={f} isSet={names.includes(f.name)} onSaved={setNames} />
      ))}
      {status === "error" && error && <div className="text-[11px]" style={{ color: "var(--lb-amber)" }}>{error}</div>}
      {spec.note && <div className="text-[11px] lb-faint">{t(spec.note)}</div>}
    </div>
  );
}

function AccountsTab({ s }: { s: Settings }) {
  const { t } = useI18n();
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => void ipc.getSecretNames().then(setNames), []);
  return (
    <Bento>
      <div className="flex items-center gap-2 rounded-[14px] px-3 py-2 text-[12px]" style={{ background: "rgba(48,209,88,0.12)", gridColumn: "1 / -1" }}>
        <Lock size={14} className="shrink-0" style={{ color: "var(--lb-green)" }} />
        {t("settings.keysNotice")}
      </div>
      <Section title={t("settings.aiLimits")}>
        <Row label={t("settings.localCli")} hint={t("settings.localCliHint")}>
          <Toggle checked={s.providers.useLocalCliCredentials} onChange={(v) => update((x) => ({ ...x, providers: { ...x.providers, useLocalCliCredentials: v } }))} />
        </Row>
        {AI_ACCOUNTS.map((a) => (
          <AccountCard key={a.id} spec={a} names={names} setNames={setNames} />
        ))}
      </Section>
      <Section title={t("settings.otherAccounts")}>
        {OTHER_ACCOUNTS.map((a) => (
          <AccountCard key={a.id} spec={a} names={names} setNames={setNames} />
        ))}
      </Section>
    </Bento>
  );
}

function CalendarTab() {
  const { t } = useI18n();
  const [names, setNames] = useState<string[]>([]);
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const result = useHub((s) => s.providers.calendar);
  useEffect(() => void ipc.getSecretNames().then(setNames), []);
  const configured = names.includes("ics_urls");
  const save = async (v: string) => {
    setError(null);
    try {
      setNames(await ipc.setSecret("ics_urls", v));
      setValue("");
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const count = (result?.data as { events?: unknown[] } | null)?.events?.length ?? 0;
  return (
    <Bento>
    <Section
      title={t("settings.ics")}
      description={t("settings.icsDesc")}
    >
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={configured ? t("settings.icsStored") : "https://calendar.google.com/calendar/ical/…/basic.ics"}
        className="lb-focus lb-thin-scroll h-28 w-full resize-none rounded-lg border-none p-3 text-[12px] outline-none"
        style={{ background: "var(--lb-card)" }}
      />
      <div className="flex items-center gap-2">
        <button className="lb-focus rounded-lg border-none px-3 py-1.5 text-[12px] font-semibold" style={{ background: "var(--lb-accent)", color: "#fff" }} disabled={!value.trim()} onClick={() => void save(value)}>
          {saved ? t("common.saved") : t("settings.saveFeeds")}
        </button>
        {configured && (
          <button className="lb-focus rounded-lg border-none px-3 py-1.5 text-[12px]" style={{ background: "var(--lb-card)" }} onClick={() => void save("")}>
            {t("settings.removeFeeds")}
          </button>
        )}
        <span className="ml-auto text-[12px] lb-muted">
          {result?.status === "ok" && t("settings.upcomingEvents", { count })}
          {result?.status === "simulated" && t("settings.simulationMode")}
          {result?.status === "error" && <span style={{ color: "var(--lb-amber)" }}>{result.error}</span>}
        </span>
        <ProviderBadge id="calendar" />
      </div>
      {error && <div className="text-[11px]" style={{ color: "var(--lb-red)" }}>{error}</div>}
    </Section>
    </Bento>
  );
}

function IntegrationsTab({ s }: { s: Settings }) {
  const { t } = useI18n();
  const p = s.providers;
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => void ipc.getSecretNames().then(setNames), []);
  const setP = (patch: Partial<Settings["providers"]>) => update((x) => ({ ...x, providers: { ...x.providers, ...patch } }));
  const num = (v: string, fallback: number) => (Number.isFinite(Number(v)) && v.trim() !== "" ? Number(v) : fallback);
  return (
    <Bento>
      <Section title={t("settings.handles")}>
        <Row label={t("settings.leetcodeUser")}><CommitInput value={p.leetcodeUsername} onCommit={(v) => setP({ leetcodeUsername: v.trim() })} /></Row>
        <Row label={t("settings.githubUser")} hint={t("settings.githubUserHint")}><CommitInput value={p.githubUsername} onCommit={(v) => setP({ githubUsername: v.trim() })} /></Row>
        <Row label={t("settings.xHandle")}><CommitInput value={p.xUsername} placeholder="@handle" onCommit={(v) => setP({ xUsername: v.trim() })} /></Row>
        <Row label={t("settings.youtubeChannel")} hint={t("settings.youtubeChannelHint")}><CommitInput value={p.youtubeChannelId} onCommit={(v) => setP({ youtubeChannelId: v.trim() })} /></Row>
        <Row label={t("settings.instagramId")} hint={t("settings.instagramIdHint")}><CommitInput value={p.instagramUserId} onCommit={(v) => setP({ instagramUserId: v.trim() })} /></Row>
        <Row label={t("settings.tiktokHandle")} hint={t("settings.tiktokHandleHint")}><CommitInput value={p.tiktokUsername ?? ""} placeholder="@handle" onCommit={(v) => setP({ tiktokUsername: v.trim() })} /></Row>
        <Row label={t("settings.gmailAddress")} hint={t("settings.gmailAddressHint")}><CommitInput value={p.gmailAddress} onCommit={(v) => setP({ gmailAddress: v.trim() })} /></Row>
      </Section>
      <Section title={t("settings.apiCounter")} description={t("settings.apiCounterDesc")}>
        <Row label={t("settings.endpointUrl")}><CommitInput width={280} value={p.apiCounterUrl} placeholder="https://api.example.com/stats" onCommit={(v) => setP({ apiCounterUrl: v.trim() })} /></Row>
        <Row label={t("settings.jsonPath")}><CommitInput value={p.apiCounterJsonPath} placeholder="data.count" onCommit={(v) => setP({ apiCounterJsonPath: v.trim() })} /></Row>
        <Row label={t("settings.label")}><CommitInput value={p.apiCounterLabel} onCommit={(v) => setP({ apiCounterLabel: v })} /></Row>
        <div className="rounded-lg p-3" style={{ background: "var(--lb-card)" }}>
          <SecretInput field={{ name: "api_counter_token", label: "settings.bearerToken" }} isSet={names.includes("api_counter_token")} onSaved={setNames} />
        </div>
      </Section>
      <Section title={t("settings.goals")}>
        <Row label={t("settings.revenueGoal")} hint={t("settings.revenueGoalHint")}><CommitInput type="number" width={110} value={p.revenueGoal} onCommit={(v) => setP({ revenueGoal: num(v, p.revenueGoal) })} /></Row>
        <Row label={t("settings.deepseekBudget")} hint={t("settings.deepseekBudgetHint")}><CommitInput type="number" width={110} value={p.deepseekBudget} onCommit={(v) => setP({ deepseekBudget: num(v, p.deepseekBudget) })} /></Row>
        <Row label={t("settings.grokBudget")}><CommitInput type="number" width={110} value={p.grokBudget} onCommit={(v) => setP({ grokBudget: num(v, p.grokBudget) })} /></Row>
      </Section>
    </Bento>
  );
}

function TestButton({ rule }: { rule: keyof AutomationSettings }) {
  const { t } = useI18n();
  const [result, setResult] = useState<string | null>(null);
  useEffect(
    () =>
      subscribe("automation:test-result", (r) => {
        if (r.rule === rule) {
          setResult(r.message);
          window.setTimeout(() => setResult(null), 3000);
        }
      }),
    [rule],
  );
  return (
    <div className="flex items-center gap-2">
      {result && <span className="text-[11px] lb-muted">{result}</span>}
      <button className="lb-focus rounded-lg border-none px-2.5 py-1 text-[12px]" style={{ background: "var(--lb-track)" }} onClick={() => void broadcast("automation:test", { rule })}>
        {t("common.test")}
      </button>
    </div>
  );
}

function AutomationsTab({ s }: { s: Settings }) {
  const { t } = useI18n();
  const a = s.automations;
  const setA = (patch: Partial<AutomationSettings>) => update((x) => ({ ...x, automations: { ...x.automations, ...patch } }));
  return (
    <Bento>
      <Section title={t("settings.rule1")} description={t("settings.rule1Desc")}>
        <Row label={t("common.enabled")}>
          <TestButton rule="preMeetingPause" />
          <Toggle checked={a.preMeetingPause.enabled} onChange={(v) => setA({ preMeetingPause: { ...a.preMeetingPause, enabled: v } })} />
        </Row>
        <Row label={t("settings.minutesBefore")}>
          <CommitInput type="number" width={70} value={a.preMeetingPause.minutes} onCommit={(v) => setA({ preMeetingPause: { ...a.preMeetingPause, minutes: Math.max(1, Math.min(60, Math.round(Number(v) || 2))) } })} />
        </Row>
      </Section>
      <Section title={t("settings.rule2")} description={t("settings.rule2Desc")}>
        <Row label={t("common.enabled")}>
          <TestButton rule="aiLimitWarning" />
          <Toggle checked={a.aiLimitWarning.enabled} onChange={(v) => setA({ aiLimitWarning: { ...a.aiLimitWarning, enabled: v } })} />
        </Row>
        <Row label={t("settings.threshold")} hint={formatPercent(a.aiLimitWarning.thresholdPercent)}>
          <input
            type="range"
            min={50}
            max={99}
            value={a.aiLimitWarning.thresholdPercent}
            onChange={(e) => setA({ aiLimitWarning: { ...a.aiLimitWarning, thresholdPercent: Number(e.target.value) } })}
            style={{ accentColor: "var(--lb-accent)" }}
          />
        </Row>
        <Row label={t("settings.critical")} hint={formatPercent(a.aiLimitWarning.criticalPercent ?? 95)}>
          <input
            type="range"
            min={60}
            max={100}
            value={a.aiLimitWarning.criticalPercent ?? 95}
            onChange={(e) => setA({ aiLimitWarning: { ...a.aiLimitWarning, criticalPercent: Math.max(Number(e.target.value), a.aiLimitWarning.thresholdPercent + 1) } })}
            style={{ accentColor: "var(--lb-red)" }}
          />
        </Row>
        <Row label={t("settings.horizon")}>
          <CommitInput type="number" width={70} value={a.aiLimitWarning.horizonHours} onCommit={(v) => setA({ aiLimitWarning: { ...a.aiLimitWarning, horizonHours: Math.max(1, Number(v) || 24) } })} />
        </Row>
      </Section>
      <Section title={t("settings.rule3")} description={t("settings.rule3Desc")}>
        <Row label={t("common.enabled")}>
          <TestButton rule="revenueMilestone" />
          <Toggle checked={a.revenueMilestone.enabled} onChange={(v) => setA({ revenueMilestone: { ...a.revenueMilestone, enabled: v } })} />
        </Row>
        <Row label={t("settings.milestones")} hint={t("settings.milestonesHint")}>
          <CommitInput
            width={240}
            value={a.revenueMilestone.milestones.join(", ")}
            onCommit={(v) =>
              setA({
                revenueMilestone: {
                  ...a.revenueMilestone,
                  milestones: v
                    .split(",")
                    .map((x) => Number(x.replace(/[^0-9.]/g, "")))
                    .filter((n) => Number.isFinite(n) && n > 0)
                    .sort((x, y) => x - y),
                },
              })
            }
          />
        </Row>
      </Section>
      <Section title={t("settings.rule4")} description={t("settings.rule4Desc")}>
        <Row label={t("common.enabled")}>
          <TestButton rule="renewalReminder" />
          <Toggle checked={a.renewalReminder.enabled} onChange={(v) => setA({ renewalReminder: { ...a.renewalReminder, enabled: v } })} />
        </Row>
        <Row label={t("settings.lookAhead")}>
          <CommitInput type="number" width={70} value={a.renewalReminder.hours} onCommit={(v) => setA({ renewalReminder: { ...a.renewalReminder, hours: Math.max(1, Number(v) || 24) } })} />
        </Row>
        <Row label={t("settings.keywords")}>
          <CommitInput
            width={240}
            value={a.renewalReminder.keywords.join(", ")}
            onCommit={(v) => setA({ renewalReminder: { ...a.renewalReminder, keywords: v.split(",").map((k) => k.trim()).filter(Boolean) } })}
          />
        </Row>
      </Section>
      <Section title={t("settings.resetHistory")}>
      <Row label={t("settings.resetHistory")} hint={t("settings.resetHistoryHint")}>
        <button className="lb-focus rounded-lg border-none px-2.5 py-1 text-[12px]" style={{ background: "var(--lb-track)" }} onClick={() => void broadcast("automation:reset", null)}>
          {t("common.reset")}
        </button>
      </Row>
      </Section>
    </Bento>
  );
}

function AdvancedTab({ s }: { s: Settings }) {
  const { t } = useI18n();
  const [glass, setGlass] = useState("");
  useEffect(() => {
    const load = () => void ipc.getGlassStatus().then(setGlass);
    load();
    const t = window.setInterval(load, 2000);
    return () => window.clearInterval(t);
  }, []);
  return (
    <Bento>
      <Section title={t("settings.testing")}>
        <Row label={t("settings.simulation")} hint={t("settings.simulationHint")}>
          <Toggle checked={s.simulation} onChange={(v) => update((x) => ({ ...x, simulation: v }))} />
        </Row>
        <Row label={t("settings.dnd")} hint={t("settings.dndHint")}>
          <Toggle checked={s.doNotDisturb} onChange={(v) => update((x) => ({ ...x, doNotDisturb: v }))} />
        </Row>
      </Section>
      <Section title={t("settings.data")}>
        <Row label={t("settings.pollMinutes")}>
          <CommitInput type="number" width={70} value={s.providers.pollMinutes} onCommit={(v) => update((x) => ({ ...x, providers: { ...x.providers, pollMinutes: Math.max(1, Math.min(120, Math.round(Number(v) || 5))) } }))} />
        </Row>
        <Row label={t("settings.storage")} hint={t("settings.storageHint")}>
          <span className="text-[11.5px] lb-muted">%APPDATA%\winglass\winglass.db</span>
        </Row>
        <Row label={t("settings.glassCapture")} hint={t("settings.glassCaptureHint")}>
          <span className="max-w-[260px] truncate text-[11.5px] lb-muted" title={glass}>{glass || "—"}</span>
        </Row>
      </Section>
      <Section title={t("settings.safety")}>
        <Row label={t("settings.restoreNow")} hint={t("settings.restoreNowHint")}>
          <button className="lb-focus flex items-center gap-1 rounded-lg border-none px-2.5 py-1 text-[12px]" style={{ background: "var(--lb-track)" }} onClick={() => void ipc.setTaskbarMode("native")}>
            <Monitor size={12} /> {t("common.restore")}
          </button>
        </Row>
        <Row label={t("settings.restoreQuit")}>
          <button className="lb-focus flex items-center gap-1 rounded-lg border-none px-2.5 py-1 text-[12px] font-semibold" style={{ background: "var(--lb-red)", color: "#fff" }} onClick={() => void ipc.restoreTaskbarAndQuit()}>
            <Power size={12} /> {t("common.quit")}
          </button>
        </Row>
      </Section>
    </Bento>
  );
}

/** Case- and accent-insensitive ("apparence" finds "Apparence", "meteo" finds "Météo"). */
function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

const APPEARANCE_DEFAULTS: Partial<Settings> = {
  theme: "liquid-glass",
  size: "medium",
  accent: "#0A84FF",
  glassFrostLevel: DEFAULT_FROST_LEVEL,
  clearMode: false,
  musicAmbiance: false,
  dockRadius: 22,
  glassRefraction: 1,
};

/** Small counters on nav items: connected accounts, upcoming events, active automations. */
function useNavBadges(s: Settings | null): Partial<Record<Tab, string>> {
  const providers = useHub((h) => h.providers);
  if (!s) return {};
  const live = (id: ProviderId) => ["ok", "simulated"].includes(providers[id]?.status ?? "");
  const accounts = AI_PROVIDERS.filter(live).length;
  const events = (providers.calendar?.data as { events?: unknown[] } | null | undefined)?.events?.length ?? 0;
  const rules = Object.values(s.automations).filter((r) => (r as { enabled?: boolean }).enabled).length;
  return {
    accounts: accounts ? String(accounts) : undefined,
    calendar: events ? String(events) : undefined,
    automations: `${rules}/${Object.keys(s.automations).length}`,
  };
}

export function SettingsModal() {
  const settings = useSettings();
  const { t } = useI18n();
  // The window is created on demand; the tab to open arrives in its URL.
  const [tab, setTab] = useState<Tab>(() => {
    const requested = new URLSearchParams(window.location.search).get("tab");
    return TABS.some((x) => x.id === requested) ? (requested as Tab) : "general";
  });
  const [query, setQuery] = useState("");
  const [version, setVersion] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const ambient = useAmbientColors(settings?.musicAmbiance ?? false);
  const badges = useNavBadges(settings);

  useEffect(() => {
    void getVersion().then(setVersion).catch(() => undefined);
    const off = subscribe("settings:navigate", (t) => {
      if (TABS.some((x) => x.id === t)) setTab(t as Tab);
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void ipc.closeWindow("settings");
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      off();
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // Every change is written by the backend before it echoes the new document back.
  useEffect(() => {
    if (!settings) return;
    setSaving(true);
    const timer = window.setTimeout(() => setSaving(false), 500);
    return () => window.clearTimeout(timer);
  }, [settings]);

  useEffect(() => {
    if (!confirmReset) return;
    const timer = window.setTimeout(() => setConfirmReset(false), 3500);
    return () => window.clearTimeout(timer);
  }, [confirmReset]);

  const q = fold(query.trim());
  const nav = NAV.map((g) => ({ ...g, items: g.items.filter((i) => !q || fold(t(i.label)).includes(q) || fold(t(g.group)).includes(q)) })).filter((g) => g.items.length > 0);
  const current = TABS.find((x) => x.id === tab);

  const rootStyle = {
    ...CANVAS_TOKENS,
    "--lb-amb-1": ambient[0] ?? "transparent",
    "--lb-amb-2": ambient[1] ?? ambient[0] ?? "transparent",
    "--lb-amb-3": ambient[2] ?? ambient[0] ?? "transparent",
    "--set-accent": ambient[0] ?? "#2563EB",
    color: "var(--lb-text)",
    // Obsidian canvas; the music colours wash in from the top edge only (no floating blobs).
    background:
      "linear-gradient(180deg in oklch, color-mix(in oklch, var(--lb-amb-1) 26%, transparent) 0%, color-mix(in oklch, var(--lb-amb-2) 10%, transparent) 38%, transparent 62%), #0E1015",
    border: "1px solid rgb(255 255 255 / 0.08)",
    transition: "--lb-amb-1 900ms ease, --lb-amb-2 900ms ease, --lb-amb-3 900ms ease",
  } as CSSProperties;

  return (
    <div className="flex h-full w-full p-3">
      <div className="relative flex h-full w-full overflow-hidden rounded-[32px]" style={rootStyle} data-ambient={ambient.length > 0 ? "on" : "off"}>
        {/* ------------------------------------------------ floating glass sidebar */}
        <nav
          data-tauri-drag-region
          aria-label={t("settings.title")}
          className="relative m-3 flex w-[228px] shrink-0 flex-col gap-3 rounded-[20px] p-3"
          style={{
            background:
              "linear-gradient(160deg in oklch, color-mix(in oklch, var(--lb-amb-1) 20%, rgb(255 255 255 / 0.07)), color-mix(in oklch, var(--lb-amb-3) 12%, rgb(255 255 255 / 0.03)))",
            border: "1px solid rgb(255 255 255 / 0.12)",
            boxShadow: "inset 0 1px 0 rgb(255 255 255 / 0.10), 0 12px 32px rgb(0 0 0 / 0.35)",
            backdropFilter: "blur(28px) saturate(160%)",
            WebkitBackdropFilter: "blur(28px) saturate(160%)",
          }}
        >
          <div data-tauri-drag-region className="flex items-center gap-2 px-1 pt-0.5">
            <img src="/favicon.svg" alt="" width={26} height={26} className="rounded-[7px]" draggable={false} />
            <span data-tauri-drag-region className="text-[15px] font-bold tracking-tight">WinGlass</span>
            {version && (
              <span className="rounded-full px-1.5 py-[1px] text-[10px] font-semibold tabular-nums lb-muted" style={{ background: "rgb(255 255 255 / 0.08)" }}>
                v{version}
              </span>
            )}
          </div>

          <label className="flex items-center gap-2 rounded-[10px] px-2.5 py-1.5" style={{ background: "rgb(0 0 0 / 0.22)", border: "1px solid rgb(255 255 255 / 0.06)" }}>
            <Search size={13} strokeWidth={2.4} className="shrink-0 lb-muted" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && nav[0]?.items[0]) setTab(nav[0].items[0].id);
              }}
              placeholder={t("settings.search")}
              aria-label={t("settings.search")}
              className="min-w-0 flex-1 border-none bg-transparent text-[12px] outline-none"
              style={{ color: "var(--lb-text)" }}
            />
            <kbd className="shrink-0 rounded-md px-1.5 text-[10px] font-semibold lb-muted" style={{ background: "rgb(255 255 255 / 0.08)", fontFamily: "inherit" }}>
              Ctrl K
            </kbd>
          </label>

          <div className="lb-thin-scroll -mx-1 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-1">
            {nav.map((g) => (
              <div key={g.group} className="flex flex-col gap-0.5">
                <div className="px-2 pb-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] lb-faint">{t(g.group)}</div>
                {g.items.map(({ id, label, icon: Icon }) => {
                  const active = tab === id;
                  return (
                    <button
                      key={id}
                      aria-current={active ? "page" : undefined}
                      className="lb-focus flex items-center gap-2.5 rounded-[10px] border-none px-2.5 py-[7px] text-left text-[12.5px]"
                      style={
                        active
                          ? { background: "#FFFFFF", color: "#111827", fontWeight: 650, boxShadow: "0 4px 16px rgb(0 0 0 / 0.25)" }
                          : { background: "transparent", color: "var(--lb-text)", fontWeight: 450 }
                      }
                      onClick={() => setTab(id)}
                    >
                      <Icon size={15} strokeWidth={active ? 2.5 : 2.1} style={{ color: active ? "#111827" : "var(--lb-muted)" }} />
                      <span className="min-w-0 flex-1 truncate">{t(label)}</span>
                      {badges[id] && (
                        <span
                          className="shrink-0 rounded-full px-1.5 text-[10px] font-semibold tabular-nums"
                          style={{ background: active ? "rgb(17 24 39 / 0.08)" : "rgb(255 255 255 / 0.08)", color: active ? "#374151" : "var(--lb-muted)" }}
                        >
                          {badges[id]}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
            {nav.length === 0 && <div className="px-2 text-[12px] lb-muted">{t("settings.noMatch")}</div>}
          </div>
        </nav>

        {/* ------------------------------------------------ bento canvas */}
        <div className="relative flex min-w-0 flex-1 flex-col">
          <div data-tauri-drag-region className="flex items-center gap-3 pb-3 pl-2 pr-4 pt-5">
            <h2 data-tauri-drag-region className="m-0 min-w-0 flex-1 truncate text-[20px] font-bold tracking-tight">
              {t(current?.label ?? "settings.title")}
            </h2>
            <button className="lb-icon-btn h-8 w-8" onClick={() => void ipc.closeWindow("settings")} aria-label={t("common.close")}>
              <X size={16} />
            </button>
          </div>
          <div className="lb-thin-scroll flex-1 overflow-y-auto pb-20 pl-2 pr-4">
            {!settings ? (
              <div className="py-10 text-center lb-muted">{t("common.loading")}</div>
            ) : tab === "general" ? (
              <GeneralTab s={settings} />
            ) : tab === "appearance" ? (
              <AppearanceTab s={settings} />
            ) : tab === "widgets" ? (
              <WidgetsTab s={settings} />
            ) : tab === "accounts" ? (
              <AccountsTab s={settings} />
            ) : tab === "calendar" ? (
              <CalendarTab />
            ) : tab === "integrations" ? (
              <IntegrationsTab s={settings} />
            ) : tab === "automations" ? (
              <AutomationsTab s={settings} />
            ) : (
              <AdvancedTab s={settings} />
            )}
          </div>

          {/* floating action / status bar */}
          <div
            className="absolute bottom-3 left-2 right-4 flex items-center gap-3 rounded-full py-1.5 pl-1.5 pr-4"
            style={{ background: "rgb(22 24 30 / 0.86)", border: "1px solid rgb(255 255 255 / 0.08)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", boxShadow: "0 10px 30px rgb(0 0 0 / 0.35)" }}
          >
            <button
              className="lb-focus rounded-full border-none px-3 py-1.5 text-[12px] font-semibold"
              style={{ background: confirmReset ? "var(--lb-red)" : "rgb(255 255 255 / 0.08)", color: confirmReset ? "#fff" : "var(--lb-text)" }}
              disabled={!settings}
              onClick={() => {
                if (!confirmReset) return setConfirmReset(true);
                setConfirmReset(false);
                update((x) => ({ ...x, ...APPEARANCE_DEFAULTS }));
              }}
            >
              {confirmReset ? t("settings.resetConfirm") : t("settings.resetDefaults")}
            </button>
            <span className="min-w-0 flex-1 truncate text-[11.5px] lb-faint">{confirmReset ? t("settings.resetScope") : ""}</span>
            <span className="flex shrink-0 items-center gap-1.5 text-[11.5px]" role="status" style={{ color: saving ? "var(--lb-muted)" : TOGGLE_ON }}>
              {saving ? <RefreshCw size={12} className="animate-spin" /> : <Check size={12} strokeWidth={2.8} />}
              {saving ? t("common.saving") : t("settings.allSaved")}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
