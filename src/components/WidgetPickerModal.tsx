// Searchable bento catalog of every widget with live miniature previews. Previews render the real
// widget components (PreviewContext supplies sample data for providers that are not set up yet).

import { Check, Plus, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { PreviewContext } from "../lib/hooks";
import { errorMessage, ipc, subscribe } from "../lib/ipc";
import { CATEGORIES, WIDGETS, categoryLabel, newInstance, sanitizeLayout, searchWidgets, widgetDescription, widgetName } from "../widgets/WidgetRegistry";
import type { LayoutItem, Span, WidgetCategory, WidgetDefinition } from "../types/lumabar";

function PreviewStrip({ def, span }: { def: WidgetDefinition; span: Span }) {
  const Component = def.component;
  const instance = useMemo<LayoutItem>(() => ({ instanceId: `preview-${def.id}`, widgetId: def.id, span }), [def.id, span]);
  return (
    <div className="pointer-events-none flex justify-center overflow-hidden rounded-[18px] py-3" style={{ background: "rgba(0,0,0,0.18)" }}>
      <div className="lb-pill flex max-w-full items-center overflow-hidden" style={{ height: "var(--lb-height)", padding: "var(--lb-padding)" }}>
        <PreviewContext.Provider value={true}>
          <Component instance={instance} span={span} preview />
        </PreviewContext.Provider>
      </div>
    </div>
  );
}

function WidgetTile(props: { def: WidgetDefinition; count: number; onAdd: (span: Span) => Promise<void> }) {
  const { def, count, onAdd } = props;
  const i18n = useI18n();
  const { t } = i18n;
  const [span, setSpan] = useState<Span>(def.defaultSize);
  const [state, setState] = useState<"idle" | "adding" | "added">("idle");
  const wide = span === "3x1" || def.id === "apps";
  const Icon = def.icon;
  return (
    <div data-widget-tile={def.id} className={`flex flex-col gap-2.5 rounded-[20px] p-3 ${wide ? "col-span-2" : ""}`} style={{ background: "var(--lb-card)" }}>
      <PreviewStrip def={def} span={span} />
      <div className="flex items-start gap-2">
        <Icon size={15} className="mt-[1px] shrink-0 lb-muted" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5 font-semibold">
            <span className="truncate">{widgetName(def, i18n)}</span>
            {count > 0 && (
              <span className="shrink-0 whitespace-nowrap rounded-full px-1.5 text-[10px] font-medium" style={{ background: "var(--lb-card-hover)" }}>
                {t("picker.inDock", { count })}
              </span>
            )}
          </div>
          <div className="text-[11.5px] lb-muted">{widgetDescription(def, i18n)}</div>
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        {def.sizes.length > 1 &&
          def.sizes.map((s) => (
            <button
              key={s}
              className="lb-focus rounded-full border-none px-2 py-0.5 text-[11px]"
              style={{ background: s === span ? "var(--lb-accent)" : "var(--lb-card-hover)", color: s === span ? "#fff" : undefined }}
              onClick={() => setSpan(s)}
            >
              {s}
            </button>
          ))}
        <button
          className="lb-focus ml-auto flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border-none px-3 py-1 text-[12px] font-semibold"
          style={{ background: state === "added" ? "var(--lb-green)" : "var(--lb-accent)", color: "#fff" }}
          disabled={state === "adding"}
          onClick={async () => {
            setState("adding");
            try {
              await onAdd(span);
              setState("added");
              window.setTimeout(() => setState("idle"), 1400);
            } catch {
              setState("idle");
            }
          }}
        >
          {state === "added" ? <Check size={12} /> : <Plus size={12} />}
          {state === "added" ? t("common.added") : t("common.add")}
        </button>
      </div>
    </div>
  );
}

export function WidgetPickerModal() {
  const i18n = useI18n();
  const { t } = i18n;
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<WidgetCategory | "All">("All");
  const [layout, setLayout] = useState<LayoutItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void ipc.getLayout().then((l) => setLayout(sanitizeLayout(l)));
    const off = subscribe("layout:changed", ({ layout: l }) => setLayout(sanitizeLayout(l)));
    const onFocus = () => {
      input.current?.focus();
      void ipc.getLayout().then((l) => setLayout(sanitizeLayout(l)));
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && void ipc.closeWindow("picker");
    window.addEventListener("focus", onFocus);
    window.addEventListener("keydown", onKey);
    return () => {
      off();
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const results = searchWidgets(query, category, i18n);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    layout.forEach((l) => m.set(l.widgetId, (m.get(l.widgetId) ?? 0) + 1));
    return m;
  }, [layout]);

  const add = async (def: WidgetDefinition, span: Span) => {
    setError(null);
    try {
      const current = sanitizeLayout(await ipc.getLayout());
      if (def.id === "apps" && current.some((l) => l.widgetId === "apps")) throw new Error(t("picker.appsAlreadyAdded"));
      const next = def.id === "apps" ? [newInstance(def.id, span), ...current] : [...current, newInstance(def.id, span)];
      await ipc.saveLayout(next);
      setLayout(next);
    } catch (err) {
      setError(errorMessage(err));
      throw err;
    }
  };

  return (
    <div className="flex h-full w-full p-3">
      <div className="lb-menu flex h-full w-full flex-col overflow-hidden rounded-[26px]" style={{ color: "var(--lb-text)" }}>
        <div data-tauri-drag-region className="flex items-center gap-3 px-5 pb-3 pt-4">
          <div data-tauri-drag-region className="shrink-0 whitespace-nowrap text-[17px] font-semibold">
            {t("picker.title")}
          </div>
          <div className="flex flex-1 items-center gap-2 rounded-full px-3 py-1.5" style={{ background: "var(--lb-card)" }}>
            <Search size={14} className="lb-muted" />
            <input
              ref={input}
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("picker.search", { count: WIDGETS.length })}
              className="min-w-0 flex-1 border-none bg-transparent outline-none placeholder:text-[var(--lb-muted)]"
            />
          </div>
          <button className="lb-icon-btn h-8 w-8" onClick={() => void ipc.closeWindow("picker")} aria-label={t("common.close")}>
            <X size={16} />
          </button>
        </div>
        <div className="lb-noscroll flex gap-1.5 overflow-x-auto px-5 pb-3">
          {(["All", ...CATEGORIES] as const).map((c) => (
            <button
              key={c}
              className="lb-focus shrink-0 whitespace-nowrap rounded-full border-none px-3 py-1 text-[12px]"
              style={{ background: c === category ? "var(--lb-text)" : "var(--lb-card)", color: c === category ? "var(--lb-menu)" : undefined }}
              onClick={() => setCategory(c)}
            >
              {categoryLabel(c, i18n)}
            </button>
          ))}
        </div>
        {error && (
          <div className="mx-5 mb-2 rounded-lg px-3 py-1.5 text-[12px]" style={{ background: "rgba(255,69,58,0.15)", color: "var(--lb-red)" }}>
            {error}
          </div>
        )}
        <div className="lb-thin-scroll grid flex-1 auto-rows-min grid-cols-2 gap-3 overflow-y-auto px-5 pb-5 md:grid-cols-3">
          {results.map((def) => (
            <WidgetTile key={def.id} def={def} count={counts.get(def.id) ?? 0} onAdd={(span) => add(def, span)} />
          ))}
          {results.length === 0 && <div className="col-span-full py-10 text-center lb-muted">{t("picker.noMatch", { query })}</div>}
        </div>
      </div>
    </div>
  );
}
