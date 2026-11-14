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
import { LANGUAGES, useI18n, type TranslationKey } from "../i18n";
import { useHub } from "../engine/DataHub";
import { FROST_ORDER, SIZE_ORDER, SIZES, THEMES, THEME_ORDER } from "../engine/ThemeEngine";
import { patchSettings, useSettings } from "../lib/hooks";
import { formatPercent } from "../lib/format";
import { broadcast, errorMessage, ipc, subscribe } from "../lib/ipc";
import type { AutomationSettings, GlassFrost, Language, ProviderId, Settings, TaskbarMode } from "../types/lumabar";

type Tab = "general" | "accounts" | "calendar" | "integrations" | "automations" | "advanced";

const TABS: Array<{ id: Tab; label: TranslationKey; icon: LucideIcon }> = [
  { id: "general", label: "settings.tab.general", icon: Palette },
  { id: "accounts", label: "settings.tab.accounts", icon: KeyRound },
  { id: "calendar", label: "settings.tab.calendar", icon: CalendarDays },
  { id: "integrations", label: "settings.tab.integrations", icon: Plug },
  { id: "automations", label: "settings.tab.automations", icon: Zap },
  { id: "advanced", label: "settings.tab.advanced", icon: SlidersHorizontal },
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
        <div className="text-[12.5px]" style={{ overflowWrap: "anywhere" }}>{props.label}</div>
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
          className="lb-focus whitespace-nowrap rounded-md border-none px-2.5 py-1 text-[12px]"
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
  const { t, lang } = useI18n();
  const frostIndex = Math.max(0, FROST_ORDER.indexOf(s.glassFrost));
  const taskbarOptions: Array<{ value: TaskbarMode; label: string }> = [
    { value: "auto_hide", label: t("settings.taskbar.autoHide") },
    { value: "completely_hidden", label: t("settings.taskbar.hidden") },
    { value: "native", label: t("settings.taskbar.keep") },
  ];
  return (
    <>
      <Section title={t("settings.language")}>
        <Row label={t("settings.language")} hint={t("settings.languageHint")}>
          <Segmented<Language> value={lang} options={LANGUAGES.map((l) => ({ value: l.id, label: l.label }))} onChange={(language) => update((x) => ({ ...x, language }))} />
        </Row>
      </Section>
      <Section title={t("settings.surface")} description={t("settings.surfaceDesc")}>
        <div className="grid grid-cols-5 gap-2">
          {THEME_ORDER.map((id) => {
            const tokens = THEMES[id];
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
                    background: id === "liquid-glass" ? "linear-gradient(120deg, rgba(120,160,255,0.55), rgba(255,140,190,0.45))" : tokens.surface,
                    border: tokens.border,
                  }}
                >
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="h-6 flex-1 rounded-[7px]" style={{ background: tokens.card }} />
                  ))}
                </div>
                <div className="text-[12px] font-semibold">{t(`theme.${id}.name`)}</div>
                <div className="text-[10.5px] lb-muted">{t(`theme.${id}.desc`)}</div>
              </button>
            );
          })}
        </div>
        <Row label={t("settings.frost")} hint={s.theme === "liquid-glass" ? t(`frost.${FROST_ORDER[frostIndex]}`) : t("settings.frostHint")}>
          <div className="flex flex-col items-stretch gap-0.5" style={{ width: 230, opacity: s.theme === "liquid-glass" ? 1 : 0.5 }}>
            <input
              type="range"
              min={0}
              max={FROST_ORDER.length - 1}
              step={1}
              value={frostIndex}
              disabled={s.theme !== "liquid-glass"}
              aria-label={t("settings.frost")}
              aria-valuetext={t(`frost.${FROST_ORDER[frostIndex]}`)}
              onChange={(e) => {
                const glassFrost: GlassFrost = FROST_ORDER[Number(e.target.value)] ?? "balanced";
                update((x) => ({ ...x, glassFrost }));
              }}
              style={{ accentColor: "var(--lb-accent)" }}
            />
            <div className="flex justify-between text-[10.5px] lb-muted">
              {FROST_ORDER.map((id, i) => (
                <span key={id} className="whitespace-nowrap" style={{ fontWeight: i === frostIndex ? 600 : 400, color: i === frostIndex ? "var(--lb-text)" : undefined }}>
                  {t(`frost.${id}`)}
                </span>
              ))}
            </div>
          </div>
        </Row>
      </Section>
      <Section title={t("settings.size")}>
        <Row label={t("settings.dockHeight")} hint={`${SIZES[s.size].height}px`}>
          <Segmented value={s.size} options={SIZE_ORDER.map((id) => ({ value: id, label: t(`size.${id}`) }))} onChange={(size) => update((x) => ({ ...x, size }))} />
        </Row>
        <Row label={t("settings.accent")}>
          <input type="color" value={s.accent} onChange={(e) => update((x) => ({ ...x, accent: e.target.value }))} className="h-7 w-10 cursor-pointer rounded border-none bg-transparent" />
        </Row>
      </Section>
      <Section title={t("settings.dock")} description={t("settings.dockDesc")}>
        <Row label={t("settings.position")}>
          <Segmented
            value={s.position}
            options={[
              { value: "bottom", label: t("menu.bottom") },
              { value: "top", label: t("menu.top") },
            ]}
            onChange={(position) => void ipc.setDockPosition(position)}
          />
        </Row>
        <Row label={t("settings.hideFullscreen")} hint={t("settings.hideFullscreenHint")}>
          <Toggle checked={s.hideOnFullscreen} onChange={(v) => update((x) => ({ ...x, hideOnFullscreen: v }))} />
        </Row>
        <Row label={t("settings.launchAtLogin")}>
          <Toggle checked={s.launchAtLogin} onChange={(v) => update((x) => ({ ...x, launchAtLogin: v }))} />
        </Row>
      </Section>
      <Section title={t("settings.taskbar")} description={t("settings.taskbarDesc")}>
        <Row label={t("settings.nativeTaskbar")} hint={s.taskbarMode === "completely_hidden" ? t("settings.taskbar.hintHidden") : s.taskbarMode === "auto_hide" ? t("settings.taskbar.hintAutoHide") : t("settings.taskbar.hintKeep")}>
          <Segmented value={s.taskbarMode} options={taskbarOptions} onChange={(mode) => void ipc.setTaskbarMode(mode)} />
        </Row>
      </Section>
    </>
  );
}

