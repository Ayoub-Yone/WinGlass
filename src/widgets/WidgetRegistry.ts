// Single source of truth for every widget: metadata, allowed spans, category and component.

import {
  Activity,
  AppWindow,
  BatteryFull,
  Bot,
  CalendarDays,
  Clock,
  Code,
  Cpu,
  DollarSign,
  FolderOpen,
  Globe,
  HardDrive,
  Hourglass,
  Keyboard,
  ListTodo,
  Mail,
  MemoryStick,
  Music,
  Network,
  Search,
  Sparkles,
  StickyNote,
  Thermometer,
  Timer,
  ToggleRight,
  Users,
  Watch,
  CloudSun,
} from "lucide-react";
import type { I18n } from "../i18n";
import type { LayoutItem, Span, WidgetCategory, WidgetDefinition } from "../types/lumabar";
import { ChatGptWidget, ClaudeWidget, DeepSeekWidget, GeminiWidget, GlmWidget, GrokWidget } from "./AiUsageWidgets";
import { CalendarWidget } from "./CalendarWidget";
import { ApiCounterWidget, GithubWidget, LeetcodeWidget } from "./DevWidgets";
import { MediaController } from "./MediaController";
import { PinnedRunningApps } from "./PinnedRunningApps";
import { DataFastWidget, DodoWidget, PolarWidget, StripeWidget } from "./RevenueWidgets";
import { ScreenTimeWidget } from "./ScreenTimeWidget";
import { GmailWidget, InstagramWidget, XWidget, YouTubeWidget } from "./SocialMailWidgets";
import {
  BatteryWidget,
  CpuWidget,
  KeyboardLayoutWidget,
  NetworkWidget,
  QuickTogglesWidget,
  RamWidget,
  StorageWidget,
  TempWidget,
} from "./SystemWidgets";
import {
  ClockWidget,
  PomodoroWidget,
  QuickFoldersWidget,
  QuickNotesWidget,
  SearchWidget,
  StopwatchWidget,
  TodosWidget,
  WeatherWidget,
  WorldClocksWidget,
} from "./UtilityWidgets";

const S1: Span[] = ["1x1"];
const S12: Span[] = ["1x1", "2x1"];
const S123: Span[] = ["1x1", "2x1", "3x1"];
const S23: Span[] = ["2x1", "3x1"];

