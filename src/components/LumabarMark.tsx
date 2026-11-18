// lumabar logo (concept « Prisme »): a light bar that splits into three soft rays. Source of truth:
// design/logo/lumabar-mark.svg (app icon: design/logo/lumabar-icon.svg -> `npx tauri icon`).

export function LumabarMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden>
      <rect x="6" y="20.5" width="24" height="7" rx="3.5" fill="var(--lb-text)" fillOpacity="0.9" />
      <g fill="none" strokeLinecap="round" strokeWidth="2.6">
        <path d="M30 22.6 L42 15.5" stroke="oklch(80% 0.12 215)" />
        <path d="M31 24 L43 24" stroke="oklch(72% 0.15 245)" />
        <path d="M30 25.4 L42 32.5" stroke="oklch(76% 0.13 275)" />
      </g>
    </svg>
  );
}
