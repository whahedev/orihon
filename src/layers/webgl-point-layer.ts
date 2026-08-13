import { createEl, listen, listenTap } from "../dom.js";
import { TILE_SIZE, latLng, projectMercator01, type LatLngLike, type Point } from "../geo.js";
import { Layer, type LayerOptions, type QueryHit, type ResolvedQueryOptions } from "../layer.js";
import type { Orihon } from "../map.js";
import { assertMercator } from "../crs.js";
import type { OverlayContent, PopupOptions } from "../overlays/div-overlay.js";
import { SpatialGridIndex } from "../services/spatial-grid-index.js";
import { compileShader, parseCssColor, type RgbColor } from "../webgl-utils.js";

export type WebGLPointInput = LatLngLike | { coordinates?: LatLngLike; latlng?: LatLngLike; lat?: number; lng?: number };

export interface WebGLPointDataOptions {
  /** Interleaved RGBA floats in 0..1, length = pointCount * 4. */
  colors?: ArrayLike<number> | null;
}

export interface WebGLPointLayerOptions extends LayerOptions {
  pointSize?: number;
  color?: string;
  opacity?: number;
  maxDpr?: number;
  fallbackCanvas?: boolean;
  rotation?: number;
  pitch?: number;
  interactive?: boolean;
  hitTolerance?: number;
  /** When true, canvas fallback still CPU-culls. WebGL always transforms on GPU. */
  cull?: boolean;
}

type ResolvedWebGLPointLayerOptions = Required<WebGLPointLayerOptions>;

interface GLLocations {
  aMerc: number;
  aColor: number;
  uScale: WebGLUniformLocation | null;
  uOrigin: WebGLUniformLocation | null;
  uResolution: WebGLUniformLocation | null;
  uDpr: WebGLUniformLocation | null;
  uPointSize: WebGLUniformLocation | null;
  uColor: WebGLUniformLocation | null;
  uUseVertexColor: WebGLUniformLocation | null;
  uCenter: WebGLUniformLocation | null;
  uRotate: WebGLUniformLocation | null;
  uPitch: WebGLUniformLocation | null;
}

export interface WebGLPointLayerStats {
  points: number;
  rendered: number;
  renderer: "webgl" | "canvas" | "none";
  bufferBytes: number;
  vertexColors: boolean;
}

export class WebGLPointLayer extends Layer<ResolvedWebGLPointLayerOptions> {
  canvas: HTMLCanvasElement | null = null;
  gl: WebGLRenderingContext | null = null;
  program: WebGLProgram | null = null;
  buffer: WebGLBuffer | null = null;
  colorBuffer: WebGLBuffer | null = null;
  /** Packed lat/lng pairs for hit-testing and canvas fallback. */
  points: Float32Array = new Float32Array();
  /**
   * GPU upload buffer: mercator relative to the current camera ref (float32).
   * Absolute world mercator lives in `_merc64` (float64) to avoid high-zoom collapse.
   */
  mercator: Float32Array = new Float32Array();
  /** Interleaved RGBA (0..1) when per-point colors are enabled. */
  colors: Float32Array = new Float32Array();
  pointData: WebGLPointInput[] = [];
  renderer: "webgl" | "canvas" | "none" = "none";
  readonly color: RgbColor;
  private _interactionUnsub: (() => void) | null = null;
  private _lastRendered = 0;
  private _glLocations: GLLocations | null = null;
  private _bufferDirty = true;
  private _colorDirty = true;
  private _useVertexColor = false;
  private _scratch: Float32Array = new Float32Array(0);
  private _scratchColors: Float32Array = new Float32Array(0);
  private _latlngBuf = new Float32Array(0);
  private _merc64 = new Float64Array(0);
  private _drawMerc = new Float32Array(0);
  private _colorBuf = new Float32Array(0);
  private _gpuMercBytes = 0;
  private _gpuColorBytes = 0;
  private _refMx = 0;
  private _refMy = 0;
  private _refZoom = Number.NaN;
  private _refOriginX = 0;
  private _refOriginY = 0;
  private _pickIndex = new SpatialGridIndex<number, number>(1);

