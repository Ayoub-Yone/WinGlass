// Utilities: Pomodoro, Stopwatch, Todos, Quick Notes, Search / Launcher, World Clocks,
// Hourly Weather (Open-Meteo), Quick Folders, Clock.

import {
  Check,
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudLightning,
  CloudRain,
  CloudSnow,
  CloudSun,
  Download,
  History,
  Image,
  ListTodo,
  Moon,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Search,
  StickyNote,
  Sun,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Popover, ProviderState, WidgetCard } from "../components/ui";
import { bus } from "../engine/EventBus";
import { formatClock } from "../lib/format";
import { broadcast, errorMessage, ipc } from "../lib/ipc";
import { useLocalState, useNow, useProvider, useSettings } from "../lib/hooks";
import type { Todo, WeatherData, WidgetProps } from "../types/lumabar";

// ---------------------------------------------------------------- Pomodoro

interface PomodoroState {
  phase: "focus" | "break";
  round: number;
  running: boolean;
  endsAt: number | null;
  remainingMs: number;
}

export function PomodoroWidget({ span, instance, preview }: WidgetProps) {
  const settings = useSettings();
  const focusMs = (settings?.pomodoroFocusMinutes ?? 25) * 60_000;
  const breakMs = (settings?.pomodoroBreakMinutes ?? 5) * 60_000;
  const [state, setState] = useLocalState<PomodoroState>(`lumabar.pomodoro.${instance.instanceId}`, {
    phase: "focus",
    round: 1,
    running: false,
    endsAt: null,
    remainingMs: focusMs,
  });
  const now = useNow(250);
  const remaining = state.running && state.endsAt ? Math.max(0, state.endsAt - now) : state.remainingMs;

  useEffect(() => {
    if (!state.running || !state.endsAt || now < state.endsAt || preview) return;
    const finishedFocus = state.phase === "focus";
    const nextPhase = finishedFocus ? "break" : "focus";
    const nextRound = finishedFocus ? state.round : state.round >= 4 ? 1 : state.round + 1;
    const duration = nextPhase === "focus" ? focusMs : breakMs;
    setState({ phase: nextPhase, round: nextRound, running: false, endsAt: null, remainingMs: duration });
    bus.emit("pomodoro:phase", { phase: nextPhase, round: nextRound });
    void broadcast("toast:push", {
      id: `pomodoro-${Date.now()}`,
      kind: "system",
      title: finishedFocus ? `Focus ${state.round}/4 complete` : "Break's over",
      subtitle: finishedFocus ? `Take a ${settings?.pomodoroBreakMinutes ?? 5} minute break` : `Ready for focus ${nextRound}/4`,
    });
  }, [now, state, focusMs, breakMs, setState, settings, preview]);

  const toggle = () => {
    if (preview) return;
    if (state.running) setState({ ...state, running: false, endsAt: null, remainingMs: remaining });
    else setState({ ...state, running: true, endsAt: Date.now() + state.remainingMs });
  };
  const reset = () => !preview && setState({ phase: "focus", round: 1, running: false, endsAt: null, remainingMs: focusMs });

  const total = state.phase === "focus" ? focusMs : breakMs;
  const progress = 1 - remaining / total;
  const color = state.phase === "focus" ? "var(--lb-red)" : "var(--lb-green)";

  return (
    <WidgetCard span={span}>
      <div className="flex w-full items-center gap-2">
        <div className="min-w-0 flex-1 leading-tight">
          <div className="lb-muted" style={{ fontSize: "var(--lb-small)" }}>
            {state.phase === "focus" ? `Focus ${state.round}/4` : "Break"}
          </div>
          <div className="font-semibold tabular-nums" style={{ fontSize: "var(--lb-large)", color: state.running ? color : undefined }}>
            {formatClock(remaining / 1000)}
          </div>
          {span !== "1x1" && (
            <div className="mt-0.5 h-[3px] w-full rounded-full" style={{ background: "var(--lb-track)" }}>
              <div className="h-full rounded-full" style={{ width: `${progress * 100}%`, background: color }} />
            </div>
          )}
        </div>
        <button className="lb-icon-btn h-7 w-7 shrink-0" style={{ background: color, color: "#fff" }} onClick={toggle} aria-label={state.running ? "Pause" : "Start"}>
          {state.running ? <Pause size={12} fill="currentColor" /> : <Play size={12} fill="currentColor" className="translate-x-[1px]" />}
        </button>
        {span !== "1x1" && (
          <button className="lb-icon-btn h-6 w-6 shrink-0" onClick={reset} aria-label="Reset">
            <RotateCcw size={12} />
          </button>
        )}
      </div>
    </WidgetCard>
  );
}

