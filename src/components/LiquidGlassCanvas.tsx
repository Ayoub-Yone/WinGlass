// WebGL2 liquid glass: the live desktop behind the dock seen through a curved, refracting capsule.
//
// Pipeline (renders only when a new backdrop frame arrives, the canvas resizes, the optics change,
// the cursor moves over the dock or the adaptive luminance is still easing — never on an idle rAF
// loop, so a static desktop costs zero GPU work):
//   upload  glass://capture BGRA  ->  source texture (swizzled to RGB in the first pass)
//           The live capture includes a 64px margin around the pill (X-Inner says where the pill
//           is), so the blur, the bulge and the shadow read real colour beyond the pill's edge.
//   pass 1  dual-Kawase blur pyramid; depth and offset come from the « Clair ↔ Givré » slider
//           (~8px effective radius when clear, ~170px when deeply frosted).
//   pass 1b separable Gaussian at half resolution on top of the pyramid (irons out Kawase
//           diamonds). The deepest pyramid level is read back (a few dozen texels) for the mean
//           luminance behind the pill, eased over ~300ms.
//   pass 2  composite, all from one deformed SDF `d` so rim, bevel, glint and shadow stay cohesive:
//             · curved meniscus: an 18px convex bevel, height h = sqrt(1 − (1 − s)²); UVs bend
//               inward along −∇d by (1 − h)^1.85 · refraction, so desktop lines bow and wrap round
//               the capsule edge while the flat centre stays undistorted. The rim looks through the
//               barely blurred first pyramid level (clear glass), the flat through the frost.
//             · prism rim: R/B split ±0.0024..0.0040 along the normal, inside the meniscus only
//             · liquid droplet: the screen-centre rim swells under the cursor (Gaussian, 8.5px)
//               with capillary pinches (≈ −1.8px) on both sides; the motion leans it; the
//               screen-edge rim swells a little when the cursor rides it; the ends stretch ~3px
//             · dual-layer Fresnel: crisp 1px outer edge reflection + soft top-lip bevel light,
//               a glossy top sheen, a bottom inner reflection, and a specular glint gliding along
//               the warped rim with the cursor — all tinted by the dock's live ambient colour
//               (Ambiance Musique), eased like the CSS bar glow, plus a tinted glow in the meniscus
//             · vibrancy ×1.32 (luminance preserving), adaptive veil from the scene luminance,
//               soft inner shadow, micro-grain, anti-aliased mask, drop shadow from the same SDF.
//               Hover only re-runs this composite pass — the blur stays cached.

import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import type { FrostPreset } from "../engine/ThemeEngine";
import { subscribe } from "../lib/ipc";
import { MAG_HEADROOM, getGlassHover, onGlassHover } from "../lib/magnify";

/** Transparent CSS px around the pill inside the canvas: bulge, stretch and drop shadow room. */
const PAD = MAG_HEADROOM;

const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const KAWASE_DOWN = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_tex;
uniform vec2 u_halfpixel;
uniform float u_offset;
uniform float u_bgra;   // 1.0 for the raw capture (BGRA byte order), 0.0 afterwards
void main() {
  vec2 hp = u_halfpixel * u_offset;
  vec4 sum = texture(u_tex, v_uv) * 4.0;
  sum += texture(u_tex, v_uv - hp);
  sum += texture(u_tex, v_uv + hp);
  sum += texture(u_tex, v_uv + vec2(hp.x, -hp.y));
  sum += texture(u_tex, v_uv - vec2(hp.x, -hp.y));
  sum /= 8.0;
  o = vec4(mix(sum.rgb, sum.bgr, u_bgra), 1.0);
}`;

const KAWASE_UP = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_tex;
uniform vec2 u_halfpixel;
uniform float u_offset;
void main() {
  vec2 hp = u_halfpixel * u_offset;
  vec4 sum = texture(u_tex, v_uv + vec2(-hp.x * 2.0, 0.0));
  sum += texture(u_tex, v_uv + vec2(-hp.x, hp.y)) * 2.0;
  sum += texture(u_tex, v_uv + vec2(0.0, hp.y * 2.0));
  sum += texture(u_tex, v_uv + vec2(hp.x, hp.y)) * 2.0;
  sum += texture(u_tex, v_uv + vec2(hp.x * 2.0, 0.0));
  sum += texture(u_tex, v_uv + vec2(hp.x, -hp.y)) * 2.0;
  sum += texture(u_tex, v_uv + vec2(0.0, -hp.y * 2.0));
  sum += texture(u_tex, v_uv + vec2(-hp.x, -hp.y)) * 2.0;
  o = sum / 12.0;
}`;

