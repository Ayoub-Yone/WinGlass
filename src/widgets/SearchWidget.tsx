// Integrated launcher: replaces the Windows Search (Win+S) overlay, which never opens over lumabar.
// The backend indexes Start Menu / Desktop shortcuts and App Paths executables
// (`search_installed_apps`, fuzzy + prefix: "riot" -> Client Riot, VALORANT, League of Legends);
// results render in a frosted popover directly above (or below, top dock) the search card.
//   ↑ / ↓ select · Enter launches and dismisses · Esc / click outside closes.

import { Globe, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AppIcon } from "../components/AppIcon";
import { Popover, WidgetCard } from "../components/ui";
import { useI18n } from "../i18n";
import { errorMessage, ipc } from "../lib/ipc";
import type { AppHit, WidgetProps } from "../types/lumabar";

type Item =
  | { kind: "app"; hit: AppHit }
  | { kind: "url"; url: string }
  | { kind: "web"; query: string };

const URL_RE = /^(https?:\/\/)?[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/i;

export function looksLikeUrl(q: string): boolean {
  return URL_RE.test(q) && !q.includes(" ");
}

export function SearchWidget({ span, preview }: WidgetProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<AppHit[]>([]);
  const [selected, setSelected] = useState(0);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const card = useRef<HTMLDivElement | null>(null);
  const seq = useRef(0);

  const q = query.trim();
  const items: Item[] = [
    ...hits.map((hit) => ({ kind: "app" as const, hit })),
    ...(q && looksLikeUrl(q) ? [{ kind: "url" as const, url: q.startsWith("http") ? q : `https://${q}` }] : []),
    ...(q ? [{ kind: "web" as const, query: q }] : []),
  ];

  // Debounced search; stale answers (slower than a newer keystroke) are dropped.
  useEffect(() => {
    if (preview) return;
    if (!q) {
      setHits([]);
      setOpen(false);
      return;
    }
    const id = ++seq.current;
    const timer = window.setTimeout(() => {
      ipc
        .searchInstalledApps(q)
        .then((r) => {
          if (id !== seq.current) return;
          setHits(r);
          setSelected(0);
          setOpen(true);
        })
        .catch((e) => id === seq.current && setError(errorMessage(e)));
    }, 70);
    return () => window.clearTimeout(timer);
  }, [q, preview]);

  const dismiss = () => {
    seq.current++;
    setOpen(false);
    setQuery("");
    setHits([]);
    input.current?.blur();
  };

  const run = (item: Item | undefined) => {
    if (!item || preview) return;
    setError(null);
    const action =
      item.kind === "app"
        ? ipc.launchApp(item.hit.path)
        : item.kind === "url"
          ? ipc.openTarget(item.url)
          : ipc.openTarget(`https://www.bing.com/search?q=${encodeURIComponent(item.query)}`);
    action.then(dismiss).catch((e) => setError(errorMessage(e)));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!items.length) return;
      setOpen(true);
      const dir = e.key === "ArrowDown" ? 1 : -1;
      setSelected((s) => (s + dir + items.length) % items.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(items[Math.min(selected, items.length - 1)]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      dismiss();
    }
  };

  return (
    <>
      <WidgetCard span={span} cardRef={card} title={error ?? t("search.title")} onClick={() => input.current?.focus()}>
        <div className="flex w-full min-w-0 items-center gap-2">
          <button
            className="lb-icon-btn h-6 w-6 shrink-0"
            onClick={(e) => {
              e.stopPropagation();
              if (q) run(items[selected]);
              else input.current?.focus();
            }}
            aria-label={t("search.open")}
          >
            <Search size={15} className="lb-muted" />
          </button>
          <input
            ref={input}
            data-testid="search-input"
            value={query}
            disabled={preview}
            onChange={(e) => {
              setQuery(e.target.value);
              setError(null);
            }}
            onFocus={() => q && setOpen(true)}
            onKeyDown={onKeyDown}
            placeholder={t("search.placeholder")}
            spellCheck={false}
            className="min-w-0 flex-1 truncate border-none bg-transparent outline-none placeholder:text-[var(--lb-muted)]"
          />
        </div>
      </WidgetCard>
      <Popover anchor={card} open={open && !preview && !!q} onClose={() => setOpen(false)} width={380}>
        <div data-testid="search-results" className="flex flex-col gap-0.5">
          {hits.length === 0 && (
            <div className="px-2 py-1.5 lb-muted" style={{ fontSize: "var(--lb-small)" }}>
              {t("search.noResults")}
            </div>
          )}
          {items.map((item, i) => {
            const active = i === selected;
            const common = {
              "data-active": active,
              onMouseEnter: () => setSelected(i),
              onClick: () => run(item),
              className: "lb-row flex w-full items-center gap-2.5 rounded-lg border-none bg-transparent px-2 py-1.5 text-left",
              style: { color: "var(--lb-text)" },
            };
            if (item.kind === "app") {
              return (
                <button key={item.hit.path} data-testid="search-hit" {...common}>
                  <AppIcon iconKey={item.hit.path} />
                  <span className="min-w-0 flex-1 truncate font-medium">{item.hit.name}</span>
                  <span className="max-w-[40%] shrink-0 truncate lb-faint" style={{ fontSize: "var(--lb-small)" }}>
                    {item.hit.folder ?? t("search.app")}
                  </span>
                </button>
              );
            }
            const label = item.kind === "url" ? t("search.openUrl", { url: item.url }) : t("search.web", { q: item.query });
            return (
              <button key={item.kind} {...common}>
                <Globe size={18} className="mx-[3px] shrink-0 lb-muted" />
                <span className="min-w-0 flex-1 truncate">{label}</span>
              </button>
            );
          })}
          <div className="mt-1 px-2 lb-faint" style={{ fontSize: "calc(var(--lb-small) - 1px)" }}>
            {t("search.hint")}
          </div>
          {error && (
            <div className="truncate px-2" style={{ fontSize: "var(--lb-small)", color: "var(--lb-red)" }} title={error}>
              {error}
            </div>
          )}
        </div>
      </Popover>
    </>
  );
}
