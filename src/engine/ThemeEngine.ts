// 5 surface themes + 3 size presets, applied as CSS custom properties on <html>.

import type { SizePreset, SizeTokens, ThemeId, ThemeTokens } from "../types/lumabar";

export const THEMES: Record<ThemeId, ThemeTokens> = {
  // iOS Liquid Glass (default): the shader refracts the live desktop through a curved, clear lens.
  "liquid-glass": {
    id: "liquid-glass",
    scheme: "dark",
    surface: "rgba(16, 18, 24, 0.30)",
    border: "1px solid rgb(255 255 255 / 0.2)",
    card: "rgb(255 255 255 / 0.055)",
    cardBorder: "rgb(255 255 255 / 0.12)",
    cardHover: "rgb(255 255 255 / 0.13)",
    text: "#F5F5F7",
    muted: "rgba(235, 235, 245, 0.7)",
    faint: "rgba(235, 235, 245, 0.4)",
    track: "rgb(255 255 255 / 0.16)",
    backdrop: "none",
    menu: "rgba(28, 30, 36, 0.84)",
    shadow: "0 10px 36px rgb(0 0 0 / 0.3)",
    usesGlassShader: true,
  },
  // Matte Liquid Glass: same lens, deeper creamy diffusion, subdued rim, velvety dark veil.
  "matte-glass": {
    id: "matte-glass",
    scheme: "dark",
    surface: "rgba(14, 15, 20, 0.42)",
    border: "1px solid rgb(255 255 255 / 0.14)",
    card: "rgb(255 255 255 / 0.06)",
    cardBorder: "rgb(255 255 255 / 0.09)",
    cardHover: "rgb(255 255 255 / 0.12)",
    text: "#F2F2F5",
    muted: "rgba(232, 232, 240, 0.66)",
    faint: "rgba(232, 232, 240, 0.38)",
    track: "rgb(255 255 255 / 0.13)",
    backdrop: "none",
    menu: "rgba(26, 27, 32, 0.88)",
    shadow: "0 10px 40px rgb(0 0 0 / 0.36)",
    usesGlassShader: true,
  },
  // Midnight Obsidian: smoked translucent slate, cool blue-violet glint along the top lip.
  midnight: {
    id: "midnight",
    scheme: "dark",
    surface: "oklch(19% 0.03 268 / 0.9)",
    border: "1px solid oklch(74% 0.09 278 / 0.24)",
    card: "oklch(25% 0.035 268 / 0.85)",
    cardBorder: "transparent",
    cardHover: "oklch(30% 0.045 270 / 0.92)",
    text: "#E9ECFB",
    muted: "rgb(205 212 245 / 0.64)",
    faint: "rgb(205 212 245 / 0.36)",
    track: "oklch(72% 0.08 276 / 0.18)",
    backdrop: "none",
    menu: "oklch(20% 0.03 268 / 0.96)",
    shadow: "0 10px 40px rgb(4 6 22 / 0.55), inset 0 1px 0 oklch(82% 0.1 285 / 0.24)",
    usesGlassShader: false,
  },
  // Frost White: luminous alabaster, dark crisp type, soft shadow.
  white: {
    id: "white",
    scheme: "light",
    surface: "oklch(98% 0.004 95 / 0.92)",
    border: "1px solid rgb(0 0 0 / 0.07)",
    card: "oklch(94.5% 0.005 95 / 0.9)",
    cardBorder: "transparent",
    cardHover: "oklch(91% 0.006 95 / 0.95)",
    text: "#111113",
    muted: "rgba(60, 60, 67, 0.7)",
    faint: "rgba(60, 60, 67, 0.4)",
    track: "rgb(0 0 0 / 0.08)",
    backdrop: "blur(20px) saturate(160%)",
    menu: "oklch(98.5% 0.004 95 / 0.97)",
    shadow: "0 8px 28px rgb(0 0 0 / 0.12), inset 0 1px 0 rgb(255 255 255 / 0.85)",
    usesGlassShader: false,
  },
  // Pure OLED Black: pitch-black capsule, razor 1px hairline, depth from lighter surfaces.
  black: {
    id: "black",
    scheme: "dark",
    surface: "#000000",
    border: "1px solid rgb(255 255 255 / 0.14)",
    card: "#0E0E10",
    cardBorder: "transparent",
    cardHover: "#19191C",
    text: "#F4F4F5",
    muted: "rgba(228, 228, 231, 0.6)",
    faint: "rgba(228, 228, 231, 0.32)",
    track: "rgb(255 255 255 / 0.12)",
    backdrop: "none",
    menu: "#070708",
    shadow: "0 8px 30px rgb(0 0 0 / 0.5)",
    usesGlassShader: false,
  },
};

export const THEME_ORDER: ThemeId[] = ["liquid-glass", "matte-glass", "midnight", "white", "black"];

/** Concentric with the capsule: inner = outer − padding − the pill's 1px border, never under 8px. */
export const concentric = (radius: number, padding: number): number => Math.max(8, radius - padding - 1);

export const SIZES: Record<SizePreset, SizeTokens> = {
  compact: { id: "compact", height: 46, padding: 5, gap: 5, unit: 92, radius: 22, cardRadius: concentric(22, 5), icon: 24, font: 11, small: 9, large: 15 },
  medium: { id: "medium", height: 58, padding: 6, gap: 6, unit: 108, radius: 22, cardRadius: concentric(22, 6), icon: 30, font: 12, small: 10, large: 17 },
  large: { id: "large", height: 70, padding: 7, gap: 7, unit: 126, radius: 22, cardRadius: concentric(22, 7), icon: 36, font: 13, small: 11, large: 20 },
};