// Separable Gaussian over 1 + 2×12 taps; `u_dir` = texel step along one axis (bilinear taps).
const GAUSS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_tex;
uniform vec2 u_dir;
uniform float u_sigma;  // in taps
void main() {
  vec4 sum = texture(u_tex, v_uv);
  float wsum = 1.0;
  float k = -0.5 / (u_sigma * u_sigma);
  for (int i = 1; i <= 12; i++) {
    float x = float(i);
    float w = exp(k * x * x);
    sum += (texture(u_tex, v_uv + u_dir * x) + texture(u_tex, v_uv - u_dir * x)) * w;
    wsum += 2.0 * w;
  }
  o = sum / wsum;
}`;

const COMPOSITE = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_blur;     // frosted desktop
uniform sampler2D u_sharp;    // first pyramid level: barely blurred desktop, seen through the rim
uniform vec2 u_size;          // canvas size in device px
uniform vec2 u_pad;           // device px of empty canvas left/right (x) and above/below (y) the pill
uniform float u_radius;       // corner radius in device px
uniform float u_dpr;
uniform vec4 u_tint;          // veil colour + base opacity
uniform vec4 u_inner;         // pill rect inside the captured frame: xy = offset, zw = scale (uv)
uniform float u_grain;        // micro-grain amplitude
uniform float u_refract;      // inward rim displacement, device px
uniform float u_clarity;      // 0..1, sharp desktop share at the rim
uniform float u_rim;          // specular strength
uniform float u_vibrancy;     // saturation boost
uniform float u_lum;          // eased mean luminance behind the pill, 0..1
uniform float u_hoverActive;  // 0..1 envelope
uniform float u_hoverX;       // spring-smoothed cursor, device px from the canvas' left edge
uniform float u_hoverY;       // −1 at the screen-edge rim .. +1 at the screen-centre rim
uniform float u_hoverVel;     // CSS px/s
uniform float u_hoverRadius;  // droplet sigma, device px
uniform float u_edgeDir;      // +1 docked at the bottom (centre side = up), −1 docked at the top
uniform vec3 u_ambient;       // the dock's live ambient colour (cover art), eased
uniform float u_ambientMix;   // 0 neutral white highlights .. 1 tinted by u_ambient

float sdRoundedBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

// Hash without sine (stable across GPUs).
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Pill-space uv -> captured-frame uv (the frame has a capture margin around the pill).
vec3 frost(vec2 uv) { return texture(u_blur, u_inner.xy + uv * u_inner.zw).rgb; }
vec3 clear(vec2 uv) { return texture(u_sharp, u_inner.xy + uv * u_inner.zw).rgb; }

float sigma() { return max(u_hoverRadius, 1.0); }
// Cursor x in canvas-centred device px.
float cursorX() { return u_hoverX - u_size.x * 0.5; }

// Outward swell of the rim (device px): Gaussian droplet of 8.5px minus a wider Gaussian, so
// capillary pinches (≈ −1.8px at ±2.5σ) flank it. Motion leans it: the trailing side stretches
// (surface tension pulling a tail), the leading side steepens.
float dropletPx(float x) {
  float dx = x - cursorX();
  float lean = clamp(u_hoverVel / 1400.0, -1.0, 1.0);
  float R = sigma() * (1.0 - 0.3 * lean * tanh(1.5 * dx / sigma()));
  float u2 = dx * dx / (R * R);
  return u_hoverActive * u_dpr * (13.71 * exp(-0.5 * u2) - 5.21 * exp(-0.125 * u2));
}

// The capsule deformed by the droplet. hp = resting half extents.
float sdPill(vec2 p, vec2 hp, float r) {
  float b = dropletPx(p.x);
  float riding = smoothstep(0.1, 0.9, -u_hoverY);   // cursor near the screen-edge rim
  float bc = b * (1.0 - 0.25 * riding);
  float be = b * 0.32 * riding;                     // stays inside the 10px screen-edge margin
  float bTop = u_edgeDir > 0.0 ? bc : be;
  float bBot = u_edgeDir > 0.0 ? be : bc;
  float cx = cursorX();
  float reach = 2.5 * sigma();
  float sR = u_hoverActive * 3.0 * u_dpr * smoothstep(hp.x - reach, hp.x, cx);
  float sL = u_hoverActive * 3.0 * u_dpr * smoothstep(hp.x - reach, hp.x, -cx);
  vec2 hb = vec2(hp.x + 0.5 * (sL + sR), hp.y + 0.5 * (bTop + bBot));
  vec2 c = vec2(0.5 * (sR - sL), 0.5 * (bTop - bBot));
  return sdRoundedBox(p - c, hb, clamp(r + 0.5 * (bTop + bBot), 0.0, hb.y));
}

void main() {
  vec2 half_size = u_size * 0.5;
  vec2 hp = half_size - u_pad;
  vec2 pill_size = hp * 2.0;
  vec2 p = v_uv * u_size - half_size;
  float r = min(u_radius, min(hp.x, hp.y));
  float d = sdPill(p, hp, r);

  // Outward unit normal from the SDF gradient (follows the droplet's curve).
  vec2 e = vec2(1.0, 0.0);
  vec2 n = vec2(sdPill(p + e.xy, hp, r) - sdPill(p - e.xy, hp, r), sdPill(p + e.yx, hp, r) - sdPill(p - e.yx, hp, r));
  n = normalize(n + 1e-6);

  float dxc = p.x - cursorX();
  float prox = u_hoverActive * exp(-0.5 * dxc * dxc / (sigma() * sigma()));
  vec2 puv = (p + hp) / pill_size;

  // Curved meniscus: glass height rises from 0 at the rim to 1 on the flat, 18px in.
  float s = clamp(-d / (18.0 * u_dpr), 0.0, 1.0);
  float h = sqrt(max(0.0, 1.0 - (1.0 - s) * (1.0 - s)));
  float rimF = 1.0 - h;
  float bend = pow(rimF, 1.85);

  // Frosted diffusion: every pixel looks through the glass at a slightly different angle.
  float g1 = hash12(gl_FragCoord.xy);
  float g2 = hash12(gl_FragCoord.xy + 61.7);
  vec2 scatter = (vec2(g1, g2) - 0.5) * (u_grain / 0.012) * (1.5 * u_dpr) / pill_size;

  // Rays through the tilted rim bend inward, so the rim shows the desktop further inside.
  vec2 uv = puv - n * bend * u_refract * (1.0 + 0.35 * prox) / pill_size + scatter;

  // Liquid lens under the cursor: radial magnification toward the droplet centre.
  vec2 lensCenter = vec2((u_hoverX - u_pad.x) / pill_size.x, 0.5);
  vec2 toC = uv - lensCenter;
  float lens = 0.12 * prox * (1.0 - 0.5 * clamp(length(toC * vec2(pill_size.x / pill_size.y, 1.0)) * 0.5, 0.0, 1.0));
  uv = lensCenter + toC * (1.0 - lens);

  // Prism rim: R and B pulled apart along the normal (isotropic in px), inside the meniscus only.
  vec2 disp = n * mix(0.0024, 0.0040, prox) * rimF * vec2(1.0, pill_size.x / pill_size.y);
  float sharpMix = u_clarity * pow(rimF, 0.8);
  vec3 col;
  col.r = mix(frost(uv + disp).r, clear(uv + disp).r, sharpMix);
  col.g = mix(frost(uv).g, clear(uv).g, sharpMix);
  col.b = mix(frost(uv - disp).b, clear(uv - disp).b, sharpMix);

  // Vibrancy: luminance-preserving saturation boost, so colour glows through instead of greying.
  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = max(mix(vec3(luma), col, u_vibrancy), 0.0);

  // Adaptive veil: thicker over bright desktops (eased scene luminance + a local term) so white
  // text stays legible over a white window; a faint lift keeps the pane visible on pitch black.
  // (Halved for clarity: a white window greys the glass a little, never into opaque plastic.)
  float veil = clamp(u_tint.a + 0.14 * smoothstep(0.35, 0.95, u_lum) + 0.06 * smoothstep(0.55, 0.98, luma), 0.0, 0.9);
  col = mix(col, u_tint.rgb, veil);
  col += vec3(0.020, 0.021, 0.024) * (1.0 + 1.5 * (1.0 - smoothstep(0.0, 0.18, u_lum)));

  // Soft inner ambient shadow, heavier along the bottom, for depth.
  float inner = smoothstep(-16.0 * u_dpr, 0.0, d);
  col *= 1.0 - 0.14 * inner * inner * (0.55 + 0.45 * clamp(-n.y, 0.0, 1.0));

  // Highlights take the dock's live colour so rim, bevel and droplet shift with the bar's glow.
  vec3 hl = mix(vec3(1.0), u_ambient, 0.62 * u_ambientMix);
  // Tinted glow inside the curved meniscus.
  col += u_ambient * pow(rimF, 2.0) * 0.14 * u_ambientMix;

  float top = smoothstep(0.0, 0.95, n.y);
  float bottom = smoothstep(0.25, 0.9, -n.y);
  // Layer 1: crisp 1px Fresnel reflection on the outer edge, all the way round, brightest on top.
  float fresnel = smoothstep(-1.5 * u_dpr, 0.0, d) * (1.0 - smoothstep(0.0, 0.75 * u_dpr, d));
  col = mix(col, hl, fresnel * u_rim * (0.16 + 0.34 * top + 0.10 * bottom));
  // Layer 2: thick-glass top lip lit from above, fading smoothly down the sides.
  col = mix(col, hl, pow(rimF, 1.4) * top * (1.0 - fresnel) * 0.24 * u_rim);
  // Polished-crystal sheen over the upper glass, and light bouncing back up the bottom lip.
  col = mix(col, hl, smoothstep(0.15, 1.0, p.y / hp.y) * (1.0 - fresnel) * 0.06 * u_rim);
  col = mix(col, hl, pow(rimF, 2.0) * bottom * (1.0 - fresnel) * 0.08 * u_rim);
  // Specular glint gliding along the warped rim with the cursor (strongest on the swelling side).
  float centreSide = u_edgeDir > 0.0 ? top : smoothstep(0.0, 0.95, -n.y);
  float band = smoothstep(-5.0 * u_dpr, -0.5 * u_dpr, d) * (1.0 - smoothstep(-0.5 * u_dpr, 0.6 * u_dpr, d));
  float glint = u_hoverActive * exp(-dxc * dxc / (1.44 * sigma() * sigma())) * band;
  col = mix(col, hl, glint * u_rim * (0.38 * centreSide + 0.10));

  // Ultra-fine procedural grain.
  col += (g1 - 0.5) * 2.0 * u_grain;

  float alpha = 1.0 - smoothstep(-0.75 * u_dpr, 0.75 * u_dpr, d);
  // Drop shadow cast by the same deformed capsule (light from above), premultiplied black.
  float ds = sdPill(p + vec2(0.0, 3.0 * u_dpr), hp, r);
  float shadow = 0.26 * (1.0 - smoothstep(-2.0 * u_dpr, 16.0 * u_dpr, ds));
  o = vec4(clamp(col, 0.0, 1.0) * alpha, alpha + (1.0 - alpha) * shadow);
}`;