export const WIDGETS: WidgetDefinition[] = [
  { id: "apps", name: "Pinned & Running Apps", description: "Taskbar pins and open windows with focus dots", category: "Apps", sizes: ["auto"], defaultSize: "auto", icon: AppWindow, keywords: ["taskbar", "windows", "launcher", "pinned"], component: PinnedRunningApps },

  { id: "claude", name: "Claude", description: "Session, weekly and Opus usage limits", category: "AI", sizes: S123, defaultSize: "2x1", icon: Sparkles, keywords: ["anthropic", "limits", "usage", "opus"], providerId: "claude", component: ClaudeWidget },
  { id: "chatgpt", name: "ChatGPT", description: "5-hour and weekly Codex/ChatGPT limits", category: "AI", sizes: S123, defaultSize: "2x1", icon: Bot, keywords: ["openai", "codex", "gpt", "usage"], providerId: "chatgpt", component: ChatGptWidget },
  { id: "gemini", name: "Gemini", description: "Pro and Flash quota with reset timers", category: "AI", sizes: S123, defaultSize: "2x1", icon: Sparkles, keywords: ["google", "quota", "flash", "pro"], providerId: "gemini", component: GeminiWidget },
  { id: "grok", name: "Grok", description: "xAI prepaid credits against your budget", category: "AI", sizes: S123, defaultSize: "2x1", icon: Bot, keywords: ["xai", "credits"], providerId: "grok", component: GrokWidget },
  { id: "deepseek", name: "DeepSeek", description: "API balance against your budget", category: "AI", sizes: S123, defaultSize: "2x1", icon: Bot, keywords: ["balance", "credits"], providerId: "deepseek", component: DeepSeekWidget },
  { id: "glm", name: "GLM", description: "Z.ai coding plan 5-hour & MCP quota", category: "AI", sizes: S123, defaultSize: "2x1", icon: Bot, keywords: ["zhipu", "z.ai", "quota"], providerId: "glm", component: GlmWidget },

  { id: "media", name: "Now Playing", description: "Album art and playback controls for any app", category: "Media", sizes: S123, defaultSize: "2x1", icon: Music, keywords: ["music", "spotify", "smtc", "player"], component: MediaController },

  { id: "screen-time", name: "Screen Time", description: "Foreground time today with hourly bars", category: "Productivity", sizes: S123, defaultSize: "2x1", icon: Hourglass, keywords: ["usage", "focus", "apps", "domains"], component: ScreenTimeWidget },
  { id: "calendar", name: "Calendar", description: "Next event and live countdown from ICS feeds", category: "Productivity", sizes: S123, defaultSize: "2x1", icon: CalendarDays, keywords: ["agenda", "ics", "meetings", "google", "outlook"], providerId: "calendar", component: CalendarWidget },
  { id: "pomodoro", name: "Pomodoro", description: "25-minute focus rounds with breaks", category: "Productivity", sizes: S12, defaultSize: "2x1", icon: Timer, keywords: ["focus", "timer"], component: PomodoroWidget },
  { id: "todos", name: "Todos", description: "Checkable tasks saved locally", category: "Productivity", sizes: S123, defaultSize: "2x1", icon: ListTodo, keywords: ["tasks", "checklist"], component: TodosWidget },
  { id: "notes", name: "Quick Notes", description: "Popover scratchpad saved as you type", category: "Productivity", sizes: S12, defaultSize: "1x1", icon: StickyNote, keywords: ["scratchpad", "memo"], component: QuickNotesWidget },

  { id: "stripe", name: "Stripe", description: "30-day revenue, goal ring and sparkline", category: "Revenue", sizes: S123, defaultSize: "3x1", icon: DollarSign, keywords: ["payments", "mrr", "sales"], providerId: "stripe", component: StripeWidget },
  { id: "polar", name: "Polar", description: "30-day revenue from Polar metrics", category: "Revenue", sizes: S123, defaultSize: "2x1", icon: DollarSign, keywords: ["payments", "sales"], providerId: "polar", component: PolarWidget },
  { id: "dodo", name: "Dodo Payments", description: "30-day succeeded payments", category: "Revenue", sizes: S123, defaultSize: "2x1", icon: DollarSign, keywords: ["payments", "sales"], providerId: "dodo", component: DodoWidget },
  { id: "datafast", name: "DataFast", description: "Attributed revenue from analytics", category: "Revenue", sizes: S123, defaultSize: "2x1", icon: DollarSign, keywords: ["analytics", "revenue"], providerId: "datafast", component: DataFastWidget },

  { id: "gmail", name: "Gmail", description: "Unread count and today's new mail", category: "Social", sizes: S12, defaultSize: "2x1", icon: Mail, keywords: ["email", "inbox"], providerId: "gmail", component: GmailWidget },
  { id: "x", name: "X", description: "Live follower counter", category: "Social", sizes: S12, defaultSize: "1x1", icon: Users, keywords: ["twitter", "followers"], providerId: "x", component: XWidget },
  { id: "youtube", name: "YouTube", description: "Live subscriber counter", category: "Social", sizes: S12, defaultSize: "1x1", icon: Users, keywords: ["subscribers", "channel"], providerId: "youtube", component: YouTubeWidget },
  { id: "instagram", name: "Instagram", description: "Live follower counter", category: "Social", sizes: S12, defaultSize: "1x1", icon: Users, keywords: ["followers", "ig"], providerId: "instagram", component: InstagramWidget },

  { id: "github", name: "GitHub", description: "52-week contribution heatmap + notifications", category: "Developer", sizes: S123, defaultSize: "3x1", icon: Code, keywords: ["contributions", "commits", "notifications"], providerId: "github", component: GithubWidget },
  { id: "leetcode", name: "LeetCode", description: "Problems solved and daily streak", category: "Developer", sizes: S12, defaultSize: "2x1", icon: Code, keywords: ["algorithms", "streak"], providerId: "leetcode", component: LeetcodeWidget },
  { id: "api-counter", name: "API Counter", description: "Any JSON endpoint metric", category: "Developer", sizes: S12, defaultSize: "1x1", icon: Activity, keywords: ["webhook", "metric", "json"], providerId: "api_counter", component: ApiCounterWidget },

  { id: "quick-toggles", name: "Quick Toggles", description: "Wi-Fi, Bluetooth, Hotspot and Focus", category: "System", sizes: S23, defaultSize: "2x1", icon: ToggleRight, keywords: ["wifi", "bluetooth", "hotspot", "dnd", "radio"], component: QuickTogglesWidget },
  { id: "cpu", name: "CPU", description: "Processor load sparkline", category: "System", sizes: S123, defaultSize: "1x1", icon: Cpu, keywords: ["processor", "load"], component: CpuWidget },
  { id: "ram", name: "Memory", description: "RAM in use", category: "System", sizes: S123, defaultSize: "1x1", icon: MemoryStick, keywords: ["ram", "memory"], component: RamWidget },
  { id: "cpu-temp", name: "CPU Temp", description: "Thermal zone temperature", category: "System", sizes: S123, defaultSize: "1x1", icon: Thermometer, keywords: ["temperature", "thermal"], component: TempWidget },
  { id: "network", name: "Network", description: "Upload and download throughput", category: "System", sizes: S123, defaultSize: "2x1", icon: Network, keywords: ["bandwidth", "speed", "internet"], component: NetworkWidget },
  { id: "battery", name: "Battery", description: "Charge level and charging state", category: "System", sizes: S12, defaultSize: "1x1", icon: BatteryFull, keywords: ["power", "charge"], component: BatteryWidget },
  { id: "storage", name: "Free Storage", description: "Free space on the system drive", category: "System", sizes: S12, defaultSize: "1x1", icon: HardDrive, keywords: ["disk", "space", "drive"], component: StorageWidget },
  { id: "keyboard", name: "Keyboard Layout", description: "Active input language (ENG / FRA)", category: "System", sizes: S1, defaultSize: "1x1", icon: Keyboard, keywords: ["language", "input", "ime"], component: KeyboardLayoutWidget },

  { id: "clock", name: "Clock", description: "Local time and date", category: "Utilities", sizes: S12, defaultSize: "1x1", icon: Clock, keywords: ["time", "date"], component: ClockWidget },
  { id: "search", name: "Search", description: "Search or open apps, files and URLs", category: "Utilities", sizes: S23, defaultSize: "2x1", icon: Search, keywords: ["launcher", "start", "find"], component: SearchWidget },
  { id: "world-clocks", name: "World Clocks", description: "NYC, LDN, TYO analog + digital", category: "Utilities", sizes: S123, defaultSize: "3x1", icon: Globe, keywords: ["time zones", "clocks"], component: WorldClocksWidget },
  { id: "weather", name: "Hourly Weather", description: "Local forecast strip (Open-Meteo)", category: "Utilities", sizes: S123, defaultSize: "3x1", icon: CloudSun, keywords: ["forecast", "temperature"], providerId: "weather", component: WeatherWidget },
  { id: "folders", name: "Quick Folders", description: "Downloads, Screenshots, Recent, Recycle Bin", category: "Utilities", sizes: S123, defaultSize: "2x1", icon: FolderOpen, keywords: ["explorer", "files", "downloads"], component: QuickFoldersWidget },
  { id: "stopwatch", name: "Stopwatch", description: "Start, pause and reset", category: "Utilities", sizes: S12, defaultSize: "1x1", icon: Watch, keywords: ["timer", "lap"], component: StopwatchWidget },
];

