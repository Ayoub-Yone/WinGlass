// Shared TypeScript contracts between the Rust backend and every winglass window.

import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";

// ---------------------------------------------------------------- themes & sizes

export type ThemeId = "liquid-glass" | "matte-glass" | "midnight" | "white" | "black";
export type SizePreset = "compact" | "medium" | "large";
export type DockPosition = "bottom" | "top";
export type TaskbarMode = "native" | "auto_hide" | "completely_hidden";
export type Language = "fr" | "en";

export interface ThemeTokens {
  id: ThemeId;
  scheme: "dark" | "light";
  surface: string;
  border: string;
  card: string;
  /** Hairline drawn inside every widget card. */
  cardBorder: string;
  cardHover: string;
  text: string;
  muted: string;
  faint: string;
  track: string;
  backdrop: string;
  menu: string;
  shadow: string;
  usesGlassShader: boolean;
}

export interface SizeTokens {
  id: SizePreset;
  height: number;
  padding: number;
  gap: number;
  unit: number;
  radius: number;
  cardRadius: number;
  icon: number;
  font: number;
  small: number;
  large: number;
}

// ---------------------------------------------------------------- settings (mirrors storage/settings.rs)

export interface WorldClock {
  label: string;
  timeZone: string;
}

export interface AutomationSettings {
  preMeetingPause: { enabled: boolean; minutes: number };
  aiLimitWarning: { enabled: boolean; thresholdPercent: number; criticalPercent: number; horizonHours: number };
  revenueMilestone: { enabled: boolean; milestones: number[] };
  renewalReminder: { enabled: boolean; hours: number; keywords: string[] };
}

export interface ProviderSettings {
  leetcodeUsername: string;
  githubUsername: string;
  xUsername: string;
  youtubeChannelId: string;
  instagramUserId: string;
  gmailAddress: string;
  apiCounterUrl: string;
  apiCounterJsonPath: string;
  apiCounterLabel: string;
  weatherLatitude: number;
  weatherLongitude: number;
  weatherCity: string;
  weatherFahrenheit: boolean;
  revenueGoal: number;
  deepseekBudget: number;
  grokBudget: number;
  useLocalCliCredentials: boolean;
  pollMinutes: number;
}

export interface Settings {
  theme: ThemeId;
  size: SizePreset;
  position: DockPosition;
  monitor: string | null;
  taskbarMode: TaskbarMode;
  hideOnFullscreen: boolean;
  /** « Masquer automatiquement le dock »: slides away when the cursor leaves, back at the screen edge. */
  autoHideDock: boolean;
  simulation: boolean;
  doNotDisturb: boolean;
  launchAtLogin: boolean;
  accent: string;
  language: Language;
  /** « Clair ↔ Givré »: 0 ultra-clear optical glass .. 1 deep matte frost (liquid-glass themes). */
  glassFrostLevel: number;
  /** « Mode Clear »: no bar background, each widget floats in its own capsule. */
  clearMode: boolean;
  /** « Ambiance Musique »: soft glow tinted by the playing track's cover art. */
  musicAmbiance: boolean;
  /** Dock corner radius in px; cards stay concentric (radius − padding). */
  dockRadius: number;
  /** Liquid-glass refraction multiplier, 0.5 .. 2 (1 = calibrated). */
  glassRefraction: number;
  pomodoroFocusMinutes: number;
  pomodoroBreakMinutes: number;
  worldClocks: WorldClock[];
  automations: AutomationSettings;
  providers: ProviderSettings;
  prayer: PrayerSettings;
}

export type PrayerKey = "fajr" | "sunrise" | "dhuhr" | "asr" | "maghrib" | "isha";

export interface PrayerSettings {
  source: "mawaqit" | "city";
  mosqueSlug: string;
  mosqueName: string;
  city: string;
  latitude: number;
  longitude: number;
  /** Aladhan method: 3 MWL, 12 UOIF, 2 ISNA, 4 Umm al-Qura. */
  method: number;
  /** 0 (off), 5, 10 or 15. */
  reminderMinutes: number;
  alerts: PrayerKey[];
  chime: boolean;
  nativeToasts: boolean;
}

export interface PrayerDay {
  date: string;
  /** "HH:MM" in PrayerKey order. */
  times: string[];
  /** Mawaqit iqama for the 5 prayers: "+10" or "HH:MM". */
  iqama: string[] | null;
}

export interface PrayerData {
  source: "mawaqit" | "city";
  name: string;
  city: string;
  method: number;
  days: PrayerDay[];
  offline: boolean;
}