// ---------------------------------------------------------------- Stopwatch

export function StopwatchWidget({ span, instance, preview }: WidgetProps) {
  const [state, setState] = useLocalState(`lumabar.stopwatch.${instance.instanceId}`, {
    running: false,
    startedAt: 0,
    accumulatedMs: 0,
  });
  const now = useNow(state.running ? 100 : 1000);
  const elapsed = state.accumulatedMs + (state.running ? now - state.startedAt : 0);
  const toggle = () => {
    if (preview) return;
    if (state.running) setState({ running: false, startedAt: 0, accumulatedMs: elapsed });
    else setState({ ...state, running: true, startedAt: Date.now() });
  };
  const tenths = Math.floor((elapsed % 1000) / 100);
  return (
    <WidgetCard span={span}>
      <div className="flex w-full items-center gap-1.5">
        <div className="min-w-0 flex-1 font-semibold tabular-nums" style={{ fontSize: "var(--lb-large)" }}>
          {formatClock(elapsed / 1000)}
          <span className="lb-muted" style={{ fontSize: "var(--lb-small)" }}>
            .{tenths}
          </span>
        </div>
        <button className="lb-icon-btn h-6 w-6 shrink-0" style={{ background: "var(--lb-accent)", color: "#fff" }} onClick={toggle} aria-label={state.running ? "Pause" : "Start"}>
          {state.running ? <Pause size={11} fill="currentColor" /> : <Play size={11} fill="currentColor" className="translate-x-[1px]" />}
        </button>
        {(span !== "1x1" || (!state.running && elapsed > 0)) && (
          <button className="lb-icon-btn h-6 w-6 shrink-0" onClick={() => !preview && setState({ running: false, startedAt: 0, accumulatedMs: 0 })} aria-label="Reset">
            <RotateCcw size={11} />
          </button>
        )}
      </div>
    </WidgetCard>
  );
}

// ---------------------------------------------------------------- Todos

const SAMPLE_TODOS: Todo[] = [
  { id: 1, listId: "", text: "Ship lumabar", done: false, position: 0, createdAt: 0 },
  { id: 2, listId: "", text: "Reply to design feedback", done: false, position: 1, createdAt: 0 },
  { id: 3, listId: "", text: "Book flights", done: true, position: 2, createdAt: 0 },
];

