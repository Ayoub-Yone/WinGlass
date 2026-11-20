// Weather (Open-Meteo, no key): sky-gradient tile with condition, city and temperature; the flyout
// has the hourly strip, the 7-day forecast and an inline city search (Open-Meteo geocoding).

import {
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudLightning,
  CloudRain,
  CloudSnow,
  CloudSun,
  MapPin,
  Moon,
  Search,
  Sun,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Popover, ProviderState, WidgetCard } from "../components/ui";
import { useI18n, type TranslationKey } from "../i18n";
import { formatHour, formatWeekdayShort } from "../lib/format";
import { errorMessage, ipc } from "../lib/ipc";
import { patchSettings, usePreview, useProvider } from "../lib/hooks";
import type { GeoPlace, WeatherData, WidgetProps } from "../types/winglass";

export function weatherIcon(code: number | null, isDay = true): LucideIcon {
  if (code === null) return Cloud;
  if (code === 0) return isDay ? Sun : Moon;
  if (code <= 2) return CloudSun;
  if (code === 3) return Cloud;
  if (code === 45 || code === 48) return CloudFog;
  if (code >= 51 && code <= 57) return CloudDrizzle;
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return CloudRain;
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return CloudSnow;
  if (code >= 95) return CloudLightning;
  return Cloud;
}

/** WMO weather code -> short condition label. */
function conditionKey(code: number | null): TranslationKey {
  if (code === null) return "weather.cond.unknown";
  if (code === 0) return "weather.cond.clear";
  if (code === 1) return "weather.cond.mainlyClear";
  if (code === 2) return "weather.cond.partlyCloudy";
  if (code === 3) return "weather.cond.overcast";
  if (code === 45 || code === 48) return "weather.cond.fog";
  if (code >= 51 && code <= 57) return "weather.cond.drizzle";
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return "weather.cond.rain";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "weather.cond.snow";
  if (code >= 95) return "weather.cond.thunder";
  return "weather.cond.unknown";
}

/** Sun-tinted when the sky is clear-ish by day, soft white otherwise. */
function WeatherGlyph({ code, isDay = true, size }: { code: number | null; isDay?: boolean; size: number }) {
  const Icon = weatherIcon(code, isDay);
  const sunny = isDay && code !== null && code <= 2;
  return <Icon size={size} strokeWidth={2.2} className="shrink-0" style={{ color: sunny ? "oklch(86% 0.15 85)" : "rgb(255 255 255 / 0.92)", filter: "drop-shadow(0 1px 2px rgb(0 0 0 / 0.25))" }} />;
}