export const CATEGORIES: WidgetCategory[] = ["Apps", "AI", "Media", "Productivity", "Revenue", "Social", "Developer", "System", "Utilities"];

const BY_ID = new Map(WIDGETS.map((w) => [w.id, w]));

export function getWidget(id: string): WidgetDefinition | undefined {
  return BY_ID.get(id);
}

/** Localized display name; the registry's English `name` is the fallback. */
export function widgetName(def: WidgetDefinition, i18n: I18n): string {
  return i18n.td(`widget.${def.id}.name`, def.name);
}

export function widgetDescription(def: WidgetDefinition, i18n: I18n): string {
  return i18n.td(`widget.${def.id}.desc`, def.description);
}

export function categoryLabel(category: WidgetCategory | "All", i18n: I18n): string {
  return i18n.td(`category.${category}`, category);
}

/** Case- and accent-insensitive ("meteo" finds "Météo"). */
function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Matches the localized name / description / category as well as the English ones and keywords. */
export function searchWidgets(query: string, category: WidgetCategory | "All", i18n: I18n): WidgetDefinition[] {
  const q = fold(query.trim());
  return WIDGETS.filter((w) => {
    if (category !== "All" && w.category !== category) return false;
    if (!q) return true;
    const haystack = [widgetName(w, i18n), widgetDescription(w, i18n), categoryLabel(w.category, i18n), w.name, w.description, w.category, ...w.keywords];
    return haystack.some((s) => fold(s).includes(q));
  });
}

export function newInstance(widgetId: string, span?: Span): LayoutItem {
  const def = getWidget(widgetId);
  return {
    instanceId: `${widgetId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    widgetId,
    span: span && def?.sizes.includes(span) ? span : def?.defaultSize ?? "1x1",
  };
}

export const DEFAULT_LAYOUT: LayoutItem[] = [
  { instanceId: "apps-default", widgetId: "apps", span: "auto" },
  { instanceId: "search-default", widgetId: "search", span: "2x1" },
  { instanceId: "media-default", widgetId: "media", span: "2x1" },
  { instanceId: "claude-default", widgetId: "claude", span: "2x1" },
  { instanceId: "calendar-default", widgetId: "calendar", span: "2x1" },
  { instanceId: "quick-toggles-default", widgetId: "quick-toggles", span: "2x1" },
  { instanceId: "cpu-default", widgetId: "cpu", span: "1x1" },
  { instanceId: "weather-default", widgetId: "weather", span: "2x1" },
  { instanceId: "clock-default", widgetId: "clock", span: "1x1" },
];

/** Drop unknown widgets / invalid spans from a stored layout. */
export function sanitizeLayout(items: LayoutItem[] | null | undefined): LayoutItem[] {
  if (!Array.isArray(items)) return DEFAULT_LAYOUT;
  const seen = new Set<string>();
  const out: LayoutItem[] = [];
  for (const item of items) {
    const def = item && getWidget(item.widgetId);
    if (!def || !item.instanceId || seen.has(item.instanceId)) continue;
    seen.add(item.instanceId);
    out.push({ ...item, span: def.sizes.includes(item.span) ? item.span : def.defaultSize });
  }
  return out;
}