export function TodosWidget({ span, instance, preview }: WidgetProps) {
  const list = instance.instanceId;
  const [todos, setTodos] = useState<Todo[]>(preview ? SAMPLE_TODOS : []);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (preview) return;
    ipc.listTodos(list).then(setTodos).catch((e) => setError(errorMessage(e)));
  }, [list, preview]);

  const run = (p: Promise<Todo[]>) => p.then(setTodos).catch((e) => setError(errorMessage(e)));
  const pending = todos.filter((t) => !t.done);
  const first = pending[0];

  return (
    <>
      <WidgetCard span={span} cardRef={ref} onClick={() => !preview && setOpen((o) => !o)}>
        <div className="flex w-full min-w-0 items-center gap-2">
          <ListTodo size={17} className="shrink-0" style={{ color: "var(--lb-accent)" }} />
          <div className="min-w-0 flex-1 leading-tight">
            <div className="font-semibold">{pending.length === 0 ? "All done" : `${pending.length} to do`}</div>
            {span !== "1x1" && first && (
              <button
                className="flex max-w-full items-center gap-1 border-none bg-transparent p-0 text-left lb-muted"
                style={{ fontSize: "var(--lb-small)" }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!preview) void run(ipc.setTodoDone(list, first.id, true));
                }}
                title="Mark done"
              >
                <span className="inline-block h-[9px] w-[9px] shrink-0 rounded-full border" style={{ borderColor: "var(--lb-muted)" }} />
                <span className="truncate">{first.text}</span>
              </button>
            )}
          </div>
        </div>
      </WidgetCard>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} width={300}>
        <form
          className="mb-2 flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!draft.trim()) return;
            void run(ipc.addTodo(list, draft));
            setDraft("");
          }}
        >
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a task…"
            className="lb-focus min-w-0 flex-1 rounded-lg border-none px-2 py-1.5 outline-none"
            style={{ background: "var(--lb-card)" }}
          />
          <button type="submit" className="lb-icon-btn h-8 w-8 shrink-0" style={{ background: "var(--lb-accent)", color: "#fff" }} aria-label="Add">
            <Plus size={14} />
          </button>
        </form>
        {error && <div className="mb-1 text-[11px]" style={{ color: "var(--lb-red)" }}>{error}</div>}
        <div className="lb-thin-scroll flex max-h-[280px] flex-col gap-0.5 overflow-y-auto">
          {todos.length === 0 && <div className="py-2 lb-muted">Nothing yet — add your first task.</div>}
          {todos.map((t) => (
            <div key={t.id} className="group flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-[var(--lb-card)]">
              <button
                className="flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-full border p-0"
                style={{ borderColor: t.done ? "var(--lb-accent)" : "var(--lb-muted)", background: t.done ? "var(--lb-accent)" : "transparent" }}
                onClick={() => void run(ipc.setTodoDone(list, t.id, !t.done))}
                aria-label={t.done ? "Mark not done" : "Mark done"}
              >
                {t.done && <Check size={10} color="#fff" strokeWidth={3} />}
              </button>
              <span className={`min-w-0 flex-1 truncate ${t.done ? "line-through lb-faint" : ""}`}>{t.text}</span>
              <button className="lb-icon-btn h-5 w-5 shrink-0 opacity-0 group-hover:opacity-100" onClick={() => void run(ipc.deleteTodo(list, t.id))} aria-label="Delete">
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
        {todos.some((t) => t.done) && (
          <button className="mt-2 flex items-center gap-1 border-none bg-transparent p-0 lb-muted" style={{ fontSize: "var(--lb-small)" }} onClick={() => void run(ipc.clearDoneTodos(list))}>
            <Trash2 size={10} /> Clear completed
          </button>
        )}
      </Popover>
    </>
  );
}

// ---------------------------------------------------------------- Quick Notes

export function QuickNotesWidget({ span, instance, preview }: WidgetProps) {
  const id = instance.instanceId;
  const [text, setText] = useState(preview ? "Ideas: liquid glass dock…" : "");
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(true);
  const ref = useRef<HTMLDivElement | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (preview) return;
    ipc.getNote(id).then(setText).catch(() => undefined);
  }, [id, preview]);

  const flush = useCallback(
    (value: string) => {
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = null;
      ipc.saveNote(id, value).then(() => setSaved(true)).catch(() => setSaved(false));
    },
    [id],
  );

  const onChange = (value: string) => {
    setText(value);
    setSaved(false);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => flush(value), 400);
  };

  const close = () => {
    if (!saved) flush(text);
    setOpen(false);
  };

  const firstLine = text.split("\n").find((l) => l.trim()) ?? "";
  return (
    <>
      <WidgetCard span={span} cardRef={ref} onClick={() => !preview && (open ? close() : setOpen(true))}>
        <div className="flex w-full min-w-0 items-center gap-2">
          <StickyNote size={17} className="shrink-0" style={{ color: "var(--lb-amber)" }} />
          <div className="min-w-0 flex-1 leading-tight">
            <div className="font-semibold">Notes</div>
            <div className="truncate lb-muted" style={{ fontSize: "var(--lb-small)" }}>
              {firstLine || "Jot something down"}
            </div>
          </div>
        </div>
      </WidgetCard>
      <Popover anchor={ref} open={open} onClose={close} width={340}>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="font-semibold">Quick Notes</span>
          <span className="lb-faint" style={{ fontSize: "var(--lb-small)" }}>{saved ? "Saved" : "Saving…"}</span>
        </div>
        <textarea
          autoFocus
          value={text}
          onChange={(e) => onChange(e.target.value)}
          spellCheck
          className="lb-focus lb-thin-scroll h-[220px] w-full resize-none rounded-lg border-none p-2 leading-relaxed outline-none"
          style={{ background: "var(--lb-card)" }}
          placeholder="Your scratchpad — saved locally as you type."
        />
      </Popover>
    </>
  );
}

