// Windows SMTC "Now Playing": album art, two-line metadata, prev / play-pause / next.

import { Music, Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { useState } from "react";
import { WidgetCard } from "../components/ui";
import { errorMessage, ipc } from "../lib/ipc";
import { useMedia, usePreview } from "../lib/hooks";
import type { WidgetProps } from "../types/lumabar";

function sourceName(aumid: string): string {
  const base = aumid.split("!").pop() ?? aumid;
  const name = base.replace(/\.exe$/i, "").split(/[._]/).filter(Boolean).pop() ?? "";
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : "";
}

export function MediaController({ span }: WidgetProps) {
  const media = useMedia();
  const preview = usePreview();
  const [error, setError] = useState<string | null>(null);
  const playing = media.status === "Playing";

  const run = (action: "toggle" | "next" | "previous") => {
    if (preview) return;
    setError(null);
    ipc.mediaCommand(action).catch((e) => setError(errorMessage(e)));
  };

  const art = (
    <div
      className="flex aspect-square h-[calc(100%-8px)] shrink-0 items-center justify-center overflow-hidden rounded-[9px]"
      style={{ background: "var(--lb-card-hover)" }}
    >
      {media.thumbnail ? (
        <img src={media.thumbnail} alt="" className="h-full w-full object-cover" draggable={false} />
      ) : (
        <Music size={16} className="lb-muted" />
      )}
    </div>
  );

  if (!media.available || !media.title) {
    return (
      <WidgetCard span={span}>
        <div className="flex h-full w-full items-center gap-2">
          {art}
          <div className="min-w-0 leading-tight">
            <div className="truncate font-semibold">Not playing</div>
            <div className="truncate lb-muted" style={{ fontSize: "var(--lb-small)" }}>
              Start music in any app
            </div>
          </div>
        </div>
      </WidgetCard>
    );
  }

  const playButton = (
    <button
      className="lb-icon-btn shrink-0"
      style={{ width: 28, height: 28, background: "var(--lb-accent)", color: "#fff" }}
      onClick={(e) => {
        e.stopPropagation();
        run("toggle");
      }}
      aria-label={playing ? "Pause" : "Play"}
    >
      {playing ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" className="translate-x-[1px]" />}
    </button>
  );

  return (
    <WidgetCard span={span} title={error ?? `${media.title} — ${media.artist}`} padded={false} className="pl-1 pr-2">
      <div className="flex h-full w-full items-center gap-2">
        {art}
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate font-semibold">{media.title}</div>
          <div className="truncate lb-muted" style={{ fontSize: "var(--lb-small)" }}>
            {media.artist || sourceName(media.sourceApp)}
          </div>
        </div>
        {span === "3x1" && (
          <button className="lb-icon-btn h-6 w-6 shrink-0" disabled={!media.canPrevious} onClick={() => run("previous")} aria-label="Previous">
            <SkipBack size={13} fill="currentColor" />
          </button>
        )}
        {playButton}
        {span !== "1x1" && (
          <button className="lb-icon-btn h-6 w-6 shrink-0" disabled={!media.canNext} onClick={() => run("next")} aria-label="Next">
            <SkipForward size={13} fill="currentColor" />
          </button>
        )}
      </div>
    </WidgetCard>
  );
}
