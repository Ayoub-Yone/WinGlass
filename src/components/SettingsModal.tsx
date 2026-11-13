// Settings: themes & sizes, dock position & taskbar mode, accounts / API keys (DPAPI-encrypted),
// calendar feeds, integrations, automation rules with thresholds + test buttons, and advanced.

import {
  AlertTriangle,
  CalendarDays,
  Check,
  CheckCircle2,
  KeyRound,
  Lock,
  Monitor,
  Palette,
  Plug,
  Power,
  RefreshCw,
  SlidersHorizontal,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { BrandGlyph } from "./ui";
import { useHub } from "../engine/DataHub";
import { SIZE_ORDER, SIZES, THEMES, THEME_ORDER } from "../engine/ThemeEngine";
import { patchSettings, useSettings } from "../lib/hooks";
import { broadcast, errorMessage, ipc, subscribe } from "../lib/ipc";
import type { AutomationSettings, ProviderId, Settings, TaskbarMode } from "../types/lumabar";

type Tab = "general" | "accounts" | "calendar" | "integrations" | "automations" | "advanced";

const TABS: Array<{ id: Tab; label: string; icon: LucideIcon }> = [
  { id: "general", label: "Appearance & Dock", icon: Palette },
  { id: "accounts", label: "Accounts & Keys", icon: KeyRound },
  { id: "calendar", label: "Calendar", icon: CalendarDays },
  { id: "integrations", label: "Integrations", icon: Plug },
  { id: "automations", label: "Automations", icon: Zap },
  { id: "advanced", label: "Advanced", icon: SlidersHorizontal },
];

// ---------------------------------------------------------------- form primitives

function Section(props: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="mb-6">
      <h3 className="mb-0.5 text-[13px] font-semibold">{props.title}</h3>
      {props.description && <p className="mb-2.5 text-[12px] lb-muted">{props.description}</p>}
      <div className="flex flex-col gap-1.5">{props.children}</div>
    </section>
  );
}

function Row(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4 rounded-xl px-3.5 py-2.5" style={{ background: "var(--lb-card)" }}>
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px]">{props.label}</div>
        {props.hint && <div className="text-[11px] lb-muted">{props.hint}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{props.children}</div>
    </div>
  );
}

function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      className="lb-focus relative h-[22px] w-[38px] rounded-full border-none p-0"
      style={{ background: props.checked ? "var(--lb-green)" : "var(--lb-track)", transition: "background 160ms" }}
      onClick={() => props.onChange(!props.checked)}
    >
      <span
        className="absolute top-[2px] h-[18px] w-[18px] rounded-full bg-white shadow"
        style={{ left: props.checked ? 18 : 2, transition: "left 180ms cubic-bezier(0.3, 0.9, 0.3, 1.2)" }}
      />
    </button>
  );
}