  constructor(points: Iterable<WebGLPointInput> = [], options: WebGLPointLayerOptions = {}) {
    super({
      pane: "overlay",
      attribution: "",
      pointSize: 5,
      color: "#e11d48",
      opacity: 0.82,
      maxDpr: 2,
      fallbackCanvas: true,
      rotation: 0,
      pitch: 0,
      interactive: false,
      hitTolerance: 5,
      cull: true,
      ...options
    });
    this.color = parseCssColor(this.options.color, { r: 225, g: 29, b: 72 });
    this.setData(points);
  }

  override onAdd(map: Orihon): void {
    assertMercator(map.crs);
    super.onAdd(map);
    const pane = this.getPane();
    if (!pane) throw new Error(`Orihon pane not found: ${this.options.pane}`);
    this.canvas = createEl("canvas", "oh-webgl-point-layer", pane);
    this.canvas.style.position = "absolute";
    this.canvas.style.pointerEvents = this.options.interactive ? "auto" : "none";
    this.gl = this.canvas.getContext("webgl", {
      antialias: false,
      alpha: true,
      depth: false,
      stencil: false,
      powerPreference: "high-performance",
      premultipliedAlpha: true
    });
    if (this.gl) {
      this.renderer = "webgl";
      this.#initWebGL();
    } else if (this.options.fallbackCanvas && this.canvas.getContext("2d")) {
      this.renderer = "canvas";
    } else {
      this.renderer = "none";
    }
    this.#syncInteraction();
    this.render();
  }

  override onRemove(): void {
    if (this.gl) {
      try {
        if (this.buffer) this.gl.deleteBuffer(this.buffer);
        if (this.colorBuffer) this.gl.deleteBuffer(this.colorBuffer);
        if (this.program) this.gl.deleteProgram(this.program);
        this.gl.getExtension("WEBGL_lose_context")?.loseContext();
      } catch {
        /* context may already be lost */
      }
    }
    this.buffer = null;
    this.colorBuffer = null;
    this.program = null;
    this.gl = null;
    this._glLocations = null;
    this._gpuMercBytes = 0;
    this._gpuColorBytes = 0;
    this.renderer = "none";
    this._interactionUnsub?.();
    this._interactionUnsub = null;
    if (this.canvas) {
      this.canvas.width = 0;
      this.canvas.height = 0;
      this.canvas.remove();
    }
    this.canvas = null;
    this.points = new Float32Array();
    this.mercator = new Float32Array();
    this.colors = new Float32Array();
    this._merc64 = new Float64Array(0);
    this._drawMerc = new Float32Array(0);
    this._colorBuf = new Float32Array(0);
    this.pointData = [];
    this._latlngBuf = new Float32Array(0);
    this._scratch = new Float32Array(0);
    this._scratchColors = new Float32Array(0);
    this._useVertexColor = false;
    this._refZoom = Number.NaN;
    this._pickIndex.clear();
    super.onRemove();
  }

  setData(points: Iterable<WebGLPointInput>, options: WebGLPointDataOptions = {}): this {
    const keepData = this.options.interactive && (!Array.isArray(points) || points.length <= 40_000);
    let keptCount = 0;

    if (Array.isArray(points)) {
      const need = points.length * 2;
      if (this._latlngBuf.length < need) this._latlngBuf = new Float32Array(need);
      if (this._merc64.length < need) this._merc64 = new Float64Array(need);
      if (this._drawMerc.length < need) this._drawMerc = new Float32Array(need);
      const latlng = this._latlngBuf;
      const merc64 = this._merc64;
      const data: WebGLPointInput[] = keepData ? new Array(points.length) : [];
      let write = 0;
      let kept = 0;
      for (let index = 0; index < points.length; index++) {
        const item = points[index];
        const next = normalizePoint(item);
        if (!next) continue;
        const m = projectMercator01(next.lat, next.lng);
        latlng[write] = next.lat;
        latlng[write + 1] = next.lng;
        merc64[write] = m.x;
        merc64[write + 1] = m.y;
        write += 2;
        if (keepData) data[kept++] = item;
      }
      this.points = latlng.subarray(0, write);
      this.mercator = this._drawMerc.subarray(0, write);
      this.pointData = keepData ? data.slice(0, kept) : [];
      keptCount = write / 2;
    } else {
      const latlngValues: number[] = [];
      const mercValues: number[] = [];
      this.pointData = [];
      for (const item of points) {
        const next = normalizePoint(item);
        if (!next) continue;
        const m = projectMercator01(next.lat, next.lng);
        latlngValues.push(next.lat, next.lng);
        mercValues.push(m.x, m.y);
        if (keepData) this.pointData.push(item);
      }
      this._latlngBuf = new Float32Array(latlngValues);
      this._merc64 = new Float64Array(mercValues);
      this._drawMerc = new Float32Array(mercValues.length);
      this.points = this._latlngBuf;
      this.mercator = this._drawMerc.subarray(0, mercValues.length);
      keptCount = mercValues.length / 2;
    }

    this.#applyColors(options.colors, keptCount);
    this.#rebuildPickIndex();
    this._refZoom = Number.NaN;
    this._bufferDirty = true;
    this.render();
    return this;
  }

