import { createEl } from "../dom.js";
import { MAX_LAT, TILE_SIZE, latLng, type LatLngLike } from "../geo.js";
import { Layer, type LayerOptions } from "../layer.js";
import type { Orihon } from "../map.js";

export type WebGLHeatInput = LatLngLike | [number, number, number?];

export interface WebGLHeatLayerOptions extends LayerOptions {
  /** Kernel radius in CSS px at `scaleZoom`. */
  radius?: number;
  /** Extra soft falloff in CSS px (added into point size). */
  blur?: number;
  scaleZoom?: number;
  maxZoom?: number;
  /** Global intensity multiplier. */
  intensity?: number;
  opacity?: number;
  minOpacity?: number;
  maxDpr?: number;
  /**
   * Cap device-pixel ratio while the camera is moving (settle restores `maxDpr`).
   * Default 1 — sharp idle, cheaper continuous pan/zoom.
   */
  interactionDpr?: number;
  /** Merge nearby points into weighted cells (heat field). Default true. */
  aggregate?: boolean;
  /**
   * Cell size as a fraction of the screen kernel radius (CSS px → mercator).
   * Default 0.45 — small enough that the field stays visually close to raw points.
   */
  aggregateCellFactor?: number;
  gradient?: Record<number, string>;
}

export interface WebGLHeatLayerStats {
  points: number;
  aggregated: number;
  drawn: number;
  bufferBytes: number;
  moving: boolean;
}

type ResolvedWebGLHeatLayerOptions = Required<
  Omit<WebGLHeatLayerOptions, "pane" | "attribution" | "scaleZoom">
> &
  Pick<WebGLHeatLayerOptions, "pane" | "attribution" | "scaleZoom">;

const DEFAULT_GRADIENT: Record<number, string> = {
  0.0: "rgba(0,0,255,0)",
  0.2: "blue",
  0.4: "cyan",
  0.6: "lime",
  0.8: "yellow",
  1.0: "red"
};

const SETTLE_MS = 100;

interface IntensityLocs {
  aMerc: number;
  aWeight: number;
  uScale: WebGLUniformLocation | null;
  uOrigin: WebGLUniformLocation | null;
  uResolution: WebGLUniformLocation | null;
  uDpr: WebGLUniformLocation | null;
  uPointSize: WebGLUniformLocation | null;
  uIntensity: WebGLUniformLocation | null;
}

interface ColorizeLocs {
  aPos: number;
  uIntensity: WebGLUniformLocation | null;
  uGradient: WebGLUniformLocation | null;
  uMinOpacity: WebGLUniformLocation | null;
  uOpacity: WebGLUniformLocation | null;
}

/**
 * GPU heatmap (MapLibre-style): additive intensity pass into an FBO, then gradient colorize.
 * Viewport-culls, zoom-aggregates density, and drops DPR while the camera is moving.
 */
export class WebGLHeatLayer extends Layer<ResolvedWebGLHeatLayerOptions> {
  canvas: HTMLCanvasElement | null = null;
  gl: WebGLRenderingContext | null = null;
  renderer: "webgl" | "none" = "none";
  /** Interleaved mercator x, y, weight (source points). */
  data = new Float32Array();
  private _dataBuf = new Float32Array(0);
  private _count = 0;
  private _aggBuf = new Float32Array(0);
  private _aggData = new Float32Array(0);
  private _aggCount = 0;
  private _aggZoom = Number.NaN;
  private _drawBuf = new Float32Array(0);
  private _drawData = new Float32Array(0);
  private _drawn = 0;
  private _drawSignature = "";
  private _buffer: WebGLBuffer | null = null;
  private _quadBuffer: WebGLBuffer | null = null;
  private _intensityProgram: WebGLProgram | null = null;
  private _colorizeProgram: WebGLProgram | null = null;
  private _intensityLocs: IntensityLocs | null = null;
  private _colorizeLocs: ColorizeLocs | null = null;
  private _fbo: WebGLFramebuffer | null = null;
  private _intensityTex: WebGLTexture | null = null;
  private _gradientTex: WebGLTexture | null = null;
  private _fboW = 0;
  private _fboH = 0;
  private _fboComplete = false;
  private _gpuBytes = 0;
  private _bufferDirty = true;
  private _cssW = 0;
  private _cssH = 0;
  private _moving = false;
  private _settleTimer: ReturnType<typeof setTimeout> | null = null;
  private scaleZoom: number | undefined;
  private _disposed = false;
  /** Reused numeric aggregation index (cleared after each rebuild). */
  private readonly _aggIndex = new Map<number, number>();
  private _aggSumX = new Float64Array(0);
  private _aggSumY = new Float64Array(0);
  private _aggSumW = new Float64Array(0);
  private readonly _onMove = (): void => this.#markMoving();
  private readonly _onSettle = (): void => this.#settle();