interface Target {
  fb: WebGLFramebuffer;
  tex: WebGLTexture;
  w: number;
  h: number;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("createShader failed");
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) ?? "shader compile failed");
  }
  return shader;
}

function program(gl: WebGL2RenderingContext, frag: string): WebGLProgram {
  const p = gl.createProgram();
  if (!p) throw new Error("createProgram failed");
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, frag));
  gl.bindAttribLocation(p, 0, "a_pos");
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link failed");
  return p;
}

function makeTexture(gl: WebGL2RenderingContext, w: number, h: number): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error("createTexture failed");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  return tex;
}

function makeTarget(gl: WebGL2RenderingContext, w: number, h: number): Target {
  const tex = makeTexture(gl, w, h);
  const fb = gl.createFramebuffer();
  if (!fb) throw new Error("createFramebuffer failed");
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fb, tex, w, h };
}

class GlassRenderer {
  private gl: WebGL2RenderingContext;
  private down: WebGLProgram;
  private up: WebGLProgram;
  private gauss: WebGLProgram;
  private comp: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private source: WebGLTexture | null = null;
  private srcW = 0;
  private srcH = 0;
  /** Pill rect inside the source frame, in source pixels (top-left origin). */
  private inner: [number, number, number, number] = [0, 0, 0, 0];
  /** `levels` downsample targets, `levels - 1` upsample targets, then two half-res Gaussian targets. */
  private chain: Target[] = [];
  private chainKey = "";
  private uniformCache = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
  private lumBuf = new Uint8Array(0);
  /** Mean luminance (0..1) of the desktop behind the pill for the latest frame; −1 before any. */
  luminance = -1;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false, alpha: true, preserveDrawingBuffer: false });
    if (!gl) throw new Error("WebGL2 unavailable");
    this.gl = gl;
    this.down = program(gl, KAWASE_DOWN);
    this.up = program(gl, KAWASE_UP);
    this.gauss = program(gl, GAUSS);
    this.comp = program(gl, COMPOSITE);
    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    if (!vao || !vbo) throw new Error("buffer allocation failed");
    this.vao = vao;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    // Single oversized triangle covering clip space.
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  }

  private loc(p: WebGLProgram, name: string): WebGLUniformLocation | null {
    let m = this.uniformCache.get(p);
    if (!m) {
      m = new Map();
      this.uniformCache.set(p, m);
    }
    if (!m.has(name)) m.set(name, this.gl.getUniformLocation(p, name));
    return m.get(name) ?? null;
  }

  /** `pixels` is the capture's raw BGRA buffer; the first blur pass swizzles it. */
  upload(width: number, height: number, pixels: Uint8Array, inner: [number, number, number, number]): void {
    const gl = this.gl;
    this.inner = inner;
    if (!this.source || width !== this.srcW || height !== this.srcH) {
      if (this.source) gl.deleteTexture(this.source);
      this.source = makeTexture(gl, width, height);
      this.srcW = width;
      this.srcH = height;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    this.frameSeq++;
  }

  private ensureChain(levels: number): void {
    const key = `${this.srcW}x${this.srcH}x${levels}`;
    if (key === this.chainKey) return;
    for (const t of this.chain) {
      this.gl.deleteFramebuffer(t.fb);
      this.gl.deleteTexture(t.tex);
    }
    const size = (level: number) => [Math.max(1, Math.round(this.srcW / 2 ** level)), Math.max(1, Math.round(this.srcH / 2 ** level))];
    const downs = Array.from({ length: levels }, (_, i) => size(i + 1));
    const ups = Array.from({ length: levels - 1 }, (_, i) => size(levels - 1 - i));
    const half = size(1);
    this.chain = [...downs, ...ups, half, half].map(([w, h]) => makeTarget(this.gl, w, h));
    this.chainKey = key;
  }

  private pass(prog: WebGLProgram, input: WebGLTexture, inW: number, inH: number, target: Target, offset: number, bgra = false): void {
    const gl = this.gl;
    gl.useProgram(prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
    gl.viewport(0, 0, target.w, target.h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, input);
    gl.uniform1i(this.loc(prog, "u_tex"), 0);
    gl.uniform2f(this.loc(prog, "u_halfpixel"), 0.5 / inW, 0.5 / inH);
    gl.uniform1f(this.loc(prog, "u_offset"), offset);
    if (prog === this.down) gl.uniform1f(this.loc(prog, "u_bgra"), bgra ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Last blurred half-res texture (reused by hover-only redraws). */
  private blurred: WebGLTexture | null = null;
  private blurKey = "";
  private frameSeq = 0;

  /** Blur when the frame / optics / size changed. False until a frame has been uploaded. */
  prepare(frost: FrostPreset): boolean {
    if (!this.source) return false;
    const key = `${this.frameSeq}|${frost.levels}|${frost.offset}|${frost.gauss}|${this.srcW}x${this.srcH}`;
    if (key !== this.blurKey || !this.blurred) {
      this.blurred = this.blur(frost);
      this.blurKey = key;
    }
    return true;
  }

  private blur(frost: FrostPreset): WebGLTexture {
    const gl = this.gl;
    const source = this.source as WebGLTexture;
    const levels = Math.max(2, Math.min(6, Math.round(frost.levels)));
    this.ensureChain(levels);
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);

    // Down the pyramid…
    let input = source;
    let inW = this.srcW;
    let inH = this.srcH;
    for (let i = 0; i < levels; i++) {
      const target = this.chain[i];
      this.pass(this.down, input, inW, inH, target, frost.offset, i === 0);
      input = target.tex;
      inW = target.w;
      inH = target.h;
    }
    this.measureLuminance(this.chain[levels - 1]);
    // …and back up to half resolution.
    const pyramid = 2 * levels - 1;
    for (let i = levels; i < pyramid; i++) {
      const target = this.chain[i];
      this.pass(this.up, input, inW, inH, target, frost.offset);
      input = target.tex;
      inW = target.w;
      inH = target.h;
    }
    // Separable Gaussian smoothing (horizontal, then vertical) at half resolution.
    const stride = 1.5;
    for (const [k, horizontal] of [[pyramid, true], [pyramid + 1, false]] as const) {
      const target = this.chain[k];
      gl.useProgram(this.gauss);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
      gl.viewport(0, 0, target.w, target.h);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, input);
      gl.uniform1i(this.loc(this.gauss, "u_tex"), 0);
      gl.uniform2f(this.loc(this.gauss, "u_dir"), horizontal ? stride / inW : 0, horizontal ? 0 : stride / inH);
      gl.uniform1f(this.loc(this.gauss, "u_sigma"), Math.max(1, frost.gauss));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      input = target.tex;
      inW = target.w;
      inH = target.h;
    }

    return input;
  }

  /** Mean luminance of the pill area from the deepest (tiny) pyramid level: one small readback per new frame. */
  private measureLuminance(t: Target): void {
    const gl = this.gl;
    const size = t.w * t.h * 4;
    if (this.lumBuf.length !== size) this.lumBuf = new Uint8Array(size);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.readPixels(0, 0, t.w, t.h, gl.RGBA, gl.UNSIGNED_BYTE, this.lumBuf);
    // Pill rect in this level's texels; rows run bottom-up (the source was uploaded flipped).
    const [ix, iy, iw, ih] = this.inner;
    const x0 = Math.floor((ix / this.srcW) * t.w);
    const x1 = Math.min(t.w, Math.max(x0 + 1, Math.ceil(((ix + iw) / this.srcW) * t.w)));
    const y0 = Math.floor(((this.srcH - iy - ih) / this.srcH) * t.h);
    const y1 = Math.min(t.h, Math.max(y0 + 1, Math.ceil(((this.srcH - iy) / this.srcH) * t.h)));
    let sum = 0;
    let count = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * t.w + x) * 4;
        sum += 0.2126 * this.lumBuf[i] + 0.7152 * this.lumBuf[i + 1] + 0.0722 * this.lumBuf[i + 2];
        count++;
      }
    }
    this.luminance = count ? sum / count / 255 : 0;
  }

  /** Composite pass only (hover animation, optics, radius, luminance / ambient easing). */
  composite(radiusCss: number, frost: FrostPreset, lum: number, ambient: [number, number, number], ambientMix: number): boolean {
    const gl = this.gl;
    const input = this.blurred;
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (!input || w === 0 || h === 0) return false;
    const dpr = window.devicePixelRatio || 1;
    const hover = getGlassHover();
    const u = (name: string) => this.loc(this.comp, name);
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);
    gl.useProgram(this.comp);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, input);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.chain[0].tex);
    gl.uniform1i(u("u_blur"), 0);
    gl.uniform1i(u("u_sharp"), 1);
    gl.uniform2f(u("u_size"), w, h);
    gl.uniform2f(u("u_pad"), PAD * dpr, PAD * dpr);
    gl.uniform1f(u("u_radius"), radiusCss * dpr);
    gl.uniform1f(u("u_dpr"), dpr);
    gl.uniform4f(u("u_tint"), frost.tintRgb[0], frost.tintRgb[1], frost.tintRgb[2], frost.tint);
    gl.uniform1f(u("u_grain"), frost.grain);
    gl.uniform1f(u("u_refract"), frost.refraction * dpr);
    gl.uniform1f(u("u_clarity"), frost.clarity);
    gl.uniform1f(u("u_rim"), frost.rim);
    gl.uniform1f(u("u_vibrancy"), frost.vibrancy);
    gl.uniform1f(u("u_lum"), Math.max(0, lum));
    gl.uniform1f(u("u_hoverActive"), hover.active);
    gl.uniform1f(u("u_hoverX"), (hover.x + PAD) * dpr);
    gl.uniform1f(u("u_hoverY"), hover.y);
    gl.uniform1f(u("u_hoverVel"), hover.vel);
    gl.uniform1f(u("u_hoverRadius"), hover.radius * dpr);
    gl.uniform1f(u("u_edgeDir"), hover.edge === "top" ? -1 : 1);
    gl.uniform3f(u("u_ambient"), ambient[0], ambient[1], ambient[2]);
    gl.uniform1f(u("u_ambientMix"), ambientMix);
    // The texture is uploaded flipped (v = 0 is the bottom row), so the pill's bottom edge maps to
    // `srcH - (y + h)`.
    const [ix, iy, iw, ih] = this.inner;
    gl.uniform4f(u("u_inner"), ix / this.srcW, (this.srcH - iy - ih) / this.srcH, iw / this.srcW, ih / this.srcH);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
    return true;
  }

  /** Free GPU resources but keep the context: the canvas may be re-used by a remount
   *  (StrictMode / theme toggles), and a lost context cannot compile shaders again. */
  dispose(): void {
    const gl = this.gl;
    for (const t of this.chain) {
      gl.deleteFramebuffer(t.fb);
      gl.deleteTexture(t.tex);
    }
    this.chain = [];
    this.chainKey = "";
    if (this.source) gl.deleteTexture(this.source);
    this.source = null;
    this.blurred = null;
    gl.deleteProgram(this.down);
    gl.deleteProgram(this.up);
    gl.deleteProgram(this.gauss);
    gl.deleteProgram(this.comp);
    gl.deleteVertexArray(this.vao);
  }
}