  /** Replace per-point RGBA (0..1). Pass null to fall back to uniform `color`. */
  setColors(colors: ArrayLike<number> | null): this {
    this.#applyColors(colors, this.points.length / 2);
    this.render();
    return this;
  }

  /**
   * Patch a single point in place (no full re-encode). Used by ObjectManager live updates.
   */
  patchPoint(index: number, lat: number, lng: number): this {
    const i = index * 2;
    if (i < 0 || i + 1 >= this.points.length) return this;
    const m = projectMercator01(lat, lng);
    this._latlngBuf[i] = lat;
    this._latlngBuf[i + 1] = lng;
    this._merc64[i] = m.x;
    this._merc64[i + 1] = m.y;
    this._pickIndex.set(index, [lat, lng], index);
    if (this._drawMerc.length >= i + 2 && Number.isFinite(this._refMx)) {
      this._drawMerc[i] = m.x - this._refMx;
      this._drawMerc[i + 1] = m.y - this._refMy;
      this.#uploadMercatorRange(i, 2);
    } else {
      this._bufferDirty = true;
    }
    return this;
  }

  /** Patch one vertex RGBA (0..1) without rebuilding the full color buffer. */
  patchColor(index: number, rgba: ArrayLike<number>): this {
    if (!this._useVertexColor || index < 0 || index * 4 + 3 >= this.colors.length) return this;
    const o = index * 4;
    this._colorBuf[o] = Number(rgba[0]) || 0;
    this._colorBuf[o + 1] = Number(rgba[1]) || 0;
    this._colorBuf[o + 2] = Number(rgba[2]) || 0;
    this._colorBuf[o + 3] = Number(rgba[3]) || this.options.opacity;
    this.#uploadColorRange(o, 4);
    return this;
  }

  /**
   * Load precomputed lat/lng + absolute mercator buffers (skips normalize + merc encode).
   * Used by ObjectManager filter restore / compact paths at 100k–1M.
   */
  setPackedData(
    latlng: Float32Array,
    merc64: Float64Array,
    options: WebGLPointDataOptions = {}
  ): this {
    const count = Math.min(latlng.length, merc64.length);
    const even = count - (count % 2);
    if (this._latlngBuf.length < even) this._latlngBuf = new Float32Array(even);
    if (this._merc64.length < even) this._merc64 = new Float64Array(even);
    if (this._drawMerc.length < even) this._drawMerc = new Float32Array(even);
    this._latlngBuf.set(latlng.subarray(0, even));
    this._merc64.set(merc64.subarray(0, even));
    this.points = this._latlngBuf.subarray(0, even);
    this.mercator = this._drawMerc.subarray(0, even);
    this.pointData = [];
    this.#applyColors(options.colors, even / 2);
    this.#rebuildPickIndex();
    this._refZoom = Number.NaN;
    this._bufferDirty = true;
    this.render();
    return this;
  }

  /** Absolute float64 mercator pairs (same length as `points`). */
  getMercator64(): Float64Array {
    return this._merc64.subarray(0, this.points.length);
  }

  getLatLngBuf(): Float32Array {
    return this._latlngBuf.subarray(0, this.points.length);
  }

  getColorBuf(): Float32Array {
    return this._colorBuf.subarray(0, this.colors.length);
  }

  addData(points: Iterable<WebGLPointInput>): this {
    const existing: WebGLPointInput[] = [];
    for (let i = 0; i < this.points.length; i += 2) {
      existing.push([this.points[i], this.points[i + 1]]);
    }
    for (const item of points) existing.push(item);
    return this.setData(existing);
  }

