// Calendar & agenda from private ICS feeds plus events quick-added here (saved in SQLite).
// Tile: weekday, day number, next event and live countdown. Flyout (works without a feed too):
// month grid of day cards on the left (event dots, per-calendar badges, overflow), the selected
// day's agenda on the right with a calendar filter and a quick-add bar.

import { CalendarDays, ChevronLeft, ChevronRight, Filter, Plus, Trash2, X } from "lucide-react";
import { useRef, useState, type KeyboardEvent } from "react";
import { Popover, WidgetCard, openSettings } from "../components/ui";
import { useI18n } from "../i18n";
import {
  firstDayOfWeek,
  formatCountdown,
  formatDayBadge,
  formatFullDate,
  formatLongDate,
  formatMonthYear,
  formatTime,
  startTimeFormatted,
} from "../lib/format";
import { errorMessage, ipc } from "../lib/ipc";
import { useNow, usePreview, useProvider } from "../lib/hooks";
import type { CalendarData, CalendarEvent, WidgetProps } from "../types/winglass";

/** The backend loads feeds for this many days ahead (providers/ical_parser.rs). */
const LOADED_DAYS = 14;
const EVENT_BLUE = "#3B82F6";
const ALL_DAY_PURPLE = "#8B5CF6";

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Events overlapping the local day (all-day ends are exclusive midnights). */
function eventsOn(events: CalendarEvent[], day: Date): CalendarEvent[] {
  const from = startOfDay(day).getTime();
  const to = addDays(day, 1).getTime();
  return events
    .filter((e) => new Date(e.start).getTime() < to && new Date(e.end).getTime() > from)
    .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start));
}

/** Whole weeks covering the month, starting on the locale's first weekday. */
function monthGrid(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const lead = (first.getDay() - firstDayOfWeek() + 7) % 7;
  const start = addDays(first, -lead);
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const weeks = Math.ceil((lead + daysInMonth) / 7);
  return Array.from({ length: weeks * 7 }, (_, i) => addDays(start, i));
}

/** Badge colour per calendar: iCloud red, Outlook / Google blue, quick-added green, others hashed. */
function calendarColor(name: string | null): string {
  const n = (name ?? "").toLowerCase();
  if (n.includes("icloud")) return "#FF453A";
  if (n.includes("outlook") || n.includes("office")) return "#0A84FF";
  if (n.includes("google") || n.includes("gmail")) return EVENT_BLUE;
  if (n === "winglass") return "#30D158";
  const palette = [EVENT_BLUE, ALL_DAY_PURPLE, "#14B8A6", "#F59E0B", "#EC4899"];
  let h = 0;
  for (const c of n) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}

/** Short weekday headers ("LUN" / "MON") in locale order. */
function weekdayShort(locale: string): string[] {
  const fmt = new Intl.DateTimeFormat(locale, { weekday: "short" });
  const base = new Date(2024, 0, 7); // a Sunday
  return Array.from({ length: 7 }, (_, i) => fmt.format(addDays(base, (firstDayOfWeek() + i) % 7)).replace(".", "").slice(0, 3).toUpperCase());
}