interface SecretField {
  name: string;
  label: TranslationKey;
  hint?: string;
}

interface AccountSpec {
  id: ProviderId;
  name: string;
  fields: SecretField[];
  note?: TranslationKey;
}

const AI_ACCOUNTS: AccountSpec[] = [
  {
    id: "claude",
    name: "Claude",
    fields: [
      { name: "claude_session_key", label: "account.claude.session", hint: "sk-ant-sid…" },
      { name: "claude_oauth_token", label: "account.claude.oauth" },
    ],
    note: "account.claude.note",
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    fields: [
      { name: "chatgpt_access_token", label: "account.chatgpt.token" },
      { name: "chatgpt_account_id", label: "account.chatgpt.account" },
    ],
    note: "account.chatgpt.note",
  },
  {
    id: "gemini",
    name: "Gemini",
    fields: [
      { name: "gemini_oauth_token", label: "account.gemini.token" },
      { name: "gemini_project_id", label: "account.gemini.project" },
    ],
  },
  { id: "grok", name: "Grok (xAI)", fields: [{ name: "xai_management_key", label: "account.grok.key" }, { name: "xai_team_id", label: "account.grok.team" }] },
  { id: "deepseek", name: "DeepSeek", fields: [{ name: "deepseek_api_key", label: "account.apiKey" }] },
  { id: "glm", name: "GLM (Z.ai)", fields: [{ name: "glm_api_key", label: "account.glm.key" }] },
];

