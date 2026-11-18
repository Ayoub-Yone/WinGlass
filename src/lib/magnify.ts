// iOS 26-style dock magnification for icon strips (pinned & running apps).
//
// One requestAnimationFrame spring loop per dock, started on pointer entry and stopped once every
// icon has settled back to 1×: no React state changes per mouse pixel. Each `[data-mag]` slot gets
// CSS custom properties consumed by index.css:
//   --mag-shift-x  the slot's horizontal offset (on the slot)
//   --mag-scale    the icon's scale (on its `[data-mag-icon]` child)
//   --mag-lift-y   the icon's lift toward the screen centre (−4 px docked bottom, +4 px top)
//
// Local compression, not expansion: the hovered icon grows to ~1.34× while its neighbours shrink
// (~0.84× at distance 1, ~0.92× at distance 2 — a Mexican-hat profile), so the strip keeps its
// resting footprint. `layoutStrip` keeps the point under the cursor fixed (like the macOS dock) and
// clamps the strip to its resting bounds: no icon is ever pushed into a neighbouring widget, past
// the capsule's ends, or (vertical clamp from the measured geometry) above or below the capsule.
// The loop also publishes the glass hover state LiquidGlassCanvas turns into the liquid bulge: the
// cursor X through a critically damped spring (its velocity leans the droplet), Y and an envelope.

/** Scale by distance from the cursor in slots: hovered, 1st neighbours, 2nd neighbours, rest. */
export const MAG_PROFILE = [1.34, 0.84, 0.92, 1] as const;
export const MAG_PEAK = MAG_PROFILE[0];
export const MAG_LIFT = 4;
/** Transparent room above/below the pill inside the dock window (bulge, ripples + label never clip). */
export const MAG_HEADROOM = 22;
/** How far the glass capsule swells over the hovered icon (px, toward the screen centre). */
export const GLASS_BULGE = 8.5;

/** Profile value at a (fractional) slot distance; cosine-eased between the key points. */
export function magnifyScale(distanceInSlots: number): number {
  const x = Math.abs(distanceInSlots);
  const last = MAG_PROFILE.length - 1;
  if (!Number.isFinite(x) || x >= last) return 1;
  const i = Math.floor(x);
  const k = (1 - Math.cos(Math.PI * (x - i))) / 2;
  return MAG_PROFILE[i] + (MAG_PROFILE[i + 1] - MAG_PROFILE[i]) * k;
}

export interface StripLayout {
  /** Final scales (uniformly reduced if the grown strip would not fit). */
  scales: number[];
  /** Horizontal offset of each slot from its resting position. */
  shifts: number[];
}

/**
 * Lay a strip out with the given scales: slots packed with their resting gaps, the strip point under
 * `cursorX` kept fixed, then clamped so the whole strip stays inside its resting bounds.
 * `lefts`/`widths` are the resting slot geometry (same unit as `cursorX`).
 */
export function layoutStrip(lefts: number[], widths: number[], scalesIn: number[], cursorX: number): StripLayout {
  const n = lefts.length;
  if (n === 0) return { scales: [], shifts: [] };
  const A = lefts[0];
  const B = lefts[n - 1] + widths[n - 1];
  const gaps = lefts.slice(0, -1).map((l, i) => lefts[i + 1] - (l + widths[i]));
  const gapSum = gaps.reduce((a, b) => a + b, 0);
  const widthSum = widths.reduce((a, b) => a + b, 0);
  let scales = scalesIn.slice();
  const total = () => scales.reduce((a, s, i) => a + s * widths[i], 0) + gapSum;
  // Never wider than at rest: shave the excess off every slot uniformly.
  const excess = total() - (B - A);
  if (excess > 1e-6 && widthSum > 0) {
    const delta = excess / widthSum;
    scales = scales.map((s) => s - delta);
  }
  const packed: number[] = [];
  let x = 0;
  for (let i = 0; i < n; i++) {
    packed.push(x);
    x += widths[i] * scales[i] + (gaps[i] ?? 0);
  }
  const T = total();
  // The packed position of the strip point under the cursor (in a slot or in a gap).
  const c = Math.min(B, Math.max(A, cursorX));
  let anchor = 0;
  for (let i = 0; i < n; i++) {
    const end = lefts[i] + widths[i];
    if (c <= end) {
      const phi = widths[i] > 0 ? Math.max(0, (c - lefts[i]) / widths[i]) : 0;
      anchor = packed[i] + phi * widths[i] * scales[i];
      break;
    }
    if (i < n - 1 && c < lefts[i + 1]) {
      const psi = gaps[i] > 0 ? (c - end) / gaps[i] : 0;
      anchor = packed[i] + widths[i] * scales[i] + psi * gaps[i];
      break;
    }
  }
  const start = Math.min(A + (B - A) - T, Math.max(A, c - anchor));
  const shifts = lefts.map((l, i) => start + packed[i] + (widths[i] * scales[i]) / 2 - (l + widths[i] / 2));
  return { scales, shifts };
}