// ---------------------------------------------------------------- Search / Launcher

export function SearchWidget({ span, preview }: WidgetProps) {
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement | null>(null);

  const submit = () => {
    if (preview) return;
    const q = query.trim();
    setError(null);
    const looksLikeUrl = /^(https?:\/\/)?[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(q) && !q.includes(" ");
    const action = looksLikeUrl ? ipc.openTarget(q.startsWith("http") ? q : `https://${q}`) : ipc.windowsSearch(q);
    action.then(() => setQuery("")).catch((e) => setError(errorMessage(e)));
  };

  return (
    <WidgetCard span={span} title={error ?? "Search apps, files and the web — or type a URL"} onClick={() => input.current?.focus()}>
      <div className="flex w-full min-w-0 items-center gap-2">
        <button
          className="lb-icon-btn h-6 w-6 shrink-0"
          onClick={(e) => {
            e.stopPropagation();
            submit();
          }}
          aria-label="Open Windows search"
        >
          <Search size={15} className="lb-muted" />
        </button>
        <input
          ref={input}
          value={query}
          disabled={preview}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") {
              setQuery("");
              input.current?.blur();
            }
          }}
          placeholder="Search or open"
          className="min-w-0 flex-1 border-none bg-transparent outline-none placeholder:text-[var(--lb-muted)]"
        />
      </div>
    </WidgetCard>
  );
}

// ---------------------------------------------------------------- World clocks

function AnalogClock({ date, timeZone, size }: { date: Date; timeZone: string; size: number }) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "numeric", hour12: false }).formatToParts(date);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const night = h < 6 || h >= 19;
  const hourAngle = ((h % 12) + m / 60) * 30;
  const minuteAngle = m * 6;
  const c = size / 2;
  const hand = (angle: number, len: number, w: number, color: string) => {
    const rad = ((angle - 90) * Math.PI) / 180;
    return <line x1={c} y1={c} x2={c + Math.cos(rad) * len} y2={c + Math.sin(rad) * len} stroke={color} strokeWidth={w} strokeLinecap="round" />;
  };
  return (
    <svg width={size} height={size} className="shrink-0">
      <circle cx={c} cy={c} r={c - 0.5} fill={night ? "#1C1C22" : "#F2F2F7"} />
      {hand(hourAngle, c * 0.5, 1.8, night ? "#fff" : "#111")}
      {hand(minuteAngle, c * 0.75, 1.3, night ? "#fff" : "#111")}
      <circle cx={c} cy={c} r={1.4} fill="var(--lb-accent)" />
    </svg>
  );
}

export function WorldClocksWidget({ span }: WidgetProps) {
  const settings = useSettings();
  const now = new Date(useNow(15_000));
  const clocks = (settings?.worldClocks ?? [
    { label: "NYC", timeZone: "America/New_York" },
    { label: "LDN", timeZone: "Europe/London" },
    { label: "TYO", timeZone: "Asia/Tokyo" },
  ]).slice(0, span === "1x1" ? 1 : span === "2x1" ? 2 : 3);
  return (
    <WidgetCard span={span} className="justify-around gap-1">
      {clocks.map((c) => {
        let time = "—";
        try {
          time = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: c.timeZone });
        } catch {
          time = "bad zone";
        }
        return (
          <div key={`${c.label}-${c.timeZone}`} className="flex min-w-0 items-center gap-1.5">
            <AnalogClock date={now} timeZone={c.timeZone} size={22} />
            <div className="min-w-0 leading-tight">
              <div className="font-semibold" style={{ fontSize: "var(--lb-small)" }}>{c.label}</div>
              <div className="truncate tabular-nums lb-muted" style={{ fontSize: "var(--lb-small)" }}>{time}</div>
            </div>
          </div>
        );
      })}
    </WidgetCard>
  );
}