const OTHER_ACCOUNTS: AccountSpec[] = [
  { id: "stripe", name: "Stripe", fields: [{ name: "stripe_api_key", label: "account.stripe.key", hint: "rk_live_…" }] },
  { id: "polar", name: "Polar", fields: [{ name: "polar_access_token", label: "account.polar.token" }] },
  { id: "dodo", name: "Dodo Payments", fields: [{ name: "dodo_api_key", label: "account.apiKey" }] },
  { id: "datafast", name: "DataFast", fields: [{ name: "datafast_api_key", label: "account.datafast.key", hint: "df_…" }] },
  { id: "gmail", name: "Gmail", fields: [{ name: "gmail_oauth_token", label: "account.gmail.oauth" }, { name: "gmail_app_password", label: "account.gmail.appPassword" }] },
  { id: "x", name: "X", fields: [{ name: "x_bearer_token", label: "account.x.token" }] },
  { id: "youtube", name: "YouTube", fields: [{ name: "youtube_api_key", label: "account.youtube.key" }] },
  { id: "instagram", name: "Instagram", fields: [{ name: "instagram_access_token", label: "account.instagram.token" }] },
  { id: "github", name: "GitHub", fields: [{ name: "github_token", label: "account.github.token" }] },
];

function SecretInput({ field, isSet, onSaved }: { field: SecretField; isSet: boolean; onSaved: (names: string[]) => void }) {
  const { t } = useI18n();
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
        <span className="w-[230px] shrink-0 truncate text-[12px] lb-muted" title={t(field.label)}>{t(field.label)}</span>
        <input
          type="password"
          value={value}
          placeholder={isSet ? t("settings.secret.stored") : field.hint ?? t("settings.secret.paste")}
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
          {status === "saved" ? <Check size={13} /> : t("common.save")}
        </button>
        {isSet && (
          <button className="lb-icon-btn h-7 w-7" title={t("common.remove")} onClick={() => void save("")}>
            <X size={13} />
          </button>
        )}
      </div>
      {status === "error" && <div className="text-[11px]" style={{ color: "var(--lb-red)" }}>{error}</div>}
    </div>
  );
}

function ProviderBadge({ id }: { id: ProviderId }) {
  const { t } = useI18n();
  const result = useHub((s) => s.providers[id]);
  const [busy, setBusy] = useState(false);
  const status = result?.status ?? "loading";
  const color = status === "ok" ? "var(--lb-green)" : status === "error" ? "var(--lb-amber)" : status === "simulated" ? "var(--lb-purple)" : "var(--lb-faint)";
  const label = status === "loading" ? "…" : t(`settings.status.${status}`);
  return (
    <div className="flex items-center gap-1.5">
      <span className="flex items-center gap-1 text-[11px]" style={{ color }} title={result?.error ?? undefined}>
        {status === "ok" ? <CheckCircle2 size={12} /> : status === "error" ? <AlertTriangle size={12} /> : null}
        {label}
      </span>
      <button
        className="lb-icon-btn h-6 w-6"
        title={t("settings.refreshNow")}
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
  const { t } = useI18n();
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
      {spec.note && <div className="text-[11px] lb-faint">{t(spec.note)}</div>}
    </div>
  );
}

function AccountsTab({ s }: { s: Settings }) {
  const { t } = useI18n();
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => void ipc.getSecretNames().then(setNames), []);
  return (
    <>
      <div className="mb-4 flex items-center gap-2 rounded-xl px-3 py-2 text-[12px]" style={{ background: "rgba(48,209,88,0.12)" }}>
        <Lock size={14} className="shrink-0" style={{ color: "var(--lb-green)" }} />
        {t("settings.keysNotice")}
      </div>
      <Section title={t("settings.aiLimits")}>
        <Row label={t("settings.localCli")} hint={t("settings.localCliHint")}>
          <Toggle checked={s.providers.useLocalCliCredentials} onChange={(v) => update((x) => ({ ...x, providers: { ...x.providers, useLocalCliCredentials: v } }))} />
        </Row>
        {AI_ACCOUNTS.map((a) => (
          <AccountCard key={a.id} spec={a} names={names} setNames={setNames} />
        ))}
      </Section>
      <Section title={t("settings.otherAccounts")}>
        {OTHER_ACCOUNTS.map((a) => (
          <AccountCard key={a.id} spec={a} names={names} setNames={setNames} />
        ))}
      </Section>
    </>
  );
}