/**
 * Largest icon scale that keeps an icon of `iconHalf` (half height) centred at `center` inside the
 * capsule [`top`, `bottom`] (+ `bulge` toward the centre side) after a lift of `lift` px.
 */
export function maxIconScale(center: number, iconHalf: number, top: number, bottom: number, edge: "bottom" | "top", bulge: number, lift: number): number {
  if (iconHalf <= 0) return MAG_PEAK;
  const margin = 1.5;
  const towardCentre = (edge === "bottom" ? center - top : bottom - center) + bulge - margin - lift;
  const towardEdge = (edge === "bottom" ? bottom - center : center - top) - margin;
  return Math.max(1, Math.min(MAG_PEAK, towardCentre / iconHalf, towardEdge / iconHalf));
}

// ---------------------------------------------------------------- glass hover (for the shader)

export interface GlassHover {
  /** 0..1, smoothed. */
  active: number;
  /** Spring-smoothed cursor X in CSS px from the pill's left edge. */
  x: number;
  /** Velocity of `x` in CSS px/s (leans the droplet toward the motion). */
  vel: number;
  /** Cursor Y across the pill: −1 at the screen-edge rim, +1 at the screen-centre rim. */
  y: number;
  /** Gaussian sigma of the bulge in CSS px (≈ 0.6 slot; the pinch lands between the neighbours). */
  radius: number;
  /** The capsule swells toward the screen centre: up when docked at the bottom. */
  edge: "bottom" | "top";
}

let glassHover: GlassHover = { active: 0, x: 0, vel: 0, y: 1, radius: 30, edge: "bottom" };
const glassListeners = new Set<() => void>();

export function getGlassHover(): GlassHover {
  return glassHover;
}

export function onGlassHover(listener: () => void): () => void {
  glassListeners.add(listener);
  return () => glassListeners.delete(listener);
}

function publishGlass(next: GlassHover): void {
  glassHover = next;
  for (const l of Array.from(glassListeners)) l();
}

// ---------------------------------------------------------------- the loop

interface Tracked {
  el: HTMLElement;
  icon: HTMLElement | null;
  /** Resting geometry relative to the viewport (transforms undone). */
  left: number;
  width: number;
  iconCenterY: number;
  iconHalf: number;
  scale: number;
}

interface Strip {
  items: Tracked[];
  left: number;
  right: number;
  slot: number;
  weight: number;
}

export interface MagnifierOptions {
  /** Which way icons lift: toward the screen centre. */
  edge: () => "bottom" | "top";
  /** Px the capsule outline swells over the hovered icon (0 when the glass shader is off). */
  bulge: () => number;
  /** Floating name pill shown above (or below) the hovered icon. */
  label: HTMLElement | null;
  /** Called when magnification starts / fully settles (to widen the hit region meanwhile). */
  onActiveChange?: (active: boolean) => void;
}

const SPRING = 18; // 1/s — settles in ~0.22 s, no overshoot
/** Angular frequency of the glass cursor spring (rad/s): ~45 px lag at a fast 1000 px/s swipe. */
const GLASS_OMEGA = 45;