const CAPTURE_URL = convertFileSrc("capture", "glass");

/** `X-Inner: x,y,w,h` — the pill inside the frame; the whole frame when absent or malformed. */
function parseInner(header: string | null, width: number, height: number): [number, number, number, number] {
  const parts = (header ?? "").split(",").map(Number);
  const [x, y, w, h] = parts;
  const valid = parts.length === 4 && parts.every((n) => Number.isFinite(n) && n >= 0) && w > 0 && h > 0 && x + w <= width && y + h <= height;
  return valid ? [x, y, w, h] : [0, 0, width, height];
}

/** Time constants of the adaptive-luminance and ambient-colour easing (the CSS bar glow takes 600 ms). */
const LUM_TAU = 0.3;
const AMBIENT_TAU = 0.2;

let probe: CanvasRenderingContext2D | null = null;
/** Any CSS colour (the ambient palette is oklch) -> sRGB 0..1, rasterised by a 1×1 canvas. */
function cssRgb(css: string): [number, number, number] {
  probe ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!probe) return [1, 1, 1];
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = "#fff";
  probe.fillStyle = css;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
  return [r / 255, g / 255, b / 255];
}

/**
 * Renders behind the dock pill. `onActiveChange(true)` once the first desktop frame has been
 * drawn — until then (or if capture is unavailable) the dock shows its CSS fallback surface.
 * The eased luminance is mirrored on the pill as `--lb-glass-lum` / `data-glass-bright` so the
 * foreground can add contrast shadows over bright desktops. `ambient` is the dock's live colour
 * (Ambiance Musique), or null for neutral white highlights.
 */
