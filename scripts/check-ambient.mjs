// Self-check for src/lib/ambient.ts (Node >= 23 strips the TypeScript types): node scripts/check-ambient.mjs
import assert from "node:assert/strict";
import { dominantColors, toOklch } from "../src/lib/ambient.ts";

const fill = (pixels) => new Uint8ClampedArray(pixels.flatMap(([r, g, b, n]) => Array.from({ length: n }, () => [r, g, b, 255]).flat()));

// Pure red / blue land at their known OKLab hues.
assert.ok(Math.abs(toOklch(255, 0, 0).h - 29.2) < 1);
assert.ok(Math.abs(toOklch(0, 0, 255).h - 264.1) < 1);

// Black, white and grey covers carry no ambiance.
assert.deepEqual(dominantColors(fill([[0, 0, 0, 50], [255, 255, 255, 50], [128, 128, 128, 50]])), []);

// A mostly orange cover with a blue accent: orange first, blue second, greys ignored.
const picked = dominantColors(fill([[240, 120, 30, 600], [30, 90, 230, 250], [20, 20, 20, 900]]));
assert.equal(picked.length, 2);
assert.ok(picked[0].h > 40 && picked[0].h < 70, `orange hue, got ${picked[0].h}`);
assert.ok(picked[1].h > 240 && picked[1].h < 275, `blue hue, got ${picked[1].h}`);
// Calibrated: fixed lightness, soft chroma.
assert.ok(picked.every((c) => c.l === 0.7 && c.c <= 0.16));

// Two near-identical hues collapse into one color.
assert.equal(dominantColors(fill([[220, 40, 40, 300], [230, 60, 50, 300]])).length, 1);

console.log("ambient: ok");
