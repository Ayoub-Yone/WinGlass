// WebGL2 "liquid glass": live desktop refraction behind the dock.
//
// Pipeline (renders only when a new DXGI frame arrives or the canvas resizes — never on an idle
// rAF loop, so a static desktop costs zero GPU work):
//   upload  glass://capture RGBA  ->  source texture
//   pass 1  dual-Kawase blur: 3 downsample + 2 upsample passes (multi-tap, ≈ 28px Gaussian)
//   pass 2  composite: SDF rounded-box refraction (UVs bend inward near the rim), ±0.002 R/B
//           chromatic dispersion at the edges, 1px specular rim light on the top/bottom bevel,
//           dark tint, anti-aliased capsule mask.

import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
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
void main() {
  vec2 hp = u_halfpixel * u_offset;
  vec4 sum = texture(u_tex, v_uv) * 4.0;
  sum += texture(u_tex, v_uv - hp);
  sum += texture(u_tex, v_uv + hp);
  sum += texture(u_tex, v_uv + vec2(hp.x, -hp.y));
  sum += texture(u_tex, v_uv - vec2(hp.x, -hp.y));
  o = sum / 8.0;
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
uniform vec4 u_tint;

float sdRoundedBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
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

  // Edge-weighted refraction: strongest at the rim, fading to zero ~18px inside.
  float edge = 18.0 * u_dpr;
  float t = clamp(1.0 + d / edge, 0.0, 1.0);
  float bend = t * t * t;
  vec2 uv = v_uv - n * bend * (12.0 * u_dpr) / u_size;

  // Chromatic dispersion: R and B pulled ±0.002 along the normal at the edges.
  float ca = 0.002 * bend;
  vec3 col;
  col.r = texture(u_blur, uv + n * ca).r;
  col.g = texture(u_blur, uv).g;
  col.b = texture(u_blur, uv - n * ca).b;

  // Gentle vibrancy, then the theme tint.
  float luma = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(luma), col, 1.18);
  col = mix(col, u_tint.rgb, u_tint.a);

  // 1px specular rim light along the top (brighter) and bottom bevel.
  float rim = 1.0 - smoothstep(0.0, 1.0 * u_dpr, abs(d + 0.75 * u_dpr));
  float vertical = smoothstep(0.15, 0.95, abs(n.y));
  float topLight = n.y > 0.0 ? 0.55 : 0.22;
  col += vec3(rim * vertical * topLight);
  // Soft inner glow just inside the rim.
  col += vec3(0.06 * bend * max(n.y, 0.0));

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

  upload(width: number, height: number, rgba: Uint8Array): void {
    const gl = this.gl;
    if (!this.source || width !== this.srcW || height !== this.srcH) {
      if (this.source) gl.deleteTexture(this.source);
      this.source = makeTexture(gl, width, height);
      this.srcW = width;
      this.srcH = height;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  }

  private ensureChain(): void {
    const key = `${this.srcW}x${this.srcH}`;
    if (key === this.chainKey) return;
    for (const t of this.chain) {
      this.gl.deleteFramebuffer(t.fb);
      this.gl.deleteTexture(t.tex);
    }
    const sizes = [2, 4, 8].map((d) => [Math.max(1, Math.round(this.srcW / d)), Math.max(1, Math.round(this.srcH / d))]);
    // down: /2, /4, /8 · up: /4, /2
    this.chain = [...sizes, sizes[1], sizes[0]].map(([w, h]) => makeTarget(this.gl, w, h));
    this.chainKey = key;
  }

  private pass(prog: WebGLProgram, input: WebGLTexture, inW: number, inH: number, target: Target, offset: number): void {
    const gl = this.gl;
    gl.useProgram(prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
    gl.viewport(0, 0, target.w, target.h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, input);
    gl.uniform1i(this.loc(prog, "u_tex"), 0);
    gl.uniform2f(this.loc(prog, "u_halfpixel"), 0.5 / inW, 0.5 / inH);
    gl.uniform1f(this.loc(prog, "u_offset"), offset);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  render(radiusCss: number, tint: [number, number, number, number]): boolean {
    if (!this.source) return false;
    const gl = this.gl;
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (w === 0 || h === 0) return false;
    this.ensureChain();
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);

    const [d1, d2, d3, u2, u1] = this.chain;
    this.pass(this.down, this.source, this.srcW, this.srcH, d1, 1.5);
    this.pass(this.down, d1.tex, d1.w, d1.h, d2, 1.5);
    this.pass(this.down, d2.tex, d2.w, d2.h, d3, 1.5);
    this.pass(this.up, d3.tex, d3.w, d3.h, u2, 1.5);
    this.pass(this.up, u2.tex, u2.w, u2.h, u1, 1.5);

    gl.useProgram(this.comp);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, u1.tex);
    gl.uniform1i(this.loc(this.comp, "u_blur"), 0);
    gl.uniform2f(this.loc(this.comp, "u_size"), w, h);
    gl.uniform1f(this.loc(this.comp, "u_radius"), radiusCss * dpr);
    gl.uniform1f(this.loc(this.comp, "u_dpr"), dpr);
    gl.uniform4f(this.loc(this.comp, "u_tint"), ...tint);
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

/**
 * Renders behind the dock pill. `onActiveChange(true)` once the first desktop frame has been
 * drawn — until then (or if capture is unavailable) the dock shows its CSS fallback surface.
 */
export function LiquidGlassCanvas(props: { radius: number; onActiveChange: (active: boolean) => void }) {
  const { radius, onActiveChange } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const radiusRef = useRef(radius);
  radiusRef.current = radius;
  const activeCb = useRef(onActiveChange);
  activeCb.current = onActiveChange;

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

    // Tint rgba(18, 18, 22, 0.28)
    const tint: [number, number, number, number] = [18 / 255, 18 / 255, 22 / 255, 0.28];
    let disposed = false;
    let inflight = false;
    let wanted = 0;
    let fetched = -1;
    let hasFrame = false;
    let raf = 0;

    const draw = () => {
      raf = 0;
      if (disposed) return;
      const ok = renderer.render(radiusRef.current, tint);
      if (ok !== hasFrame) {
        hasFrame = ok;
        activeCb.current(ok);
      }
    };
    const scheduleDraw = () => {
      if (!raf) raf = requestAnimationFrame(draw);
    };

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
            renderer.upload(w, h, buf);
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
      off();
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
      renderer.dispose();
      activeCb.current(false);
    };
  }, []);

  return <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" style={{ borderRadius: radius }} aria-hidden />;
}
