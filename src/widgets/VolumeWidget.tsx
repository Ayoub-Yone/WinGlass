// System volume in the dock bar (Windows Core Audio / WASAPI).
//   · speaker glyph (muted / low / medium / high) + percentage
//   · mouse wheel over the card: ±2 % per notch, ±4 % when spinning fast
//   · click: frosted popover above the dock with mute, slider and output-device selector
// External changes (media keys, Liner, the Windows flyout) arrive as `audio:state` pushes from the
// endpoint-volume callback, so the card never polls.

import { Check, Speaker, Volume, Volume1, Volume2, VolumeX } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Popover, WidgetCard } from "../components/ui";
import { useI18n } from "../i18n";
import { errorMessage, ipc, subscribe } from "../lib/ipc";
import { usePreview } from "../lib/hooks";
import type { AudioState, WidgetProps } from "../types/lumabar";

const EMPTY: AudioState = { available: false, volume: 0, muted: false, deviceId: "", deviceName: "", devices: [] };
const SAMPLE: AudioState = {
  available: true,
  volume: 64,
  muted: false,
  deviceId: "sample",
  deviceName: "Speakers",
  devices: [{ id: "sample", name: "Speakers", isDefault: true }],
};

// ---------------------------------------------------------------- window-local audio store

let audio: AudioState = EMPTY;
let started = false;
const listeners = new Set<() => void>();

function setAudio(next: AudioState): void {
  audio = next;
  for (const l of Array.from(listeners)) l();
}

function ensureStarted(): void {
  if (started) return;
  started = true;
  subscribe("audio:state", setAudio);
  void ipc.audioState().then(setAudio).catch(() => undefined);
}

function useAudio(): AudioState {
  ensureStarted();
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => audio,
  );
}

// ---------------------------------------------------------------- helpers

export type VolumeLevel = "muted" | "low" | "medium" | "high";

export function volumeLevel(volume: number, muted: boolean): VolumeLevel {
  if (muted || volume <= 0) return "muted";
  if (volume < 34) return "low";
  if (volume < 67) return "medium";
  return "high";
}

function VolumeGlyph({ level, size }: { level: VolumeLevel; size: number }) {
  const Icon = level === "muted" ? VolumeX : level === "low" ? Volume : level === "medium" ? Volume1 : Volume2;
  return <Icon size={size} className="shrink-0" style={{ color: level === "muted" ? "var(--lb-red)" : "var(--lb-text)" }} />;
}

/** Wheel notches -> step: 2 % normally, 4 % when notches arrive in quick succession. */
export function wheelStep(deltaY: number, msSinceLast: number): number {
  if (deltaY === 0) return 0;
  const magnitude = msSinceLast < 60 || Math.abs(deltaY) >= 200 ? 4 : 2;
  return deltaY < 0 ? magnitude : -magnitude;
}

// ---------------------------------------------------------------- widget

