// Typed in-window publish/subscribe bus for cross-widget communication.
// Cross-*window* traffic goes through Tauri events (lib/ipc.ts); the DataHub bridges those
// onto this bus so widgets and the AutomationEngine only ever deal with one API.

import type {
  AiUsageData,
  CalendarTick,
  DockPosition,
  MediaState,
  ProviderId,
  ProviderResult,
  RevenueData,
  TelemetrySample,
  ToastSpec,
} from "../types/winglass";

export interface BusEvents {
  "calendar:tick": CalendarTick;
  "media:state": MediaState;
  "ai:usage": { providerId: ProviderId; data: AiUsageData; status: ProviderResult["status"] };
  "revenue:update": { providerId: ProviderId; data: RevenueData; status: ProviderResult["status"] };
  "provider:update": ProviderResult;
  "telemetry:sample": TelemetrySample;
  "dock:position-changed": DockPosition;
  "toast:show": ToastSpec;
  "pomodoro:phase": { phase: "focus" | "break"; round: number };
}

type Handler<T> = (payload: T) => void;

class TypedEventBus {
  private handlers = new Map<keyof BusEvents, Set<Handler<never>>>();
  private last = new Map<keyof BusEvents, unknown>();

  on<K extends keyof BusEvents>(event: K, handler: Handler<BusEvents[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as Handler<never>);
    return () => {
      set.delete(handler as Handler<never>);
    };
  }

  /** Subscribe and immediately receive the most recent payload, if any. */
  onWithLatest<K extends keyof BusEvents>(event: K, handler: Handler<BusEvents[K]>): () => void {
    const off = this.on(event, handler);
    if (this.last.has(event)) handler(this.last.get(event) as BusEvents[K]);
    return off;
  }

  emit<K extends keyof BusEvents>(event: K, payload: BusEvents[K]): void {
    this.last.set(event, payload);
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of Array.from(set)) {
      try {
        (handler as Handler<BusEvents[K]>)(payload);
      } catch (err) {
        console.error(`[winglass] bus handler for ${String(event)} failed`, err);
      }
    }
  }

  latest<K extends keyof BusEvents>(event: K): BusEvents[K] | undefined {
    return this.last.get(event) as BusEvents[K] | undefined;
  }
}

export const bus = new TypedEventBus();