function CalendarTab() {
  const { t } = useI18n();
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
      title={t("settings.ics")}
      description={t("settings.icsDesc")}
    >
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={configured ? t("settings.icsStored") : "https://calendar.google.com/calendar/ical/…/basic.ics"}
        className="lb-focus lb-thin-scroll h-28 w-full resize-none rounded-xl border-none p-3 text-[12px] outline-none"
        style={{ background: "var(--lb-card)" }}
      />
      <div className="flex items-center gap-2">
        <button className="lb-focus rounded-lg border-none px-3 py-1.5 text-[12px] font-semibold" style={{ background: "var(--lb-accent)", color: "#fff" }} disabled={!value.trim()} onClick={() => void save(value)}>
          {saved ? t("common.saved") : t("settings.saveFeeds")}
        </button>
        {configured && (
          <button className="lb-focus rounded-lg border-none px-3 py-1.5 text-[12px]" style={{ background: "var(--lb-card)" }} onClick={() => void save("")}>
            {t("settings.removeFeeds")}
          </button>
        )}
        <span className="ml-auto text-[12px] lb-muted">
          {result?.status === "ok" && t("settings.upcomingEvents", { count })}
          {result?.status === "simulated" && t("settings.simulationMode")}
          {result?.status === "error" && <span style={{ color: "var(--lb-amber)" }}>{result.error}</span>}
        </span>
        <ProviderBadge id="calendar" />
      </div>
      {error && <div className="text-[11px]" style={{ color: "var(--lb-red)" }}>{error}</div>}
    </Section>
  );
}

