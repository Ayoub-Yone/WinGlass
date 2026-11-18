// Ambiance Musique colors for the dock: the playing track's cover sampled on an offscreen canvas.
// Empty (neutral look) when the mode is off, nothing plays, the cover is missing or colorless, or
// playback has been paused for longer than PAUSE_GRACE_MS.

import { useEffect, useState } from "react";
import { useHub } from "../engine/DataHub";
import { dominantColors, oklchCss } from "./ambient";

const SAMPLE = 32;
const PAUSE_GRACE_MS = 30_000;
/** Last cover -> colors, so the same track never re-samples. */
let cached: { src: string; colors: string[] } | null = null;

function sample(src: string): Promise<string[]> {
  if (cached?.src === src) return Promise.resolve(cached.colors);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = SAMPLE;
      canvas.height = SAMPLE;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return resolve([]);
      ctx.drawImage(img, 0, 0, SAMPLE, SAMPLE);
      const colors = dominantColors(ctx.getImageData(0, 0, SAMPLE, SAMPLE).data).map(oklchCss);
      cached = { src, colors };
      resolve(colors);
    };
    img.onerror = () => resolve([]);
    img.src = src;
  });
}

export function useAmbientColors(enabled: boolean): string[] {
  const media = useHub((s) => s.media);
  const [colors, setColors] = useState<string[]>([]);
  const [pausedLong, setPausedLong] = useState(false);
  const playing = media.status === "Playing";
  const paused = media.status === "Paused";
  const cover = enabled && media.available && (playing || paused) ? media.thumbnail : null;

  useEffect(() => {
    setPausedLong(false);
    if (!paused) return;
    const timer = window.setTimeout(() => setPausedLong(true), PAUSE_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [paused, media.title]);

  useEffect(() => {
    if (!cover) {
      setColors([]);
      return;
    }
    let alive = true;
    void sample(cover).then((c) => alive && setColors(c));
    return () => {
      alive = false;
    };
  }, [cover]);

  return pausedLong ? [] : colors;
}
