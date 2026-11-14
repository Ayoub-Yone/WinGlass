// WebGL2 "matte liquid glass": the live desktop behind the dock, diffused into frosted glass.
//
// Pipeline (renders only when a new backdrop frame arrives, the canvas resizes or the frost preset
// changes — never on an idle rAF loop, so a static desktop costs zero GPU work):
//   upload  glass://capture BGRA  ->  source texture (swizzled to RGB in the first pass)
//           The live capture includes a margin around the pill (X-Inner says where the pill is),
//           so the blur pulls in real colour from outside instead of smearing its edge pixels.
//   pass 1  dual-Kawase blur pyramid: 4–6 downsample + matching upsample passes with wide sample
//           offsets (~60–120px effective radius). Deep enough that windows, text and bright
//           elements melt into smooth, creamy colour gradients — no shapes bleed through.
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

import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import { GLASS_TINT_RGB, type FrostPreset } from "../engine/ThemeEngine";
import { subscribe } from "../lib/ipc";

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

void main() {
  vec2 half_size = u_size * 0.5;
  vec2 p = v_uv * u_size - half_size;
  float r = min(u_radius, min(half_size.x, half_size.y));
  float d = sdRoundedBox(p, half_size, r);

  // Outward surface normal from the SDF gradient.
  vec2 e = vec2(1.0, 0.0);
  vec2 n = vec2(
    sdRoundedBox(p + e.xy, half_size, r) - sdRoundedBox(p - e.xy, half_size, r),
    sdRoundedBox(p + e.yx, half_size, r) - sdRoundedBox(p - e.yx, half_size, r));
  n = normalize(n + 1e-6);

  // Optical edge: a 10px bevel with a circular profile, so the bend starts imperceptibly and
  // steepens smoothly towards the rim (no visible seam where refraction begins).
  float t = clamp(1.0 + d / (10.0 * u_dpr), 0.0, 1.0);
  float bend = 1.0 - sqrt(max(1.0 - t * t, 0.0));

  // Frosted diffusion: every pixel looks through the glass at a slightly different angle.
  float g1 = hash12(gl_FragCoord.xy);
  float g2 = hash12(gl_FragCoord.xy + 61.7);
  vec2 scatter = (vec2(g1, g2) - 0.5) * (u_grain / 0.012) * (1.5 * u_dpr) / u_size;

  vec2 uv = v_uv - n * bend * (14.0 * u_dpr) / u_size + scatter;

  // Chromatic dispersion: R and B pulled ±0.0015 along the normal at the rim.
  float ca = 0.0015 * bend;
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
  private comp: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private source: WebGLTexture | null = null;
  private srcW = 0;
  private srcH = 0;
  /** Pill rect inside the source frame, in source pixels (top-left origin). */
  private inner: [number, number, number, number] = [0, 0, 0, 0];
  /** `levels` downsample targets followed by `levels - 1` upsample targets. */
  private chain: Target[] = [];
  private chainKey = "";
  private uniformCache = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false, alpha: true, preserveDrawingBuffer: false });
    if (!gl) throw new Error("WebGL2 unavailable");
    this.gl = gl;
    this.down = program(gl, KAWASE_DOWN);
    this.up = program(gl, KAWASE_UP);
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
    this.chain = [...downs, ...ups].map(([w, h]) => makeTarget(this.gl, w, h));
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

  render(radiusCss: number, frost: FrostPreset): boolean {
    if (!this.source) return false;
    const gl = this.gl;
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (w === 0 || h === 0) return false;
    const levels = Math.max(2, Math.min(6, Math.round(frost.levels)));
    this.ensureChain(levels);
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);

    // Down the pyramid…
    let input = this.source;
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
    for (let i = levels; i < this.chain.length; i++) {
      const target = this.chain[i];
      this.pass(this.up, input, inW, inH, target, frost.offset);
      input = target.tex;
      inW = target.w;
      inH = target.h;
    }

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
    gl.deleteProgram(this.down);
    gl.deleteProgram(this.up);
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
      const ok = renderer.render(radiusRef.current, frostRef.current);
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

  // The canvas covers the pill's border box (the pill border is transparent while glass is live).
  return <canvas ref={canvasRef} className="pointer-events-none absolute h-full w-full" style={{ inset: -1, width: "calc(100% + 2px)", height: "calc(100% + 2px)", borderRadius: radius }} aria-hidden />;
}