export function VolumeWidget({ span, preview: previewProp }: WidgetProps) {
  const { t } = useI18n();
  const preview = usePreview() || !!previewProp;
  const live = useAudio();
  const state = preview && !live.available ? SAMPLE : live;
  const ref = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Optimistic value while a wheel / slider request is in flight.
  const [pending, setPending] = useState<number | null>(null);
  const lastWheel = useRef(0);
  const queued = useRef(0);
  const inFlight = useRef(false);

  const shown = pending ?? state.volume;
  const level = volumeLevel(shown, state.muted);

  const flushWheel = useCallback(() => {
    if (inFlight.current || queued.current === 0) return;
    const delta = queued.current;
    queued.current = 0;
    inFlight.current = true;
    ipc
      .audioStep(delta)
      .then((s) => {
        setAudio(s);
        setError(null);
      })
      .catch((e) => setError(errorMessage(e)))
      .finally(() => {
        inFlight.current = false;
        if (queued.current !== 0) flushWheel();
        else setPending(null);
      });
  }, []);

  // stopPropagation keeps the dock from scrolling horizontally under the wheel.
  const onWheel = (e: React.WheelEvent) => {
    e.stopPropagation();
    if (preview || !state.available) return;
    const now = performance.now();
    const step = wheelStep(e.deltaY, now - lastWheel.current);
    lastWheel.current = now;
    if (!step) return;
    queued.current += step;
    setPending((p) => Math.min(100, Math.max(0, (p ?? state.volume) + step)));
    flushWheel();
  };

  const setVolume = (v: number) => {
    setPending(v);
    ipc
      .audioSetVolume(v)
      .then((s) => {
        setAudio(s);
        setError(null);
      })
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setPending(null));
  };

  const toggleMute = () => {
    ipc
      .audioSetMute(null)
      .then(setAudio)
      .catch((e) => setError(errorMessage(e)));
  };

  const pickDevice = (id: string) => {
    if (id === state.deviceId) return;
    ipc
      .audioSetDevice(id)
      .then((s) => {
        setAudio(s);
        setError(null);
      })
      .catch((e) => setError(errorMessage(e)));
  };

  useEffect(() => {
    if (!state.available) setOpen(false);
  }, [state.available]);

  const label = state.available ? (state.muted ? t("volume.muted") : `${shown}%`) : "—";
  const wide = span !== "1x1";

  return (
    <>
      <WidgetCard
          span={span}
          cardRef={ref}
          title={error ?? (state.available ? `${state.deviceName} · ${label}` : t("volume.unavailable"))}
          onClick={() => !preview && state.available && setOpen((o) => !o)}
          onWheel={onWheel}
          className="cursor-pointer gap-2"
        >
          <div data-testid="volume-widget" className={`flex w-full min-w-0 items-center gap-2 ${wide ? "" : "justify-center"}`}>
            <VolumeGlyph level={state.available ? level : "muted"} size={wide ? 18 : 17} />
            {wide ? (
              <div className="min-w-0 flex-1 leading-tight">
                <div className="flex items-baseline justify-between gap-1">
                  <span className="truncate font-semibold">{t("volume.title")}</span>
                  <span className="shrink-0 font-semibold tabular-nums">{label}</span>
                </div>
                <div className="mt-1 h-1 w-full overflow-hidden rounded-full" style={{ background: "var(--lb-track)" }}>
                  <div
                    className="h-full rounded-full transition-[width] duration-150"
                    style={{ width: `${state.muted ? 0 : shown}%`, background: "var(--lb-accent)" }}
                  />
                </div>
              </div>
            ) : (
              <span className="truncate font-semibold tabular-nums" style={{ fontSize: "var(--lb-small)" }}>
                {state.available ? (state.muted ? "0%" : `${shown}%`) : "—"}
              </span>
            )}
          </div>
        </WidgetCard>
      <Popover anchor={ref} open={open && !preview} onClose={() => setOpen(false)} width={300}>
        <div data-testid="volume-popover" className="flex flex-col gap-3">
          <div className="flex items-center gap-2" onWheel={onWheel}>
            <button
              data-testid="volume-mute"
              className="lb-icon-btn h-8 w-8 shrink-0"
              onClick={toggleMute}
              aria-label={state.muted ? t("volume.unmute") : t("volume.mute")}
              title={state.muted ? t("volume.unmute") : t("volume.mute")}
            >
              <VolumeGlyph level={level} size={17} />
            </button>
            <input
              data-testid="volume-slider"
              type="range"
              min={0}
              max={100}
              step={1}
              value={state.muted ? 0 : shown}
              onChange={(e) => setVolume(Number(e.target.value))}
              className="lb-range min-w-0 flex-1"
              style={{ accentColor: "var(--lb-accent)" }}
              aria-label={t("volume.title")}
            />
            <span className="w-10 shrink-0 text-right font-semibold tabular-nums">{state.muted ? "0%" : `${shown}%`}</span>
          </div>
          <div className="flex flex-col gap-1">
            <div className="lb-faint uppercase tracking-wide" style={{ fontSize: "calc(var(--lb-small) - 1px)" }}>
              {t("volume.output")}
            </div>
            <div className="lb-thin-scroll flex max-h-[180px] flex-col gap-0.5 overflow-y-auto">
              {state.devices.map((d) => (
                <button
                  key={d.id}
                  data-testid="volume-device"
                  className="lb-row flex w-full items-center gap-2 rounded-lg border-none bg-transparent px-2 py-1.5 text-left"
                  data-active={d.isDefault}
                  style={{ color: "var(--lb-text)" }}
                  onClick={() => pickDevice(d.id)}
                >
                  <Speaker size={14} className="shrink-0 lb-muted" />
                  <span className="min-w-0 flex-1 truncate">{d.name || t("volume.unknownDevice")}</span>
                  {d.isDefault && <Check size={14} className="shrink-0" style={{ color: "var(--lb-accent)" }} />}
                </button>
              ))}
            </div>
          </div>
          {error && (
            <div className="truncate" style={{ fontSize: "var(--lb-small)", color: "var(--lb-red)" }} title={error}>
              {error}
            </div>
          )}
        </div>
      </Popover>
    </>
  );
}