function IntegrationsTab({ s }: { s: Settings }) {
  const { t } = useI18n();
  const p = s.providers;
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => void ipc.getSecretNames().then(setNames), []);
  const setP = (patch: Partial<Settings["providers"]>) => update((x) => ({ ...x, providers: { ...x.providers, ...patch } }));
  const num = (v: string, fallback: number) => (Number.isFinite(Number(v)) && v.trim() !== "" ? Number(v) : fallback);
  return (
    <>
      <Section title={t("settings.handles")}>
        <Row label={t("settings.leetcodeUser")}><CommitInput value={p.leetcodeUsername} onCommit={(v) => setP({ leetcodeUsername: v.trim() })} /></Row>
        <Row label={t("settings.githubUser")} hint={t("settings.githubUserHint")}><CommitInput value={p.githubUsername} onCommit={(v) => setP({ githubUsername: v.trim() })} /></Row>
        <Row label={t("settings.xHandle")}><CommitInput value={p.xUsername} placeholder="@handle" onCommit={(v) => setP({ xUsername: v.trim() })} /></Row>
        <Row label={t("settings.youtubeChannel")} hint={t("settings.youtubeChannelHint")}><CommitInput value={p.youtubeChannelId} onCommit={(v) => setP({ youtubeChannelId: v.trim() })} /></Row>
        <Row label={t("settings.instagramId")} hint={t("settings.instagramIdHint")}><CommitInput value={p.instagramUserId} onCommit={(v) => setP({ instagramUserId: v.trim() })} /></Row>
        <Row label={t("settings.gmailAddress")} hint={t("settings.gmailAddressHint")}><CommitInput value={p.gmailAddress} onCommit={(v) => setP({ gmailAddress: v.trim() })} /></Row>
      </Section>
      <Section title={t("settings.apiCounter")} description={t("settings.apiCounterDesc")}>
        <Row label={t("settings.endpointUrl")}><CommitInput width={280} value={p.apiCounterUrl} placeholder="https://api.example.com/stats" onCommit={(v) => setP({ apiCounterUrl: v.trim() })} /></Row>
        <Row label={t("settings.jsonPath")}><CommitInput value={p.apiCounterJsonPath} placeholder="data.count" onCommit={(v) => setP({ apiCounterJsonPath: v.trim() })} /></Row>
        <Row label={t("settings.label")}><CommitInput value={p.apiCounterLabel} onCommit={(v) => setP({ apiCounterLabel: v })} /></Row>
        <div className="rounded-xl p-3" style={{ background: "var(--lb-card)" }}>
          <SecretInput field={{ name: "api_counter_token", label: "settings.bearerToken" }} isSet={names.includes("api_counter_token")} onSaved={setNames} />
        </div>
      </Section>
      <Section title={t("settings.weather")} description={t("settings.weatherDesc")}>
        <Row label={t("settings.cityLabel")}><CommitInput value={p.weatherCity} onCommit={(v) => setP({ weatherCity: v })} /></Row>
        <Row label={t("settings.latLon")}>
          <CommitInput type="number" width={95} value={p.weatherLatitude} onCommit={(v) => setP({ weatherLatitude: num(v, p.weatherLatitude) })} />
          <CommitInput type="number" width={95} value={p.weatherLongitude} onCommit={(v) => setP({ weatherLongitude: num(v, p.weatherLongitude) })} />
        </Row>
        <Row label={t("settings.units")}>
          <Segmented value={p.weatherFahrenheit ? "f" : "c"} options={[{ value: "f", label: "°F" }, { value: "c", label: "°C" }]} onChange={(v) => setP({ weatherFahrenheit: v === "f" })} />
        </Row>
      </Section>
      <Section title={t("settings.goals")}>
        <Row label={t("settings.revenueGoal")} hint={t("settings.revenueGoalHint")}><CommitInput type="number" width={110} value={p.revenueGoal} onCommit={(v) => setP({ revenueGoal: num(v, p.revenueGoal) })} /></Row>
        <Row label={t("settings.deepseekBudget")} hint={t("settings.deepseekBudgetHint")}><CommitInput type="number" width={110} value={p.deepseekBudget} onCommit={(v) => setP({ deepseekBudget: num(v, p.deepseekBudget) })} /></Row>
        <Row label={t("settings.grokBudget")}><CommitInput type="number" width={110} value={p.grokBudget} onCommit={(v) => setP({ grokBudget: num(v, p.grokBudget) })} /></Row>
      </Section>
      <Section title={t("settings.worldClocks")} description={t("settings.worldClocksDesc")}>
        {s.worldClocks.map((c, i) => (
          <Row key={i} label={t("settings.clockN", { n: i + 1 })}>
            <CommitInput width={70} value={c.label} onCommit={(v) => update((x) => ({ ...x, worldClocks: x.worldClocks.map((w, j) => (j === i ? { ...w, label: v.slice(0, 4).toUpperCase() } : w)) }))} />
            <CommitInput width={170} value={c.timeZone} onCommit={(v) => update((x) => ({ ...x, worldClocks: x.worldClocks.map((w, j) => (j === i ? { ...w, timeZone: v.trim() } : w)) }))} />
          </Row>
        ))}
      </Section>
      <Section title={t("settings.pomodoro")}>
        <Row label={t("settings.pomodoroMinutes")}>
          <CommitInput type="number" width={70} value={s.pomodoroFocusMinutes} onCommit={(v) => update((x) => ({ ...x, pomodoroFocusMinutes: Math.max(1, Math.round(num(v, 25))) }))} />
          <CommitInput type="number" width={70} value={s.pomodoroBreakMinutes} onCommit={(v) => update((x) => ({ ...x, pomodoroBreakMinutes: Math.max(1, Math.round(num(v, 5))) }))} />
        </Row>
      </Section>
    </>
  );
}

function TestButton({ rule }: { rule: keyof AutomationSettings }) {
  const { t } = useI18n();
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
        {t("common.test")}
      </button>
    </div>
  );
}

