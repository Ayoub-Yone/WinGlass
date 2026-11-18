import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { getHub, setHub, useHub } from "../engine/DataHub";
import { SAMPLE_MEDIA, SAMPLE_PROVIDER_DATA, sampleTelemetry } from "../widgets/samples";
import { ipc } from "./ipc";
import type { MediaState, ProviderId, ProviderResult, Settings, TelemetrySample } from "../types/winglass";

/** True inside the widget picker: hooks fall back to sample data so previews are never empty. */
export const PreviewContext = createContext(false);

export function usePreview(): boolean {
  return useContext(PreviewContext);
}

/**
 * Wall clock that re-renders every `intervalMs`. While the dock is hidden behind a fullscreen
 * app nobody can see the result, so the timer stops (no 1 Hz re-renders) unless `essential` —
 * e.g. a running Pomodoro that must still notice its deadline.
 */
export function useNow(intervalMs = 1000, essential = false): number {
  const [now, setNow] = useState(() => Date.now());
  const hidden = useHub((s) => s.fullscreen);
  const paused = hidden && !essential;
  useEffect(() => {
    if (paused) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs, paused]);
  return now;
}

export function useSettings(): Settings | null {
  return useHub((s) => s.settings);
}

export async function patchSettings(mutate: (s: Settings) => Settings): Promise<Settings | null> {
  const current = getHub().settings ?? (await ipc.getSettings());
  const next = mutate(structuredClone(current));
  setHub({ settings: next });
  return ipc.updateSettings(next);
}

export interface ProviderView<T> {
  status: ProviderResult["status"] | "loading";
  data: T | null;
  error: string | null;
  fetchedAt: number | null;
  isSample: boolean;
}

export function useProvider<T>(id: ProviderId): ProviderView<T> {
  const preview = usePreview();
  const result = useHub((s) => s.providers[id]);
  return useMemo(() => {
    if (result?.data) {
      return { status: result.status, data: result.data as T, error: result.error, fetchedAt: result.fetchedAt, isSample: false };
    }
    if (preview && SAMPLE_PROVIDER_DATA[id]) {
      return { status: "simulated", data: SAMPLE_PROVIDER_DATA[id] as T, error: null, fetchedAt: null, isSample: true };
    }
    if (!result) return { status: "loading", data: null, error: null, fetchedAt: null, isSample: false };
    return { status: result.status, data: null, error: result.error, fetchedAt: result.fetchedAt, isSample: false };
  }, [result, preview, id]);
}

const SAMPLE_TELEMETRY = sampleTelemetry();

export function useTelemetry(): TelemetrySample[] {
  const preview = usePreview();
  const live = useHub((s) => s.telemetry);
  return preview && live.length < 2 ? SAMPLE_TELEMETRY : live;
}

export function useMedia(): MediaState {
  const preview = usePreview();
  const media = useHub((s) => s.media);
  return preview && !media.available ? SAMPLE_MEDIA : media;
}

/** Persisted per-widget UI state (pomodoro progress, stopwatch, etc.). */
export function useLocalState<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = (v: T | ((p: T) => T)) => {
    setValue((prev) => {
      const next = typeof v === "function" ? (v as (p: T) => T)(prev) : v;
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* storage unavailable: state stays in memory */
      }
      return next;
    });
  };
  return [value, set];
}
