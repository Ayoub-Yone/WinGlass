// WebGL2 "matte liquid glass": the live desktop behind the dock, diffused into frosted glass.
//
// Pipeline (renders only when a new backdrop frame arrives, the canvas resizes or the frost preset
// changes — never on an idle rAF loop, so a static desktop costs zero GPU work):
//   upload  glass://capture BGRA  ->  source texture (swizzled to RGB in the first pass)
//           The live capture includes a margin around the pill (X-Inner says where the pill is),
//           so the blur pulls in real colour from outside instead of smearing its edge pixels.
//   pass 1  dual-Kawase blur pyramid: 5–6 downsample + matching upsample passes with wide sample
//           offsets (~80–160px effective radius). Deep enough that windows, text and bright
//           elements melt into smooth, creamy colour gradients — no shapes bleed through.
//   pass 1b separable 25-tap Gaussian (horizontal + vertical) at half resolution on top of the
//           pyramid: irons out the faint diamond / blocky Kawase artefacts so live windows behind
//           the dock diffuse into one soft, continuous frost.
//   pass 2  composite:
//             · SDF rounded-box lens — UVs bend along the outer 10px perimeter with a circular
//               bevel profile, ±0.0015 R/B chromatic dispersion at the rim
//             · micro-grain diffusion — sub-pixel UV jitter + ~0.012 luminance grain (static, so
//               it never forces a redraw) for a tactile matte finish instead of glossy plastic
//             · adaptive contrast veil — the matte tint thickens over bright backgrounds so white
//               text stays readable on a pure-white wallpaper, and a faint lift keeps the glass
//               visible on pitch black
//             · soft inner ambient shadow, crisp 1px specular light catch along the top edge
//             · anti-aliased capsule mask
//             · hover (iOS 26 liquid glass): the capsule's screen-centre edge swells over the
//               hovered icon (+6.5px) with gentle inward pinches (≈−1.6px) over the shrunken
//               neighbours — a Mexican-hat profile 11.5·e^(−u²) − 5·e^(−u²/4), u = (x−hx)/R —
//               the backdrop inside the bulge is magnified by a radial lens with ±0.0032
//               dispersion, and the rim light + a specular caustic trace the curved edge.
//               Hover only re-runs this composite pass — the blur stays cached.

import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import { GLASS_TINT_RGB, type FrostPreset } from "../engine/ThemeEngine";
import { subscribe } from "../lib/ipc";
import { getGlassHover, onGlassHover } from "../lib/magnify";

/** Transparent CSS px above and below the pill so the bulge has room inside the canvas. */
const BULGE_PAD = 10;

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
uniform sampler2D u_blur;
uniform vec2 u_size;      // canvas size in device px
uniform float u_radius;   // corner radius in device px
uniform float u_dpr;
uniform vec4 u_tint;      // matte veil colour + base opacity
uniform vec4 u_inner;     // pill rect inside the blurred frame: xy = offset, zw = scale (uv units)
uniform float u_grain;    // micro-grain amplitude (~0.012)
uniform float u_pad;      // device px of empty canvas above and below the pill (bulge room)
uniform float u_hoverActive;  // 0..1 (smoothed)
uniform float u_hoverX;       // device px from the canvas' left edge
uniform float u_hoverRadius;  // device px
uniform float u_edgeDir;      // +1 docked at the bottom (swell upward), -1 docked at the top

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

// Pill-space uv -> blurred-frame uv (the frame has a capture margin around the pill).
vec3 glass(vec2 uv) {
  return texture(u_blur, u_inner.xy + uv * u_inner.zw).rgb;
}

// Distance from the cursor in bulge radii, at canvas-centred x.
float hoverU(float x) {
  return (x + u_size.x * 0.5 - u_hoverX) / max(u_hoverRadius, 1.0);
}

// Lens strength: Gaussian around the cursor.
float hoverWeight(float x) {
  float u = hoverU(x);
  return u_hoverActive * exp(-u * u);
}

// Outline offset in device px: +6.5 over the cursor, a gentle pinch (min ≈ −1.6 at u ≈ 2) over
// the shrunken neighbours, 0 far away.
float bulgePx(float x) {
  float u2 = hoverU(x);
  u2 *= u2;
  return u_hoverActive * u_dpr * (11.5 * exp(-u2) - 5.0 * exp(-0.25 * u2));
}

// The capsule with its screen-centre edge displaced by bulgePx (the screen-edge side stays put).
float sdPill(vec2 p, vec2 half_pill, float r) {
  float b = bulgePx(p.x);
  float hy = half_pill.y + 0.5 * b;
  vec2 q = p - vec2(0.0, u_edgeDir * 0.5 * b);
  return sdRoundedBox(q, vec2(half_pill.x, hy), clamp(r + 0.5 * b, 0.0, hy));
}

