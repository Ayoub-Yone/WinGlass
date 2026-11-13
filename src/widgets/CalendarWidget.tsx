// Calendar & agenda from private ICS feeds: day badge, next event, live countdown.

import { useRef, useState } from "react";
import { Popover, WidgetCard, openSettings } from "../components/ui";
import { formatCountdown, startTimeFormatted } from "../lib/format";
import { ipc } from "../lib/ipc";
import { useNow, usePreview, useProvider } from "../lib/hooks";
import type { CalendarData, CalendarEvent, WidgetProps } from "../types/lumabar";

function DayBadge({ now }: { now: Date }) {
  return (
    <div className="flex h-[calc(100%-8px)] aspect-square shrink-0 flex-col items-center justify-center overflow-hidden rounded-[9px]" style={{ background: "var(--lb-card-hover)" }}>
      <div className="font-bold uppercase leading-none" style={{ fontSize: "calc(var(--lb-small) - 1px)", color: "var(--lb-red)" }}>
        {now.toLocaleDateString("en-US", { weekday: "short" })}
      </div>
      <div className="font-semibold leading-none tabular-nums" style={{ fontSize: "var(--lb-large)" }}>
        {now.getDate()}
      </div>
    </div>
  );
}

function openEvent(event: CalendarEvent) {
  void ipc.openTarget(event.url ?? "calendar-app");
}

export function CalendarWidget({ span }: WidgetProps) {
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
      <div className="min-w-0 leading-tight">
        <div className="truncate font-semibold">{now.toLocaleDateString("en-US", { month: "long", day: "numeric" })}</div>
        <div className="truncate lb-muted" style={{ fontSize: "var(--lb-small)" }} title={view.error ?? undefined}>
          {view.status === "loading" ? "Loading…" : view.status === "error" ? view.error : "Add calendar feed"}
        </div>
      </div>
    );
  } else if (!next) {
    body = (
      <div className="min-w-0 leading-tight">
        <div className="truncate font-semibold">No more events</div>
        <div className="truncate lb-muted" style={{ fontSize: "var(--lb-small)" }}>Enjoy the free time</div>
      </div>
    );
  } else {
    const start = new Date(next.start);
    const minutes = (start.getTime() - nowMs) / 60000;
    const soon = minutes > 0 && minutes <= 10;
    body = (
      <div className="min-w-0 flex-1 leading-tight">
        <div className="truncate font-semibold">{next.title}</div>
        <div className="flex gap-1 truncate" style={{ fontSize: "var(--lb-small)" }}>
          {span !== "1x1" && <span className="lb-muted truncate">{startTimeFormatted(start, next.allDay, now)}</span>}
          {!next.allDay && (
            <span className="shrink-0 font-semibold" style={{ color: soon ? "var(--lb-red)" : "var(--lb-accent)" }}>
              {span !== "1x1" && "· "}
              {formatCountdown(minutes)}
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
        onClick={() => {
          if (preview) return;
          if (!view.data) openSettings("calendar");
          else setOpen((o) => !o);
        }}
      >
        <DayBadge now={now} />
        {body}
      </WidgetCard>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} width={300}>
        <div className="mb-2 font-semibold">Upcoming</div>
        <div className="lb-thin-scroll flex max-h-[300px] flex-col gap-1 overflow-y-auto">
          {events.length === 0 && <div className="lb-muted">Nothing in the next two weeks.</div>}
          {events.slice(0, 20).map((e) => {
            const start = new Date(e.start);
            return (
              <button
                key={e.uid}
                className="lb-card flex w-full flex-col items-start rounded-lg border-none px-2 py-1.5 text-left"
                onClick={() => openEvent(e)}
              >
                <span className="w-full truncate font-medium">{e.title}</span>
                <span className="w-full truncate lb-muted" style={{ fontSize: "var(--lb-small)" }}>
                  {startTimeFormatted(start, e.allDay, now)}
                  {!e.allDay && ` · ${formatCountdown((start.getTime() - nowMs) / 60000)}`}
                  {e.calendar && ` · ${e.calendar}`}
                </span>
              </button>
            );
          })}
        </div>
      </Popover>
    </>
  );
}