  constructor(points: Iterable<WebGLHeatInput> = [], options: WebGLHeatLayerOptions = {}) {
    super({
      pane: "overlay",
      attribution: "",
      radius: 22,
      blur: 16,
      maxZoom: 18,
      intensity: 0.6,
      opacity: 0.7,
      minOpacity: 0.02,
      maxDpr: 1.5,
      interactionDpr: 1,
      aggregate: true,
      aggregateCellFactor: 0.45,
      gradient: DEFAULT_GRADIENT,
      ...options
    });
    if (options.scaleZoom != null) this.scaleZoom = options.scaleZoom;
    this.setData(points);
  }

  get count(): number {
    return this._count;
  }

  getStats(): WebGLHeatLayerStats {
    return {
      points: this._count,
      aggregated: this._aggCount,
      drawn: this._drawn,
      bufferBytes: this._drawData.byteLength,
      moving: this._moving
    };
  }

  /**
   * Rebuild zoom density aggregation without a full WebGL pass.
   * Called automatically from `render`; exposed for tests / tooling.
   */
  prepare(zoom: number): this {
    this.#ensureAggregate(zoom);
    return this;
  }

  setData(points: Iterable<WebGLHeatInput>): this {
    if (Array.isArray(points)) {
      const need = points.length * 3;
      if (this._dataBuf.length < need) this._dataBuf = new Float32Array(need);
      const buf = this._dataBuf;
      let write = 0;
      for (let i = 0; i < points.length; i++) {
        const next = normalizeHeat(points[i]);
        if (!next) continue;
        const m = latLngToMercator(next.lat, next.lng);
        buf[write++] = m.x;
        buf[write++] = m.y;
        buf[write++] = next.weight;
      }
      this.data = buf.subarray(0, write);
      this._count = write / 3;
    } else {
      const values: number[] = [];
      for (const item of points) {
        const next = normalizeHeat(item);
        if (!next) continue;
        const m = latLngToMercator(next.lat, next.lng);
        values.push(m.x, m.y, next.weight);
      }
      this._dataBuf = new Float32Array(values);
      this.data = this._dataBuf;
      this._count = values.length / 3;
    }
    this._aggZoom = Number.NaN;
    this._bufferDirty = true;
    this.render();
    return this;
  }

  setLatLngs(points: Iterable<WebGLHeatInput>): this {
    return this.setData(points);
  }

  clear(): this {
    this.data = new Float32Array();
    this._count = 0;
    this._aggData = new Float32Array(0);
    this._aggCount = 0;
    this._aggZoom = Number.NaN;
    this._drawData = new Float32Array(0);
    this._drawn = 0;
    this._gpuBytes = 0;
    this._bufferDirty = true;
    this.render();
    return this;
  }

  override onAdd(map: Orihon): void {
    this._disposed = false;
    super.onAdd(map);
    const pane = this.getPane();
    if (!pane) throw new Error(`Orihon pane not found: ${this.options.pane}`);
    this.canvas = createEl("canvas", "oh-webgl-heat-layer", pane);
    this.canvas.style.position = "absolute";
    this.canvas.style.left = "0";
    this.canvas.style.top = "0";
    this.canvas.style.pointerEvents = "none";
    this.gl = this.canvas.getContext("webgl", {
      antialias: false,
      alpha: true,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      powerPreference: "high-performance"
    });
    if (this.gl && this.#initWebGL()) {
      this.renderer = "webgl";
    } else {
      this.renderer = "none";
    }
    if (this.scaleZoom == null) this.scaleZoom = map.getZoom();
    // Debounced settle: Orihon setView begins+ends the view session synchronously,
    // so moveend alone cannot mark "idle"; continuous move keeps LOD low until quiet.
    map.on("move", this._onMove);
    map.on("zoom", this._onMove);
    map.on("moveend", this._onSettle);
    map.on("zoomend", this._onSettle);
    this.render();
  }

