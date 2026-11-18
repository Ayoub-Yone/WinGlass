// Window-local reactive store fed by backend events, bridged onto the EventBus.

import { useSyncExternalStore } from "react";
import { bus } from "./EventBus";
import { ipc, subscribe } from "../lib/ipc";
import { startTimeFormatted } from "../lib/format";
import { normalizeLang, setActiveLang } from "../i18n";
import type {
  AiUsageData,
  CalendarData,
  DockLayout,
  DockPosition,
  MediaState,
  ProviderId,
  ProviderResult,
  RevenueData,
  Settings,
  TelemetrySample,
  UpcomingEvent,
} from "../types/winglass";

export const AI_PROVIDERS: ProviderId[] = ["claude", "chatgpt", "gemini", "grok", "deepseek", "glm"];
export const REVENUE_PROVIDERS: ProviderId[] = ["stripe", "polar", "dodo", "datafast"];

export const EMPTY_MEDIA: MediaState = {
  available: false,
  title: "",
  artist: "",
  album: "",
  status: "",
  sourceApp: "",
  isLiner: false,
  thumbnail: null,
  canNext: false,
  canPrevious: false,
};

export interface HubState {
  settings: Settings | null;
  providers: Partial<Record<ProviderId, ProviderResult>>;
  telemetry: TelemetrySample[];
  media: MediaState;
  dockLayout: DockLayout | null;
  position: DockPosition;
  fullscreen: boolean;
}

const TELEMETRY_HISTORY = 60;

let state: HubState = {
  settings: null,
  providers: {},
  telemetry: [],
  media: EMPTY_MEDIA,
  dockLayout: null,
  position: "bottom",
  fullscreen: false,
};

const listeners = new Set<() => void>();

export function getHub(): HubState {
  return state;
}

export function setHub(patch: Partial<HubState>): void {
  // Formatters and non-React code follow the language as soon as settings arrive.
  if (patch.settings) setActiveLang(normalizeLang(patch.settings.language));
  state = { ...state, ...patch };
  for (const l of Array.from(listeners)) l();
}

function subscribeHub(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useHub<T>(selector: (s: HubState) => T): T {
  return useSyncExternalStore(subscribeHub, () => selector(state));
}

function acceptProvider(result: ProviderResult): void {
  setHub({ providers: { ...state.providers, [result.id]: result } });
  bus.emit("provider:update", result);
  if (result.data && AI_PROVIDERS.includes(result.id)) {
    bus.emit("ai:usage", { providerId: result.id, data: result.data as AiUsageData, status: result.status });
  }
  if (result.data && REVENUE_PROVIDERS.includes(result.id)) {
    bus.emit("revenue:update", { providerId: result.id, data: result.data as RevenueData, status: result.status });
  }
  if (result.id === "calendar") emitCalendarTick();
}

export function upcomingEvents(now = Date.now()): UpcomingEvent[] {
  const data = state.providers.calendar?.data as CalendarData | null | undefined;
  if (!data?.events) return [];
  const nowDate = new Date(now);
  return data.events
    .map((event) => {
      const start = new Date(event.start);
      return {
        event,
        minutesUntil: (start.getTime() - now) / 60000,
        startTimeFormatted: startTimeFormatted(start, event.allDay, nowDate),
        end: new Date(event.end).getTime(),
      };
    })
    .filter((e) => e.end > now)
    .sort((a, b) => a.minutesUntil - b.minutesUntil)
    .map(({ event, minutesUntil, startTimeFormatted: s }) => ({ event, minutesUntil, startTimeFormatted: s }));
}

function emitCalendarTick(): void {
  const now = Date.now();
  bus.emit("calendar:tick", { now, upcoming: upcomingEvents(now) });
}

/** Wire this window to the backend. `calendarTicks` drives automations (dock window only). */
export function startHub(options: { calendarTicks?: boolean } = {}): () => void {
  const cleanups: Array<() => void> = [];

  void ipc.getSettings().then((settings) => setHub({ settings, position: settings.position }));
  void ipc.getProviders().then((list) => list.forEach(acceptProvider));
  void ipc.mediaState().then((media) => {
    setHub({ media });
    bus.emit("media:state", media);
  });

  cleanups.push(subscribe("settings:changed", (settings) => setHub({ settings, position: settings.position })));
  cleanups.push(subscribe("provider:update", acceptProvider));
  cleanups.push(
    subscribe("telemetry:sample", (sample) => {
      // Hidden behind a fullscreen app: keep the bus fed but skip the 1 Hz widget re-render.
      if (state.fullscreen) {
        state = { ...state, telemetry: [...state.telemetry, sample].slice(-TELEMETRY_HISTORY) };
        bus.emit("telemetry:sample", sample);
        return;
      }
      const telemetry = [...state.telemetry, sample].slice(-TELEMETRY_HISTORY);
      setHub({ telemetry });
      bus.emit("telemetry:sample", sample);
    }),
  );
  cleanups.push(
    subscribe("media:state", (media) => {
      setHub({ media });
      bus.emit("media:state", media);
    }),
  );
  cleanups.push(
    subscribe("dock:position-changed", (position) => {
      setHub({ position });
      bus.emit("dock:position-changed", position);
    }),
  );
  cleanups.push(subscribe("dock:layout", (dockLayout) => setHub({ dockLayout, position: dockLayout.position })));
  // `fullscreen` in the hub means "dock slid away": a fullscreen app, or auto-hide (dock window only).
  const isDock = new URLSearchParams(window.location.search).get("window") === "dock";
  let fullscreenApp = false;
  let autoHidden = false;
  const applyHidden = () => {
    const fullscreen = fullscreenApp || (isDock && autoHidden);
    if (fullscreen === state.fullscreen) return;
    // Pauses CSS animations (index.css) along with the timers gated on `fullscreen`.
    document.documentElement.dataset.hidden = String(fullscreen);
    setHub({ fullscreen });
  };
  cleanups.push(
    subscribe("dock:fullscreen", (v) => {
      fullscreenApp = v;
      applyHidden();
    }),
  );
  cleanups.push(
    subscribe("dock:autohide", (v) => {
      autoHidden = v;
      applyHidden();
    }),
  );

  if (options.calendarTicks) {
    const timer = window.setInterval(emitCalendarTick, 5000);
    cleanups.push(() => window.clearInterval(timer));
  }

  return () => cleanups.forEach((c) => c());
}
