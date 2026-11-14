// 5 surface themes + 3 size presets, applied as CSS custom properties on <html>.

import type { GlassFrost, SizePreset, SizeTokens, ThemeId, ThemeTokens } from "../types/lumabar";

export const THEMES: Record<ThemeId, ThemeTokens> = {
  "liquid-glass": {
    id: "liquid-glass",
    scheme: "dark",
    // Matte veil; the shader applies the same tint (see FROST) over the blurred desktop.
    surface: "rgba(18, 20, 26, 0.36)",
    border: "1px solid rgba(255, 255, 255, 0.16)",
    card: "rgba(255, 255, 255, 0.065)",
    cardBorder: "rgba(255, 255, 255, 0.10)",
    cardHover: "rgba(255, 255, 255, 0.13)",
    text: "#F5F5F7",
    muted: "rgba(235, 235, 245, 0.66)",
    faint: "rgba(235, 235, 245, 0.38)",
    track: "rgba(255, 255, 255, 0.14)",
    backdrop: "none",
    menu: "rgba(30, 30, 36, 0.86)",
    shadow: "0 10px 40px rgba(0, 0, 0, 0.35)",
    usesGlassShader: true,
  },
  "ios-glass": {
    id: "ios-glass",
    scheme: "dark",
    surface: "rgba(22, 22, 26, 0.72)",
    border: "1px solid rgba(255, 255, 255, 0.14)",
    card: "rgba(255, 255, 255, 0.07)",
    cardBorder: "transparent",
    cardHover: "rgba(255, 255, 255, 0.12)",
    text: "#F5F5F7",
    muted: "rgba(235, 235, 245, 0.62)",
    faint: "rgba(235, 235, 245, 0.34)",
    track: "rgba(255, 255, 255, 0.12)",
    backdrop: "blur(28px) saturate(180%)",
    menu: "rgba(28, 28, 32, 0.9)",
    shadow: "0 10px 40px rgba(0, 0, 0, 0.4)",
    usesGlassShader: false,
  },
  white: {
    id: "white",
    scheme: "light",
    surface: "rgba(250, 250, 252, 0.92)",
    border: "1px solid rgba(0, 0, 0, 0.08)",
    card: "#F1F2F6",
    cardBorder: "transparent",
    cardHover: "#E6E8EE",
    text: "#111113",
    muted: "rgba(60, 60, 67, 0.66)",
    faint: "rgba(60, 60, 67, 0.38)",
    track: "rgba(0, 0, 0, 0.08)",
    backdrop: "blur(20px) saturate(160%)",
    menu: "rgba(252, 252, 254, 0.96)",
    shadow: "0 10px 40px rgba(0, 0, 0, 0.16)",
    usesGlassShader: false,
  },
  black: {
    id: "black",
    scheme: "dark",
    surface: "#09090B",
    border: "1px solid #242429",
    card: "#141417",
    cardBorder: "transparent",
    cardHover: "#1C1C20",
    text: "#F4F4F5",
    muted: "rgba(228, 228, 231, 0.6)",
    faint: "rgba(228, 228, 231, 0.32)",
    track: "#26262B",
    backdrop: "none",
    menu: "#111114",
    shadow: "0 10px 40px rgba(0, 0, 0, 0.6)",
    usesGlassShader: false,
  },
  midnight: {
    id: "midnight",
    scheme: "dark",
    surface: "#0D111C",
    border: "1px solid rgba(96, 165, 250, 0.18)",
    card: "#161D2E",
    cardBorder: "transparent",
    cardHover: "#1D2640",
    text: "#E8EEFC",
    muted: "rgba(200, 214, 245, 0.62)",
    faint: "rgba(200, 214, 245, 0.34)",
    track: "rgba(96, 165, 250, 0.16)",
    backdrop: "none",
    menu: "#121828",
    shadow: "0 10px 40px rgba(2, 6, 23, 0.6)",
    usesGlassShader: false,
  },
};

export const THEME_ORDER: ThemeId[] = ["liquid-glass", "ios-glass", "white", "black", "midnight"];

export const SIZES: Record<SizePreset, SizeTokens> = {
  compact: { id: "compact", height: 46, padding: 5, gap: 5, unit: 92, radius: 22, cardRadius: 12, icon: 24, font: 11, small: 9, large: 15 },
  medium: { id: "medium", height: 58, padding: 6, gap: 6, unit: 108, radius: 22, cardRadius: 14, icon: 30, font: 12, small: 10, large: 17 },
  large: { id: "large", height: 70, padding: 7, gap: 7, unit: 126, radius: 22, cardRadius: 16, icon: 36, font: 13, small: 11, large: 20 },
};

export const SIZE_ORDER: SizePreset[] = ["compact", "medium", "large"];

export function spanWidth(span: "1x1" | "2x1" | "3x1", size: SizeTokens): number {
  const units = span === "1x1" ? 1 : span === "2x1" ? 2 : 3;
  return units * size.unit + (units - 1) * size.gap;
}

export function applyTheme(themeId: ThemeId, sizeId: SizePreset, accent: string): void {
  const theme = THEMES[themeId] ?? THEMES["ios-glass"];
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

// ---------------------------------------------------------------- liquid-glass frost presets

export interface FrostPreset {
  id: GlassFrost;
  /** Dual-Kawase pyramid depth (each level doubles the blur radius). */
  levels: number;
  /** Kawase sample offset in half-texels; larger = creamier. */
  offset: number;
  /** Matte veil: rgba(18, 20, 26, tint). */
  tint: number;
  /** Procedural micro-grain amplitude. */
  grain: number;
}

export const FROST_ORDER: GlassFrost[] = ["subtle", "balanced", "deep"];

export const FROST: Record<GlassFrost, FrostPreset> = {
  subtle: { id: "subtle", levels: 3, offset: 1.6, tint: 0.26, grain: 0.008 },
  balanced: { id: "balanced", levels: 4, offset: 1.75, tint: 0.36, grain: 0.012 },
  deep: { id: "deep", levels: 5, offset: 2.1, tint: 0.5, grain: 0.016 },
};

export const GLASS_TINT_RGB: [number, number, number] = [18 / 255, 20 / 255, 26 / 255];

export function frostPreset(id: GlassFrost | undefined): FrostPreset {
  return FROST[id ?? "balanced"] ?? FROST.balanced;
}
