// System volume in the dock bar (Windows Core Audio / WASAPI).
//   · speaker glyph (muted / low / medium / high) + percentage
//   · mouse wheel over the card: ±2 % per notch, ±4 % when spinning fast
//   · click: frosted popover above the dock with mute, master slider, output-device selector and a
//     per-app mixer (« Volume des applications », WASAPI sessions grouped by executable)
//   · inside the popover the wheel changes a volume ONLY while the cursor is on a slider; everywhere
//     else it scrolls the popover normally
// External changes (media keys, Liner, the Windows flyout) arrive as `audio:state` pushes from the
// endpoint-volume callback, so the card never polls.

import { Check, Speaker, Volume, Volume1, Volume2, VolumeX } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AppIcon } from "../components/AppIcon";
import { Popover, WidgetCard } from "../components/ui";
import { useI18n } from "../i18n";
import { errorMessage, ipc, on } from "../lib/ipc";
import { usePreview } from "../lib/hooks";
import type { AppAudio, AudioState, WidgetProps } from "../types/lumabar";

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
  // The worker only pushes on change, and the listener registers asynchronously: re-query once it
  // is in place, and keep asking (every 2 s) until the default endpoint is bound.
  void on("audio:state", setAudio).then(() => {
    const poll = () =>
      ipc
        .audioState()
        .then((s) => {
          if (!audio.available || s.available) setAudio(s);
          if (!s.available) window.setTimeout(poll, 2000);
        })
        .catch(() => window.setTimeout(poll, 2000));
    void poll();
  });
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

/**
 * Range input that also takes the mouse wheel (±2 % / ±4 %). The listener is native and
 * non-passive so it can preventDefault (the popover must not scroll while a slider is under the
 * cursor) and stop propagation (the dock must not scroll horizontally either).
 */
function VolumeSlider(props: {
  value: number;
  onChange: (v: number) => void;
  onStep: (delta: number) => void;
  label: string;
  testId: string;
  disabled?: boolean;
}) {
  const { value, onChange, onStep, label, testId, disabled } = props;
  const ref = useRef<HTMLInputElement | null>(null);
  const stepRef = useRef(onStep);
  stepRef.current = onStep;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let last = 0;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const now = performance.now();
      const step = wheelStep(e.deltaY, now - last);
      last = now;
      if (step) stepRef.current(step);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  return (
    <input
      ref={ref}
      data-testid={testId}
      type="range"
      min={0}
      max={100}
      step={1}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value))}
      className="lb-range min-w-0 flex-1"
      style={{ accentColor: "var(--lb-accent)" }}
      aria-label={label}
    />
  );
}