function AutomationsTab({ s }: { s: Settings }) {
  const { t } = useI18n();
  const a = s.automations;
  const setA = (patch: Partial<AutomationSettings>) => update((x) => ({ ...x, automations: { ...x.automations, ...patch } }));
  return (
    <>
      <Section title={t("settings.rule1")} description={t("settings.rule1Desc")}>
        <Row label={t("common.enabled")}>
          <TestButton rule="preMeetingPause" />
          <Toggle checked={a.preMeetingPause.enabled} onChange={(v) => setA({ preMeetingPause: { ...a.preMeetingPause, enabled: v } })} />
        </Row>
        <Row label={t("settings.minutesBefore")}>
          <CommitInput type="number" width={70} value={a.preMeetingPause.minutes} onCommit={(v) => setA({ preMeetingPause: { ...a.preMeetingPause, minutes: Math.max(1, Math.min(60, Math.round(Number(v) || 5))) } })} />
        </Row>
      </Section>
      <Section title={t("settings.rule2")} description={t("settings.rule2Desc")}>
        <Row label={t("common.enabled")}>
          <TestButton rule="aiLimitWarning" />
          <Toggle checked={a.aiLimitWarning.enabled} onChange={(v) => setA({ aiLimitWarning: { ...a.aiLimitWarning, enabled: v } })} />
        </Row>
        <Row label={t("settings.threshold")} hint={formatPercent(a.aiLimitWarning.thresholdPercent)}>
          <input
            type="range"
            min={50}
            max={99}
            value={a.aiLimitWarning.thresholdPercent}
            onChange={(e) => setA({ aiLimitWarning: { ...a.aiLimitWarning, thresholdPercent: Number(e.target.value) } })}
            style={{ accentColor: "var(--lb-accent)" }}
          />
        </Row>
        <Row label={t("settings.horizon")}>
          <CommitInput type="number" width={70} value={a.aiLimitWarning.horizonHours} onCommit={(v) => setA({ aiLimitWarning: { ...a.aiLimitWarning, horizonHours: Math.max(1, Number(v) || 24) } })} />
        </Row>
      </Section>
      <Section title={t("settings.rule3")} description={t("settings.rule3Desc")}>
        <Row label={t("common.enabled")}>
          <TestButton rule="revenueMilestone" />
          <Toggle checked={a.revenueMilestone.enabled} onChange={(v) => setA({ revenueMilestone: { ...a.revenueMilestone, enabled: v } })} />
        </Row>
        <Row label={t("settings.milestones")} hint={t("settings.milestonesHint")}>
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
      <Section title={t("settings.rule4")} description={t("settings.rule4Desc")}>
        <Row label={t("common.enabled")}>
          <TestButton rule="renewalReminder" />
          <Toggle checked={a.renewalReminder.enabled} onChange={(v) => setA({ renewalReminder: { ...a.renewalReminder, enabled: v } })} />
        </Row>
        <Row label={t("settings.lookAhead")}>
          <CommitInput type="number" width={70} value={a.renewalReminder.hours} onCommit={(v) => setA({ renewalReminder: { ...a.renewalReminder, hours: Math.max(1, Number(v) || 24) } })} />
        </Row>
        <Row label={t("settings.keywords")}>
          <CommitInput
            width={240}
            value={a.renewalReminder.keywords.join(", ")}
            onCommit={(v) => setA({ renewalReminder: { ...a.renewalReminder, keywords: v.split(",").map((k) => k.trim()).filter(Boolean) } })}
          />
        </Row>
      </Section>
      <Row label={t("settings.resetHistory")} hint={t("settings.resetHistoryHint")}>
        <button className="lb-focus rounded-lg border-none px-2.5 py-1 text-[12px]" style={{ background: "var(--lb-track)" }} onClick={() => void broadcast("automation:reset", null)}>
          {t("common.reset")}
        </button>
      </Row>
    </>
  );
}