void main() {
  vec2 half_size = u_size * 0.5;
  vec2 half_pill = vec2(half_size.x, half_size.y - u_pad);
  vec2 pill_size = half_pill * 2.0;
  vec2 p = v_uv * u_size - half_size;
  float r = min(u_radius, min(half_pill.x, half_pill.y));
  float d = sdPill(p, half_pill, r);

  // Outward surface normal from the SDF gradient (follows the bulge's curve).
  vec2 e = vec2(1.0, 0.0);
  vec2 n = vec2(
    sdPill(p + e.xy, half_pill, r) - sdPill(p - e.xy, half_pill, r),
    sdPill(p + e.yx, half_pill, r) - sdPill(p - e.yx, half_pill, r));
  n = normalize(n + 1e-6);
  float lensW = hoverWeight(p.x);
  // Pill-space uv (0..1 across the resting pill; the bulge reads the capture margin beyond it).
  vec2 puv = (p + half_pill) / pill_size;

  // Optical edge: a 10px bevel with a circular profile, so the bend starts imperceptibly and
  // steepens smoothly towards the rim (no visible seam where refraction begins).
  float t = clamp(1.0 + d / (10.0 * u_dpr), 0.0, 1.0);
  float bend = 1.0 - sqrt(max(1.0 - t * t, 0.0));

  // Frosted diffusion: every pixel looks through the glass at a slightly different angle.
  float g1 = hash12(gl_FragCoord.xy);
  float g2 = hash12(gl_FragCoord.xy + 61.7);
  vec2 scatter = (vec2(g1, g2) - 0.5) * (u_grain / 0.012) * (1.5 * u_dpr) / pill_size;

  vec2 uv = puv - n * bend * (14.0 * u_dpr) / pill_size + scatter;

  // Liquid lens under the cursor: radial magnification of the backdrop toward the hover centre,
  // strongest in the middle of the bulge.
  vec2 lensCenter = vec2((u_hoverX - (u_size.x * 0.5 - half_pill.x)) / pill_size.x, 0.5);
  vec2 toC = uv - lensCenter;
  float lensRefract = 0.14 * lensW * (1.0 - 0.5 * clamp(length(toC * vec2(pill_size.x / pill_size.y, 1.0)) * 0.5, 0.0, 1.0));
  uv = lensCenter + toC * (1.0 - lensRefract);

  // Chromatic dispersion: R and B pulled ±0.0015 along the normal at the rim, up to ±0.0032 in
  // the bulge.
  float ca = mix(0.0015, 0.0032, lensW) * max(bend, 0.35 * lensW);
  vec3 col;
  col.r = glass(uv + n * ca).r;
  col.g = glass(uv).g;
  col.b = glass(uv - n * ca).b;

  // Matte: only a whisper of vibrancy, then the adaptive contrast veil.
  float luma = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(luma), col, 1.06);
  float veil = clamp(u_tint.a + 0.30 * smoothstep(0.42, 0.95, luma), 0.0, 0.9);
  col = mix(col, u_tint.rgb, veil);
  // Keep the pane distinguishable from a pitch-black wallpaper.
  col += vec3(0.020, 0.021, 0.024);

  // Soft inner ambient shadow, heavier along the bottom, for depth.
  float inner = smoothstep(-16.0 * u_dpr, 0.0, d);
  col *= 1.0 - 0.16 * inner * inner * (0.55 + 0.45 * clamp(-n.y, 0.0, 1.0));

  // Crisp 1px specular light catch on the top edge (rgba(255,255,255,0.26)); a faint echo below.
  float rim = 1.0 - smoothstep(0.35 * u_dpr, 0.85 * u_dpr, abs(d + 0.6 * u_dpr));
  float top = smoothstep(0.25, 0.9, n.y);
  float bottom = smoothstep(0.25, 0.9, -n.y);
  col = mix(col, vec3(1.0), rim * (0.26 * top + 0.07 * bottom + 0.045));
  // Specular caustic tracing the swollen edge: a soft band just inside the curved rim.
  float caustic = lensW * smoothstep(-5.0 * u_dpr, -0.5 * u_dpr, d) * (1.0 - smoothstep(-0.5 * u_dpr, 0.6 * u_dpr, d));
  col = mix(col, vec3(1.0), caustic * (0.22 * top + 0.12 * bottom + 0.05));

  // Ultra-fine procedural grain.
  col += (g1 - 0.5) * 2.0 * u_grain;

  float alpha = 1.0 - smoothstep(-0.75 * u_dpr, 0.75 * u_dpr, d);
  o = vec4(clamp(col, 0.0, 1.0) * alpha, alpha);
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

  /** Blur (when the frame / frost / size changed) and composite. */
  render(radiusCss: number, frost: FrostPreset, padCss: number): boolean {
    if (!this.source) return false;
    const key = `${this.frameSeq}|${frost.id}|${frost.levels}|${frost.offset}|${frost.gauss}|${this.srcW}x${this.srcH}`;
    if (key !== this.blurKey || !this.blurred) {
      this.blurred = this.blur(frost);
      this.blurKey = key;
    }
    return this.composite(radiusCss, frost, padCss);
  }

  private frameSeq = 0;

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
    if (frost.gauss > 0) {
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
        gl.uniform1f(this.loc(this.gauss, "u_sigma"), frost.gauss);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        input = target.tex;
        inW = target.w;
        inH = target.h;
      }
    }

    return input;
  }

  /** Composite pass only (hover animation, frost tint, radius). */
  composite(radiusCss: number, frost: FrostPreset, padCss: number): boolean {
    const gl = this.gl;
    const input = this.blurred;
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (!input || w === 0 || h === 0) return false;
    const dpr = window.devicePixelRatio || 1;
    const hover = getGlassHover();
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);
    gl.useProgram(this.comp);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, input);
    gl.uniform1i(this.loc(this.comp, "u_blur"), 0);
    gl.uniform2f(this.loc(this.comp, "u_size"), w, h);
    gl.uniform1f(this.loc(this.comp, "u_radius"), radiusCss * dpr);
    gl.uniform1f(this.loc(this.comp, "u_dpr"), dpr);
    gl.uniform4f(this.loc(this.comp, "u_tint"), GLASS_TINT_RGB[0], GLASS_TINT_RGB[1], GLASS_TINT_RGB[2], frost.tint);
    gl.uniform1f(this.loc(this.comp, "u_grain"), frost.grain);
    gl.uniform1f(this.loc(this.comp, "u_pad"), padCss * dpr);
    gl.uniform1f(this.loc(this.comp, "u_hoverActive"), hover.active);
    gl.uniform1f(this.loc(this.comp, "u_hoverX"), (hover.x + 1) * dpr); // canvas starts 1px left of the pill
    gl.uniform1f(this.loc(this.comp, "u_hoverRadius"), hover.radius * dpr);
    gl.uniform1f(this.loc(this.comp, "u_edgeDir"), hover.edge === "top" ? -1 : 1);
    // The texture is uploaded flipped (v = 0 is the bottom row), so the pill's bottom edge maps to
    // `srcH - (y + h)`.
    const [ix, iy, iw, ih] = this.inner;
    gl.uniform4f(this.loc(this.comp, "u_inner"), ix / this.srcW, (this.srcH - iy - ih) / this.srcH, iw / this.srcW, ih / this.srcH);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
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

