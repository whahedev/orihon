import { createEl } from "../dom.js";
import { MAX_LAT, TILE_SIZE, LatLngBounds, latLng, type LatLngLike } from "../geo.js";
import { Layer, type LayerOptions } from "../layer.js";
import type { Orihon } from "../map.js";
import type { PathOptions } from "./vector.js";

export interface WebGLPathBatchOptions extends LayerOptions, PathOptions {
  className?: string;
  maxDpr?: number;
  /** Fall back to Canvas 2D if WebGL init fails. Default true. */
  fallbackCanvas?: boolean;
}

type ResolvedOptions = Required<
  Pick<WebGLPathBatchOptions, "pane" | "stroke" | "strokeWidth" | "strokeOpacity" | "maxDpr" | "fallbackCanvas" | "className">
> &
  WebGLPathBatchOptions;

interface GLLocs {
  aAlong: number;
  aSide: number;
  aA: number;
  aB: number;
  uScale: WebGLUniformLocation | null;
  uOrigin: WebGLUniformLocation | null;
  uResolution: WebGLUniformLocation | null;
  uDpr: WebGLUniformLocation | null;
  uHalfWidth: WebGLUniformLocation | null;
  uColor: WebGLUniformLocation | null;
}

interface RGB {
  r: number;
  g: number;
  b: number;
}

type InstancedExt = {
  vertexAttribDivisorANGLE(index: number, divisor: number): void;
  drawArraysInstancedANGLE(mode: number, first: number, count: number, primcount: number): void;
};

/**
 * GPU stroked polylines: mercator segments uploaded once, camera via uniforms.
 * Uses ANGLE_instanced_arrays when available (one instance per segment).
 */
export class WebGLPathBatch extends Layer<ResolvedOptions> {
  canvas: HTMLCanvasElement | null = null;
  gl: WebGLRenderingContext | null = null;
  renderer: "webgl" | "canvas" | "none" = "none";
  private program: WebGLProgram | null = null;
  private quadBuffer: WebGLBuffer | null = null;
  private instanceBuffer: WebGLBuffer | null = null;
  private locs: GLLocs | null = null;
  private ext: InstancedExt | null = null;
  /** Per-segment: ax, ay, bx, by (normalized mercator). */
  private _segBuf = new Float32Array(0);
  private _segmentCount = 0;
  private _bufferDirty = true;
  private _gpuBytes = 0;
  private _cssW = 0;
  private _cssH = 0;
  private _attribsBound = false;
  private _drawnZoom = Number.NaN;
  private _drawnOriginX = 0;
  private _drawnOriginY = 0;
  private color: RGB;
  private _minLat = Number.POSITIVE_INFINITY;
  private _maxLat = Number.NEGATIVE_INFINITY;
  private _minLng = Number.POSITIVE_INFINITY;
  private _maxLng = Number.NEGATIVE_INFINITY;
  /** Canvas fallback path storage (only filled when renderer === "canvas"). */
  private _canvasRings: Array<{ lat: Float64Array; lng: Float64Array }> = [];

  constructor(options: WebGLPathBatchOptions = {}) {
    super({
      pane: "overlay",
      className: "oh-webgl-path-batch",
      stroke: "#0f766e",
      strokeWidth: 1.5,
      strokeOpacity: 0.7,
      maxDpr: 1,
      fallbackCanvas: true,
      interactive: false,
      ...options
    } as ResolvedOptions);
    this.color = parseColor(String(this.options.stroke ?? "#0f766e"));
  }

  get count(): number {
    return this._segmentCount;
  }

  getBounds(): LatLngBounds {
    const bounds = new LatLngBounds();
    if (!Number.isFinite(this._minLat)) return bounds;
    bounds.extend([this._minLat, this._minLng]);
    bounds.extend([this._maxLat, this._maxLng]);
    return bounds;
  }

  clearPaths(): this {
    this._segBuf = new Float32Array(0);
    this._segmentCount = 0;
    this._bufferDirty = true;
    this._canvasRings = [];
    this._minLat = Number.POSITIVE_INFINITY;
    this._maxLat = Number.NEGATIVE_INFINITY;
    this._minLng = Number.POSITIVE_INFINITY;
    this._maxLng = Number.NEGATIVE_INFINITY;
    this._drawnZoom = Number.NaN;
    this.render();
    return this;
  }