function AdvancedTab({ s }: { s: Settings }) {
  const { t } = useI18n();
  const [glass, setGlass] = useState("");
  useEffect(() => {
    const load = () => void ipc.getGlassStatus().then(setGlass);
    load();
    const t = window.setInterval(load, 2000);
    return () => window.clearInterval(t);
  }, []);
  return (
    <>
      <Section title={t("settings.testing")}>
        <Row label={t("settings.simulation")} hint={t("settings.simulationHint")}>
          <Toggle checked={s.simulation} onChange={(v) => update((x) => ({ ...x, simulation: v }))} />
        </Row>
        <Row label={t("settings.dnd")} hint={t("settings.dndHint")}>
          <Toggle checked={s.doNotDisturb} onChange={(v) => update((x) => ({ ...x, doNotDisturb: v }))} />
        </Row>
      </Section>
      <Section title={t("settings.data")}>
        <Row label={t("settings.pollMinutes")}>
          <CommitInput type="number" width={70} value={s.providers.pollMinutes} onCommit={(v) => update((x) => ({ ...x, providers: { ...x.providers, pollMinutes: Math.max(1, Math.min(120, Math.round(Number(v) || 5))) } }))} />
        </Row>
        <Row label={t("settings.storage")} hint={t("settings.storageHint")}>
          <span className="text-[11.5px] lb-muted">%APPDATA%\lumabar\lumabar.db</span>
        </Row>
        <Row label={t("settings.glassCapture")} hint={t("settings.glassCaptureHint")}>
          <span className="max-w-[260px] truncate text-[11.5px] lb-muted" title={glass}>{glass || "—"}</span>
        </Row>
      </Section>
      <Section title={t("settings.safety")}>
        <Row label={t("settings.restoreNow")} hint={t("settings.restoreNowHint")}>
          <button className="lb-focus flex items-center gap-1 rounded-lg border-none px-2.5 py-1 text-[12px]" style={{ background: "var(--lb-track)" }} onClick={() => void ipc.setTaskbarMode("native")}>
            <Monitor size={12} /> {t("common.restore")}
          </button>
        </Row>
        <Row label={t("settings.restoreQuit")}>
          <button className="lb-focus flex items-center gap-1 rounded-lg border-none px-2.5 py-1 text-[12px] font-semibold" style={{ background: "var(--lb-red)", color: "#fff" }} onClick={() => void ipc.restoreTaskbarAndQuit()}>
            <Power size={12} /> {t("common.quit")}
          </button>
        </Row>
      </Section>
    </>
  );
}

export function SettingsModal() {
  const settings = useSettings();
  const { t } = useI18n();
  // The window is created on demand; the tab to open arrives in its URL.
  const [tab, setTab] = useState<Tab>(() => {
    const requested = new URLSearchParams(window.location.search).get("tab");
    return TABS.some((x) => x.id === requested) ? (requested as Tab) : "general";
  });

  useEffect(() => {
    const off = subscribe("settings:navigate", (t) => {
      if (TABS.some((x) => x.id === t)) setTab(t as Tab);
    });
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && void ipc.closeWindow("settings");
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
            {t("settings.title")}
          </div>
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className="lb-focus flex items-center gap-2 rounded-lg border-none px-2.5 py-2 text-left text-[12.5px]"
              style={{ background: tab === id ? "var(--lb-card-hover)" : "transparent", fontWeight: tab === id ? 600 : 400 }}
              onClick={() => setTab(id)}
            >
              <Icon size={14} className="lb-muted" />
              <span className="truncate">{t(label)}</span>
            </button>
          ))}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          <div data-tauri-drag-region className="flex items-center justify-between px-6 pb-2 pt-4">
            <h2 data-tauri-drag-region className="m-0 text-[15px] font-semibold">
              {t(TABS.find((x) => x.id === tab)?.label ?? "settings.title")}
            </h2>
            <button className="lb-icon-btn h-8 w-8" onClick={() => void ipc.closeWindow("settings")} aria-label={t("common.close")}>
              <X size={16} />
            </button>
          </div>
          <div className="lb-thin-scroll flex-1 overflow-y-auto px-6 pb-6">
            {!settings ? (
              <div className="py-10 text-center lb-muted">{t("common.loading")}</div>
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