const deg = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${Math.round(v)}°`);

export function CitySearch({ onDone }: { onDone: () => void }) {
  const { t, lang } = useI18n();
  const [query, setQuery] = useState("");
  const [places, setPlaces] = useState<GeoPlace[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const q = query.trim();
    setError(null);
    if (q.length < 2) return setPlaces([]);
    let alive = true;
    const timer = window.setTimeout(() => {
      ipc
        .geocodeCity(q, lang)
        .then((p) => alive && setPlaces(p))
        .catch((err) => alive && setError(errorMessage(err)));
    }, 300);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [query, lang]);

  const pick = (p: GeoPlace) => {
    void patchSettings((s) => ({ ...s, providers: { ...s.providers, weatherCity: p.name, weatherLatitude: p.latitude, weatherLongitude: p.longitude } }));
    onDone();
  };

  return (
    <div className="flex flex-col gap-1.5">
      <label className="flex items-center gap-2 rounded-full px-3 py-1.5" style={{ background: "var(--lb-card)" }}>
        <Search size={13} strokeWidth={2.4} className="shrink-0 lb-muted" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("weather.searchCity")}
          aria-label={t("weather.searchCity")}
          className="min-w-0 flex-1 border-none bg-transparent text-[12.5px] outline-none"
          style={{ color: "var(--lb-text)" }}
        />
      </label>
      {error && <div className="px-1 text-[11.5px]" style={{ color: "var(--lb-amber)" }}>{error}</div>}
      {places.map((p) => (
        <button key={`${p.latitude},${p.longitude}`} className="lb-row lb-focus flex items-center gap-2 rounded-lg border-none bg-transparent px-2 py-1.5 text-left" onClick={() => pick(p)}>
          <MapPin size={13} strokeWidth={2.4} className="shrink-0 lb-muted" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12.5px] font-semibold">{p.name}</span>
            <span className="block truncate text-[11px] lb-muted">{[p.admin, p.country].filter(Boolean).join(", ")}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

function Forecast({ d }: { d: WeatherData }) {
  const { t } = useI18n();
  const hours = d.hourly.slice(0, 7);
  const days = d.daily ?? [];
  return (
    <>
      <div className="flex items-center gap-3 px-1">
        <WeatherGlyph code={d.code} isDay={d.isDay} size={40} />
        <div className="text-[34px] font-light leading-none tabular-nums">{deg(d.current)}</div>
        <div className="min-w-0 flex-1 truncate text-[12.5px] lb-muted">
          {t(conditionKey(d.code))} · {t("weather.highLow", { high: deg(d.high), low: deg(d.low) })}
        </div>
      </div>
      <div className="grid grid-cols-7 gap-0.5 rounded-lg px-1 py-2" style={{ background: "var(--lb-card)" }}>
        {hours.map((h, i) => (
          <div key={h.time} className="flex flex-col items-center gap-1 text-[11px]">
            <span className="whitespace-nowrap lb-muted" style={{ fontWeight: i === 0 ? 650 : 450 }}>{i === 0 ? t("weather.now") : formatHour(new Date(h.time))}</span>
            <WeatherGlyph code={h.code} size={16} />
            <span className="font-semibold tabular-nums">{deg(h.temp)}</span>
          </div>
        ))}
      </div>
      {days.length > 0 && (
        <div className="flex flex-col">
          {days.map((day, i) => (
            <div key={day.date} className="flex items-center gap-3 px-2 py-[5px] text-[12.5px]">
              <span className="w-[72px] shrink-0 truncate font-medium capitalize">{i === 0 ? t("common.today") : formatWeekdayShort(new Date(`${day.date}T12:00`))}</span>
              <WeatherGlyph code={day.code} size={16} />
              <span className="flex-1" />
              <span className="w-[34px] text-right tabular-nums lb-muted">{deg(day.low)}</span>
              <span className="w-[34px] text-right font-semibold tabular-nums">{deg(day.high)}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export function WeatherWidget({ span }: WidgetProps) {
  const { t } = useI18n();
  const view = useProvider<WeatherData>("weather");
  const preview = usePreview();
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  if (!view.data) {
    return <ProviderState span={span} providerId="weather" glyph={<CloudSun size={20} />} name={t("weather.name")} status={view.status} error={view.error} tab="widgets" />;
  }
  const d = view.data;
  // Azure by day, deep indigo at night; interpolated in OKLCH so the middle never greys out.
  const sky = d.isDay ? "linear-gradient(135deg in oklch, #2575D6 0%, #4EA4F5 100%)" : "linear-gradient(135deg in oklch, #1B2450 0%, #3A3F86 100%)";

  return (
    <>
      <WidgetCard
        span={span}
        cardRef={ref}
        className="gap-2 text-white"
        title={view.error ?? t("weather.title", { city: d.city, high: d.high ?? "—", low: d.low ?? "—" })}
        onClick={() => !preview && setOpen((o) => !o)}
      >
        <div aria-hidden className="pointer-events-none absolute inset-0" style={{ background: sky, boxShadow: "inset 0 1px 0 rgb(255 255 255 / 0.35), inset 0 0 0 1px rgb(255 255 255 / 0.12)", borderRadius: "inherit" }} />
        {span === "1x1" ? (
          <div className="relative flex w-full items-center justify-center gap-1.5">
            <WeatherGlyph code={d.code} isDay={d.isDay} size={20} />
            <span className="font-light tabular-nums" style={{ fontSize: "var(--lb-large)" }}>{deg(d.current)}</span>
          </div>
        ) : (
          <>
            <div className="relative min-w-0 flex-1 leading-tight">
              <div className="truncate font-semibold">{t(conditionKey(d.code))}</div>
              <div className="truncate" style={{ fontSize: "var(--lb-small)", color: "rgb(255 255 255 / 0.78)" }}>{d.city}</div>
            </div>
            <span className="relative font-light tabular-nums" style={{ fontSize: "calc(var(--lb-large) + 4px)" }}>{deg(d.current)}</span>
            <span className="relative">
              <WeatherGlyph code={d.code} isDay={d.isDay} size={span === "3x1" ? 26 : 22} />
            </span>
          </>
        )}
      </WidgetCard>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} width={340} testId="weather-popover">
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1 truncate text-[14px] font-bold">{d.city}</div>
            <button className="lb-focus shrink-0 rounded-full border-none px-2.5 py-1 text-[11.5px] font-semibold" style={{ background: "var(--lb-card)", color: "var(--lb-accent)" }} onClick={() => setSearching((s) => !s)}>
              {searching ? t("common.done") : t("weather.change")}
            </button>
            <button className="lb-icon-btn h-7 w-7 shrink-0" aria-label={t("common.close")} onClick={() => setOpen(false)}>
              <X size={15} strokeWidth={2.4} />
            </button>
          </div>
          {searching ? <CitySearch onDone={() => setSearching(false)} /> : <Forecast d={d} />}
        </div>
      </Popover>
    </>
  );
}