  addPath(rings: LatLngLike[][], _closed = false, style: PathOptions = {}): this {
    if (style.stroke) this.color = parseColor(String(style.stroke));
    if (style.strokeWidth != null) this.options.strokeWidth = style.strokeWidth;
    if (style.strokeOpacity != null) this.options.strokeOpacity = style.strokeOpacity;

    const keepCanvas = this.renderer === "canvas" || this.renderer === "none";

    for (const ring of rings) {
      if (ring.length < 2) continue;
      const lat = keepCanvas ? new Float64Array(ring.length) : null;
      const lng = keepCanvas ? new Float64Array(ring.length) : null;
      const mercX = new Float64Array(ring.length);
      const mercY = new Float64Array(ring.length);
      for (let i = 0; i < ring.length; i++) {
        const p = latLng(ring[i]);
        if (lat && lng) {
          lat[i] = p.lat;
          lng[i] = p.lng;
        }
        const m = latLngToMercator(p.lat, p.lng);
        mercX[i] = m.x;
        mercY[i] = m.y;
        if (p.lat < this._minLat) this._minLat = p.lat;
        if (p.lat > this._maxLat) this._maxLat = p.lat;
        if (p.lng < this._minLng) this._minLng = p.lng;
        if (p.lng > this._maxLng) this._maxLng = p.lng;
      }
      if (lat && lng) this._canvasRings.push({ lat, lng });

      const segments = ring.length - 1;
      this.#ensureCapacity((this._segmentCount + segments) * 4);
      let write = this._segmentCount * 4;
      const buf = this._segBuf;
      for (let i = 0; i < segments; i++) {
        buf[write++] = mercX[i];
        buf[write++] = mercY[i];
        buf[write++] = mercX[i + 1];
        buf[write++] = mercY[i + 1];
      }
      this._segmentCount = write / 4;
    }
    this._bufferDirty = true;
    this._drawnZoom = Number.NaN;
    if (this.map) this.render();
    return this;
  }

  override onAdd(map: Orihon): void {
    super.onAdd(map);
    const pane = this.getPane();
    if (!pane) throw new Error(`Orihon pane not found: ${this.options.pane}`);
    this.canvas = createEl("canvas", this.options.className ?? "oh-webgl-path-batch", pane);
    this.canvas.style.position = "absolute";
    this.canvas.style.left = "0";
    this.canvas.style.top = "0";
    this.canvas.style.pointerEvents = "none";
    this.gl =
      this.canvas.getContext("webgl", {
        antialias: false,
        alpha: true,
        depth: false,
        stencil: false,
        premultipliedAlpha: true,
        powerPreference: "high-performance",
        preserveDrawingBuffer: false,
        desynchronized: true
      } as WebGLContextAttributes) ||
      this.canvas.getContext("webgl", {
        antialias: false,
        alpha: true,
        depth: false,
        stencil: false,
        premultipliedAlpha: true,
        powerPreference: "high-performance",
        preserveDrawingBuffer: false
      });
    if (this.gl && this.#initWebGL()) {
      this.renderer = "webgl";
    } else if (this.options.fallbackCanvas !== false) {
      this.#disposeGL();
      // Same canvas cannot acquire a 2D context after WebGL — replace the element.
      this.canvas.remove();
      this.canvas = createEl("canvas", this.options.className ?? "oh-webgl-path-batch", pane);
      this.canvas.style.position = "absolute";
      this.canvas.style.left = "0";
      this.canvas.style.top = "0";
      this.canvas.style.pointerEvents = "none";
      this.renderer = "canvas";
      this.gl = null;
      if (!this._canvasRings.length && this._segmentCount) {
        // Segments were recorded without lat/lng rings — canvas needs a rebuild path.
        // Caller typically adds paths before onAdd; rings are kept when renderer was "none".
      }
    } else {
      this.renderer = "none";
    }
    this.render();
  }

  override onRemove(): void {
    this.#disposeGL();
    if (this.canvas) {
      this.canvas.width = 0;
      this.canvas.height = 0;
      this.canvas.remove();
    }
    this.canvas = null;
    this._cssW = 0;
    this._cssH = 0;
    this._attribsBound = false;
    this._drawnZoom = Number.NaN;
    super.onRemove();
  }