  override onRemove(): void {
    this._disposed = true;
    this.map?.off("move", this._onMove);
    this.map?.off("zoom", this._onMove);
    this.map?.off("moveend", this._onSettle);
    this.map?.off("zoomend", this._onSettle);
    if (this._settleTimer != null) {
      clearTimeout(this._settleTimer);
      this._settleTimer = null;
    }
    this.#disposeGL();
    if (this.canvas) {
      this.canvas.width = 0;
      this.canvas.height = 0;
      this.canvas.remove();
    }
    this.canvas = null;
    this.renderer = "none";
    this.#releaseCpuBuffers();
    super.onRemove();
  }

  override render(): void {
    if (this._disposed || !this.map || !this.canvas || this.renderer !== "webgl") return;
    const cssW = this.map.size.width;
    const cssH = this.map.size.height;
    const dprCap = this._moving
      ? Math.min(this.options.interactionDpr, this.options.maxDpr)
      : this.options.maxDpr;
    // Cap backing store — full-retina FBOs on large maps blow GPU memory across re-runs.
    const maxEdge = 1600;
    const rawDpr = Math.min(dprCap, window.devicePixelRatio || 1);
    const dpr = Math.min(rawDpr, maxEdge / Math.max(cssW, cssH, 1));
    const width = Math.max(1, Math.round(cssW * dpr));
    const height = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    if (this._cssW !== cssW || this._cssH !== cssH) {
      this.canvas.style.width = `${cssW}px`;
      this.canvas.style.height = `${cssH}px`;
      this._cssW = cssW;
      this._cssH = cssH;
    }
    this.#ensureFbo(width, height);
    this.#renderWebGL(dpr, cssW, cssH);
  }

