// App icons by key (exe / shortcut path, or hwnd:<n>) from the backend's bounded icon LRU.

import { AppWindow } from "lucide-react";
import { useEffect, useState } from "react";
import { ipc } from "../lib/ipc";

/** Bounded per-window icon cache (the backend LRU holds the PNGs; this only avoids re-asking). */
const ICONS = new Map<string, string | null>();
const ICON_LIMIT = 64;

export function useIcon(path: string): string | null {
  const [url, setUrl] = useState<string | null>(() => ICONS.get(path) ?? null);
  useEffect(() => {
    if (ICONS.has(path)) {
      setUrl(ICONS.get(path) ?? null);
      return;
    }
    let alive = true;
    void ipc
      .getAppIcon(path)
      .then((u) => {
        if (ICONS.size >= ICON_LIMIT) ICONS.delete(ICONS.keys().next().value as string);
        ICONS.set(path, u);
        if (alive) setUrl(u);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [path]);
  return url;
}

export function AppIcon({ iconKey, size = 24 }: { iconKey: string; size?: number }) {
  const url = useIcon(iconKey);
  return url ? (
    <img src={url} alt="" className="shrink-0 object-contain" style={{ width: size, height: size }} draggable={false} />
  ) : (
    <AppWindow size={Math.round(size * 0.82)} className="shrink-0 lb-muted" />
  );
}

