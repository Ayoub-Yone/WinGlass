// Typed wrappers around every Tauri command and cross-window event.

import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AccountStatus,
  AppEntry,
  AppAudio,
  AppHit,
  BrightnessDisplay,
  PathHit,
  TrayAction,
  TrayIcon,
  TrayOutcome,
  AudioState,
  DockLayout,
  DockPosition,
  LayoutItem,
  MediaState,
  ProviderId,
  ProviderResult,
  GeoPlace,
  Mosque,
  ScreenTimeDay,
  Settings,
  TaskbarMode,
  TelemetrySample,
  Todo,
  ToastSpec,
  WindowPreview,
} from "../types/winglass";

export type HitRect = [number, number, number, number];

export const ipc = {
  getSettings: () => invoke<Settings>("get_settings"),
  updateSettings: (settings: Settings) => invoke<Settings>("update_settings", { settings }),
  getDockLayout: () => invoke<DockLayout>("get_dock_layout"),
  geocodeCity: (query: string, language: string) => invoke<GeoPlace[]>("geocode_city", { query, language }),
  searchMawaqitMosques: (query: string) => invoke<Mosque[]>("search_mawaqit_mosques", { query }),
  notifyNative: (title: string, body: string) => invoke<void>("notify_native", { title, body }),
  addLocalEvent: (title: string, start: string, end: string) => invoke<void>("add_local_event", { title, start, end }),
  deleteLocalEvent: (uid: string) => invoke<void>("delete_local_event", { uid }),
  setHitRegions: (rects: HitRect[], captureAll: boolean, hold: boolean) =>
    invoke<void>("set_hit_regions", { rects, captureAll, hold }),
  snapDockToCursor: () => invoke<DockPosition>("snap_dock_to_cursor"),
  setDockPosition: (position: DockPosition) => invoke<void>("set_dock_position", { position }),
  setTaskbarMode: (mode: TaskbarMode) => invoke<void>("set_taskbar_mode", { mode }),
  restoreTaskbarAndQuit: () => invoke<void>("restore_taskbar_and_quit"),
  openWindow: (label: "picker" | "settings", tab?: string) => invoke<void>("open_window", { label, tab: tab ?? null }),
  closeWindow: (label: "picker" | "settings") => invoke<void>("close_window", { label }),

  setGlassRect: (rect: HitRect) => invoke<void>("set_glass_rect", { rect }),
  getGlassStatus: () => invoke<string>("get_glass_status"),

  listApps: () => invoke<AppEntry[]>("list_apps"),
  getAppIcon: (key: string) => invoke<string | null>("get_app_icon", { key }),
  activateWindow: (hwnd: number) => invoke<void>("activate_window", { hwnd }),
  getAppWindowPreviews: (appId: string) => invoke<WindowPreview[]>("get_app_window_previews", { appId }),
  focusAppWindow: (hwnd: number) => invoke<void>("focus_app_window", { hwnd }),
  closeAppWindow: (hwnd: number) => invoke<void>("close_app_window", { hwnd }),
  launchApp: (path: string) => invoke<void>("launch_app", { path }),
  openTarget: (target: string) => invoke<void>("open_target", { target }),
  searchInstalledApps: (query: string) => invoke<AppHit[]>("search_installed_apps", { query }),

  audioState: () => invoke<AudioState>("audio_state"),
  audioSetVolume: (volume: number) => invoke<AudioState>("audio_set_volume", { volume: Math.round(Math.min(100, Math.max(0, volume))) }),
  audioStep: (delta: number) => invoke<AudioState>("audio_step", { delta }),
  /** null toggles. */
  audioSetMute: (muted: boolean | null) => invoke<AudioState>("audio_set_mute", { muted }),
  audioSetDevice: (id: string) => invoke<AudioState>("audio_set_device", { id }),
  getAudioSessions: () => invoke<AppAudio[]>("get_audio_sessions"),
  setAppVolume: (pid: number, volume: number) => invoke<AppAudio[]>("set_app_volume", { pid, volume: Math.round(Math.min(100, Math.max(0, volume))) }),
  setAppMute: (pid: number, muted: boolean) => invoke<AppAudio[]>("set_app_mute", { pid, muted }),

  completePath: (query: string) => invoke<PathHit[]>("complete_path", { query }),
  openPath: (path: string) => invoke<void>("open_path", { path }),
  getBrightness: () => invoke<BrightnessDisplay[]>("get_brightness"),
  setBrightness: (id: string, percent: number) => invoke<BrightnessDisplay>("set_brightness", { id, percent: Math.round(Math.min(100, Math.max(0, percent))) }),

  getTrayIcons: () => invoke<TrayIcon[]>("get_tray_icons"),
  trayIconAction: (id: string, action: TrayAction) => invoke<TrayOutcome>("tray_icon_action", { id, action }),

  mediaState: () => invoke<MediaState>("media_state"),
  mediaCommand: (action: "toggle" | "pause" | "play" | "next" | "previous") => invoke<void>("media_command", { action }),
  mediaPause: () => invoke<void>("media_pause"),
  mediaOpenSource: () => invoke<string>("media_open_source"),

  getScreenTime: (day?: string) => invoke<ScreenTimeDay>("get_screen_time", { day: day ?? null }),
  setRadio: (kind: "wifi" | "bluetooth", on: boolean) => invoke<void>("set_radio", { kind, on }),
  setHotspot: (on: boolean) => invoke<void>("set_hotspot", { on }),
  cycleKeyboardLayout: () => invoke<void>("cycle_keyboard_layout"),
  /** Restart / shutdown must be confirmed in the UI first. */
  powerAction: (action: "lock" | "sleep" | "restart" | "shutdown") => invoke<void>("power_action", { action }),

  getProviders: () => invoke<ProviderResult[]>("get_providers"),
  refreshProvider: (id: ProviderId) => invoke<ProviderResult>("refresh_provider", { id }),
  setSecret: (name: string, value: string) => invoke<string[]>("set_secret", { name, value }),
  getSecretNames: () => invoke<string[]>("get_secret_names"),
  accountStatus: (provider: AccountStatus["provider"]) => invoke<AccountStatus>("account_status", { provider }),
  accountLogin: (provider: AccountStatus["provider"]) => invoke<void>("account_login", { provider }),

  getLayout: () => invoke<LayoutItem[] | null>("get_layout"),
  saveLayout: (layout: LayoutItem[]) => invoke<void>("save_layout", { layout }),
  getNote: (id: string) => invoke<string>("get_note", { id }),
  saveNote: (id: string, content: string) => invoke<void>("save_note", { id, content }),
  listTodos: (list: string) => invoke<Todo[]>("list_todos", { list }),
  addTodo: (list: string, text: string) => invoke<Todo[]>("add_todo", { list, text }),
  setTodoDone: (list: string, id: number, done: boolean) => invoke<Todo[]>("set_todo_done", { list, id, done }),
  deleteTodo: (list: string, id: number) => invoke<Todo[]>("delete_todo", { list, id }),
  clearDoneTodos: (list: string) => invoke<Todo[]>("clear_done_todos", { list }),
};