function Segmented<T extends string>(props: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void }) {
  return (
    <div className="flex rounded-lg p-0.5" style={{ background: "var(--lb-track)" }}>
      {props.options.map((o) => (
        <button
          key={o.value}
          className="lb-focus rounded-md border-none px-2.5 py-1 text-[12px]"
          style={{ background: props.value === o.value ? "var(--lb-card-hover)" : "transparent", fontWeight: props.value === o.value ? 600 : 400 }}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Text/number input that commits on blur or Enter (avoids a settings write per keystroke). */
function CommitInput(props: { value: string | number; onCommit: (v: string) => void; type?: "text" | "number"; width?: number; placeholder?: string }) {
  const [draft, setDraft] = useState(String(props.value));
  useEffect(() => setDraft(String(props.value)), [props.value]);
  const commit = () => draft !== String(props.value) && props.onCommit(draft);
  return (
    <input
      type={props.type ?? "text"}
      value={draft}
      placeholder={props.placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
      className="lb-focus rounded-lg border-none px-2.5 py-1.5 text-[12px] outline-none"
      style={{ background: "var(--lb-track)", width: props.width ?? 200 }}
    />
  );
}

const update = (mutate: (s: Settings) => Settings) => void patchSettings(mutate);

// ---------------------------------------------------------------- tabs

function GeneralTab({ s }: { s: Settings }) {
  const taskbarOptions: Array<{ value: TaskbarMode; label: string }> = [
    { value: "auto_hide", label: "Auto-hide" },
    { value: "completely_hidden", label: "Hidden" },
    { value: "native", label: "Keep" },
  ];
  return (
    <>
      <Section title="Surface" description="Liquid Glass refracts the live desktop behind the dock using a GPU shader.">
        <div className="grid grid-cols-5 gap-2">
          {THEME_ORDER.map((id) => {
            const t = THEMES[id];
            const active = s.theme === id;
            return (
              <button
                key={id}
                className="lb-focus flex flex-col items-stretch gap-1.5 rounded-xl border-none p-2 text-left"
                style={{ background: "var(--lb-card)", outline: active ? "2px solid var(--lb-accent)" : "none" }}
                onClick={() => update((x) => ({ ...x, theme: id }))}
              >
                <div
                  className="flex h-10 items-center gap-1 rounded-[12px] px-1.5"
                  style={{
                    background: id === "liquid-glass" ? "linear-gradient(120deg, rgba(120,160,255,0.55), rgba(255,140,190,0.45))" : t.surface,
                    border: t.border,
                  }}
                >
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="h-6 flex-1 rounded-[7px]" style={{ background: t.card }} />
                  ))}
                </div>
                <div className="text-[12px] font-semibold">{t.name}</div>
                <div className="text-[10.5px] lb-muted">{t.description}</div>
              </button>
            );
          })}
        </div>
      </Section>
      <Section title="Size">
        <Row label="Dock height" hint={`${SIZES[s.size].height}px`}>
          <Segmented value={s.size} options={SIZE_ORDER.map((id) => ({ value: id, label: SIZES[id].name }))} onChange={(size) => update((x) => ({ ...x, size }))} />
        </Row>
        <Row label="Accent color">
          <input type="color" value={s.accent} onChange={(e) => update((x) => ({ ...x, accent: e.target.value }))} className="h-7 w-10 cursor-pointer rounded border-none bg-transparent" />
        </Row>
      </Section>
      <Section title="Dock" description="You can also drag the dock vertically to snap it to the top or bottom edge.">
        <Row label="Position">
          <Segmented
            value={s.position}
            options={[
              { value: "bottom", label: "Bottom" },
              { value: "top", label: "Top" },
            ]}
            onChange={(position) => void ipc.setDockPosition(position)}
          />
        </Row>
        <Row label="Hide during fullscreen games & video" hint="Slides away when a fullscreen app is in front">
          <Toggle checked={s.hideOnFullscreen} onChange={(v) => update((x) => ({ ...x, hideOnFullscreen: v }))} />
        </Row>
        <Row label="Launch at sign-in">
          <Toggle checked={s.launchAtLogin} onChange={(v) => update((x) => ({ ...x, launchAtLogin: v }))} />
        </Row>
      </Section>
      <Section title="Windows taskbar" description="lumabar always restores the original taskbar on exit, crash or sign-out. Emergency hotkey: Ctrl + Alt + Shift + R.">
        <Row label="Native taskbar" hint={s.taskbarMode === "completely_hidden" ? "Hidden on every monitor" : s.taskbarMode === "auto_hide" ? "Collapses off-screen until you hover the edge" : "Left untouched"}>
          <Segmented value={s.taskbarMode} options={taskbarOptions} onChange={(mode) => void ipc.setTaskbarMode(mode)} />
        </Row>
      </Section>
    </>
  );
}

interface SecretField {
  name: string;
  label: string;
  hint?: string;
}

interface AccountSpec {
  id: ProviderId;
  name: string;
  fields: SecretField[];
  note?: string;
}

const AI_ACCOUNTS: AccountSpec[] = [
  {
    id: "claude",
    name: "Claude",
    fields: [
      { name: "claude_session_key", label: "claude.ai sessionKey cookie", hint: "sk-ant-sid…" },
      { name: "claude_oauth_token", label: "or Claude Code OAuth token" },
    ],
    note: "Usage limits come from Claude's own usage endpoint (not an official public API).",
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    fields: [
      { name: "chatgpt_access_token", label: "ChatGPT / Codex access token" },
      { name: "chatgpt_account_id", label: "ChatGPT account id (optional)" },
    ],
    note: "Reads 5-hour and weekly limits from the endpoint Codex uses (unofficial).",
  },
  {
    id: "gemini",
    name: "Gemini",
    fields: [
      { name: "gemini_oauth_token", label: "Gemini CLI OAuth access token" },
      { name: "gemini_project_id", label: "Code Assist project id (optional)" },
    ],
  },
  { id: "grok", name: "Grok (xAI)", fields: [{ name: "xai_management_key", label: "Management API key" }, { name: "xai_team_id", label: "Team id" }] },
  { id: "deepseek", name: "DeepSeek", fields: [{ name: "deepseek_api_key", label: "API key" }] },
  { id: "glm", name: "GLM (Z.ai)", fields: [{ name: "glm_api_key", label: "Coding Plan API key" }] },
];

const OTHER_ACCOUNTS: AccountSpec[] = [
  { id: "stripe", name: "Stripe", fields: [{ name: "stripe_api_key", label: "Restricted key (read balance transactions)", hint: "rk_live_…" }] },
  { id: "polar", name: "Polar", fields: [{ name: "polar_access_token", label: "Organization access token (metrics:read)" }] },
  { id: "dodo", name: "Dodo Payments", fields: [{ name: "dodo_api_key", label: "API key" }] },
  { id: "datafast", name: "DataFast", fields: [{ name: "datafast_api_key", label: "Website API key", hint: "df_…" }] },
  { id: "gmail", name: "Gmail", fields: [{ name: "gmail_oauth_token", label: "OAuth access token (gmail.readonly)" }, { name: "gmail_app_password", label: "or App password (with address in Integrations)" }] },
  { id: "x", name: "X", fields: [{ name: "x_bearer_token", label: "API bearer token" }] },
  { id: "youtube", name: "YouTube", fields: [{ name: "youtube_api_key", label: "Data API v3 key" }] },
  { id: "instagram", name: "Instagram", fields: [{ name: "instagram_access_token", label: "Graph API access token" }] },
  { id: "github", name: "GitHub", fields: [{ name: "github_token", label: "Personal access token (read:user, notifications)" }] },
];

function SecretInput({ field, isSet, onSaved }: { field: SecretField; isSet: boolean; onSaved: (names: string[]) => void }) {
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const save = async (v: string) => {
    setStatus("saving");
    try {
      onSaved(await ipc.setSecret(field.name, v));
      setValue("");
      setStatus("saved");
      window.setTimeout(() => setStatus("idle"), 1500);
    } catch (err) {
      setError(errorMessage(err));
      setStatus("error");
    }
  };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="w-[230px] shrink-0 truncate text-[12px] lb-muted">{field.label}</span>
        <input
          type="password"
          value={value}
          placeholder={isSet ? "•••••••• (stored encrypted)" : field.hint ?? "Paste value"}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && value && void save(value)}
          className="lb-focus min-w-0 flex-1 rounded-lg border-none px-2.5 py-1.5 text-[12px] outline-none"
          style={{ background: "var(--lb-track)" }}
        />
        <button
          className="lb-focus rounded-lg border-none px-2.5 py-1.5 text-[12px] font-semibold"
          style={{ background: "var(--lb-accent)", color: "#fff", opacity: value ? 1 : 0.5 }}
          disabled={!value || status === "saving"}
          onClick={() => void save(value)}
        >
          {status === "saved" ? <Check size={13} /> : "Save"}
        </button>
        {isSet && (
          <button className="lb-icon-btn h-7 w-7" title="Remove" onClick={() => void save("")}>
            <X size={13} />
          </button>
        )}
      </div>
      {status === "error" && <div className="text-[11px]" style={{ color: "var(--lb-red)" }}>{error}</div>}
    </div>
  );
}

function ProviderBadge({ id }: { id: ProviderId }) {
  const result = useHub((s) => s.providers[id]);
  const [busy, setBusy] = useState(false);
  const status = result?.status ?? "loading";
  const color = status === "ok" ? "var(--lb-green)" : status === "error" ? "var(--lb-amber)" : status === "simulated" ? "var(--lb-purple)" : "var(--lb-faint)";
  const label = { ok: "Connected", error: "Error", simulated: "Simulated", unconfigured: "Not set up", loading: "…" }[status];
  return (
    <div className="flex items-center gap-1.5">
      <span className="flex items-center gap-1 text-[11px]" style={{ color }} title={result?.error ?? undefined}>
        {status === "ok" ? <CheckCircle2 size={12} /> : status === "error" ? <AlertTriangle size={12} /> : null}
        {label}
      </span>
      <button
        className="lb-icon-btn h-6 w-6"
        title="Refresh now"
        onClick={() => {
          setBusy(true);
          void ipc.refreshProvider(id).finally(() => setBusy(false));
        }}
      >
        <RefreshCw size={11} className={busy ? "animate-spin" : ""} />
      </button>
    </div>
  );
}

function AccountCard({ spec, names, setNames }: { spec: AccountSpec; names: string[]; setNames: (n: string[]) => void }) {
  const error = useHub((s) => s.providers[spec.id]?.error);
  const status = useHub((s) => s.providers[spec.id]?.status);
  return (
    <div className="flex flex-col gap-2 rounded-xl p-3" style={{ background: "var(--lb-card)" }}>
      <div className="flex items-center gap-2">
        <BrandGlyph id={spec.id} size={22} />
        <span className="flex-1 font-semibold">{spec.name}</span>
        <ProviderBadge id={spec.id} />
      </div>
      {spec.fields.map((f) => (
        <SecretInput key={f.name} field={f} isSet={names.includes(f.name)} onSaved={setNames} />
      ))}
      {status === "error" && error && <div className="text-[11px]" style={{ color: "var(--lb-amber)" }}>{error}</div>}
      {spec.note && <div className="text-[11px] lb-faint">{spec.note}</div>}
    </div>
  );
}

function AccountsTab({ s }: { s: Settings }) {
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => void ipc.getSecretNames().then(setNames), []);
  return (
    <>
      <div className="mb-4 flex items-center gap-2 rounded-xl px-3 py-2 text-[12px]" style={{ background: "rgba(48,209,88,0.12)" }}>
        <Lock size={14} style={{ color: "var(--lb-green)" }} />
        Keys are encrypted with Windows DPAPI for your user account and never leave this PC except to the provider you configure.
      </div>
      <Section title="AI usage limits">
        <Row label="Use local CLI credentials" hint="Read tokens from ~/.codex/auth.json and ~/.gemini/oauth_creds.json when no key is set">
          <Toggle checked={s.providers.useLocalCliCredentials} onChange={(v) => update((x) => ({ ...x, providers: { ...x.providers, useLocalCliCredentials: v } }))} />
        </Row>
        {AI_ACCOUNTS.map((a) => (
          <AccountCard key={a.id} spec={a} names={names} setNames={setNames} />
        ))}
      </Section>
      <Section title="Revenue, mail, social & developer">
        {OTHER_ACCOUNTS.map((a) => (
          <AccountCard key={a.id} spec={a} names={names} setNames={setNames} />
        ))}
      </Section>
    </>
  );
}

