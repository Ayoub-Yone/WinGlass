// Typed wrappers around every Tauri command and cross-window event.

import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AppEntry,
  DockLayout,
  DockPosition,
  LayoutItem,
  MediaState,
  ProviderId,
  ProviderResult,
  ScreenTimeDay,
  Settings,
  TaskbarMode,
  TelemetrySample,
  Todo,
  ToastSpec,
} from "../types/lumabar";

export type HitRect = [number, number, number, number];

export const ipc = {
  getSettings: () => invoke<Settings>("get_settings"),
  updateSettings: (settings: Settings) => invoke<Settings>("update_settings", { settings }),
  getDockLayout: () => invoke<DockLayout>("get_dock_layout"),
  setHitRegions: (rects: HitRect[], captureAll: boolean) => invoke<void>("set_hit_regions", { rects, captureAll }),
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
  launchApp: (path: string) => invoke<void>("launch_app", { path }),
  openTarget: (target: string) => invoke<void>("open_target", { target }),
  windowsSearch: (query: string) => invoke<void>("windows_search", { query }),

  mediaState: () => invoke<MediaState>("media_state"),
  mediaCommand: (action: "toggle" | "pause" | "play" | "next" | "previous") => invoke<void>("media_command", { action }),
  mediaPause: () => invoke<void>("media_pause"),
  mediaOpenSource: () => invoke<string>("media_open_source"),

  getScreenTime: (day?: string) => invoke<ScreenTimeDay>("get_screen_time", { day: day ?? null }),
  setRadio: (kind: "wifi" | "bluetooth", on: boolean) => invoke<void>("set_radio", { kind, on }),
  setHotspot: (on: boolean) => invoke<void>("set_hotspot", { on }),
  cycleKeyboardLayout: () => invoke<void>("cycle_keyboard_layout"),

  getProviders: () => invoke<ProviderResult[]>("get_providers"),
  refreshProvider: (id: ProviderId) => invoke<ProviderResult>("refresh_provider", { id }),
  setSecret: (name: string, value: string) => invoke<string[]>("set_secret", { name, value }),
  getSecretNames: () => invoke<string[]>("get_secret_names"),

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
  "layout:changed": { source: string; layout: LayoutItem[] };
  "provider:update": ProviderResult;
  "telemetry:sample": TelemetrySample;
  "media:state": MediaState;
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