/** Events crossing window boundaries. */
export interface AppEvents {
  "settings:changed": Settings;
  "dock:position-changed": DockPosition;
  "dock:layout": DockLayout;
  "dock:fullscreen": boolean;
  /** Dock auto-hidden (pointer left); only the dock window slides away for it. */
  "dock:autohide": boolean;
  "layout:changed": { source: string; layout: LayoutItem[] };
  "provider:update": ProviderResult;
  "telemetry:sample": TelemetrySample;
  "media:state": MediaState;
  "audio:state": AudioState;
  "account:connected": AccountStatus;
  "glass:frame": number;
  "apps:foreground": number;
  "toast:push": ToastSpec;
  "settings:navigate": string;
  "automation:test": { rule: "preMeetingPause" | "aiLimitWarning" | "revenueMilestone" | "renewalReminder" };
  "automation:test-result": { rule: string; ok: boolean; message: string };
  "automation:reset": null;
}

export function on<K extends keyof AppEvents>(event: K, handler: (payload: AppEvents[K]) => void): Promise<UnlistenFn> {
  return listen<AppEvents[K]>(event, (e) => handler(e.payload));
}

export function broadcast<K extends keyof AppEvents>(event: K, payload: AppEvents[K]): Promise<void> {
  return emit(event, payload);
}

/** Subscribe inside a React effect: returns a cleanup that handles the async unlisten. */
export function subscribe<K extends keyof AppEvents>(event: K, handler: (payload: AppEvents[K]) => void): () => void {
  let disposed = false;
  let unlisten: UnlistenFn | null = null;
  void on(event, handler).then((fn) => {
    if (disposed) fn();
    else unlisten = fn;
  });
  return () => {
    disposed = true;
    if (unlisten) unlisten();
  };
}

export function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return JSON.stringify(err);
}
