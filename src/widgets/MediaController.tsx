// Windows SMTC "Now Playing": album art, two-line metadata, prev / play-pause / next.
// Liner (tryliner.fun) is prioritized by the backend; when it is the source the card shows a
// subtle "Liner" pill and the artwork focuses the player window (or launches it).
// With artwork the cover fills the whole tile edge to edge (iOS Now Playing): a 350 ms crossfade +
// zoom between tracks, a multi-stop scrim and text shadows keep the controls readable on any cover.

import { Music, Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { useEffect, useState } from "react";
import { WidgetCard } from "../components/ui";
import { useI18n } from "../i18n";
import { errorMessage, ipc } from "../lib/ipc";
import { useMedia, usePreview } from "../lib/hooks";
import type { WidgetProps } from "../types/winglass";

function sourceName(aumid: string): string {
  const base = aumid.split("!").pop() ?? aumid;
  const name = base.replace(/\.exe$/i, "").split(/[._]/).filter(Boolean).pop() ?? "";
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : "";
}

function LinerPill() {
  return (
    <span
      data-testid="liner-pill"
      className="shrink-0 rounded-full px-1.5 font-semibold uppercase tracking-wide"
      style={{
        fontSize: "calc(var(--lb-small) - 2px)",
        lineHeight: "1.55",
        color: "var(--lb-text)",
        background: "color-mix(in srgb, var(--lb-accent) 30%, transparent)",
        boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--lb-accent) 55%, transparent)",
      }}
    >
      Liner
    </span>
  );
}

/** Full-bleed artwork: each new cover crossfades in over the previous one, which is then dropped. */
function CoverArt({ src }: { src: string }) {
  const [layers, setLayers] = useState([{ src, key: 0 }]);
  useEffect(() => {
    setLayers((l) => {
      const top = l[l.length - 1];
      return top.src === src ? l : [top, { src, key: top.key + 1 }];
    });
  }, [src]);
  return layers.map((layer, i) => (
    <img
      key={layer.key}
      src={layer.src}
      alt=""
      draggable={false}
      className="lb-cover"
      onAnimationEnd={i > 0 ? () => setLayers([layer]) : undefined}
    />
  ));
}

export function MediaController({ span }: WidgetProps) {
  const media = useMedia();
  const preview = usePreview();
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const playing = media.status === "Playing";
  const idle = !media.available || !media.title;
  // Artwork is a one-click path to Liner: focus it when it is the source, launch it when idle.
  const artOpensLiner = !preview && (media.isLiner || idle);

  const run = (action: "toggle" | "next" | "previous") => {
    if (preview) return;
    setError(null);
    ipc.mediaCommand(action).catch((e) => setError(errorMessage(e)));
  };

  const openLiner = () => {
    setError(null);
    // "Liner is not installed" is expected for people who use another player: stay quiet.
    ipc.mediaOpenSource().catch((e) => media.isLiner && setError(errorMessage(e)));
  };

  const artInner = media.thumbnail ? (
    <img src={media.thumbnail} alt="" className="h-full w-full object-cover" draggable={false} />
  ) : (
    <Music size={16} className="lb-muted" />
  );
  const artClass = "flex aspect-square h-[calc(100%-8px)] shrink-0 items-center justify-center overflow-hidden rounded-[9px] border-none p-0";
  const art = artOpensLiner ? (
    <button
      data-no-drag
      className={`${artClass} lb-focus`}
      style={{ background: "var(--lb-card-hover)" }}
      title={media.isLiner ? t("media.showLiner") : t("media.openLiner")}
      aria-label={media.isLiner ? t("media.showLiner") : t("media.openLiner")}
      onClick={(e) => {
        e.stopPropagation();
        openLiner();
      }}
    >
      {artInner}
    </button>
  ) : (
    <div className={artClass} style={{ background: "var(--lb-card-hover)" }}>
      {artInner}
    </div>
  );

  if (idle) {
    return (
      <WidgetCard span={span} padded={false} className="pl-1 pr-2">
        <div className="flex h-full w-full items-center gap-2">
          {art}
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate font-semibold">{t("media.notPlaying")}</div>
            {span !== "1x1" && (
              <div className="truncate lb-muted" style={{ fontSize: "var(--lb-small)" }}>
                {t("media.hint")}
              </div>
            )}
          </div>
        </div>
      </WidgetCard>
    );
  }

  const playButton = (
    <button
      className="lb-icon-btn pointer-events-auto shrink-0"
      style={{ width: 28, height: 28, background: "var(--lb-accent)", color: "#fff" }}
      onClick={(e) => {
        e.stopPropagation();
        run("toggle");
      }}
      aria-label={playing ? t("common.pause") : t("common.play")}
    >
      {playing ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" className="translate-x-[1px]" />}
    </button>
  );

  const secondLine = media.artist || sourceName(media.sourceApp);
  const state = playing ? t("media.playing") : t("media.paused");
  const transport = (
    <>
      {span === "3x1" && (
        <button
          className="lb-icon-btn pointer-events-auto h-6 w-6 shrink-0"
          disabled={!media.canPrevious}
          onClick={(e) => {
            e.stopPropagation();
            run("previous");
          }}
          aria-label={t("common.previous")}
        >
          <SkipBack size={13} fill="currentColor" />
        </button>
      )}
      {playButton}
      {span !== "1x1" && (
        <button
          className="lb-icon-btn pointer-events-auto h-6 w-6 shrink-0"
          disabled={!media.canNext}
          onClick={(e) => {
            e.stopPropagation();
            run("next");
          }}
          aria-label={t("common.next")}
        >
          <SkipForward size={13} fill="currentColor" />
        </button>
      )}
    </>
  );
  const meta = (
    <div className="min-w-0 flex-1 leading-tight">
      <div className="truncate font-semibold">{media.title}</div>
      <div className="flex min-w-0 items-center gap-1" style={{ fontSize: "var(--lb-small)" }}>
        <span className="truncate lb-muted">{secondLine}</span>
        {media.isLiner && span !== "1x1" && <LinerPill />}
      </div>
    </div>
  );

  if (media.thumbnail) {
    return (
      <WidgetCard span={span} title={error ?? `${media.title} — ${secondLine} · ${state}`} padded={false} className="lb-media-cover pl-3 pr-2">
        <CoverArt src={media.thumbnail} />
        <div aria-hidden className="lb-cover-scrim" />
        {artOpensLiner && (
          <button
            className="lb-cover-hit lb-focus"
            title={media.isLiner ? t("media.showLiner") : t("media.openLiner")}
            aria-label={media.isLiner ? t("media.showLiner") : t("media.openLiner")}
            onClick={(e) => {
              e.stopPropagation();
              openLiner();
            }}
          />
        )}
        {/* Clicks fall through to the artwork button except on the transport controls. */}
        <div className="pointer-events-none relative flex h-full w-full min-w-0 items-center gap-2">
          {meta}
          {transport}
        </div>
      </WidgetCard>
    );
  }

  return (
    <WidgetCard span={span} title={error ?? `${media.title} — ${secondLine} · ${state}`} padded={false} className="pl-1 pr-2">
      <div className="flex h-full w-full items-center gap-2">
        {art}
        {meta}
        {transport}
      </div>
    </WidgetCard>
  );
}