  #markMoving(): void {
    if (this._disposed) return;
    this._moving = true;
    if (this._settleTimer != null) clearTimeout(this._settleTimer);
    this._settleTimer = setTimeout(() => {
      this._settleTimer = null;
      if (this._disposed) return;
      this._moving = false;
      this._aggZoom = Number.NaN;
      this.render();
    }, SETTLE_MS);
  }

  #settle(): void {
    if (this._disposed) return;
    // Re-arm the same debounce so sync setView(moveend) does not force full-res every frame.
    if (this._settleTimer != null) clearTimeout(this._settleTimer);
    this._settleTimer = setTimeout(() => {
      this._settleTimer = null;
      if (this._disposed) return;
      if (!this._moving) {
        this._aggZoom = Number.NaN;
        this.render();
        return;
      }
      this._moving = false;
      this._aggZoom = Number.NaN;
      this.render();
    }, SETTLE_MS);
  }

  #initWebGL(): boolean {
    const gl = this.gl;
    if (!gl) return false;

    const intensityVert = compileShader(
      gl,
      gl.VERTEX_SHADER,
      `
      attribute vec2 a_merc;
      attribute float a_weight;
      uniform float u_scale;
      uniform vec2 u_origin;
      uniform vec2 u_resolution;
      uniform float u_dpr;
      uniform float u_pointSize;
      uniform float u_intensity;
      varying float v_weight;
      void main() {
        vec2 pixel = a_merc * u_scale - u_origin;
        vec2 clip = ((pixel * u_dpr) / u_resolution) * 2.0 - 1.0;
        gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
        gl_PointSize = u_pointSize;
        v_weight = a_weight * u_intensity;
      }
    `
    );
    const intensityFrag = compileShader(
      gl,
      gl.FRAGMENT_SHADER,
      `
      precision mediump float;
      varying float v_weight;
      void main() {
        vec2 c = gl_PointCoord * 2.0 - 1.0;
        float d = length(c);
        if (d > 1.0) discard;
        float falloff = 1.0 - d;
        float a = v_weight * falloff * falloff;
        gl_FragColor = vec4(a, a, a, 1.0);
      }
    `
    );
    const colorizeVert = compileShader(
      gl,
      gl.VERTEX_SHADER,
      `
      attribute vec2 a_pos;
      varying vec2 v_uv;
      void main() {
        v_uv = a_pos * 0.5 + 0.5;
        gl_Position = vec4(a_pos, 0.0, 1.0);
      }
    `
    );
    const colorizeFrag = compileShader(
      gl,
      gl.FRAGMENT_SHADER,
      `
      precision mediump float;
      varying vec2 v_uv;
      uniform sampler2D u_intensity;
      uniform sampler2D u_gradient;
      uniform float u_minOpacity;
      uniform float u_opacity;
      void main() {
        // FBO texture is upside-down vs screen NDC in WebGL1.
        float t = texture2D(u_intensity, vec2(v_uv.x, 1.0 - v_uv.y)).r;
        if (t < u_minOpacity) discard;
        // Soft curve keeps mid-density blues/greens before clipping to red.
        t = clamp(pow(t, 0.85), 0.0, 1.0);
        vec4 color = texture2D(u_gradient, vec2(t, 0.5));
        // Alpha follows intensity so the basemap stays visible (not opaque color.a).
        float alpha = t * u_opacity;
        gl_FragColor = vec4(color.rgb * alpha, alpha);
      }
    `
    );

    if (!intensityVert || !intensityFrag || !colorizeVert || !colorizeFrag) {
      return false;
    }

    this._intensityProgram = linkProgram(gl, intensityVert, intensityFrag);
    this._colorizeProgram = linkProgram(gl, colorizeVert, colorizeFrag);
    gl.deleteShader(intensityVert);
    gl.deleteShader(intensityFrag);
    gl.deleteShader(colorizeVert);
    gl.deleteShader(colorizeFrag);
    if (!this._intensityProgram || !this._colorizeProgram) return false;

    this._intensityLocs = {
      aMerc: gl.getAttribLocation(this._intensityProgram, "a_merc"),
      aWeight: gl.getAttribLocation(this._intensityProgram, "a_weight"),
      uScale: gl.getUniformLocation(this._intensityProgram, "u_scale"),
      uOrigin: gl.getUniformLocation(this._intensityProgram, "u_origin"),
      uResolution: gl.getUniformLocation(this._intensityProgram, "u_resolution"),
      uDpr: gl.getUniformLocation(this._intensityProgram, "u_dpr"),
      uPointSize: gl.getUniformLocation(this._intensityProgram, "u_pointSize"),
      uIntensity: gl.getUniformLocation(this._intensityProgram, "u_intensity")
    };
    this._colorizeLocs = {
      aPos: gl.getAttribLocation(this._colorizeProgram, "a_pos"),
      uIntensity: gl.getUniformLocation(this._colorizeProgram, "u_intensity"),
      uGradient: gl.getUniformLocation(this._colorizeProgram, "u_gradient"),
      uMinOpacity: gl.getUniformLocation(this._colorizeProgram, "u_minOpacity"),
      uOpacity: gl.getUniformLocation(this._colorizeProgram, "u_opacity")
    };

    this._buffer = gl.createBuffer();
    this._quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    this._gradientTex = this.#createGradientTexture();
    this._bufferDirty = true;
    return true;
  }

  #createGradientTexture(): WebGLTexture | null {
    const gl = this.gl;
    if (!gl) return null;
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 1;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    const grd = ctx.createLinearGradient(0, 0, 256, 0);
    for (const [stop, color] of Object.entries(this.options.gradient)) {
      grd.addColorStop(Number(stop), color);
    }
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, 256, 1);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    return tex;
  }

  #ensureFbo(width: number, height: number): void {
    const gl = this.gl;
    if (!gl) return;
    if (this._fbo && this._intensityTex && this._fboW === width && this._fboH === height && this._fboComplete) {
      return;
    }

    if (this._fbo) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(this._fbo);
      this._fbo = null;
    }
    if (this._intensityTex) {
      gl.deleteTexture(this._intensityTex);
      this._intensityTex = null;
    }

    this._intensityTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._intensityTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    this._fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._intensityTex, 0);
    this._fboComplete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this._fboW = width;
    this._fboH = height;
  }

  #ensureAggregate(zoom: number): void {
    const zoomKey = Math.floor(zoom);
    // Continuous stress oscillates zoom every frame — rebuilding a 50k Map each time OOMs.
    // Keep the last aggregate while the camera is moving; refresh on settle.
    if (this._moving && Number.isFinite(this._aggZoom) && this._aggCount > 0) return;
    if (zoomKey === this._aggZoom && this._aggData.length >= this._aggCount * 3) return;

    if (!this.options.aggregate || this._count === 0) {
      this._aggData = this.data;
      this._aggCount = this._count;
      this._aggZoom = zoomKey;
      return;
    }

    const scaleZoom = this.scaleZoom ?? zoom;
    const scale = TILE_SIZE * 2 ** zoom;
    const radiusScale = heatRadiusScale(zoom, scaleZoom);
    const kernelCss = Math.max(4, (this.options.radius + this.options.blur * 0.5) * radiusScale);
    let cellMerc = Math.max(1e-7, (kernelCss * this.options.aggregateCellFactor) / scale);

    // If cells would be smaller than ~1 CSS px, aggregation buys nothing — use source.
    if (cellMerc * scale < 1.25) {
      this._aggData = this.data;
      this._aggCount = this._count;
      this._aggZoom = zoomKey;
      return;
    }

    // Soft-cap unique cells: enlarge cell until count stays manageable.
    const maxCells = Math.min(24_000, Math.max(2_000, this._count));
    let slots = 0;
    for (let attempt = 0; attempt < 6; attempt++) {
      slots = this.#aggregateIntoBuffers(cellMerc);
      if (slots <= maxCells || attempt === 5) break;
      cellMerc *= 1.55;
      this._aggIndex.clear();
    }

    const need = slots * 3;
    if (this._aggBuf.length < need) this._aggBuf = new Float32Array(need);
    const out = this._aggBuf;
    let write = 0;
    for (let i = 0; i < slots; i++) {
      const w = this._aggSumW[i];
      const invW = w > 0 ? 1 / w : 0;
      out[write++] = this._aggSumX[i] * invW;
      out[write++] = this._aggSumY[i] * invW;
      out[write++] = w;
    }
    this._aggIndex.clear();
    this._aggData = out.subarray(0, write);
    this._aggCount = write / 3;
    this._aggZoom = zoomKey;
  }

  /** Numeric aggregation — no per-cell object literals (avoids GC blow-ups). */
  #aggregateIntoBuffers(cellMerc: number): number {
    const inv = 1 / cellMerc;
    const src = this.data;
    const strideY = 1_048_576;
    const index = this._aggIndex;
    index.clear();
    let n = 0;
    const cap = this._count;
    if (this._aggSumX.length < cap) {
      this._aggSumX = new Float64Array(cap);
      this._aggSumY = new Float64Array(cap);
      this._aggSumW = new Float64Array(cap);
    }
    const sumX = this._aggSumX;
    const sumY = this._aggSumY;
    const sumW = this._aggSumW;

    for (let i = 0; i < src.length; i += 3) {
      const mx = src[i];
      const my = src[i + 1];
      const w = src[i + 2];
      const ix = Math.floor(mx * inv);
      const iy = Math.floor(my * inv);
      const key = ix * strideY + iy;
      let slot = index.get(key);
      if (slot === undefined) {
        slot = n++;
        index.set(key, slot);
        sumX[slot] = mx * w;
        sumY[slot] = my * w;
        sumW[slot] = w;
      } else {
        sumX[slot] += mx * w;
        sumY[slot] += my * w;
        sumW[slot] += w;
      }
    }
    return n;
  }

  #cullToDraw(scale: number, originX: number, originY: number, cssW: number, cssH: number, padCss: number): void {
    const src = this._aggData;
    const count = this._aggCount;
    const need = count * 3;
    if (this._drawBuf.length < need) this._drawBuf = new Float32Array(Math.max(need, 64));
    const out = this._drawBuf;

    const minMx = (originX - padCss) / scale;
    const maxMx = (originX + cssW + padCss) / scale;
    const minMy = (originY - padCss) / scale;
    const maxMy = (originY + cssH + padCss) / scale;

    let write = 0;
    for (let i = 0; i < src.length; i += 3) {
      const mx = src[i];
      const my = src[i + 1];
      if (mx < minMx || mx > maxMx || my < minMy || my > maxMy) continue;
      out[write++] = mx;
      out[write++] = my;
      out[write++] = src[i + 2];
    }
    this._drawData = out.subarray(0, write);
    this._drawn = write / 3;

    // Avoid re-uploading the same GPU buffer every frame when the draw set is unchanged.
    const signature = `${this._drawn}|${originX.toFixed(1)}|${originY.toFixed(1)}|${write}`;
    this._bufferDirty = signature !== this._drawSignature;
    this._drawSignature = signature;
  }

  #uploadDrawBuffer(): void {
    const gl = this.gl;
    if (!gl || !this._buffer || !this._bufferDirty) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this._buffer);
    const bytes = this._drawData.byteLength;
    if (bytes > 0 && bytes <= this._gpuBytes) {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this._drawData);
    } else {
      gl.bufferData(gl.ARRAY_BUFFER, this._drawData, gl.DYNAMIC_DRAW);
      this._gpuBytes = bytes;
    }
    this._bufferDirty = false;
  }

  #renderWebGL(dpr: number, cssW: number, cssH: number): void {
    const gl = this.gl;
    const map = this.map;
    const intensityLocs = this._intensityLocs;
    const colorizeLocs = this._colorizeLocs;
    if (
      !gl ||
      !map ||
      !this.canvas ||
      !this._intensityProgram ||
      !this._colorizeProgram ||
      !this._buffer ||
      !this._quadBuffer ||
      !this._fbo ||
      !this._intensityTex ||
      !this._gradientTex ||
      !intensityLocs ||
      !colorizeLocs ||
      !this._fboComplete
    ) {
      return;
    }

    const width = this.canvas.width;
    const height = this.canvas.height;
    const scale = TILE_SIZE * 2 ** map.zoom;
    const zoom = map.zoom;
    const scaleZoom = this.scaleZoom ?? zoom;
    const radiusScale = heatRadiusScale(zoom, scaleZoom);
    const pointSize = Math.max(4, (this.options.radius + this.options.blur * 0.5) * radiusScale * dpr * 2);
    const zoomIntensity = this.options.intensity * heatIntensityScale(zoom, scaleZoom);
    const padCss = pointSize / (2 * Math.max(dpr, 1e-6));

    this.#ensureAggregate(zoom);
    this.#cullToDraw(scale, map.pixelOrigin.x, map.pixelOrigin.y, cssW, cssH, padCss);

    // --- Pass 1: additive intensity into FBO ---
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (this._drawn > 0) {
      this.#uploadDrawBuffer();
      gl.useProgram(this._intensityProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._buffer);
      gl.enableVertexAttribArray(intensityLocs.aMerc);
      gl.vertexAttribPointer(intensityLocs.aMerc, 2, gl.FLOAT, false, 12, 0);
      gl.enableVertexAttribArray(intensityLocs.aWeight);
      gl.vertexAttribPointer(intensityLocs.aWeight, 1, gl.FLOAT, false, 12, 8);

      gl.uniform1f(intensityLocs.uScale, scale);
      gl.uniform2f(intensityLocs.uOrigin, map.pixelOrigin.x, map.pixelOrigin.y);
      gl.uniform2f(intensityLocs.uResolution, width, height);
      gl.uniform1f(intensityLocs.uDpr, dpr);
      gl.uniform1f(intensityLocs.uPointSize, pointSize);
      gl.uniform1f(intensityLocs.uIntensity, zoomIntensity);

      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.drawArrays(gl.POINTS, 0, this._drawn);
      gl.disableVertexAttribArray(intensityLocs.aMerc);
      gl.disableVertexAttribArray(intensityLocs.aWeight);
    }

    // --- Pass 2: colorize to screen ---
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this._colorizeProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuffer);
    gl.enableVertexAttribArray(colorizeLocs.aPos);
    gl.vertexAttribPointer(colorizeLocs.aPos, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._intensityTex);
    gl.uniform1i(colorizeLocs.uIntensity, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._gradientTex);
    gl.uniform1i(colorizeLocs.uGradient, 1);
    gl.uniform1f(colorizeLocs.uMinOpacity, this.options.minOpacity);
    gl.uniform1f(colorizeLocs.uOpacity, this.options.opacity);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disableVertexAttribArray(colorizeLocs.aPos);
  }

  #disposeGL(): void {
    const gl = this.gl;
    if (gl) {
      try {
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.useProgram(null);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, null);

        if (this._fbo) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.deleteFramebuffer(this._fbo);
        }
        if (this._intensityTex) gl.deleteTexture(this._intensityTex);
        if (this._gradientTex) gl.deleteTexture(this._gradientTex);
        if (this._buffer) gl.deleteBuffer(this._buffer);
        if (this._quadBuffer) gl.deleteBuffer(this._quadBuffer);
        if (this._intensityProgram) gl.deleteProgram(this._intensityProgram);
        if (this._colorizeProgram) gl.deleteProgram(this._colorizeProgram);

        // Force the browser to drop GPU memory for this context (critical across bench re-runs).
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      } catch {
        /* context may already be lost */
      }
    }
    this._buffer = null;
    this._quadBuffer = null;
    this._intensityProgram = null;
    this._colorizeProgram = null;
    this._intensityLocs = null;
    this._colorizeLocs = null;
    this._intensityTex = null;
    this._gradientTex = null;
    this._fbo = null;
    this.gl = null;
    this._gpuBytes = 0;
    this._fboW = 0;
    this._fboH = 0;
    this._fboComplete = false;
  }

  #releaseCpuBuffers(): void {
    this.data = new Float32Array();
    this._dataBuf = new Float32Array(0);
    this._aggBuf = new Float32Array(0);
    this._aggData = new Float32Array(0);
    this._drawBuf = new Float32Array(0);
    this._drawData = new Float32Array(0);
    this._aggSumX = new Float64Array(0);
    this._aggSumY = new Float64Array(0);
    this._aggSumW = new Float64Array(0);
    this._aggIndex.clear();
    this._count = 0;
    this._aggCount = 0;
    this._drawn = 0;
    this._aggZoom = Number.NaN;
    this._drawSignature = "";
    this._bufferDirty = true;
  }
}