export const SIZE_ORDER: SizePreset[] = ["compact", "medium", "large"];

export function spanWidth(span: "1x1" | "2x1" | "3x1", size: SizeTokens): number {
  const units = span === "1x1" ? 1 : span === "2x1" ? 2 : 3;
  return units * size.unit + (units - 1) * size.gap;
}

export function applyTheme(themeId: ThemeId, sizeId: SizePreset, accent: string): void {
  const theme = THEMES[themeId] ?? THEMES["liquid-glass"];
  const size = SIZES[sizeId] ?? SIZES.medium;
  const root = document.documentElement;
  const vars: Record<string, string> = {
    "--lb-surface": theme.surface,
    "--lb-border": theme.border,
    "--lb-card": theme.card,
    "--lb-card-border": theme.cardBorder,
    "--lb-card-hover": theme.cardHover,
    "--lb-text": theme.text,
    "--lb-muted": theme.muted,
    "--lb-faint": theme.faint,
    "--lb-track": theme.track,
    "--lb-backdrop": theme.backdrop,
    "--lb-menu": theme.menu,
    "--lb-shadow": theme.shadow,
    "--lb-accent": accent,
    "--lb-height": `${size.height}px`,
    "--lb-padding": `${size.padding}px`,
    "--lb-gap": `${size.gap}px`,
    "--lb-unit": `${size.unit}px`,
    "--lb-radius": `${size.radius}px`,
    "--lb-card-radius": `${size.cardRadius}px`,
    "--lb-icon": `${size.icon}px`,
    "--lb-font": `${size.font}px`,
    "--lb-small": `${size.small}px`,
    "--lb-large": `${size.large}px`,
  };
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.dataset.theme = theme.id;
  root.dataset.scheme = theme.scheme;
  root.style.colorScheme = theme.scheme;
}

// ---------------------------------------------------------------- liquid-glass optics

/** Everything the glass shader needs, derived from the theme and the « Clair ↔ Givré » slider. */
export interface FrostPreset {
  /** Dual-Kawase pyramid depth (each level doubles the blur radius). */
  levels: number;
  /** Kawase sample offset in half-texels. */
  offset: number;
  /** Sigma (in taps) of the separable Gaussian smoothing pass after the pyramid. */
  gauss: number;
  /** Veil opacity over the blurred desktop (the adaptive luminance adds to it). */
  tint: number;
  /** Veil colour, 0..1. */
  tintRgb: [number, number, number];
  /** Procedural micro-grain amplitude. */
  grain: number;
  /** Inward UV displacement at the very rim, CSS px. */
  refraction: number;
  /** How much of the sharp (barely blurred) desktop the curved rim shows, 0..1. */
  clarity: number;
  /** Specular rim / bevel / glint strength multiplier. */
  rim: number;
  /** Luminance-preserving saturation boost of the backdrop. */
  vibrancy: number;
}

interface GlassOptics {
  tintRgb: [number, number, number];
  /** Slider range mapped onto the frost curve: the matte theme never gets fully clear. */
  frost: [number, number];
  rim: number;
  refraction: number;
  vibrancy: number;
  grain: number;
}

const OPTICS: Partial<Record<ThemeId, GlassOptics>> = {
  "liquid-glass": { tintRgb: [16 / 255, 18 / 255, 24 / 255], frost: [0, 1], rim: 1, refraction: 1, vibrancy: 1.32, grain: 1 },
  "matte-glass": { tintRgb: [14 / 255, 15 / 255, 20 / 255], frost: [0.45, 1], rim: 0.55, refraction: 0.6, vibrancy: 1.12, grain: 1.35 },
};

export const DEFAULT_FROST_LEVEL = 0.5;

/**
 * `level` 0 = ultra-clear optical glass (light blur, strong edge refraction, low tint, bright rim),
 * 0.5 = balanced liquid glass, 1 = deep matte frost (heavy creamy diffusion, rich tint).
 * Continuous: the blur radius grows exponentially and the pyramid depth is picked so the Kawase
 * offset stays in its artefact-free 1.5–3 half-texel band.
 */
export function frostPreset(themeId: ThemeId | undefined, level: number | undefined): FrostPreset {
  const o = OPTICS[themeId ?? "liquid-glass"] ?? (OPTICS["liquid-glass"] as GlassOptics);
  const l = Math.min(1, Math.max(0, typeof level === "number" && Number.isFinite(level) ? level : DEFAULT_FROST_LEVEL));
  const t = o.frost[0] + (o.frost[1] - o.frost[0]) * l;
  const radius = 8 * 21 ** t; // source px: 8 (clear) .. 168 (deep)
  const levels = Math.min(6, Math.max(2, Math.ceil(Math.log2(radius / 3))));
  return {
    levels,
    offset: radius / 2 ** levels,
    gauss: 1 + 5.5 * t,
    tint: 0.08 + 0.44 * t,
    tintRgb: o.tintRgb,
    grain: (0.004 + 0.012 * t) * o.grain,
    refraction: (24 - 12 * t) * o.refraction,
    clarity: 0.85 * (1 - t) ** 1.5,
    rim: (1 - 0.45 * t) * o.rim,
    vibrancy: o.vibrancy,
  };
}