function CalendarTab() {
  const [names, setNames] = useState<string[]>([]);
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const result = useHub((s) => s.providers.calendar);
  useEffect(() => void ipc.getSecretNames().then(setNames), []);
  const configured = names.includes("ics_urls");
  const save = async (v: string) => {
    setError(null);
    try {
      setNames(await ipc.setSecret("ics_urls", v));
      setValue("");
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const count = (result?.data as { events?: unknown[] } | null)?.events?.length ?? 0;
  return (
    <Section
      title="Private ICS / iCal feeds"
      description="Google Calendar: Settings › your calendar › Secret address in iCal format. Outlook: Publish calendar › ICS. iCloud: Share › Public calendar (webcal:// is fine). One URL per line."
    >
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={configured ? "Feeds are stored encrypted. Paste new URLs to replace them." : "https://calendar.google.com/calendar/ical/…/basic.ics"}
        className="lb-focus lb-thin-scroll h-28 w-full resize-none rounded-xl border-none p-3 text-[12px] outline-none"
        style={{ background: "var(--lb-card)" }}
      />
      <div className="flex items-center gap-2">
        <button className="lb-focus rounded-lg border-none px-3 py-1.5 text-[12px] font-semibold" style={{ background: "var(--lb-accent)", color: "#fff" }} disabled={!value.trim()} onClick={() => void save(value)}>
          {saved ? "Saved" : "Save feeds"}
        </button>
        {configured && (
          <button className="lb-focus rounded-lg border-none px-3 py-1.5 text-[12px]" style={{ background: "var(--lb-card)" }} onClick={() => void save("")}>
            Remove feeds
          </button>
        )}
        <span className="ml-auto text-[12px] lb-muted">
          {result?.status === "ok" && `${count} upcoming events`}
          {result?.status === "simulated" && "Simulation mode"}
          {result?.status === "error" && <span style={{ color: "var(--lb-amber)" }}>{result.error}</span>}
        </span>
        <ProviderBadge id="calendar" />
      </div>
      {error && <div className="text-[11px]" style={{ color: "var(--lb-red)" }}>{error}</div>}
    </Section>
  );
}

function IntegrationsTab({ s }: { s: Settings }) {
  const p = s.providers;
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => void ipc.getSecretNames().then(setNames), []);
  const setP = (patch: Partial<Settings["providers"]>) => update((x) => ({ ...x, providers: { ...x.providers, ...patch } }));
  const num = (v: string, fallback: number) => (Number.isFinite(Number(v)) && v.trim() !== "" ? Number(v) : fallback);
  return (
    <>
      <Section title="Accounts & handles">
        <Row label="LeetCode username"><CommitInput value={p.leetcodeUsername} onCommit={(v) => setP({ leetcodeUsername: v.trim() })} /></Row>
        <Row label="GitHub username" hint="Leave empty to use the token's own account"><CommitInput value={p.githubUsername} onCommit={(v) => setP({ githubUsername: v.trim() })} /></Row>
        <Row label="X handle"><CommitInput value={p.xUsername} placeholder="@handle" onCommit={(v) => setP({ xUsername: v.trim() })} /></Row>
        <Row label="YouTube channel" hint="Channel id (UC…) or @handle"><CommitInput value={p.youtubeChannelId} onCommit={(v) => setP({ youtubeChannelId: v.trim() })} /></Row>
        <Row label="Instagram user id" hint="Instagram business account id"><CommitInput value={p.instagramUserId} onCommit={(v) => setP({ instagramUserId: v.trim() })} /></Row>
        <Row label="Gmail address" hint="Needed for the app-password (Atom feed) method"><CommitInput value={p.gmailAddress} onCommit={(v) => setP({ gmailAddress: v.trim() })} /></Row>
      </Section>
      <Section title="API counter" description="Any HTTPS endpoint returning JSON. The path selects the number, e.g. data.count or /stats/0/value.">
        <Row label="Endpoint URL"><CommitInput width={280} value={p.apiCounterUrl} placeholder="https://api.example.com/stats" onCommit={(v) => setP({ apiCounterUrl: v.trim() })} /></Row>
        <Row label="JSON path"><CommitInput value={p.apiCounterJsonPath} placeholder="data.count" onCommit={(v) => setP({ apiCounterJsonPath: v.trim() })} /></Row>
        <Row label="Label"><CommitInput value={p.apiCounterLabel} onCommit={(v) => setP({ apiCounterLabel: v })} /></Row>
        <div className="rounded-xl p-3" style={{ background: "var(--lb-card)" }}>
          <SecretInput field={{ name: "api_counter_token", label: "Bearer token (optional)" }} isSet={names.includes("api_counter_token")} onSaved={setNames} />
        </div>
      </Section>
      <Section title="Weather" description="Forecast from Open-Meteo — no account or API key required.">
        <Row label="City label"><CommitInput value={p.weatherCity} onCommit={(v) => setP({ weatherCity: v })} /></Row>
        <Row label="Latitude / longitude">
          <CommitInput type="number" width={95} value={p.weatherLatitude} onCommit={(v) => setP({ weatherLatitude: num(v, p.weatherLatitude) })} />
          <CommitInput type="number" width={95} value={p.weatherLongitude} onCommit={(v) => setP({ weatherLongitude: num(v, p.weatherLongitude) })} />
        </Row>
        <Row label="Units">
          <Segmented value={p.weatherFahrenheit ? "f" : "c"} options={[{ value: "f", label: "°F" }, { value: "c", label: "°C" }]} onChange={(v) => setP({ weatherFahrenheit: v === "f" })} />
        </Row>
      </Section>
      <Section title="Goals & budgets">
        <Row label="30-day revenue goal" hint="Drives the goal ring"><CommitInput type="number" width={110} value={p.revenueGoal} onCommit={(v) => setP({ revenueGoal: num(v, p.revenueGoal) })} /></Row>
        <Row label="DeepSeek budget" hint="Balance shown as % of this amount"><CommitInput type="number" width={110} value={p.deepseekBudget} onCommit={(v) => setP({ deepseekBudget: num(v, p.deepseekBudget) })} /></Row>
        <Row label="Grok budget"><CommitInput type="number" width={110} value={p.grokBudget} onCommit={(v) => setP({ grokBudget: num(v, p.grokBudget) })} /></Row>
      </Section>
      <Section title="World clocks" description="IANA time zones, e.g. America/New_York, Europe/Paris, Asia/Tokyo.">
        {s.worldClocks.map((c, i) => (
          <Row key={i} label={`Clock ${i + 1}`}>
            <CommitInput width={70} value={c.label} onCommit={(v) => update((x) => ({ ...x, worldClocks: x.worldClocks.map((w, j) => (j === i ? { ...w, label: v.slice(0, 4).toUpperCase() } : w)) }))} />
            <CommitInput width={170} value={c.timeZone} onCommit={(v) => update((x) => ({ ...x, worldClocks: x.worldClocks.map((w, j) => (j === i ? { ...w, timeZone: v.trim() } : w)) }))} />
          </Row>
        ))}
      </Section>
      <Section title="Pomodoro">
        <Row label="Focus / break minutes">
          <CommitInput type="number" width={70} value={s.pomodoroFocusMinutes} onCommit={(v) => update((x) => ({ ...x, pomodoroFocusMinutes: Math.max(1, Math.round(num(v, 25))) }))} />
          <CommitInput type="number" width={70} value={s.pomodoroBreakMinutes} onCommit={(v) => update((x) => ({ ...x, pomodoroBreakMinutes: Math.max(1, Math.round(num(v, 5))) }))} />
        </Row>
      </Section>
    </>
  );
}

function TestButton({ rule }: { rule: keyof AutomationSettings }) {
  const [result, setResult] = useState<string | null>(null);
  useEffect(
    () =>
      subscribe("automation:test-result", (r) => {
        if (r.rule === rule) {
          setResult(r.message);
          window.setTimeout(() => setResult(null), 3000);
        }
      }),
    [rule],
  );
  return (
    <div className="flex items-center gap-2">
      {result && <span className="text-[11px] lb-muted">{result}</span>}
      <button className="lb-focus rounded-lg border-none px-2.5 py-1 text-[12px]" style={{ background: "var(--lb-track)" }} onClick={() => void broadcast("automation:test", { rule })}>
        Test
      </button>
    </div>
  );
}

function AutomationsTab({ s }: { s: Settings }) {
  const a = s.automations;
  const setA = (patch: Partial<AutomationSettings>) => update((x) => ({ ...x, automations: { ...x.automations, ...patch } }));
  return (
    <>
      <Section title="Pre-meeting music auto-pause" description="Pauses whatever is playing and shows the meeting when an event is about to start.">
        <Row label="Enabled">
          <TestButton rule="preMeetingPause" />
          <Toggle checked={a.preMeetingPause.enabled} onChange={(v) => setA({ preMeetingPause: { ...a.preMeetingPause, enabled: v } })} />
        </Row>
        <Row label="Minutes before start">
          <CommitInput type="number" width={70} value={a.preMeetingPause.minutes} onCommit={(v) => setA({ preMeetingPause: { ...a.preMeetingPause, minutes: Math.max(1, Math.min(60, Math.round(Number(v) || 5))) } })} />
        </Row>
      </Section>
      <Section title="AI limit early warning" description="Warns when any AI tier crosses the threshold, or when its burn rate would exhaust it within the horizon.">
        <Row label="Enabled">
          <TestButton rule="aiLimitWarning" />
          <Toggle checked={a.aiLimitWarning.enabled} onChange={(v) => setA({ aiLimitWarning: { ...a.aiLimitWarning, enabled: v } })} />
        </Row>
        <Row label="Utilization threshold" hint={`${a.aiLimitWarning.thresholdPercent}%`}>
          <input
            type="range"
            min={50}
            max={99}
            value={a.aiLimitWarning.thresholdPercent}
            onChange={(e) => setA({ aiLimitWarning: { ...a.aiLimitWarning, thresholdPercent: Number(e.target.value) } })}
            style={{ accentColor: "var(--lb-accent)" }}
          />
        </Row>
        <Row label="Projected depletion within (hours)">
          <CommitInput type="number" width={70} value={a.aiLimitWarning.horizonHours} onCommit={(v) => setA({ aiLimitWarning: { ...a.aiLimitWarning, horizonHours: Math.max(1, Number(v) || 24) } })} />
        </Row>
      </Section>
      <Section title="Revenue milestone alert" description="Celebrates when 30-day revenue in Stripe, Polar or Dodo Payments crosses a milestone.">
        <Row label="Enabled">
          <TestButton rule="revenueMilestone" />
          <Toggle checked={a.revenueMilestone.enabled} onChange={(v) => setA({ revenueMilestone: { ...a.revenueMilestone, enabled: v } })} />
        </Row>
        <Row label="Milestones" hint="Comma separated, in your currency">
          <CommitInput
            width={240}
            value={a.revenueMilestone.milestones.join(", ")}
            onCommit={(v) =>
              setA({
                revenueMilestone: {
                  ...a.revenueMilestone,
                  milestones: v
                    .split(",")
                    .map((x) => Number(x.replace(/[^0-9.]/g, "")))
                    .filter((n) => Number.isFinite(n) && n > 0)
                    .sort((x, y) => x - y),
                },
              })
            }
          />
        </Row>
      </Section>
      <Section title="Subscription renewal reminder" description="Flags calendar events that look like renewals or billing dates.">
        <Row label="Enabled">
          <TestButton rule="renewalReminder" />
          <Toggle checked={a.renewalReminder.enabled} onChange={(v) => setA({ renewalReminder: { ...a.renewalReminder, enabled: v } })} />
        </Row>
        <Row label="Look-ahead (hours)">
          <CommitInput type="number" width={70} value={a.renewalReminder.hours} onCommit={(v) => setA({ renewalReminder: { ...a.renewalReminder, hours: Math.max(1, Number(v) || 24) } })} />
        </Row>
        <Row label="Keywords">
          <CommitInput
            width={240}
            value={a.renewalReminder.keywords.join(", ")}
            onCommit={(v) => setA({ renewalReminder: { ...a.renewalReminder, keywords: v.split(",").map((k) => k.trim()).filter(Boolean) } })}
          />
        </Row>
      </Section>
      <Row label="Reset automation history" hint="Lets already-fired reminders and milestones fire again">
        <button className="lb-focus rounded-lg border-none px-2.5 py-1 text-[12px]" style={{ background: "var(--lb-track)" }} onClick={() => void broadcast("automation:reset", null)}>
          Reset
        </button>
      </Row>
    </>
  );
}

function AdvancedTab({ s }: { s: Settings }) {
  const [glass, setGlass] = useState("");
  useEffect(() => {
    const load = () => void ipc.getGlassStatus().then(setGlass);
    load();
    const t = window.setInterval(load, 2000);
    return () => window.clearInterval(t);
  }, []);
  return (
    <>
      <Section title="Testing">
        <Row label="Simulation mode" hint="Every external widget uses realistic local data — no network, no keys. Values drift so automations fire.">
          <Toggle checked={s.simulation} onChange={(v) => update((x) => ({ ...x, simulation: v }))} />
        </Row>
        <Row label="Focus / Do Not Disturb" hint="Silences lumabar toasts (system notices still show)">
          <Toggle checked={s.doNotDisturb} onChange={(v) => update((x) => ({ ...x, doNotDisturb: v }))} />
        </Row>
      </Section>
      <Section title="Data">
        <Row label="Refresh providers every (minutes)">
          <CommitInput type="number" width={70} value={s.providers.pollMinutes} onCommit={(v) => update((x) => ({ ...x, providers: { ...x.providers, pollMinutes: Math.max(1, Math.min(120, Math.round(Number(v) || 5))) } }))} />
        </Row>
        <Row label="Storage" hint="Layout, notes, todos, screen time and encrypted keys">
          <span className="text-[11.5px] lb-muted">%APPDATA%\lumabar\lumabar.db</span>
        </Row>
        <Row label="Liquid glass capture" hint="DXGI desktop duplication status">
          <span className="max-w-[260px] truncate text-[11.5px] lb-muted" title={glass}>{glass || "—"}</span>
        </Row>
      </Section>
      <Section title="Safety">
        <Row label="Restore the Windows taskbar now" hint="Keeps lumabar running · same as Ctrl + Alt + Shift + R">
          <button className="lb-focus flex items-center gap-1 rounded-lg border-none px-2.5 py-1 text-[12px]" style={{ background: "var(--lb-track)" }} onClick={() => void ipc.setTaskbarMode("native")}>
            <Monitor size={12} /> Restore
          </button>
        </Row>
        <Row label="Restore Windows taskbar & quit">
          <button className="lb-focus flex items-center gap-1 rounded-lg border-none px-2.5 py-1 text-[12px] font-semibold" style={{ background: "var(--lb-red)", color: "#fff" }} onClick={() => void ipc.restoreTaskbarAndQuit()}>
            <Power size={12} /> Quit
          </button>
        </Row>
      </Section>
    </>
  );
}

export function SettingsModal() {
  const settings = useSettings();
  const [tab, setTab] = useState<Tab>("general");

  useEffect(() => {
    const off = subscribe("settings:navigate", (t) => {
      if (TABS.some((x) => x.id === t)) setTab(t as Tab);
    });
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && void ipc.hideWindow("settings");
    window.addEventListener("keydown", onKey);
    return () => {
      off();
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <div className="flex h-full w-full p-3">
      <div className="lb-menu flex h-full w-full overflow-hidden rounded-[26px]" style={{ color: "var(--lb-text)" }}>
        <nav data-tauri-drag-region className="flex w-[200px] shrink-0 flex-col gap-0.5 p-3" style={{ background: "var(--lb-card)" }}>
          <div data-tauri-drag-region className="mb-3 px-2 pt-1 text-[17px] font-semibold">
            Settings
          </div>
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className="lb-focus flex items-center gap-2 rounded-lg border-none px-2.5 py-2 text-left text-[12.5px]"
              style={{ background: tab === id ? "var(--lb-card-hover)" : "transparent", fontWeight: tab === id ? 600 : 400 }}
              onClick={() => setTab(id)}
            >
              <Icon size={14} className="lb-muted" />
              {label}
            </button>
          ))}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          <div data-tauri-drag-region className="flex items-center justify-between px-6 pb-2 pt-4">
            <h2 data-tauri-drag-region className="m-0 text-[15px] font-semibold">
              {TABS.find((t) => t.id === tab)?.label}
            </h2>
            <button className="lb-icon-btn h-8 w-8" onClick={() => void ipc.hideWindow("settings")} aria-label="Close">
              <X size={16} />
            </button>
          </div>
          <div className="lb-thin-scroll flex-1 overflow-y-auto px-6 pb-6">
            {!settings ? (
              <div className="py-10 text-center lb-muted">Loading…</div>
            ) : tab === "general" ? (
              <GeneralTab s={settings} />
            ) : tab === "accounts" ? (
              <AccountsTab s={settings} />
            ) : tab === "calendar" ? (
              <CalendarTab />
            ) : tab === "integrations" ? (
              <IntegrationsTab s={settings} />
            ) : tab === "automations" ? (
              <AutomationsTab s={settings} />
            ) : (
              <AdvancedTab s={settings} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