export interface GeoPlace {
  name: string;
  country: string;
  admin: string;
  latitude: number;
  longitude: number;
}

export interface Mosque {
  slug: string;
  name: string;
  location: string;
}

export interface DockLayout {
  position: DockPosition;
  dockHeight: number;
  popoverSpace: number;
  edgeMargin: number;
  scaleFactor: number;
  monitorName: string | null;
}

// ---------------------------------------------------------------- widgets

export type Span = "1x1" | "2x1" | "3x1" | "auto";

export type WidgetCategory =
  | "Apps"
  | "AI"
  | "Media"
  | "Productivity"
  | "Revenue"
  | "Social"
  | "Developer"
  | "System"
  | "Utilities";

export interface LayoutItem {
  instanceId: string;
  widgetId: string;
  span: Span;
}

export interface WidgetProps {
  instance: LayoutItem;
  span: Span;
  preview?: boolean;
}

export interface WidgetDefinition {
  id: string;
  name: string;
  description: string;
  category: WidgetCategory;
  sizes: Span[];
  defaultSize: Span;
  icon: LucideIcon;
  keywords: string[];
  providerId?: ProviderId;
  component: ComponentType<WidgetProps>;
}

// ---------------------------------------------------------------- providers

export type ProviderId =
  | "claude"
  | "chatgpt"
  | "gemini"
  | "grok"
  | "deepseek"
  | "glm"
  | "stripe"
  | "polar"
  | "dodo"
  | "datafast"
  | "gmail"
  | "x"
  | "youtube"
  | "instagram"
  | "github"
  | "leetcode"
  | "api_counter"
  | "weather"
  | "calendar"
  | "prayer";

export type ProviderStatus = "unconfigured" | "ok" | "error" | "simulated";

export interface ProviderResult<T = unknown> {
  id: ProviderId;
  status: ProviderStatus;
  data: T | null;
  error: string | null;
  fetchedAt: number;
}

export interface UsageTier {
  key: string;
  label: string;
  percent: number;
  resetsAt: string | null;
  windowSeconds: number | null;
}

export interface AiUsageData {
  provider: string;
  plan: string | null;
  tiers: UsageTier[];
  balance?: number;
  budget?: number;
  currency?: string;
}

export interface RevenueData {
  provider: string;
  currency: string;
  total30d: number;
  previous30d: number;
  net30d: number;
  deltaPercent: number;
  daily: number[];
  goal: number;
}

export interface GmailData {
  unread: number;
  today: number;
  account: string;
}

export interface SocialData {
  followers: number;
  deltaToday: number;
  handle: string;
  metric: "followers" | "subscribers";
}

export interface GithubData {
  login: string;
  weeks: number[][];
  total: number;
  notifications: number;
  notificationsMore: boolean;
}

export interface LeetcodeData {
  username: string;
  solved: number;
  easy: number;
  medium: number;
  hard: number;
  streak: number;
  maxStreak: number;
}

export interface ApiCounterData {
  value: number;
  deltaToday: number;
  label: string;
}

export interface WeatherHour {
  time: string;
  temp: number | null;
  code: number | null;
  precip: number | null;
}

export interface WeatherData {
  city: string;
  unit: "F" | "C";
  current: number | null;
  code: number | null;
  isDay: boolean;
  high: number | null;
  low: number | null;
  hourly: WeatherHour[];
  /** 7 days, today first. */
  daily?: WeatherDay[];
}

export interface WeatherDay {
  date: string;
  code: number | null;
  high: number | null;
  low: number | null;
}

export interface CalendarEvent {
  uid: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string | null;
  url: string | null;
  calendar: string | null;
  /** Part of a repeating series (RRULE). */
  recurring?: boolean;
}

export interface CalendarData {
  events: CalendarEvent[];
}

// ---------------------------------------------------------------- native data

export interface AppWindow {
  hwnd: number;
  title: string;
  isMinimized: boolean;
  isActive: boolean;
}

export interface AppEntry {
  id: string;
  name: string;
  exePath: string | null;
  iconKey: string;
  pinnedPath: string | null;
  windows: AppWindow[];
  isActive: boolean;
}

/** Taskbar-style hover preview of one app window. */
export interface WindowPreview {
  hwnd: number;
  title: string;
  isMinimized: boolean;
  isActive: boolean;
  /** PNG data URL; null when minimized or nothing could be rendered. */
  thumbnail: string | null;
}

export interface AudioDevice {
  id: string;
  name: string;
  isDefault: boolean;
}

