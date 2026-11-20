// « Heures de prière »: next prayer + live countdown on the tile; the flyout lists the day's six
// times (adhan, Mawaqit iqama), a bell per prayer, the reminder lead time, and the mosque / city
// picker (Mawaqit timetable or Aladhan calculation by city). Alerts: engine/PrayerScheduler.ts.

import { Bell, BellOff, MapPin, MoonStar, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Popover, ProviderState, WidgetCard } from "../components/ui";
import { useI18n } from "../i18n";
import { formatFullDate, formatTime } from "../lib/format";
import { errorMessage, ipc } from "../lib/ipc";
import { patchSettings, useNow, usePreview, useProvider, useSettings } from "../lib/hooks";
import { PHASE_TINT, countdown, localDay, nextPrayer, prayerPhase, prayerSlots, type PrayerSlot } from "../lib/prayer";
import type { GeoPlace, Mosque, PrayerData, PrayerKey, PrayerSettings, WidgetProps } from "../types/winglass";

export const PRAYER_METHODS: Array<{ id: number; label: string }> = [
  { id: 3, label: "MWL" },
  { id: 12, label: "UOIF (France)" },
  { id: 2, label: "ISNA" },
  { id: 4, label: "Umm al-Qura" },
];

const setPrayer = (patch: Partial<PrayerSettings>) => void patchSettings((s) => ({ ...s, prayer: { ...s.prayer, ...patch } }));

/** Hijri date from the platform's Umm al-Qura calendar (no network). */
function hijri(date: Date, locale: string): string {
  try {
    return new Intl.DateTimeFormat(`${locale}-u-ca-islamic-umalqura`, { day: "numeric", month: "long", year: "numeric" }).format(date);
  } catch {
    return "";
  }
}

/** Reminder lead time, chime and native toasts; shared with Settings › Heures de prière. */
export function PrayerAlertControls({ prefs }: { prefs: PrayerSettings }) {
  const { t } = useI18n();
  const pill = (active: boolean) => ({
    background: active ? "var(--lb-card-hover)" : "transparent",
    fontWeight: active ? 650 : 450,
  });
  return (
    <div className="flex flex-col gap-1.5 text-[12px]">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate lb-muted">{t("prayer.reminder")}</span>
        <div className="flex rounded-full p-0.5" style={{ background: "var(--lb-track)" }} role="radiogroup" aria-label={t("prayer.reminder")}>
          {[0, 5, 10, 15].map((m) => (
            <button
              key={m}
              role="radio"
              aria-checked={prefs.reminderMinutes === m}
              className="lb-focus rounded-full border-none px-2 py-0.5 text-[11.5px]"
              style={pill(prefs.reminderMinutes === m)}
              onClick={() => setPrayer({ reminderMinutes: m })}
            >
              {m === 0 ? t("prayer.off") : t("prayer.minutesShort", { minutes: m })}
            </button>
          ))}
        </div>
      </div>
      {(
        [
          ["chime", t("prayer.chime")],
          ["nativeToasts", t("prayer.native")],
        ] as const
      ).map(([key, label]) => (
        <label key={key} className="flex cursor-pointer items-center gap-2">
          <span className="min-w-0 flex-1 truncate lb-muted">{label}</span>
          <input type="checkbox" checked={prefs[key]} onChange={(e) => setPrayer({ [key]: e.target.checked })} style={{ accentColor: "var(--lb-accent)" }} />
        </label>
      ))}
    </div>
  );
}