export function webglHeatLayer(
  points?: Iterable<WebGLHeatInput>,
  options?: WebGLHeatLayerOptions
): WebGLHeatLayer {
  return new WebGLHeatLayer(points, options);
}

function normalizeHeat(value: WebGLHeatInput): { lat: number; lng: number; weight: number } | null {
  if (Array.isArray(value)) {
    const lat = Number(value[0]);
    const lng = Number(value[1]);
    const weight = value[2] == null ? 1 : Number(value[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng, weight: Number.isFinite(weight) ? weight : 1 };
  }
  const point = latLng(value);
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return null;
  return { lat: point.lat, lng: point.lng, weight: 1 };
}

function latLngToMercator(lat: number, lng: number): { x: number; y: number } {
  let clampedLat = lat;
  if (clampedLat > MAX_LAT) clampedLat = MAX_LAT;
  else if (clampedLat < -MAX_LAT) clampedLat = -MAX_LAT;
  const wrappedLng = ((((lng + 180) % 360) + 360) % 360) - 180;
  const sin = Math.sin((clampedLat * Math.PI) / 180);
  return {
    x: (wrappedLng + 180) / 360,
    y: 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)
  };
}

/** Screen kernel scale: shrink when zoomed out; flat when zooming in (geographic size shrinks). */
function heatRadiusScale(zoom: number, scaleZoom: number): number {
  const dz = zoom - scaleZoom;
  if (dz >= 0) return 1;
  const geo = Math.pow(2, dz);
  return Math.max(0.22, geo * 0.55 + 0.45 * Math.pow(geo, 0.35));
}

/**
 * Intensity scale: ease down when zooming in so dense packs don't saturate to solid red.
 * Stays ~1 at/below scaleZoom (radius shrink handles overview).
 */
function heatIntensityScale(zoom: number, scaleZoom: number): number {
  const dz = zoom - scaleZoom;
  if (dz <= 0) return 1;
  return 1 / Math.pow(2, Math.min(dz, 6) * 0.45);
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

function linkProgram(
  gl: WebGLRenderingContext,
  vertex: WebGLShader,
  fragment: WebGLShader
): WebGLProgram | null {
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }
  return program;
}