  clear(): this {
    this.points = new Float32Array();
    this.mercator = new Float32Array();
    this.colors = new Float32Array();
    this._merc64 = new Float64Array(0);
    this._drawMerc = new Float32Array(0);
    this._colorBuf = new Float32Array(0);
    this.pointData = [];
    this._gpuMercBytes = 0;
    this._gpuColorBytes = 0;
    this._useVertexColor = false;
    this._refZoom = Number.NaN;
    this._bufferDirty = true;
    this._colorDirty = true;
    this.render();
    return this;
  }

  override bindPopup(content: OverlayContent, options?: PopupOptions): this {
    this.setInteractive(true);
    return super.bindPopup(content, options);
  }

  setInteractive(enabled: boolean): this {
    this.options.interactive = Boolean(enabled);
    if (this.canvas) this.canvas.style.pointerEvents = this.options.interactive ? "auto" : "none";
    this.#syncInteraction();
    return this;
  }

  setViewTransform(options: { rotation?: number; pitch?: number }): this {
    if (typeof options.rotation === "number") this.options.rotation = options.rotation;
    if (typeof options.pitch === "number") this.options.pitch = Math.max(0, Math.min(60, options.pitch));
    this.render();
    return this;
  }

  /** Public hit-test for ObjectManager hover / bench sampling. */
  hitTestAt(clientX: number, clientY: number, tolerance = this.options.hitTolerance): {
    index: number;
    latlng: LatLngLike;
    containerPoint: { x: number; y: number };
  } | null {
    return this.#hitTest(clientX, clientY, tolerance);
  }

  queryHit(point: Point, options: ResolvedQueryOptions): QueryHit | null {
    if (!this.map || !this.options.interactive) return null;
    const rect = this.map.container.getBoundingClientRect();
    const hit = this.#hitTest(rect.left + point.x, rect.top + point.y, options.tolerance);
    return hit ? {
      layer: this,
      latlng: latLng(hit.latlng),
      source: "webgl",
      index: hit.index,
      feature: this.pointData[hit.index]
    } : null;
  }

  getStats(): WebGLPointLayerStats {
    // Count used merc64 slots (not spare capacity from over-allocation on filtered inputs).
    const merc64Bytes = this.points.length * Float64Array.BYTES_PER_ELEMENT;
    return {
      points: this.points.length / 2,
      rendered: this._lastRendered,
      renderer: this.renderer,
      bufferBytes: this.points.byteLength + merc64Bytes + this.mercator.byteLength + this.colors.byteLength,
      vertexColors: this._useVertexColor
    };
  }

  override render(): void {
    if (!this.map || !this.canvas) return;
    const dpr = Math.min(this.options.maxDpr, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(this.map.size.width * dpr));
    const height = Math.max(1, Math.round(this.map.size.height * dpr));
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    this.canvas.style.left = "0px";
    this.canvas.style.top = "0px";
    this.canvas.style.width = `${this.map.size.width}px`;
    this.canvas.style.height = `${this.map.size.height}px`;
    if (this.renderer === "webgl") this.#renderWebGL(dpr);
    else if (this.renderer === "canvas") this.#renderCanvas(dpr);
  }