/** Next quarter hour after `now`, as "HH:MM". */
function nextQuarter(now: Date): string {
  const d = new Date(now);
  d.setMinutes(Math.ceil((d.getMinutes() + 1) / 15) * 15, 0, 0);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function QuickAdd({ day, now }: { day: Date; now: Date }) {
  const { t } = useI18n();
  const [time, setTime] = useState(() => nextQuarter(now));
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const placeholder = sameDay(day, now) ? t("calendar.newEventToday") : t("calendar.newEventOn", { date: formatLongDate(day) });

  const submit = () => {
    const [h, m] = time.split(":").map(Number);
    if (!title.trim() || !Number.isFinite(h) || !Number.isFinite(m)) return;
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
    const end = new Date(start.getTime() + 30 * 60_000);
    setBusy(true);
    setError(null);
    ipc
      .addLocalEvent(title.trim(), start.toISOString(), end.toISOString())
      .then(() => setTitle(""))
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex flex-col gap-1">
      <form
        className="flex items-center gap-1.5 rounded-full p-1"
        style={{ background: "var(--lb-card)" }}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {/* ponytail: native time input (value "HH:MM"); swap for a custom picker if a richer UI is needed. */}
        <input
          type="time"
          value={time}
          onChange={(e) => setTime(e.target.value)}
          aria-label={t("calendar.eventTime")}
          className="lb-focus shrink-0 rounded-full border-none px-2 py-1 text-[11.5px] font-semibold tabular-nums outline-none"
          style={{ background: "var(--lb-card-hover)", color: "var(--lb-text)", colorScheme: "dark" }}
        />
        <input
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          className="min-w-0 flex-1 border-none bg-transparent px-1 text-[12.5px] outline-none"
          style={{ color: "var(--lb-text)" }}
        />
        <button
          type="submit"
          className="lb-focus flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-none"
          style={{ background: "var(--lb-accent)", color: "#fff", opacity: title.trim() && !busy ? 1 : 0.5 }}
          disabled={!title.trim() || busy}
          aria-label={t("calendar.addEvent")}
          title={t("calendar.addEvent")}
        >
          <Plus size={15} strokeWidth={2.8} />
        </button>
      </form>
      {error && <div className="px-2 text-[11px]" style={{ color: "var(--lb-red)" }}>{error}</div>}
    </div>
  );
}

function MonthCalendar(props: { events: CalendarEvent[]; configured: boolean; now: Date; onClose: () => void }) {
  const { configured, now, onClose } = props;
  const { t, locale } = useI18n();
  const today = startOfDay(now);
  const [month, setMonth] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const [selected, setSelected] = useState(today);
  const [hidden, setHidden] = useState<string[]>([]);
  const [filterOpen, setFilterOpen] = useState(false);
  const gridRef = useRef<HTMLDivElement | null>(null);

  const calendars = Array.from(new Set(props.events.map((e) => e.calendar ?? t("calendar.default"))));
  const events = props.events.filter((e) => !hidden.includes(e.calendar ?? t("calendar.default")));
  const days = monthGrid(month);
  const dayEvents = eventsOn(events, selected);
  const beyondLoaded = configured && selected.getTime() >= addDays(today, LOADED_DAYS).getTime();
  const isCurrentMonth = month.getFullYear() === today.getFullYear() && month.getMonth() === today.getMonth();

  const shiftMonth = (delta: number) => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + delta, 1));

  const select = (day: Date, focus = false) => {
    setSelected(day);
    if (day.getMonth() !== month.getMonth() || day.getFullYear() !== month.getFullYear()) {
      setMonth(new Date(day.getFullYear(), day.getMonth(), 1));
    }
    if (focus) requestAnimationFrame(() => gridRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus());
  };

  // Arrows move by day / week, PageUp / PageDown by month, Home returns to today.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, () => Date> = {
      ArrowLeft: () => addDays(selected, -1),
      ArrowRight: () => addDays(selected, 1),
      ArrowUp: () => addDays(selected, -7),
      ArrowDown: () => addDays(selected, 7),
      PageUp: () => new Date(selected.getFullYear(), selected.getMonth() - 1, Math.min(selected.getDate(), 28)),
      PageDown: () => new Date(selected.getFullYear(), selected.getMonth() + 1, Math.min(selected.getDate(), 28)),
      Home: () => today,
    };
    const move = moves[e.key];
    if (!move) return;
    e.preventDefault();
    select(move(), true);
  };

  return (
    <div className="flex gap-3" data-testid="calendar-month">
      {/* ------------------------------------------------ month grid */}
      <div className="flex w-[292px] shrink-0 flex-col gap-2">
        <div className="flex items-center gap-2 px-0.5">
          <div className="min-w-0 flex-1 truncate text-[14px] font-bold capitalize" aria-live="polite">
            {formatMonthYear(month)}
          </div>
          <span className="flex shrink-0 items-center gap-1 text-[10.5px] lb-muted">
            <span className="h-[6px] w-[6px] rounded-full" style={{ background: EVENT_BLUE }} />
            {t("calendar.legendEvents")}
          </span>
          <span className="flex shrink-0 items-center gap-1 text-[10.5px] lb-muted">
            <span className="h-[6px] w-[6px] rounded-full" style={{ background: ALL_DAY_PURPLE }} />
            {t("calendar.allDay")}
          </span>
        </div>

        <div ref={gridRef} role="grid" aria-label={formatMonthYear(month)} onKeyDown={onKeyDown} className="flex flex-col gap-1">
          <div role="row" className="grid grid-cols-7 gap-1">
            {weekdayShort(locale).map((label, i) => (
              <div key={i} role="columnheader" className="rounded-full py-[2px] text-center text-[9.5px] font-semibold tracking-wide lb-muted" style={{ background: "var(--lb-card)" }}>
                {label}
              </div>
            ))}
          </div>
          {Array.from({ length: days.length / 7 }, (_, w) => (
            <div key={w} role="row" className="grid grid-cols-7 gap-1">
              {days.slice(w * 7, w * 7 + 7).map((day) => {
                const inMonth = day.getMonth() === month.getMonth();
                const isToday = sameDay(day, today);
                const isSelected = sameDay(day, selected);
                const list = eventsOn(events, day);
                const count = list.length;
                const sources = Array.from(new Set(list.map((e) => e.calendar))).slice(0, 2);
                const overflow = count - sources.length;
                const countLabel = count === 1 ? t("calendar.oneEvent") : count > 1 ? t("calendar.eventCount", { count }) : "";
                return (
                  <button
                    key={day.toISOString()}
                    role="gridcell"
                    aria-selected={isSelected}
                    aria-current={isToday ? "date" : undefined}
                    aria-label={countLabel ? `${formatFullDate(day)}, ${countLabel}` : formatFullDate(day)}
                    tabIndex={isSelected ? 0 : -1}
                    onClick={() => select(day)}
                    className="lb-focus relative flex h-[38px] flex-col items-center justify-start gap-[3px] rounded-lg border-none p-0 pt-[3px] tabular-nums"
                    style={{
                      background: inMonth ? "var(--lb-card)" : "transparent",
                      boxShadow: isSelected ? `inset 0 0 0 1.5px ${EVENT_BLUE}` : undefined,
                      color: inMonth ? "var(--lb-text)" : "var(--lb-faint)",
                    }}
                  >
                    <span
                      className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-[3px] text-[11px]"
                      style={{
                        background: isSelected ? "#2563EB" : "transparent",
                        color: isSelected ? "#fff" : isToday ? EVENT_BLUE : undefined,
                        fontWeight: isSelected || isToday ? 700 : 500,
                      }}
                    >
                      {day.getDate()}
                    </span>
                    {count > 0 && (
                      <>
                        <span aria-hidden className="absolute right-[4px] top-[4px] h-[5px] w-[5px] rounded-full" style={{ background: list.some((e) => e.allDay) ? ALL_DAY_PURPLE : EVENT_BLUE }} />
                        <span aria-hidden className="flex items-center gap-[2px]">
                          {sources.map((c) => (
                            <span key={c ?? "-"} className="h-[6px] w-[6px] rounded-[2px]" style={{ background: calendarColor(c) }} />
                          ))}
                          {overflow > 0 && <span className="text-[8px] font-semibold leading-none lb-muted">+{overflow}</span>}
                        </span>
                      </>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* ------------------------------------------------ agenda */}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="relative flex items-center gap-1">
          {calendars.length > 0 && (
            <button
              className="lb-focus flex items-center gap-1 rounded-full border-none px-2.5 py-1 text-[11.5px] font-semibold"
              style={{ background: "var(--lb-card)", color: "var(--lb-text)" }}
              aria-expanded={filterOpen}
              onClick={() => setFilterOpen((o) => !o)}
            >
              <Filter size={11} strokeWidth={2.6} />
              {t("calendar.calendars")}
              {hidden.length > 0 && <span className="lb-muted">· {calendars.length - hidden.length}</span>}
            </button>
          )}
          {filterOpen && (
            <div className="lb-menu absolute left-0 top-8 z-10 flex w-[190px] flex-col gap-0.5 p-1.5" role="menu">
              {calendars.map((c) => (
                <label key={c} className="lb-row flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-[12px]">
                  <input
                    type="checkbox"
                    checked={!hidden.includes(c)}
                    onChange={() => setHidden((h) => (h.includes(c) ? h.filter((x) => x !== c) : [...h, c]))}
                    style={{ accentColor: calendarColor(c) }}
                  />
                  <span className="min-w-0 flex-1 truncate">{c}</span>
                </label>
              ))}
            </div>
          )}
          <span className="flex-1" />
          {(!isCurrentMonth || !sameDay(selected, today)) && (
            <button className="lb-focus shrink-0 rounded-full border-none px-2.5 py-1 text-[11.5px] font-semibold" style={{ background: EVENT_BLUE, color: "#fff" }} onClick={() => select(today)}>
              {t("common.today")}
            </button>
          )}
          <button className="lb-icon-btn h-7 w-7 shrink-0" onClick={() => shiftMonth(-1)} aria-label={t("calendar.prevMonth")} title={t("calendar.prevMonth")}>
            <ChevronLeft size={15} strokeWidth={2.4} />
          </button>
          <button className="lb-icon-btn h-7 w-7 shrink-0" onClick={() => shiftMonth(1)} aria-label={t("calendar.nextMonth")} title={t("calendar.nextMonth")}>
            <ChevronRight size={15} strokeWidth={2.4} />
          </button>
          <button className="lb-icon-btn h-7 w-7 shrink-0" onClick={onClose} aria-label={t("common.close")}>
            <X size={15} strokeWidth={2.4} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-1.5 rounded-lg p-2" style={{ background: "var(--lb-card)" }}>
          <div className="flex items-baseline gap-2 px-1">
            <span className="min-w-0 flex-1 truncate text-[13px] font-bold">{sameDay(selected, today) ? t("common.today") : formatFullDate(selected)}</span>
            <span className="shrink-0 text-[11px] lb-muted">{dayEvents.length === 1 ? t("calendar.oneEvent") : t("calendar.eventCount", { count: dayEvents.length })}</span>
          </div>
          <div className="lb-thin-scroll flex h-[214px] flex-col gap-0.5 overflow-y-auto">
            {!configured && dayEvents.length === 0 ? (
              <button className="lb-focus m-1 self-start rounded-full border-none px-2.5 py-1 text-[12px] font-semibold" style={{ background: "var(--lb-card-hover)", color: "var(--lb-accent)" }} onClick={() => openSettings("calendar")}>
                {t("calendar.addFeed")}
              </button>
            ) : dayEvents.length === 0 ? (
              <div className="px-1 py-1 text-[12px] lb-muted">{beyondLoaded ? t("calendar.outOfRange") : t("calendar.dayEmpty")}</div>
            ) : (
              dayEvents.map((e) => {
                const color = e.allDay ? ALL_DAY_PURPLE : calendarColor(e.calendar);
                const sub = [e.calendar, e.location].filter(Boolean).join(" · ");
                const local = e.uid.startsWith("local-");
                return (
                  <div key={e.uid} className="lb-row group flex items-center gap-2 rounded-md px-1.5 py-1.5">
                    <span className="w-[52px] shrink-0 text-[11px] font-semibold tabular-nums lb-muted">{e.allDay ? t("calendar.allDay") : formatTime(new Date(e.start))}</span>
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md" style={{ background: color }}>
                      <CalendarDays size={12} strokeWidth={2.6} color="#fff" />
                    </span>
                    <button className="min-w-0 flex-1 border-none bg-transparent p-0 text-left" onClick={() => openEvent(e)} title={e.location ?? e.title} style={{ color: "var(--lb-text)" }}>
                      <span className="block truncate text-[12.5px] font-semibold">{e.title}</span>
                      {sub && <span className="block truncate text-[11px] lb-muted">{sub}</span>}
                    </button>
                    {local && (
                      <button className="lb-icon-btn h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" aria-label={t("common.delete")} title={t("common.delete")} onClick={() => void ipc.deleteLocalEvent(e.uid)}>
                        <Trash2 size={12} strokeWidth={2.4} />
                      </button>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>

        <QuickAdd day={selected} now={now} />
      </div>
    </div>
  );
}

/** Weekday over day number: `MAR` / `20` in French, `TUE` / `20` in English. */
function DayBadge({ now }: { now: Date }) {
  const badge = formatDayBadge(now);
  return (
    <div className="flex h-[calc(100%-8px)] aspect-square shrink-0 flex-col items-center justify-center gap-[1px] overflow-hidden rounded-[9px]" style={{ background: "var(--lb-card-hover)" }}>
      <div className="font-bold uppercase leading-none tracking-wide" style={{ fontSize: "calc(var(--lb-small) - 1px)", color: "var(--lb-red)" }}>
        {badge.weekday}
      </div>
      <div className="font-bold leading-none tabular-nums" style={{ fontSize: "calc(var(--lb-large) + 1px)" }}>
        {badge.day}
      </div>
    </div>
  );
}

function openEvent(event: CalendarEvent) {
  void ipc.openTarget(event.url ?? "calendar-app");
}

export function CalendarWidget({ span }: WidgetProps) {
  const { t } = useI18n();
  const view = useProvider<CalendarData>("calendar");
  const preview = usePreview();
  const nowMs = useNow(1000);
  const now = new Date(nowMs);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  const events = (view.data?.events ?? []).filter((e) => new Date(e.end).getTime() > nowMs);
  const next = events.find((e) => !e.allDay) ?? events[0];

  let body;
  if (!view.data) {
    body = (
      <div className="min-w-0 flex-1 leading-tight">
        <div className="truncate font-semibold">{formatLongDate(now)}</div>
        <div className="truncate lb-muted" style={{ fontSize: "var(--lb-small)" }} title={view.error ?? undefined}>
          {view.status === "loading" ? t("common.loading") : view.status === "error" ? view.error : t("calendar.addFeed")}
        </div>
      </div>
    );
  } else if (!next) {
    body = (
      <div className="min-w-0 flex-1 leading-tight">
        <div className="truncate font-semibold">{t("calendar.noMore")}</div>
        <div className="truncate lb-muted" style={{ fontSize: "var(--lb-small)" }}>{t("calendar.free")}</div>
      </div>
    );
  } else {
    const start = new Date(next.start);
    const minutes = (start.getTime() - nowMs) / 60000;
    const soon = minutes > 0 && minutes <= 10;
    body = (
      <div className="min-w-0 flex-1 leading-tight">
        <div className="truncate font-semibold">{view.isSample ? t("toast.test.sampleMeeting") : next.title}</div>
        <div className="flex min-w-0 gap-1" style={{ fontSize: "var(--lb-small)" }}>
          {span !== "1x1" && <span className="lb-muted truncate">{startTimeFormatted(start, next.allDay, now)}</span>}
          {!next.allDay && (
            <span className={`font-semibold ${span === "1x1" ? "truncate" : "shrink-0"}`} style={{ color: soon ? "var(--lb-red)" : EVENT_BLUE }}>
              {span !== "1x1" && "· "}
              {formatCountdown(minutes, span === "1x1")}
            </span>
          )}
        </div>
      </div>
    );
  }

  return (
    <>
      <WidgetCard
        span={span}
        cardRef={ref}
        padded={false}
        className="gap-2 pl-1 pr-2.5"
        title={next ? `${t("calendar.nextEvent")} · ${next.title}` : undefined}
        onClick={() => {
          if (!preview) setOpen((o) => !o);
        }}
      >
        <DayBadge now={now} />
        {body}
      </WidgetCard>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} width={640} testId="calendar-popover">
        <MonthCalendar events={view.data?.events ?? []} configured={Boolean(view.data)} now={now} onClose={() => setOpen(false)} />
      </Popover>
    </>
  );
}