// ---------------------------------------------------------------- Weather

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

export function WeatherWidget({ span }: WidgetProps) {
  const view = useProvider<WeatherData>("weather");
  if (!view.data) {
    return <ProviderState span={span} providerId="weather" glyph={<CloudSun size={20} />} name="Weather" status={view.status} error={view.error} tab="integrations" />;
  }
  const d = view.data;
  const Icon = weatherIcon(d.code, d.isDay);
  const hours = d.hourly.slice(1, span === "3x1" ? 7 : 4);
  return (
    <WidgetCard span={span} title={view.error ?? `${d.city} · H ${d.high ?? "—"}° L ${d.low ?? "—"}°`}>
      <div className="flex w-full min-w-0 items-center gap-2">
        <Icon size={20} className="shrink-0" style={{ color: d.isDay ? "var(--lb-amber)" : "var(--lb-muted)" }} />
        <div className="shrink-0 leading-tight">
          <div className="font-semibold tabular-nums" style={{ fontSize: "var(--lb-large)" }}>
            {d.current === null ? "—" : `${Math.round(d.current)}°`}
          </div>
          <div className="max-w-[70px] truncate lb-muted" style={{ fontSize: "var(--lb-small)" }}>{d.city}</div>
        </div>
        {span !== "1x1" && (
          <div className="ml-auto flex min-w-0 gap-2">
            {hours.map((h) => {
              const HIcon = weatherIcon(h.code);
              const hour = new Date(h.time).toLocaleTimeString("en-US", { hour: "numeric" }).replace(" ", "").toLowerCase();
              return (
                <div key={h.time} className="flex flex-col items-center leading-tight" style={{ fontSize: "var(--lb-small)" }}>
                  <span className="lb-faint">{hour}</span>
                  <HIcon size={11} className="my-[1px] lb-muted" />
                  <span className="tabular-nums">{h.temp === null ? "—" : `${Math.round(h.temp)}°`}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </WidgetCard>
  );
}

// ---------------------------------------------------------------- Quick folders

const FOLDERS: Array<{ id: string; label: string; icon: LucideIcon }> = [
  { id: "downloads", label: "Downloads", icon: Download },
  { id: "screenshots", label: "Screenshots", icon: Image },
  { id: "recent", label: "Recent", icon: History },
  { id: "recycle-bin", label: "Recycle Bin", icon: Trash2 },
];

export function QuickFoldersWidget({ span, preview }: WidgetProps) {
  const [error, setError] = useState<string | null>(null);
  const shown = span === "1x1" ? FOLDERS.slice(0, 2) : FOLDERS;
  return (
    <WidgetCard span={span} padded={false} className="gap-0.5 p-1" title={error ?? undefined}>
      {shown.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          className="lb-icon-btn flex h-full min-w-0 flex-1 flex-col gap-0.5 rounded-[10px]"
          title={label}
          onClick={(e) => {
            e.stopPropagation();
            if (!preview) ipc.openTarget(id).catch((err) => setError(errorMessage(err)));
          }}
        >
          <Icon size={15} className="lb-muted" />
          {span === "3x1" && <span className="max-w-full truncate px-0.5" style={{ fontSize: "calc(var(--lb-small) - 1px)" }}>{label}</span>}
        </button>
      ))}
    </WidgetCard>
  );
}

// ---------------------------------------------------------------- Clock

export function ClockWidget({ span }: WidgetProps) {
  const now = new Date(useNow(1000));
  return (
    <WidgetCard span={span} className="justify-center" title={now.toLocaleString()}>
      <div className="flex flex-col items-center leading-tight">
        <div className="font-semibold tabular-nums" style={{ fontSize: span === "1x1" ? "var(--lb-font)" : "var(--lb-large)" }}>
          {now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
        </div>
        <div className="lb-muted" style={{ fontSize: "var(--lb-small)" }}>
          {now.toLocaleDateString("en-US", span === "1x1" ? { month: "numeric", day: "numeric", year: "numeric" } : { weekday: "short", month: "short", day: "numeric" })}
        </div>
      </div>
    </WidgetCard>
  );
}