/** Default playback endpoint (WASAPI), pushed as "audio:state" on every change. */
export interface AudioState {
  available: boolean;
  /** 0–100 */
  volume: number;
  muted: boolean;
  deviceId: string;
  deviceName: string;
  devices: AudioDevice[];
}

/** One app in the per-app volume mixer (all of its WASAPI sessions). */
export interface AppAudio {
  pid: number;
  pids: number[];
  exe: string;
  /** Empty for the system-sounds session. */
  name: string;
  iconKey: string;
  isSystem: boolean;
  active: boolean;
  volume: number;
  muted: boolean;
}

/** A notification-area (tray) app, forwarded to its real tray icon on click. */
export interface TrayIcon {
  id: string;
  name: string;
  exe: string;
  /** PNG data URL. */
  iconPng: string | null;
  isHiddenOverflow: boolean;
  /** winglass's own entry: the dock handles Open / Settings / Quit itself. */
  isSelf: boolean;
}

export type TrayAction = "open" | "settings" | "quit";

export type TrayOutcome = "focused" | "invoked" | "launched" | "shown" | "closed" | "terminated" | "stillOpen";

/** A local path typed in the launcher, or one of its completions. */
export interface PathHit {
  path: string;
  name: string;
  isDir: boolean;
  /** The typed path itself (not a completion). */
  exact: boolean;
}

/** A display whose brightness can be changed (WMI panel or DDC/CI monitor). */
export interface BrightnessDisplay {
  id: string;
  name: string;
  internal: boolean;
  percent: number;
}

/** Integrated launcher result (Start Menu / Desktop / packaged Store apps / App Paths). */
export interface AppHit {
  name: string;
  /** .lnk / .url / .exe / `shell:AppsFolder\<AUMID>` — also the icon key. */
  path: string;
  kind: "shortcut" | "packaged" | "app";
  folder: string | null;
}

export interface AccountStatus {
  provider: "claude" | "chatgpt" | "gemini";
  connected: boolean;
  source: "cli" | "manual" | "none";
  cliInstalled: boolean;
  detail: string | null;
}

export interface MediaState {
  available: boolean;
  title: string;
  artist: string;
  album: string;
  status: "Playing" | "Paused" | "Stopped" | "Closed" | "Opened" | "Changing" | "Unknown" | "";
  sourceApp: string;
  isLiner: boolean;
  thumbnail: string | null;
  canNext: boolean;
  canPrevious: boolean;
}

export interface RadioStatus {
  wifi: boolean | null;
  bluetooth: boolean | null;
  hotspot: boolean | null;
}

export interface TelemetrySample {
  ts: number;
  cpuPercent: number;
  ramUsedGb: number;
  ramTotalGb: number;
  ramPercent: number;
  cpuTempC: number | null;
  netUpBps: number;
  netDownBps: number;
  hasBattery: boolean;
  batteryPercent: number | null;
  charging: boolean;
  diskFreeGb: number;
  diskTotalGb: number;
  keyboardLayout: string;
  radios: RadioStatus;
  /** Interface carrying the default route. */
  networkType: "ethernet" | "wifi" | "disconnected";
  /** Friendly adapter name ("Ethernet", "Wi-Fi 2"…) when connected. */
  networkAdapter: string | null;
}

export interface ScreenTimeApp {
  app: string;
  domain: string | null;
  seconds: number;
}

export interface ScreenTimeDay {
  day: string;
  totalSeconds: number;
  hourly: number[];
  topApps: ScreenTimeApp[];
}

export interface Todo {
  id: number;
  listId: string;
  text: string;
  done: boolean;
  position: number;
  createdAt: number;
}

// ---------------------------------------------------------------- toasts & events

export type ToastAction =
  | { kind: "open"; target: string }
  | { kind: "window"; label: "settings" | "picker" }
  | { kind: "dismiss" };

export interface ToastSpec {
  id: string;
  title: string;
  subtitle?: string;
  kind?: "calendar" | "ai" | "revenue" | "renewal" | "system" | "prayer";
  actionLabel?: string;
  action?: ToastAction;
  /** Second pill (e.g. « Résilier » next to « Garder »). */
  secondaryLabel?: string;
  secondaryAction?: ToastAction;
  durationMs?: number;
}

export interface UpcomingEvent {
  event: CalendarEvent;
  minutesUntil: number;
  startTimeFormatted: string;
}

export interface CalendarTick {
  now: number;
  upcoming: UpcomingEvent[];
}