/**
 * Renders behind the dock pill. `onActiveChange(true)` once the first desktop frame has been
 * drawn — until then (or if capture is unavailable) the dock shows its CSS fallback surface.
 */
export function LiquidGlassCanvas(props: { radius: number; frost: FrostPreset; onActiveChange: (active: boolean) => void }) {
  const { radius, frost, onActiveChange } = props;
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
      console.warn("[lumabar] liquid glass disabled:", err);
      activeCb.current(false);
      return;
    }

    let disposed = false;
    let inflight = false;
    let wanted = 0;
    let fetched = -1;
    let hasFrame = false;
    let raf = 0;

    const draw = () => {
      raf = 0;
      if (disposed) return;
      const ok = renderer.render(radiusRef.current, frostRef.current, BULGE_PAD);
      if (ok !== hasFrame) {
        hasFrame = ok;
        activeCb.current(ok);
      }
    };
    const scheduleDraw = () => {
      if (!raf) raf = requestAnimationFrame(draw);
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
        console.warn("[lumabar] glass frame fetch failed", err);
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

    // Hover bulge: composite-only redraws, one per animation frame at most.
    let hoverRaf = 0;
    const offHover = onGlassHover(() => {
      if (hoverRaf || disposed || !hasFrame) return;
      hoverRaf = requestAnimationFrame(() => {
        hoverRaf = 0;
        if (!disposed) renderer.composite(radiusRef.current, frostRef.current, BULGE_PAD);
      });
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
      if (hoverRaf) cancelAnimationFrame(hoverRaf);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
      renderer.dispose();
      activeCb.current(false);
    };
  }, []);

  // Frost slider / radius changes re-composite the frame already on the GPU.
  useEffect(() => {
    redraw.current?.();
  }, [frost, radius]);

  // The canvas covers the pill's border box (the pill border is transparent while glass is live)
  // plus BULGE_PAD above and below, where the swollen capsule is drawn on hover.
  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute"
      style={{ left: -1, top: -1 - BULGE_PAD, width: "calc(100% + 2px)", height: `calc(100% + ${2 + 2 * BULGE_PAD}px)` }}
      aria-hidden
    />
  );
}