  #applyColors(colors: ArrayLike<number> | null | undefined, pointCount: number): void {
    if (!colors || pointCount <= 0) {
      this._useVertexColor = false;
      this.colors = new Float32Array();
      this._colorBuf = new Float32Array(0);
      this._colorDirty = true;
      this._gpuColorBytes = 0;
      return;
    }
    const need = pointCount * 4;
    if (this._colorBuf.length < need) this._colorBuf = new Float32Array(need);
    const dst = this._colorBuf;
    const n = Math.min(need, colors.length);
    for (let i = 0; i < n; i++) dst[i] = Number(colors[i]) || 0;
    for (let i = n; i < need; i++) dst[i] = i % 4 === 3 ? this.options.opacity : 0;
    this.colors = dst.subarray(0, need);
    this._useVertexColor = true;
    this._colorDirty = true;
  }

  #initWebGL(): void {
    const gl = this.gl;
    if (!gl) return;
    const vertex = compileShader(gl, gl.VERTEX_SHADER, `
      attribute vec2 a_merc;
      attribute vec4 a_color;
      uniform float u_scale;
      uniform vec2 u_origin;
      uniform vec2 u_resolution;
      uniform float u_dpr;
      uniform float u_pointSize;
      uniform vec2 u_center;
      uniform float u_rotate;
      uniform float u_pitch;
      uniform float u_useVertexColor;
      uniform vec4 u_color;
      varying vec4 v_color;
      void main() {
        vec2 pixel = a_merc * u_scale - u_origin;
        if (u_rotate != 0.0 || u_pitch != 1.0) {
          vec2 d = pixel - u_center;
          d.y *= u_pitch;
          float c = cos(u_rotate);
          float s = sin(u_rotate);
          pixel = u_center + vec2(d.x * c - d.y * s, d.x * s + d.y * c);
        }
        vec2 clip = ((pixel * u_dpr) / u_resolution) * 2.0 - 1.0;
        gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
        gl_PointSize = u_pointSize;
        v_color = u_useVertexColor > 0.5 ? a_color : u_color;
      }
    `);
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, `
      precision mediump float;
      varying vec4 v_color;
      void main() {
        vec2 offset = gl_PointCoord - vec2(0.5);
        if (dot(offset, offset) > 0.25) discard;
        gl_FragColor = v_color;
      }
    `);
    if (!vertex || !fragment) {
      this.renderer = this.options.fallbackCanvas ? "canvas" : "none";
      return;
    }
    this.program = gl.createProgram();
    if (!this.program) return;
    gl.attachShader(this.program, vertex);
    gl.attachShader(this.program, fragment);
    gl.linkProgram(this.program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      this.renderer = this.options.fallbackCanvas ? "canvas" : "none";
      return;
    }
    this.buffer = gl.createBuffer();
    this.colorBuffer = gl.createBuffer();
    this._glLocations = {
      aMerc: gl.getAttribLocation(this.program, "a_merc"),
      aColor: gl.getAttribLocation(this.program, "a_color"),
      uScale: gl.getUniformLocation(this.program, "u_scale"),
      uOrigin: gl.getUniformLocation(this.program, "u_origin"),
      uResolution: gl.getUniformLocation(this.program, "u_resolution"),
      uDpr: gl.getUniformLocation(this.program, "u_dpr"),
      uPointSize: gl.getUniformLocation(this.program, "u_pointSize"),
      uColor: gl.getUniformLocation(this.program, "u_color"),
      uUseVertexColor: gl.getUniformLocation(this.program, "u_useVertexColor"),
      uCenter: gl.getUniformLocation(this.program, "u_center"),
      uRotate: gl.getUniformLocation(this.program, "u_rotate"),
      uPitch: gl.getUniformLocation(this.program, "u_pitch")
    };
    this._bufferDirty = true;
    this._colorDirty = true;
  }

  #uploadMercatorIfNeeded(): void {
    const gl = this.gl;
    if (!gl || !this.buffer || !this._bufferDirty) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    const bytes = this.mercator.byteLength;
    // Reuse GPU storage on live updates — repeated bufferData(STATIC) leaks VRAM on some drivers.
    if (bytes > 0 && bytes === this._gpuMercBytes) {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.mercator);
    } else {
      gl.bufferData(gl.ARRAY_BUFFER, this.mercator, gl.DYNAMIC_DRAW);
      this._gpuMercBytes = bytes;
    }
    this._bufferDirty = false;
  }

  #uploadColorsIfNeeded(): void {
    const gl = this.gl;
    if (!gl || !this.colorBuffer || !this._colorDirty) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
    if (!this._useVertexColor || !this.colors.length) {
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(0), gl.DYNAMIC_DRAW);
      this._gpuColorBytes = 0;
      this._colorDirty = false;
      return;
    }
    const bytes = this.colors.byteLength;
    if (bytes > 0 && bytes === this._gpuColorBytes) {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.colors);
    } else {
      gl.bufferData(gl.ARRAY_BUFFER, this.colors, gl.DYNAMIC_DRAW);
      this._gpuColorBytes = bytes;
    }
    this._colorDirty = false;
  }

  #uploadMercatorRange(floatOffset: number, floatCount: number): void {
    const gl = this.gl;
    if (!gl || !this.buffer || floatCount <= 0) return;
    if (this._gpuMercBytes !== this.mercator.byteLength) {
      this._bufferDirty = true;
      return;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferSubData(
      gl.ARRAY_BUFFER,
      floatOffset * 4,
      this._drawMerc.subarray(floatOffset, floatOffset + floatCount)
    );
  }

  #uploadColorRange(floatOffset: number, floatCount: number): void {
    const gl = this.gl;
    if (!gl || !this.colorBuffer || floatCount <= 0 || !this._useVertexColor) return;
    if (this._gpuColorBytes !== this.colors.byteLength) {
      this._colorDirty = true;
      return;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
    gl.bufferSubData(
      gl.ARRAY_BUFFER,
      floatOffset * 4,
      this._colorBuf.subarray(floatOffset, floatOffset + floatCount)
    );
  }

  /**
   * Encode absolute float64 mercator as camera-relative float32 for the GPU.
   * Avoids `float32(absoluteMerc) * 2^z` precision collapse at high zoom.
   *
   * Re-encode only when data changes or the camera has drifted far in *pixel*
   * space relative to the current mercator ref. Zoom-only changes must NOT
   * trigger a full CPU pass — otherwise continuous zoom stress rewrites every
   * point every frame (~1 FPS at 1M).
   */
  #ensureRelativeEncoding(): void {
    if (!this.map) return;
    const count = this.points.length;
    if (!count) {
      this.mercator = this._drawMerc.subarray(0, 0);
      return;
    }
    if (this._drawMerc.length < count) this._drawMerc = new Float32Array(count);

    const scale = TILE_SIZE * 2 ** this.map.zoom;
    const ox = this.map.pixelOrigin.x;
    const oy = this.map.pixelOrigin.y;
    // Residual if we keep the existing mercator ref (stable across zoom-only updates).
    const pixelDrift = Math.hypot(ox - this._refMx * scale, oy - this._refMy * scale);
    // float32 relative mercator stays sub-pixel accurate far beyond a few kpx of drift.
    const REENCODE_DRIFT_PX = 8192;
    if (!this._bufferDirty && pixelDrift <= REENCODE_DRIFT_PX && this.mercator.length === count) {
      return;
    }

    this._refMx = ox / scale;
    this._refMy = oy / scale;
    this._refZoom = this.map.zoom;
    this._refOriginX = ox;
    this._refOriginY = oy;

    const src = this._merc64;
    const dst = this._drawMerc;
    for (let i = 0; i < count; i += 2) {
      dst[i] = src[i] - this._refMx;
      dst[i + 1] = src[i + 1] - this._refMy;
    }
    this.mercator = dst.subarray(0, count);
    this._bufferDirty = true;
  }

  /** Fast screen projection from absolute float64 mercator. */
  #mercatorToScreen(mx: number, my: number, scale: number, originX: number, originY: number): { x: number; y: number } {
    let x = mx * scale - originX;
    let y = my * scale - originY;
    if (this.options.rotation !== 0 || this.options.pitch !== 0) {
      const transformed = this.#transformPoint(x, y);
      x = transformed.x;
      y = transformed.y;
    }
    return { x, y };
  }

  #projectVisibleCanvas(dpr: number): { xy: Float32Array; indices: Int32Array } {
    if (!this.map || !this.points.length) {
      this._lastRendered = 0;
      return { xy: new Float32Array(), indices: new Int32Array() };
    }

    const map = this.map;
    const scale = TILE_SIZE * 2 ** map.zoom;
    const originX = map.pixelOrigin.x;
    const originY = map.pixelOrigin.y;
    const width = map.size.width;
    const height = map.size.height;
    const padding = this.options.pointSize + 2;
    const source = this._merc64;
    const needed = this.points.length;
    if (this._scratch.length < needed) this._scratch = new Float32Array(needed);
    const indexBuf = this._scratchColors.length >= needed
      ? this._scratchColors
      : (this._scratchColors = new Float32Array(needed));
    const projected = this._scratch;
    let write = 0;
    let indexWrite = 0;
    const cull = this.options.cull !== false;

    for (let index = 0; index < needed; index += 2) {
      const point = this.#mercatorToScreen(source[index], source[index + 1], scale, originX, originY);
      if (cull && (point.x < -padding || point.y < -padding || point.x > width + padding || point.y > height + padding)) {
        continue;
      }
      projected[write++] = point.x * dpr;
      projected[write++] = point.y * dpr;
      indexBuf[indexWrite++] = index / 2;
    }

    this._lastRendered = write / 2;
    const indices = new Int32Array(indexWrite);
    for (let i = 0; i < indexWrite; i++) indices[i] = indexBuf[i];
    return { xy: projected.subarray(0, write), indices };
  }

  #transformPoint(x: number, y: number): { x: number; y: number } {
    if (!this.map) return { x, y };
    const rotation = (this.options.rotation * Math.PI) / 180;
    const pitchScale = Math.cos((this.options.pitch * Math.PI) / 180);
    if (!rotation && this.options.pitch === 0) return { x, y };
    const cx = this.map.size.width / 2;
    const cy = this.map.size.height / 2;
    const dx = x - cx;
    const dy = (y - cy) * pitchScale;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    return {
      x: cx + dx * cos - dy * sin,
      y: cy + dx * sin + dy * cos
    };
  }

  #syncInteraction(): void {
    this._interactionUnsub?.();
    this._interactionUnsub = null;
    if (!this.canvas || !this.options.interactive) return;
    const unsubs = [
      listenTap(this.canvas, (event) => {
        const hit = this.#hitTest(event.clientX, event.clientY);
        if (!hit) return;
        event.preventDefault();
        event.stopPropagation();
        this.emit("click", {
          originalEvent: event,
          latlng: hit.latlng,
          containerPoint: hit.containerPoint,
          index: hit.index,
          data: this.pointData[hit.index]
        });
      }),
      listen(this.canvas, "mousemove", (event) => {
        const hit = this.#hitTest(event.clientX, event.clientY);
        this.emit("hover", {
          originalEvent: event,
          latlng: hit?.latlng ?? null,
          containerPoint: hit?.containerPoint ?? null,
          index: hit ? hit.index : -1,
          data: hit ? this.pointData[hit.index] : null
        });
      }),
      listen(this.canvas, "mouseleave", (event) => {
        this.emit("hover", {
          originalEvent: event,
          latlng: null,
          containerPoint: null,
          index: -1,
          data: null
        });
      })
    ];
    this._interactionUnsub = () => {
      for (const off of unsubs) off();
    };
  }

  #rebuildPickIndex(): void {
    this._pickIndex.clear();
    const pts = this.points;
    const n = pts.length;
    for (let i = 0; i < n; i += 2) this._pickIndex.set(i / 2, [pts[i], pts[i + 1]], i / 2);
  }

  #hitTest(clientX: number, clientY: number, hitTolerance = this.options.hitTolerance): {
    index: number;
    latlng: LatLngLike;
    containerPoint: { x: number; y: number };
  } | null {
    if (!this.map || !this.points.length) return null;
    const rect = this.map.container.getBoundingClientRect();
    const targetX = clientX - rect.left;
    const targetY = clientY - rect.top;
    const tolerance = Math.max(0, hitTolerance) + this.options.pointSize / 2;
    const maxDistance = tolerance * tolerance;
    const scale = TILE_SIZE * 2 ** this.map.zoom;
    const originX = this.map.pixelOrigin.x;
    const originY = this.map.pixelOrigin.y;
    let nearest = -1;
    let nearestDistance = maxDistance;
    let nearestPoint = { x: 0, y: 0 };
    const merc = this._merc64;
    const count = this.points.length;
    const pointCount = count / 2;
    const rotated = this.options.rotation !== 0 || this.options.pitch !== 0;
    if (rotated || pointCount <= 256) {
      for (let index = 0; index < count; index += 2) {
        const point = this.#mercatorToScreen(merc[index], merc[index + 1], scale, originX, originY);
        const distance = (point.x - targetX) ** 2 + (point.y - targetY) ** 2;
        if (distance > nearestDistance) continue;
        nearest = index / 2;
        nearestDistance = distance;
        nearestPoint = point;
      }
    } else {
      const ll = this.map.containerPointToLatLng({ x: targetX, y: targetY });
      const pad = Math.max(0.002, (tolerance / scale) * 360);
      for (const i of this._pickIndex.searchIds([[ll.lat - pad, ll.lng - pad], [ll.lat + pad, ll.lng + pad]])) {
        const point = this.#mercatorToScreen(merc[i * 2], merc[i * 2 + 1], scale, originX, originY);
        const distance = (point.x - targetX) ** 2 + (point.y - targetY) ** 2;
        if (distance > nearestDistance) continue;
        nearest = i;
        nearestDistance = distance;
        nearestPoint = point;
      }
    }
    if (nearest < 0) return null;
    return {
      index: nearest,
      latlng: [this.points[nearest * 2], this.points[nearest * 2 + 1]],
      containerPoint: nearestPoint
    };
  }

  #renderWebGL(dpr: number): void {
    const gl = this.gl;
    const locs = this._glLocations;
    if (!gl || !this.program || !this.buffer || !this.canvas || !locs || !this.map) return;

    const count = this.points.length / 2;
    this._lastRendered = count;

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!count) return;

    this.#ensureRelativeEncoding();
    this.#uploadMercatorIfNeeded();
    this.#uploadColorsIfNeeded();

    const scale = TILE_SIZE * 2 ** this.map.zoom;
    const rotation = (this.options.rotation * Math.PI) / 180;
    const pitch = Math.cos((this.options.pitch * Math.PI) / 180);
    // Residual origin after relative encoding — stays small between re-encodes.
    const originX = this.map.pixelOrigin.x - this._refMx * scale;
    const originY = this.map.pixelOrigin.y - this._refMy * scale;

    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.enableVertexAttribArray(locs.aMerc);
    gl.vertexAttribPointer(locs.aMerc, 2, gl.FLOAT, false, 0, 0);

    if (this._useVertexColor && this.colorBuffer && locs.aColor >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
      gl.enableVertexAttribArray(locs.aColor);
      gl.vertexAttribPointer(locs.aColor, 4, gl.FLOAT, false, 0, 0);
    } else if (locs.aColor >= 0) {
      gl.disableVertexAttribArray(locs.aColor);
      gl.vertexAttrib4f(locs.aColor, this.color.r / 255, this.color.g / 255, this.color.b / 255, this.options.opacity);
    }

    gl.uniform1f(locs.uScale, scale);
    gl.uniform2f(locs.uOrigin, originX, originY);
    gl.uniform2f(locs.uResolution, this.canvas.width, this.canvas.height);
    gl.uniform1f(locs.uDpr, dpr);
    gl.uniform1f(locs.uPointSize, this.options.pointSize * dpr);
    gl.uniform4f(
      locs.uColor,
      this.color.r / 255,
      this.color.g / 255,
      this.color.b / 255,
      this.options.opacity
    );
    gl.uniform1f(locs.uUseVertexColor, this._useVertexColor ? 1 : 0);
    gl.uniform2f(locs.uCenter, this.map.size.width / 2, this.map.size.height / 2);
    gl.uniform1f(locs.uRotate, rotation);
    gl.uniform1f(locs.uPitch, pitch);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    // Chunk large POINTS draws — some ANGLE/D3D drivers stall or drop a single 1M call.
    const CHUNK = 262144;
    if (count <= CHUNK) {
      gl.drawArrays(gl.POINTS, 0, count);
    } else {
      for (let start = 0; start < count; start += CHUNK) {
        gl.drawArrays(gl.POINTS, start, Math.min(CHUNK, count - start));
      }
    }
  }

  #renderCanvas(dpr: number): void {
    if (!this.canvas) return;
    const context = this.canvas.getContext("2d");
    if (!context) return;
    const { xy, indices } = this.#projectVisibleCanvas(dpr);
    context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const radius = Math.max(1, (this.options.pointSize * dpr) / 2);
    const useVertex = this._useVertexColor && this.colors.length >= indices.length * 4;
    for (let i = 0; i < indices.length; i++) {
      const pointIndex = indices[i];
      if (useVertex) {
        const c = pointIndex * 4;
        context.globalAlpha = this.colors[c + 3];
        context.fillStyle = `rgb(${Math.round(this.colors[c] * 255)},${Math.round(this.colors[c + 1] * 255)},${Math.round(this.colors[c + 2] * 255)})`;
      } else {
        context.globalAlpha = this.options.opacity;
        context.fillStyle = `rgb(${this.color.r},${this.color.g},${this.color.b})`;
      }
      context.beginPath();
      context.arc(xy[i * 2], xy[i * 2 + 1], radius, 0, Math.PI * 2);
      context.fill();
    }
    context.globalAlpha = 1;
  }
}

export function webglPointLayer(points?: Iterable<WebGLPointInput>, options?: WebGLPointLayerOptions): WebGLPointLayer {
  return new WebGLPointLayer(points, options);
}

function normalizePoint(value: WebGLPointInput): { lat: number; lng: number } | null {
  const source = Array.isArray(value) || value instanceof Object && "lat" in value && "lng" in value
    ? value as LatLngLike
    : (value as { coordinates?: LatLngLike; latlng?: LatLngLike }).coordinates ?? (value as { latlng?: LatLngLike }).latlng;
  if (!source) return null;
  const point = latLng(source);
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return null;
  return point;
}