/** One exact step of a critically damped spring toward `target` (no overshoot at any dt). */
export function springStep(x: number, v: number, target: number, omega: number, dt: number): [number, number] {
  const d = x - target;
  const e = Math.exp(-omega * dt);
  const c = (v + omega * d) * dt;
  return [target + (d + c) * e, (v - c * omega) * e];
}

export function attachMagnifier(pill: HTMLElement, opts: MagnifierOptions): () => void {
  let raf = 0;
  let last = 0;
  let cursorX = 0;
  let cursorY = 0;
  let inside = false;
  let strips: Strip[] = [];
  let glass = 0;
  let glassX = 0;
  let glassVel = 0;
  let glassY = 1;
  let glassRadius = glassHover.radius;
  let running = false;

  const measure = () => {
    const groups = Array.from(pill.querySelectorAll<HTMLElement>("[data-mag-group]"));
    strips = groups
      .map((group) => {
        const items = Array.from(group.querySelectorAll<HTMLElement>("[data-mag]")).map((el): Tracked => {
          const shift = parseFloat(el.style.getPropertyValue("--mag-shift-x")) || 0;
          const r = el.getBoundingClientRect();
          const icon = el.querySelector<HTMLElement>("[data-mag-icon]");
          const scale = parseFloat(icon?.style.getPropertyValue("--mag-scale") ?? "") || 1;
          const ir = icon?.getBoundingClientRect();
          const lift = parseFloat(icon?.style.getPropertyValue("--mag-lift-y") ?? "") || 0;
          return {
            el,
            icon,
            left: r.left - shift,
            width: r.width,
            iconCenterY: ir ? ir.top + ir.height / 2 - lift : r.top + r.height / 2,
            iconHalf: ir ? ir.height / scale / 2 : 0,
            scale,
          };
        });
        const n = items.length;
        const left = n ? items[0].left : 0;
        const right = n ? items[n - 1].left + items[n - 1].width : 0;
        return { items, left, right, slot: n ? (right - left) / n : 0, weight: 0 };
      })
      .filter((s) => s.items.length > 0);
  };

  const write = (t: Tracked, shift: number, scale: number, lift: number) => {
    t.el.style.setProperty("--mag-shift-x", `${shift.toFixed(2)}px`);
    if (t.icon) {
      t.icon.style.setProperty("--mag-scale", scale.toFixed(4));
      t.icon.style.setProperty("--mag-lift-y", `${lift.toFixed(2)}px`);
    }
  };

  const stop = () => {
    running = false;
    for (const s of strips) {
      for (const t of s.items) {
        t.el.style.removeProperty("--mag-shift-x");
        t.icon?.style.removeProperty("--mag-scale");
        t.icon?.style.removeProperty("--mag-lift-y");
        t.scale = 1;
      }
    }
    if (opts.label) opts.label.style.opacity = "0";
    publishGlass({ ...glassHover, active: 0 });
    opts.onActiveChange?.(false);
  };

  const frame = (now: number) => {
    raf = 0;
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 1 / 60);
    last = now;
    const k = 1 - Math.exp(-dt * SPRING);
    const edge = opts.edge();
    const liftDir = edge === "bottom" ? -1 : 1;
    const pr = pill.getBoundingClientRect();
    const bulge = opts.bulge();
    let settled = true;
    let best: { t: Tracked; shift: number; strip: Strip } | null = null;
    // The liquid glass reacts across the whole capsule (apps, widgets, music, tray, clock); over an
    // icon strip the droplet narrows to its slots so the pinches land between the neighbours.
    const glassTarget = inside ? 1 : 0;
    let radiusTarget = pr.height * 0.6;

    for (const s of strips) {
      const over = inside && cursorX >= s.left - s.slot * 0.25 && cursorX <= s.right + s.slot * 0.25;
      const wTarget = over ? 1 : 0;
      s.weight += (wTarget - s.weight) * k;
      if (Math.abs(wTarget - s.weight) > 0.002) settled = false;
      if (over) radiusTarget = s.slot * 0.6;

      const cx = Math.min(s.right, Math.max(s.left, cursorX));
      for (const t of s.items) {
        const center = t.left + t.width / 2;
        const profile = magnifyScale((cx - center) / Math.max(1, s.slot));
        const cap = maxIconScale(t.iconCenterY, t.iconHalf, pr.top, pr.bottom, edge, bulge, MAG_LIFT);
        const target = 1 + (Math.min(profile, cap) - 1) * s.weight;
        t.scale += (target - t.scale) * k;
        if (Math.abs(target - t.scale) > 0.002 || Math.abs(t.scale - 1) > 0.002) settled = false;
      }
      const lay = layoutStrip(s.items.map((t) => t.left), s.items.map((t) => t.width), s.items.map((t) => t.scale), cx);
      s.items.forEach((t, i) => {
        const scale = lay.scales[i];
        const grow = Math.max(0, scale - 1) / (MAG_PEAK - 1);
        write(t, lay.shifts[i], scale, liftDir * MAG_LIFT * grow);
        if (!best || scale > best.t.scale) best = { t, shift: lay.shifts[i], strip: s };
      });
    }

    glass += (glassTarget - glass) * k;
    glassRadius += (radiusTarget - glassRadius) * k;
    if (Math.abs(glassTarget - glass) > 0.003) settled = false;
    const gx = cursorX - pr.left;
    // Entering from rest: start the spring under the cursor instead of sweeping in from afar.
    if (glass < 0.02 && glassTarget > 0) [glassX, glassVel] = [gx, 0];
    else [glassX, glassVel] = springStep(glassX, glassVel, gx, GLASS_OMEGA, dt);
    if (Math.abs(glassVel) > 2) settled = false;
    const half = Math.max(1, pr.height / 2);
    const gy = Math.max(-1, Math.min(1, ((cursorY - (pr.top + half)) / half) * liftDir));
    glassY += (gy - glassY) * k;
    publishGlass({ active: glass, x: glassX, vel: glassVel, y: glassY, radius: glassRadius, edge });

    const label = opts.label;
    if (label) {
      const hit = best as { t: Tracked; shift: number; strip: Strip } | null;
      const name = hit?.t.el.dataset.magLabel ?? "";
      const show = inside && hit !== null && hit.t.scale > 1.2 && name !== "";
      if (hit && label.textContent !== name) label.textContent = name;
      if (hit) {
        const x = hit.t.left + hit.t.width / 2 + hit.shift - pr.left;
        label.style.transform = `translateX(calc(${x.toFixed(1)}px - 50%))`;
      }
      label.style.opacity = show ? String(Math.min(1, (hit.t.scale - 1.2) * 8)) : "0";
    }

    if (!inside && settled) {
      stop();
      return;
    }
    raf = requestAnimationFrame(frame);
  };

  const start = () => {
    if (!running) {
      running = true;
      last = 0;
      measure();
      opts.onActiveChange?.(true);
    }
    if (!raf) raf = requestAnimationFrame(frame);
  };

  // Tracked on the document: the headroom extends beyond the pill.
  const onMove = (e: PointerEvent) => {
    const r = pill.getBoundingClientRect();
    cursorX = e.clientX;
    cursorY = e.clientY;
    const within = cursorX >= r.left && cursorX <= r.right && cursorY >= r.top - MAG_HEADROOM && cursorY <= r.bottom + MAG_HEADROOM;
    if (within && !inside) {
      inside = true;
      // Fresh geometry when entering from rest (widgets may have moved).
      if (!running) strips = [];
    } else if (!within) {
      inside = false;
    }
    if (inside || running) start();
  };
  const onLeave = () => {
    inside = false;
    if (running) start();
  };
  // Scrolling the dock moves the strips: re-measure from rest.
  const onScroll = () => {
    if (running) measure();
  };

  document.addEventListener("pointermove", onMove, { passive: true });
  document.documentElement.addEventListener("pointerleave", onLeave);
  window.addEventListener("blur", onLeave);
  pill.addEventListener("scroll", onScroll, { capture: true, passive: true });
  return () => {
    document.removeEventListener("pointermove", onMove);
    document.documentElement.removeEventListener("pointerleave", onLeave);
    window.removeEventListener("blur", onLeave);
    pill.removeEventListener("scroll", onScroll, { capture: true });
    if (raf) cancelAnimationFrame(raf);
    if (running) stop();
  };
}