  override render(): void {
    if (!this.map || !this.canvas || this.renderer === "none") return;
    const { width, height } = this.map.size;
    const dpr = Math.min(this.options.maxDpr ?? 1, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
    if (width !== this._cssW || height !== this._cssH) {
      this._cssW = width;
      this._cssH = height;
      this.canvas.style.width = `${width}px`;
      this.canvas.style.height = `${height}px`;
      this.canvas.width = Math.max(1, Math.round(width * dpr));
      this.canvas.height = Math.max(1, Math.round(height * dpr));
      this._attribsBound = false;
      this._drawnZoom = Number.NaN;
    }
    if (this.renderer === "webgl") {
      const zoom = this.map.zoom;
      const ox = this.map.pixelOrigin.x;
      const oy = this.map.pixelOrigin.y;
      // Same zoom: move the already-rasterized layer with the map (MapLibre-style cheap pan).
      if (zoom === this._drawnZoom && this._segmentCount > 0) {
        this.canvas.style.transform = `translate3d(${this._drawnOriginX - ox}px,${this._drawnOriginY - oy}px,0)`;
        return;
      }
      this.canvas.style.transform = "";
      this.#renderWebGL(dpr);
      this._drawnZoom = zoom;
      this._drawnOriginX = ox;
      this._drawnOriginY = oy;
    } else {
      this.canvas.style.transform = "";
      this.#renderCanvas(dpr);
    }
  }

  #ensureCapacity(floats: number): void {
    if (this._segBuf.length >= floats) return;
    const next = new Float32Array(Math.max(floats, Math.ceil(this._segBuf.length * 1.5) || floats));
    next.set(this._segBuf.subarray(0, this._segmentCount * 4));
    this._segBuf = next;
  }

  #initWebGL(): boolean {
    const gl = this.gl;
    if (!gl) return false;
    const ext = gl.getExtension("ANGLE_instanced_arrays") as InstancedExt | null;
    if (!ext) return false;
    this.ext = ext;