/** Mosque (Mawaqit) or city (Aladhan) picker. */
export function PrayerPlacePicker({ prefs, onDone }: { prefs: PrayerSettings; onDone?: () => void }) {
  const { t, lang } = useI18n();
  const [source, setSource] = useState(prefs.source);
  const [query, setQuery] = useState("");
  const [mosques, setMosques] = useState<Mosque[]>([]);
  const [places, setPlaces] = useState<GeoPlace[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const q = query.trim();
    setError(null);
    if (q.length < 2) {
      setMosques([]);
      setPlaces([]);
      return;
    }
    let alive = true;
    const timer = window.setTimeout(() => {
      setBusy(true);
      const run = source === "mawaqit" ? ipc.searchMawaqitMosques(q).then((m) => alive && setMosques(m)) : ipc.geocodeCity(q, lang).then((p) => alive && setPlaces(p));
      run
        .catch((err) => {
          if (!alive) return;
          const msg = errorMessage(err);
          setError(msg === "mawaqit-search-locked" ? t("prayer.pasteLink") : msg);
        })
        .finally(() => alive && setBusy(false));
    }, 350);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [query, source, lang, t]);

  const results =
    source === "mawaqit"
      ? mosques.map((m) => ({ key: m.slug, title: m.name, sub: m.location, pick: () => setPrayer({ source: "mawaqit", mosqueSlug: m.slug, mosqueName: m.name }) }))
      : places.map((p) => ({
          key: `${p.latitude},${p.longitude}`,
          title: p.name,
          sub: [p.admin, p.country].filter(Boolean).join(", "),
          pick: () => setPrayer({ source: "city", city: p.name, latitude: p.latitude, longitude: p.longitude }),
        }));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex rounded-full p-0.5 text-[12px]" style={{ background: "var(--lb-track)" }} role="tablist">
        {(["mawaqit", "city"] as const).map((s) => (
          <button
            key={s}
            role="tab"
            aria-selected={source === s}
            className="lb-focus flex-1 rounded-full border-none py-1"
            style={{ background: source === s ? "var(--lb-card-hover)" : "transparent", fontWeight: source === s ? 650 : 450 }}
            onClick={() => {
              setSource(s);
              setQuery("");
            }}
          >
            {s === "mawaqit" ? t("prayer.sourceMawaqit") : t("prayer.sourceCity")}
          </button>
        ))}
      </div>
      <label className="flex items-center gap-2 rounded-full px-3 py-1.5" style={{ background: "var(--lb-card)" }}>
        <Search size={13} strokeWidth={2.4} className="shrink-0 lb-muted" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={source === "mawaqit" ? t("prayer.searchMosque") : t("prayer.searchCity")}
          aria-label={source === "mawaqit" ? t("prayer.searchMosque") : t("prayer.searchCity")}
          className="min-w-0 flex-1 border-none bg-transparent text-[12.5px] outline-none"
          style={{ color: "var(--lb-text)" }}
        />
        {busy && <span className="text-[11px] lb-faint">…</span>}
      </label>
      {error && <div className="px-1 text-[11.5px]" style={{ color: "var(--lb-amber)" }}>{error}</div>}
      {source === "city" && (
        <label className="flex items-center gap-2 px-1 text-[12px]">
          <span className="min-w-0 flex-1 truncate lb-muted">{t("prayer.method")}</span>
          <select
            value={prefs.method}
            onChange={(e) => setPrayer({ method: Number(e.target.value) })}
            className="lb-focus rounded-lg border-none px-2 py-1 text-[12px]"
            style={{ background: "var(--lb-track)", color: "var(--lb-text)" }}
          >
            {PRAYER_METHODS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {results.length > 0 && (
        <div className="lb-thin-scroll flex max-h-[180px] flex-col gap-0.5 overflow-y-auto">
          {results.map((r) => (
            <button
              key={r.key}
              className="lb-row lb-focus flex items-center gap-2 rounded-lg border-none bg-transparent px-2 py-1.5 text-left"
              onClick={() => {
                r.pick();
                onDone?.();
              }}
            >
              <MapPin size={13} strokeWidth={2.4} className="shrink-0 lb-muted" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-semibold">{r.title}</span>
                {r.sub && <span className="block truncate text-[11px] lb-muted">{r.sub}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PrayerRow({ slot, next, prefs, now }: { slot: PrayerSlot; next: boolean; prefs: PrayerSettings; now: number }) {
  const { t } = useI18n();
  const on = prefs.alerts.includes(slot.key);
  const past = slot.at.getTime() < now && !next;
  const name = t(`prayer.${slot.key}`);
  return (
    <div
      className="flex items-center gap-2 rounded-lg px-2.5 py-1.5"
      style={{
        background: next ? "color-mix(in oklch, var(--lb-accent) 22%, transparent)" : "transparent",
        boxShadow: next ? "inset 0 0 0 1px color-mix(in oklch, var(--lb-accent) 45%, transparent)" : undefined,
        opacity: past ? 0.55 : 1,
      }}
    >
      <span className="min-w-0 flex-1 truncate text-[12.5px]" style={{ fontWeight: next ? 700 : 500 }}>
        {name}
      </span>
      {slot.iqama && <span className="shrink-0 text-[11px] tabular-nums lb-muted">{t("prayer.iqama", { time: formatTime(slot.iqama) })}</span>}
      <span className="w-[46px] shrink-0 text-right text-[13px] font-semibold tabular-nums">{formatTime(slot.at)}</span>
      <button
        className="lb-icon-btn h-7 w-7 shrink-0"
        aria-pressed={on}
        aria-label={on ? t("prayer.bellOff", { name }) : t("prayer.bellOn", { name })}
        title={on ? t("prayer.bellOff", { name }) : t("prayer.bellOn", { name })}
        onClick={() => setPrayer({ alerts: on ? prefs.alerts.filter((k) => k !== slot.key) : [...prefs.alerts, slot.key as PrayerKey] })}
      >
        {on ? <Bell size={14} strokeWidth={2.4} style={{ color: "var(--lb-accent)" }} /> : <BellOff size={14} strokeWidth={2.4} className="lb-faint" />}
      </button>
    </div>
  );
}

export function PrayerTimesWidget({ span }: WidgetProps) {
  const { t, locale } = useI18n();
  const view = useProvider<PrayerData>("prayer");
  const settings = useSettings();
  const preview = usePreview();
  const now = useNow(1000);
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const prefs = settings?.prayer;

  const popover = (body: React.ReactNode) => (
    <Popover anchor={ref} open={open} onClose={() => setOpen(false)} width={340} testId="prayer-popover">
      {body}
    </Popover>
  );

  if (!view.data) {
    const glyph = <MoonStar size={20} strokeWidth={2.2} />;
    if (view.status === "unconfigured" && prefs && !preview) {
      return (
        <>
          <WidgetCard span={span} cardRef={ref} onClick={() => setOpen((o) => !o)} title={t("prayer.setup")}>
            <div className="flex min-w-0 items-center gap-2">
              {glyph}
              <div className="min-w-0 leading-tight">
                <div className="truncate font-semibold">{t("prayer.name")}</div>
                <div className="truncate lb-muted" style={{ fontSize: "var(--lb-small)" }}>{t("prayer.setup")}</div>
              </div>
            </div>
          </WidgetCard>
          {popover(<PrayerPlacePicker prefs={prefs} onDone={() => setOpen(false)} />)}
        </>
      );
    }
    return <ProviderState span={span} providerId="prayer" glyph={glyph} name={t("prayer.name")} status={view.status} error={view.error} tab="widgets" />;
  }

  const slots = prayerSlots(view.data);
  const next = nextPrayer(slots, now);
  const today = localDay(now);
  const todays = slots.filter((s) => s.date === today);
  const tint = PHASE_TINT[prayerPhase(slots, now)];
  const place = view.data.name || view.data.city;
  const nextName = next ? t(`prayer.${next.key}`) : "";
  const msLeft = next ? next.at.getTime() - now : 0;
  const minutesLeft = Math.ceil(msLeft / 60_000);
  const shortLeft = minutesLeft < 60 ? t("prayer.inMinutes", { minutes: minutesLeft }) : t("prayer.inHours", { hours: Math.floor(minutesLeft / 60), minutes: String(minutesLeft % 60).padStart(2, "0") });

  return (
    <>
      <WidgetCard span={span} cardRef={ref} className="gap-2" title={`${place} · ${nextName} ${next ? formatTime(next.at) : ""}`} onClick={() => !preview && setOpen((o) => !o)}>
        <div aria-hidden className="pointer-events-none absolute inset-0" style={{ background: `linear-gradient(120deg in oklch, ${tint}, transparent 75%)`, transition: "background 1.2s ease" }} />
        <MoonStar size={span === "1x1" ? 18 : 20} strokeWidth={2.2} className="relative shrink-0" style={{ color: "oklch(84% 0.1 85)" }} />
        <div className="relative min-w-0 flex-1 leading-tight">
          <div className="truncate font-semibold tabular-nums">
            {next ? (span === "1x1" ? formatTime(next.at) : `${nextName} · ${formatTime(next.at)}`) : t("prayer.name")}
          </div>
          {span === "1x1" ? (
            <div className="truncate lb-muted tabular-nums" style={{ fontSize: "var(--lb-small)" }}>{nextName}</div>
          ) : (
            <div className="truncate lb-muted" style={{ fontSize: "var(--lb-small)" }}>{place}</div>
          )}
        </div>
        {span !== "1x1" && next && (
          <span
            className="relative shrink-0 rounded-full px-2 py-0.5 font-semibold tabular-nums"
            style={{ fontSize: "var(--lb-small)", background: "rgb(255 255 255 / 0.12)", color: minutesLeft <= 10 ? "var(--lb-amber)" : "var(--lb-text)" }}
          >
            {span === "3x1" ? `-${countdown(msLeft)}` : shortLeft}
          </span>
        )}
      </WidgetCard>
      {prefs &&
        popover(
          <div className="flex flex-col gap-2.5">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] font-bold">{place}</div>
                <div className="truncate text-[11.5px] lb-muted">{hijri(new Date(now), locale)}</div>
                <div className="truncate text-[11.5px] lb-muted first-letter:uppercase">
                  {formatFullDate(new Date(now))}
                  {view.data.offline ? ` · ${t("prayer.offline")}` : ""}
                </div>
              </div>
              <button className="lb-focus shrink-0 rounded-full border-none px-2.5 py-1 text-[11.5px] font-semibold" style={{ background: "var(--lb-card)", color: "var(--lb-accent)" }} onClick={() => setPicking((p) => !p)}>
                {picking ? t("common.done") : t("weather.change")}
              </button>
              <button className="lb-icon-btn h-7 w-7 shrink-0" aria-label={t("common.close")} onClick={() => setOpen(false)}>
                <X size={15} strokeWidth={2.4} />
              </button>
            </div>

            {picking ? (
              <PrayerPlacePicker prefs={prefs} onDone={() => setPicking(false)} />
            ) : (
              <>
                {next && (
                  <div className="flex items-center gap-3 rounded-lg px-3 py-2.5" style={{ background: `linear-gradient(120deg in oklch, ${tint}, var(--lb-card))` }}>
                    <MoonStar size={26} strokeWidth={2} style={{ color: "oklch(86% 0.1 85)" }} />
                    <div className="min-w-0 flex-1 leading-tight">
                      <div className="text-[11px] font-semibold uppercase tracking-wide lb-muted">{t("prayer.next")}</div>
                      <div className="truncate text-[17px] font-bold">
                        {nextName} · <span className="tabular-nums">{formatTime(next.at)}</span>
                      </div>
                    </div>
                    <div className="shrink-0 text-[15px] font-semibold tabular-nums" aria-live="off">-{countdown(msLeft)}</div>
                  </div>
                )}
                <div className="flex flex-col gap-0.5">
                  {todays.map((slot) => (
                    <PrayerRow key={slot.key} slot={slot} next={slot === next} prefs={prefs} now={now} />
                  ))}
                </div>
                <div className="h-px" style={{ background: "var(--lb-track)" }} />
                <PrayerAlertControls prefs={prefs} />
              </>
            )}
          </div>,
        )}
    </>
  );
}