export function LiquidGlassCanvas(props: { radius: number; frost: FrostPreset; ambient: string | null; onActiveChange: (active: boolean) => void }) {
  const { radius, frost, ambient, onActiveChange } = props;
  const ambientRef = useRef<[number, number, number] | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const radiusRef = useRef(radius);
  radiusRef.current = radius;
  const frostRef = useRef(frost);
  frostRef.current = frost;
  const activeCb = useRef(onActiveChange);
  activeCb.current = onActiveChange;
  const redraw = useRef<(() => void) | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let renderer: GlassRenderer;
    try {
      renderer = new GlassRenderer(canvas);
    } catch (err) {
      console.warn("[winglass] liquid glass disabled:", err);
      activeCb.current(false);
      return;
    }

    let disposed = false;
    let inflight = false;
    let wanted = 0;
    let fetched = -1;
    let hasFrame = false;
    let raf = 0;
    let lum = -1;
    let easedAt = 0;
    let lumCss = "";
    const amb: [number, number, number] = [1, 1, 1];
    let ambMix = 0;

    const host = canvas.parentElement;
    const mirrorLuminance = () => {
      const css = lum.toFixed(2);
      if (!host || css === lumCss) return;
      lumCss = css;
      host.style.setProperty("--lb-glass-lum", css);
      host.dataset.glassBright = lum > 0.62 ? "true" : "false";
    };

    const draw = (now: number) => {
      raf = 0;
      if (disposed) return;
      let ok = renderer.prepare(frostRef.current);
      if (ok) {
        const dt = easedAt ? Math.min(0.1, (now - easedAt) / 1000) : 0;
        easedAt = now;
        const target = renderer.luminance;
        lum = lum < 0 ? target : lum + (target - lum) * (1 - Math.exp(-dt / LUM_TAU));
        // Ambient colour: glides between tracks; appears / fades out through the mix.
        const goal = ambientRef.current;
        const a = 1 - Math.exp(-dt / AMBIENT_TAU);
        if (goal) for (let i = 0; i < 3; i++) amb[i] += (goal[i] - amb[i]) * (ambMix < 0.01 ? 1 : a);
        ambMix += ((goal ? 1 : 0) - ambMix) * a;
        ok = renderer.composite(radiusRef.current, frostRef.current, lum, amb, ambMix);
        mirrorLuminance();
        // Keep easing (composite-only frames, ~1 s at most).
        const easing =
          Math.abs(target - lum) > 0.004 || Math.abs((goal ? 1 : 0) - ambMix) > 0.004 || (goal !== null && goal.some((v, i) => Math.abs(v - amb[i]) > 0.004));
        if (easing) scheduleDraw();
        else easedAt = 0;
      }
      if (ok !== hasFrame) {
        hasFrame = ok;
        activeCb.current(ok);
      }
    };
    const scheduleDraw = () => {
      if (!raf && !disposed) raf = requestAnimationFrame(draw);
    };
    redraw.current = scheduleDraw;

    const pull = async () => {
      if (inflight || disposed || wanted === fetched) return;
      inflight = true;
      const seq = wanted;
      try {
        const resp = await fetch(`${CAPTURE_URL}?t=${seq}`, { cache: "no-store" });
        if (resp.status === 200) {
          const w = Number(resp.headers.get("X-Width"));
          const h = Number(resp.headers.get("X-Height"));
          const buf = new Uint8Array(await resp.arrayBuffer());
          if (w > 0 && h > 0 && buf.length === w * h * 4 && !disposed) {
            renderer.upload(w, h, buf, parseInner(resp.headers.get("X-Inner"), w, h));
            scheduleDraw();
          }
        }
        fetched = seq;
      } catch (err) {
        console.warn("[winglass] glass frame fetch failed", err);
      } finally {
        inflight = false;
        if (wanted !== fetched) void pull();
      }
    };

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        scheduleDraw();
      }
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    // Cursor droplet: composite-only redraws, one per animation frame at most.
    const offHover = onGlassHover(() => {
      if (hasFrame) scheduleDraw();
    });

    const off = subscribe("glass:frame", (seq) => {
      wanted = seq;
      void pull();
    });
    // Pick up a frame captured before this component mounted.
    wanted = Number.MAX_SAFE_INTEGER;
    void pull();

    return () => {
      disposed = true;
      redraw.current = null;
      off();
      offHover();
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
      renderer.dispose();
      host?.style.removeProperty("--lb-glass-lum");
      if (host) delete host.dataset.glassBright;
      activeCb.current(false);
    };
  }, []);

  // Slider / theme / radius / ambient changes re-composite the frame already on the GPU.
  useEffect(() => {
    ambientRef.current = ambient ? cssRgb(ambient) : null;
    redraw.current?.();
  }, [frost, radius, ambient]);

  // The canvas covers the pill's border box (the pill border is transparent while glass is live)
  // plus PAD on every side, where the droplet, the stretched ends and the drop shadow are drawn.
  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute"
      style={{ left: -1 - PAD, top: -1 - PAD, width: `calc(100% + ${2 + 2 * PAD}px)`, height: `calc(100% + ${2 + 2 * PAD}px)` }}
      aria-hidden
    />
  );
}