    const vertex = compileShader(gl, gl.VERTEX_SHADER, `
      attribute float a_along;
      attribute float a_side;
      attribute vec2 a_a;
      attribute vec2 a_b;
      uniform float u_scale;
      uniform vec2 u_origin;
      uniform vec2 u_resolution;
      uniform float u_dpr;
      uniform float u_halfWidth;
      void main() {
        vec2 a = a_a * u_scale - u_origin;
        vec2 b = a_b * u_scale - u_origin;
        vec2 dir = b - a;
        float len = length(dir);
        vec2 normal = len > 0.001 ? vec2(-dir.y, dir.x) / len : vec2(0.0, 1.0);
        vec2 pixel = mix(a, b, a_along) + normal * a_side * u_halfWidth;
        vec2 clip = ((pixel * u_dpr) / u_resolution) * 2.0 - 1.0;
        gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
      }
    `);
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, `
      precision mediump float;
      uniform vec4 u_color;
      void main() {
        gl_FragColor = u_color;
      }
    `);
    if (!vertex || !fragment) return false;
    const program = gl.createProgram();
    if (!program) return false;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      return false;
    }
    this.program = program;

    // Unit quad as triangle strip: (along, side)
    const quad = new Float32Array([
      0, -1,
      0, 1,
      1, -1,
      1, 1
    ]);
    this.quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);

    this.instanceBuffer = gl.createBuffer();
    this.locs = {
      aAlong: gl.getAttribLocation(program, "a_along"),
      aSide: gl.getAttribLocation(program, "a_side"),
      aA: gl.getAttribLocation(program, "a_a"),
      aB: gl.getAttribLocation(program, "a_b"),
      uScale: gl.getUniformLocation(program, "u_scale"),
      uOrigin: gl.getUniformLocation(program, "u_origin"),
      uResolution: gl.getUniformLocation(program, "u_resolution"),
      uDpr: gl.getUniformLocation(program, "u_dpr"),
      uHalfWidth: gl.getUniformLocation(program, "u_halfWidth"),
      uColor: gl.getUniformLocation(program, "u_color")
    };
    return true;
  }

  #uploadIfNeeded(): void {
    const gl = this.gl;
    if (!gl || !this.instanceBuffer || !this._bufferDirty) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    const data = this._segBuf.subarray(0, this._segmentCount * 4);
    const bytes = data.byteLength;
    if (bytes > 0 && bytes === this._gpuBytes) {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
    } else {
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      this._gpuBytes = bytes;
    }
    this._bufferDirty = false;
    this._attribsBound = false;
  }

  #bindAttribs(): void {
    const gl = this.gl;
    const locs = this.locs;
    const ext = this.ext;
    if (!gl || !locs || !ext || !this.quadBuffer || !this.instanceBuffer || this._attribsBound) return;

    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(locs.aAlong);
    gl.vertexAttribPointer(locs.aAlong, 1, gl.FLOAT, false, 8, 0);
    gl.enableVertexAttribArray(locs.aSide);
    gl.vertexAttribPointer(locs.aSide, 1, gl.FLOAT, false, 8, 4);
    ext.vertexAttribDivisorANGLE(locs.aAlong, 0);
    ext.vertexAttribDivisorANGLE(locs.aSide, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.enableVertexAttribArray(locs.aA);
    gl.vertexAttribPointer(locs.aA, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(locs.aB);
    gl.vertexAttribPointer(locs.aB, 2, gl.FLOAT, false, 16, 8);
    ext.vertexAttribDivisorANGLE(locs.aA, 1);
    ext.vertexAttribDivisorANGLE(locs.aB, 1);

    this._attribsBound = true;
  }

  #renderWebGL(dpr: number): void {
    const gl = this.gl;
    const locs = this.locs;
    const ext = this.ext;
    const map = this.map;
    if (!gl || !locs || !ext || !this.program || !map || !this._segmentCount) return;

    this.#uploadIfNeeded();
    gl.viewport(0, 0, this.canvas!.width, this.canvas!.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.program);
    this.#bindAttribs();

    const scale = TILE_SIZE * 2 ** map.zoom;
    gl.uniform1f(locs.uScale, scale);
    gl.uniform2f(locs.uOrigin, map.pixelOrigin.x, map.pixelOrigin.y);
    gl.uniform2f(locs.uResolution, this.canvas!.width, this.canvas!.height);
    gl.uniform1f(locs.uDpr, dpr);
    gl.uniform1f(locs.uHalfWidth, Math.max(0.5, (this.options.strokeWidth ?? 1.5) * 0.5));
    const alpha = this.options.strokeOpacity ?? 0.7;
    gl.uniform4f(locs.uColor, this.color.r / 255, this.color.g / 255, this.color.b / 255, alpha);
    ext.drawArraysInstancedANGLE(gl.TRIANGLE_STRIP, 0, 4, this._segmentCount);
  }

  #renderCanvas(dpr: number): void {
    if (!this.map || !this.canvas) return;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    const { width, height } = this.map.size;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = this.options.stroke ?? "#0f766e";
    ctx.globalAlpha = this.options.strokeOpacity ?? 0.7;
    ctx.lineWidth = this.options.strokeWidth ?? 1.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const ring of this._canvasRings) {
      if (ring.lat.length < 2) continue;
      ctx.beginPath();
      for (let i = 0; i < ring.lat.length; i++) {
        const pt = this.map.latLngToContainerPoint([ring.lat[i], ring.lng[i]]);
        if (i === 0) ctx.moveTo(pt.x, pt.y);
        else ctx.lineTo(pt.x, pt.y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  #disposeGL(): void {
    const gl = this.gl;
    if (gl) {
      try {
        if (this.quadBuffer) gl.deleteBuffer(this.quadBuffer);
        if (this.instanceBuffer) gl.deleteBuffer(this.instanceBuffer);
        if (this.program) gl.deleteProgram(this.program);
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      } catch {
        /* ignore */
      }
    }
    this.quadBuffer = null;
    this.instanceBuffer = null;
    this.program = null;
    this.locs = null;
    this.ext = null;
    this.gl = null;
    this._gpuBytes = 0;
    this._attribsBound = false;
  }
}

export function webglPathBatch(options?: WebGLPathBatchOptions): WebGLPathBatch {
  return new WebGLPathBatch(options);
}

function latLngToMercator(lat: number, lng: number): { x: number; y: number } {
  let clampedLat = lat;
  if (clampedLat > MAX_LAT) clampedLat = MAX_LAT;
  else if (clampedLat < -MAX_LAT) clampedLat = -MAX_LAT;
  const wrappedLng = ((lng + 180) % 360 + 360) % 360 - 180;
  const sin = Math.sin((clampedLat * Math.PI) / 180);
  return {
    x: (wrappedLng + 180) / 360,
    y: 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)
  };
}

function parseColor(value: string): RGB {
  const text = String(value || "").trim();
  const hex = text.startsWith("#") ? text.slice(1) : "";
  if (hex.length === 3) {
    return {
      r: Number.parseInt(hex[0] + hex[0], 16),
      g: Number.parseInt(hex[1] + hex[1], 16),
      b: Number.parseInt(hex[2] + hex[2], 16)
    };
  }
  if (hex.length === 6) {
    return {
      r: Number.parseInt(hex.slice(0, 2), 16),
      g: Number.parseInt(hex.slice(2, 4), 16),
      b: Number.parseInt(hex.slice(4, 6), 16)
    };
  }
  const rgb = text.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  if (rgb) {
    return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };
  }
  return { r: 15, g: 118, b: 110 };
}

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}
