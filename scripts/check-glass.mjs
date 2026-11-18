// Self-check for the liquid-glass math (Node >= 23 strips the TypeScript types): node scripts/check-glass.mjs
import assert from "node:assert/strict";
import { MAG_PEAK, magnifyScale, maxIconScale, springStep } from "../src/lib/magnify.ts";
import { SIZES, frostPreset } from "../src/engine/ThemeEngine.ts";

// Magnification profile: 1.34x hovered, 0.84x / 0.92x neighbours, 1x beyond.
assert.equal(MAG_PEAK, 1.34);
assert.equal(magnifyScale(0), 1.34);
assert.equal(magnifyScale(1), 0.84);
assert.equal(magnifyScale(2), 0.92);
assert.equal(magnifyScale(3), 1);
// A grown icon never leaves the capsule (+ bulge): 30px icon centred in a 58px pill, 8.5px bulge.
assert.ok(maxIconScale(29, 15, 0, 58, "bottom", 8.5, 4) <= MAG_PEAK);
assert.ok(maxIconScale(23, 18, 0, 46, "bottom", 0, 4) * 18 <= 23 - 1.5);

// Critically damped spring: reaches the target without overshoot, at any frame time.
for (const dt of [1 / 120, 1 / 60, 0.05]) {
  let [x, v] = [0, 0];
  let max = 0;
  for (let i = 0; i < Math.ceil(1 / dt); i++) {
    [x, v] = springStep(x, v, 100, 45, dt);
    max = Math.max(max, x);
  }
  assert.ok(max <= 100 + 1e-9, `overshoot at dt=${dt}: ${max}`);
  assert.ok(Math.abs(x - 100) < 0.01 && Math.abs(v) < 0.5, `settles at dt=${dt}: x=${x} v=${v}`);
}
// Moving right gives a positive velocity (the droplet leans with the motion).
assert.ok(springStep(0, 0, 50, 45, 1 / 60)[1] > 0);

// « Clair ↔ Givré »: blur, tint and grain rise and refraction / clarity / rim fall monotonically.
const radius = (p) => p.offset * 2 ** p.levels;
let prev = frostPreset("liquid-glass", 0);
assert.ok(radius(prev) >= 5 && radius(prev) <= 7 && prev.tint < 0.05 && prev.vibrancy === 1.32);
for (let i = 1; i <= 20; i++) {
  const p = frostPreset("liquid-glass", i / 20);
  assert.ok(radius(p) > radius(prev) && p.tint > prev.tint && p.grain > prev.grain, `frost rises at ${i / 20}`);
  assert.ok(p.refraction < prev.refraction && p.clarity <= prev.clarity && p.rim < prev.rim, `optics fall at ${i / 20}`);
  assert.ok(p.levels >= 2 && p.levels <= 6 && p.offset >= 1.5 && p.offset <= 3.01, `kawase band at ${i / 20}: ${p.levels}/${p.offset}`);
  prev = p;
}
assert.ok(radius(prev) > 160 && prev.tint > 0.5);
// The matte theme is never fully clear; out-of-range / missing levels are clamped to sane values.
assert.ok(frostPreset("matte-glass", 0).tint > frostPreset("liquid-glass", 0.4).tint);
assert.deepEqual(frostPreset("liquid-glass", 7), frostPreset("liquid-glass", 1));
assert.deepEqual(frostPreset(undefined, Number.NaN), frostPreset("liquid-glass", 0.32));
// The default is clear: light blur and a thin veil.
assert.ok(radius(frostPreset("liquid-glass", 0.32)) < 20 && frostPreset("liquid-glass", 0.32).tint < 0.15);

// Concentric cards: outer radius - padding - the 1px border.
assert.deepEqual(Object.values(SIZES).map((s) => s.cardRadius), [16, 15, 14]);

console.log("check-glass: ok");
