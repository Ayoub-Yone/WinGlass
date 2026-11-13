// Sample payloads used for live miniature previews in the widget picker when a provider has
// no data yet (unconfigured). Shapes match the backend exactly.

import type {
  AiUsageData,
  ApiCounterData,
  CalendarData,
  GithubData,
  GmailData,
  LeetcodeData,
  MediaState,
  ProviderId,
  RevenueData,
  SocialData,
  TelemetrySample,
  WeatherData,
} from "../types/lumabar";

const hours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

const ai = (provider: string, tiers: Array<[string, string, number, number]>): AiUsageData => ({
  provider,
  plan: null,
  tiers: tiers.map(([key, label, percent, resetH]) => ({ key, label, percent, resetsAt: hours(resetH), windowSeconds: null })),
});

const revenue = (provider: string, total: number): RevenueData => {
  const daily = Array.from({ length: 30 }, (_, i) => (total / 30) * (0.7 + 0.6 * ((Math.sin(i * 1.7) + 1.2) / 2.2)));
  return { provider, currency: "USD", total30d: total, previous30d: total / 1.31, net30d: total * 0.97, deltaPercent: 31, daily, goal: 15000 };
};

const social = (handle: string, followers: number, delta: number, metric: SocialData["metric"] = "followers"): SocialData => ({
  followers,
  deltaToday: delta,
  handle,
  metric,
});

export const SAMPLE_PROVIDER_DATA: Partial<Record<ProviderId, unknown>> = {
  claude: ai("Claude", [
    ["five_hour", "Session", 42, 2],
    ["seven_day", "Weekly", 87, 40],
    ["seven_day_opus", "Opus", 31, 40],
  ]),
  chatgpt: ai("ChatGPT", [
    ["primary_window", "5h", 38, 3],
    ["secondary_window", "Weekly", 54, 90],
  ]),
  gemini: ai("Gemini", [
    ["pro", "Pro", 62, 9],
    ["flash", "Flash", 18, 9],
  ]),
  grok: { ...ai("Grok", [["credits", "Credits", 57, 0]]), balance: 21.4, budget: 50, currency: "USD" },
  deepseek: { ...ai("DeepSeek", [["credits", "Credits", 24, 0]]), balance: 37.9, budget: 50, currency: "USD" },
  glm: ai("GLM", [
    ["tokens", "5h", 24, 4],
    ["mcp", "MCP", 12, 280],
  ]),
  stripe: revenue("Stripe", 3012),
  polar: revenue("Polar", 8551),
  dodo: revenue("Dodo Payments", 1180),
  datafast: revenue("DataFast", 2980),
  gmail: { unread: 4, today: 9, account: "you@example.com" } satisfies GmailData,
  x: social("@lumabar", 12480, 37),
  youtube: social("lumabar", 48210, 112, "subscribers"),
  instagram: social("@lumabar", 9031, 14),
  github: {
    login: "octocat",
    weeks: Array.from({ length: 52 }, (_, w) =>
      Array.from({ length: 7 }, (_, d) => {
        const x = Math.sin((w * 7 + d) * 12.9898) * 43758.5453;
        const r = x - Math.floor(x);
        return r < 0.28 ? 0 : Math.floor(r * 14);
      }),
    ),
    total: 1873,
    notifications: 7,
    notificationsMore: false,
  } satisfies GithubData,
  leetcode: { username: "lumabar", solved: 412, easy: 160, medium: 210, hard: 42, streak: 14, maxStreak: 61 } satisfies LeetcodeData,
  api_counter: { value: 128_400, deltaToday: 2314, label: "API calls" } satisfies ApiCounterData,
  weather: {
    city: "New York",
    unit: "F",
    current: 36,
    code: 1,
    isDay: true,
    high: 38,
    low: 29,
    hourly: Array.from({ length: 12 }, (_, i) => ({
      time: new Date(Date.now() + i * 3_600_000).toISOString().slice(0, 13) + ":00",
      temp: 36 - Math.round(i * 0.3),
      code: i < 4 ? 1 : 3,
      precip: i * 5,
    })),
  } satisfies WeatherData,
  calendar: {
    events: [
      {
        uid: "sample-1",
        title: "Design review",
        start: new Date(Date.now() + 5 * 60_000).toISOString(),
        end: new Date(Date.now() + 35 * 60_000).toISOString(),
        allDay: false,
        location: "Zoom",
        url: null,
        calendar: "Work",
      },
    ],
  } satisfies CalendarData,
};

export const SAMPLE_MEDIA: MediaState = {
  available: true,
  title: "Midnight City",
  artist: "M83",
  album: "Hurry Up, We're Dreaming",
  status: "Playing",
  sourceApp: "Spotify.exe",
  thumbnail: null,
  canNext: true,
  canPrevious: true,
};

export function sampleTelemetry(): TelemetrySample[] {
  const now = Date.now();
  return Array.from({ length: 40 }, (_, i) => ({
    ts: now - (40 - i) * 1000,
    cpuPercent: 22 + 14 * Math.sin(i / 4) + 6 * Math.sin(i * 1.3),
    ramUsedGb: 11.2 + Math.sin(i / 9) * 0.4,
    ramTotalGb: 32,
    ramPercent: 35 + Math.sin(i / 9) * 1.2,
    cpuTempC: 54 + 5 * Math.sin(i / 6),
    netUpBps: 40_000 + 30_000 * Math.abs(Math.sin(i / 3)),
    netDownBps: 900_000 + 700_000 * Math.abs(Math.sin(i / 5)),
    hasBattery: true,
    batteryPercent: 81,
    charging: false,
    diskFreeGb: 1281,
    diskTotalGb: 1863,
    keyboardLayout: "ENG",
    radios: { wifi: true, bluetooth: true, hotspot: false },
  }));
}
