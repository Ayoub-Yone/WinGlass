// Calendar & agenda from private ICS feeds: day badge, next event, live countdown.
// Clicking the card opens a month calendar (works without a feed too) with the selected day's agenda.

import { ChevronLeft, ChevronRight } from "lucide-react";
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
  weekdayInitials,
} from "../lib/format";
import { ipc } from "../lib/ipc";
import { useNow, usePreview, useProvider } from "../lib/hooks";
import type { CalendarData, CalendarEvent, WidgetProps } from "../types/lumabar";

/** The backend loads feeds for this many days ahead (providers/ical_parser.rs). */
const LOADED_DAYS = 14;

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

function MonthCalendar(props: { events: CalendarEvent[]; configured: boolean; now: Date }) {
  const { events, configured, now } = props;
  const { t } = useI18n();
  const today = startOfDay(now);
  const [month, setMonth] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const [selected, setSelected] = useState(today);
  const gridRef = useRef<HTMLDivElement | null>(null);

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

  const goToday = () => select(today);

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
    <div className="flex flex-col gap-2" data-testid="calendar-month">
      <div className="flex items-center gap-1">
        <div className="min-w-0 flex-1 truncate pl-1 text-[13px] font-semibold" aria-live="polite">
          {formatMonthYear(month)}
        </div>
        {!isCurrentMonth || !sameDay(selected, today) ? (
          <button className="lb-focus shrink-0 rounded-full border-none px-2 py-0.5 text-[11px] font-semibold" style={{ background: "var(--lb-card)", color: "var(--lb-accent)" }} onClick={goToday}>
            {t("common.today")}
          </button>
        ) : null}
        <button className="lb-icon-btn h-7 w-7 shrink-0" onClick={() => shiftMonth(-1)} aria-label={t("calendar.prevMonth")} title={t("calendar.prevMonth")}>
          <ChevronLeft size={15} strokeWidth={2.4} />
        </button>
        <button className="lb-icon-btn h-7 w-7 shrink-0" onClick={() => shiftMonth(1)} aria-label={t("calendar.nextMonth")} title={t("calendar.nextMonth")}>
          <ChevronRight size={15} strokeWidth={2.4} />
        </button>
      </div>

      <div ref={gridRef} role="grid" aria-label={formatMonthYear(month)} onKeyDown={onKeyDown}>
        <div role="row" className="grid grid-cols-7 pb-1">
          {weekdayInitials().map((label, i) => (
            <div key={i} role="columnheader" className="text-center text-[10.5px] font-semibold lb-faint">
              {label}
            </div>
          ))}
        </div>
        {Array.from({ length: days.length / 7 }, (_, w) => (
          <div key={w} role="row" className="grid grid-cols-7">
            {days.slice(w * 7, w * 7 + 7).map((day) => {
              const inMonth = day.getMonth() === month.getMonth();
              const isToday = sameDay(day, today);
              const isSelected = sameDay(day, selected);
              const count = eventsOn(events, day).length;
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
                  className="lb-focus relative mx-auto flex h-[30px] w-[30px] flex-col items-center justify-center rounded-full border-none p-0 text-[12px] tabular-nums"
                  style={{
                    background: isToday ? "var(--lb-accent)" : isSelected ? "var(--lb-card-hover)" : "transparent",
                    color: isToday ? "#fff" : inMonth ? "var(--lb-text)" : "var(--lb-faint)",
                    fontWeight: isToday || isSelected ? 650 : 400,
                    boxShadow: isSelected && !isToday ? "inset 0 0 0 1.5px color-mix(in oklch, var(--lb-accent) 70%, transparent)" : undefined,
                  }}
                >
                  {day.getDate()}
                  {count > 0 && (
                    <span
                      aria-hidden
                      className="absolute bottom-[3px] h-[3.5px] w-[3.5px] rounded-full"
                      style={{ background: isToday ? "#fff" : "var(--lb-accent)" }}
                    />
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div className="h-px" style={{ background: "var(--lb-track)" }} />

      <div className="flex flex-col gap-1">
        <div className="truncate px-1 text-[11.5px] font-semibold lb-muted">{formatFullDate(selected)}</div>
        <div className="lb-thin-scroll flex max-h-[132px] flex-col gap-0.5 overflow-y-auto">
          {!configured ? (
            <button
              className="lb-focus self-start rounded-full border-none px-2.5 py-1 text-[12px] font-semibold"
              style={{ background: "var(--lb-card)", color: "var(--lb-accent)" }}
              onClick={() => openSettings("calendar")}
            >
              {t("calendar.addFeed")}
            </button>
          ) : dayEvents.length === 0 ? (
            <div className="px-1 py-1 text-[12px] lb-muted">{beyondLoaded ? t("calendar.outOfRange") : t("calendar.dayEmpty")}</div>
          ) : (
            dayEvents.map((e) => (
              <button
                key={e.uid}
                className="lb-card flex w-full items-baseline gap-2 rounded-lg border-none px-2 py-1.5 text-left"
                onClick={() => openEvent(e)}
                title={e.location ?? e.title}
              >
                <span className="w-[54px] shrink-0 text-[11px] tabular-nums lb-muted">{e.allDay ? t("calendar.allDay") : formatTime(new Date(e.start))}</span>
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{e.title}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/** Weekday over day number: `LUN` / `20` in French, `MON` / `20` in English. */
function DayBadge({ now }: { now: Date }) {
  const badge = formatDayBadge(now);
  return (
    <div className="flex h-[calc(100%-8px)] aspect-square shrink-0 flex-col items-center justify-center overflow-hidden rounded-[9px]" style={{ background: "var(--lb-card-hover)" }}>
      <div className="font-bold uppercase leading-none" style={{ fontSize: "calc(var(--lb-small) - 1px)", color: "var(--lb-red)" }}>
        {badge.weekday}
      </div>
      <div className="font-semibold leading-none tabular-nums" style={{ fontSize: "var(--lb-large)" }}>
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
            <span className={`font-semibold ${span === "1x1" ? "truncate" : "shrink-0"}`} style={{ color: soon ? "var(--lb-red)" : "var(--lb-accent)" }}>
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
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} width={286} testId="calendar-popover">
        <MonthCalendar events={view.data?.events ?? []} configured={Boolean(view.data)} now={now} />
      </Popover>
    </>
  );
}