/** Per-app sessions, polled every second while the popover is open. */
function useAppSessions(open: boolean): [AppAudio[], (next: AppAudio[]) => void, string | null] {
  const [apps, setApps] = useState<AppAudio[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const load = () =>
      ipc
        .getAudioSessions()
        .then((list) => {
          if (!alive) return;
          setApps(list);
          setError(null);
        })
        .catch((e) => alive && setError(errorMessage(e)));
    void load();
    const timer = window.setInterval(load, 1000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [open]);
  return [apps, setApps, error];
}

function AppVolumeRow({ app, onChanged, onError }: { app: AppAudio; onChanged: (list: AppAudio[]) => void; onError: (e: string) => void }) {
  const { t } = useI18n();
  // Optimistic level; requests are serialized so a fast wheel never reorders them.
  const [pending, setPending] = useState<number | null>(null);
  const latest = useRef<number | null>(null);
  const busy = useRef(false);
  const level = pending ?? app.volume;

  const send = useCallback(() => {
    if (busy.current || latest.current === null) return;
    const v = latest.current;
    latest.current = null;
    busy.current = true;
    ipc
      .setAppVolume(app.pid, v)
      .then(onChanged)
      .catch((e) => onError(errorMessage(e)))
      .finally(() => {
        busy.current = false;
        if (latest.current !== null) send();
        else setPending(null);
      });
  }, [app.pid, onChanged, onError]);

  const setLevel = (v: number) => {
    const clamped = Math.min(100, Math.max(0, Math.round(v)));
    setPending(clamped);
    latest.current = clamped;
    send();
  };

  const name = app.isSystem ? t("volume.systemSounds") : app.name;
  const shownLevel = app.muted ? 0 : level;
  return (
    <div data-testid="app-volume-row" className="flex items-center gap-2 px-1 py-1">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center" style={{ opacity: app.active ? 1 : 0.65 }}>
        {app.isSystem ? <Volume2 size={18} className="lb-muted" /> : <AppIcon iconKey={app.iconKey} size={22} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate" style={{ fontSize: "var(--lb-small)" }} title={name}>{name}</span>
          <span className="shrink-0 tabular-nums lb-muted" style={{ fontSize: "var(--lb-small)" }}>{shownLevel}%</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            data-testid="app-volume-mute"
            className="lb-icon-btn h-6 w-6 shrink-0"
            onClick={() =>
              ipc
                .setAppMute(app.pid, !app.muted)
                .then(onChanged)
                .catch((e) => onError(errorMessage(e)))
            }
            title={app.muted ? t("volume.unmute") : t("volume.mute")}
            aria-label={app.muted ? t("volume.unmute") : t("volume.mute")}
          >
            <VolumeGlyph level={volumeLevel(level, app.muted)} size={14} />
          </button>
          <VolumeSlider
            testId="app-volume-slider"
            value={shownLevel}
            onChange={setLevel}
            onStep={(d) => setLevel((latest.current ?? level) + d)}
            label={name}
          />
        </div>
      </div>
    </div>
  );
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

  const stepMaster = (step: number) => {
    if (preview || !state.available || !step) return;
    queued.current += step;
    setPending((p) => Math.min(100, Math.max(0, (p ?? state.volume) + step)));
    flushWheel();
  };

  // Wheel over the dock card itself (stopPropagation keeps the dock from scrolling horizontally).
  const onCardWheel = (e: React.WheelEvent) => {
    e.stopPropagation();
    const now = performance.now();
    const step = wheelStep(e.deltaY, now - lastWheel.current);
    lastWheel.current = now;
    stepMaster(step);
  };

  const [apps, setApps, appsError] = useAppSessions(open && !preview);
  const onAppError = useCallback((e: string) => setError(e), []);

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
          onWheel={onCardWheel}
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
      <Popover anchor={ref} open={open && !preview} onClose={() => setOpen(false)} width={320}>
        <div data-testid="volume-popover" className="lb-thin-scroll -mr-1.5 flex max-h-[420px] flex-col gap-3 overflow-y-auto pr-1.5">
          <div className="flex items-center gap-2">
            <button
              data-testid="volume-mute"
              className="lb-icon-btn h-8 w-8 shrink-0"
              onClick={toggleMute}
              aria-label={state.muted ? t("volume.unmute") : t("volume.mute")}
              title={state.muted ? t("volume.unmute") : t("volume.mute")}
            >
              <VolumeGlyph level={level} size={17} />
            </button>
            <VolumeSlider
              testId="volume-slider"
              value={state.muted ? 0 : shown}
              onChange={setVolume}
              onStep={stepMaster}
              label={t("volume.title")}
            />
            <span className="w-10 shrink-0 text-right font-semibold tabular-nums">{state.muted ? "0%" : `${shown}%`}</span>
          </div>
          <div className="flex flex-col gap-1">
            <div className="lb-faint uppercase tracking-wide" style={{ fontSize: "calc(var(--lb-small) - 1px)" }}>
              {t("volume.output")}
            </div>
            <div data-testid="volume-devices" className="flex flex-col gap-0.5">
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
          <div data-testid="volume-apps" className="flex flex-col gap-0.5">
            <div className="lb-faint uppercase tracking-wide" style={{ fontSize: "calc(var(--lb-small) - 1px)" }}>
              {t("volume.apps")}
            </div>
            {apps.length === 0 && (
              <div className="px-1 py-1 lb-muted" style={{ fontSize: "var(--lb-small)" }}>
                {t("volume.noApps")}
              </div>
            )}
            {apps.map((app) => (
              <AppVolumeRow key={app.pid} app={app} onChanged={setApps} onError={onAppError} />
            ))}
          </div>
          {(error ?? appsError) && (
            <div className="truncate" style={{ fontSize: "var(--lb-small)", color: "var(--lb-red)" }} title={error ?? appsError ?? ""}>
              {error ?? appsError}
            </div>
          )}
        </div>
      </Popover>
    </>
  );
}
