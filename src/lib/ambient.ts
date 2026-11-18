// « Ambiance Musique »: 2–3 dominant, harmonious colors from a cover-art thumbnail, calibrated in
// OKLCH so the glow behind the bar stays soft and never fights the text. Pure (no DOM): the dock
// samples the cover on an offscreen canvas and passes the RGBA pixels here.

export interface Oklch {
  l: number;
  c: number;
  h: number;
}

function linear(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** sRGB (0–255) -> OKLCH (Björn Ottosson's OKLab matrices). */
export function toOklch(r: number, g: number, b: number): Oklch {
  const lr = linear(r);
  const lg = linear(g);
  const lb = linear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const h = (Math.atan2(B, A) * 180) / Math.PI;
  return { l: L, c: Math.hypot(A, B), h: h < 0 ? h + 360 : h };
}

const BINS = 18;
/** Too dark, too light or too dull to carry an ambiance (blacks, whites, greys). */
const MIN_L = 0.28;
const MAX_L = 0.94;
const MIN_C = 0.05;
/** Picked hues are at least this far apart, so the glow is not three shades of one color. */
const MIN_HUE_GAP = 35;
/** Output calibration: balanced lightness, chroma capped so the glow stays soft. */
const OUT_L = 0.7;
const MAX_OUT_C = 0.16;

function hueGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Up to `max` dominant colors of an RGBA buffer, most prominent first. Vivid pixels weigh more than
 * dull ones; an empty array means the cover has no usable color (fall back to the neutral look).
 */
export function dominantColors(rgba: ArrayLike<number>, max = 3): Oklch[] {
  const bins = Array.from({ length: BINS }, () => ({ w: 0, l: 0, c: 0, x: 0, y: 0 }));
  let total = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] < 200) continue;
    const p = toOklch(rgba[i], rgba[i + 1], rgba[i + 2]);
    if (p.l < MIN_L || p.l > MAX_L || p.c < MIN_C) continue;
    const bin = bins[Math.floor(p.h / (360 / BINS)) % BINS];
    const w = p.c;
    const rad = (p.h * Math.PI) / 180;
    bin.w += w;
    bin.l += p.l * w;
    bin.c += p.c * w;
    bin.x += Math.cos(rad) * w;
    bin.y += Math.sin(rad) * w;
    total += w;
  }
  if (total === 0) return [];
  const ranked = bins
    .filter((b) => b.w >= total * 0.06)
    .sort((a, b) => b.w - a.w)
    .map((b) => {
      const h = (Math.atan2(b.y, b.x) * 180) / Math.PI;
      return { l: b.l / b.w, c: b.c / b.w, h: h < 0 ? h + 360 : h };
    });
  const picked: Oklch[] = [];
  for (const color of ranked) {
    if (picked.length >= max) break;
    if (picked.every((p) => hueGap(p.h, color.h) >= MIN_HUE_GAP)) picked.push(color);
  }
  return picked.map((p) => ({ l: OUT_L, c: Math.min(p.c * 1.1, MAX_OUT_C), h: p.h }));
}

export function oklchCss(color: Oklch): string {
  return `oklch(${(color.l * 100).toFixed(1)}% ${color.c.toFixed(3)} ${color.h.toFixed(1)})`;
}
