import { createEl } from "../dom.js";
import { TILE_SIZE, latLng, projectMercator01, type LatLngLike } from "../geo.js";
import { Layer, type LayerOptions } from "../layer.js";
import type { Orihon } from "../map.js";
import { assertMercator } from "../crs.js";
import { heatKernelAtZoom, heatWarpNeedsGpu, valueHeatTone } from "../services/heat-scale.js";
import { compileShader, linkProgram } from "../webgl-utils.js";

export type WebGLHeatInput = LatLngLike | [number, number, number?];

export interface WebGLHeatLayerOptions extends LayerOptions {
  /** Kernel radius in CSS px at `scaleZoom`. */
  radius?: number;
  /** Extra soft falloff in CSS px (added into point size). */
  blur?: number;
  scaleZoom?: number;
  /** Floor for screen radius when zoomed far out (px). Default 4. */
  minRadius?: number;
  /** Cap for screen radius when zoomed in (px). Default 96. */
  maxRadius?: number;
  maxZoom?: number;
  /**
   * Density that maps to the top of the gradient after zoom compensation.
   * Default 1 — a single unweighted point at `scaleZoom` peaks at `intensity`.
   */
  max?: number;
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
  /**
   * `density` (default) — color is mass / kernel area (point count).
   * `value` — color is the kernel-weighted average of per-point weights,
   * so more sensors in a cell do not make it hotter.
   */
  field?: "density" | "value";
  /** Merge nearby points into weighted cells (heat field). Default true. */
  aggregate?: boolean;
  /**
   * Cell size as a fraction of the screen kernel radius (CSS px → mercator).
   * Default 0.22 — well inside the kernel so stamps blend into a field, not a cluster grid.
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
  0.0: "rgba(0,80,255,0.45)",
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
  uValueField: WebGLUniformLocation | null;
  uAccum: WebGLUniformLocation | null;
}

interface ColorizeLocs {
  aPos: number;
  uIntensity: WebGLUniformLocation | null;
  uGradient: WebGLUniformLocation | null;
  uMinOpacity: WebGLUniformLocation | null;
  uOpacity: WebGLUniformLocation | null;
  uValueField: WebGLUniformLocation | null;
  uMax: WebGLUniformLocation | null;
  uPreNormalized: WebGLUniformLocation | null;
}

/**
 * GPU heatmap: additive KDE into an FBO, then gradient colorize.
 * Color is geographic density (mass / kernel area). The kernel follows
 * mercator scale; min/max pixel clamps are area-compensated so zooming out
 * cannot inflate overlap into false reds. Camera frames CSS-warp the last
 * paint (same as tiles/points); KDE rebuilds on settle. Viewport-culls,
 * zoom-aggregates, and drops DPR while the camera is moving.
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
  private _aggViewKey = "";
  private _aggCellMerc = 0;
  private _aggCoversWorld = false;
  private _aggMinMx = 0;
  private _aggMaxMx = 0;
  private _aggMinMy = 0;
  private _aggMaxMy = 0;
  private _viewBuf = new Float32Array(0);
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
  private _maxPointSize = 64;
  private _moving = false;
  private _settleTimer: ReturnType<typeof setTimeout> | null = null;
  private _forceGpu = true;
  private _hasPainted = false;
  private _paintedZoom = Number.NaN;
  private _paintedOriginX = 0;
  private _paintedOriginY = 0;
  private _paintedPad = 0;
  private _lastGpuMs = 0;
  private _packedMerc: Float64Array | null = null;
  private _packedN = -1;
  private _packedHasWeights = false;
  private scaleZoom: number | undefined;
  private _disposed = false;
  /** Reused numeric aggregation index (cleared after each rebuild). */
  private readonly _aggIndex = new Map<number, number>();
  private _aggSumX = new Float64Array(0);
  private _aggSumY = new Float64Array(0);
  private _aggSumW = new Float64Array(0);
  private _aggSumN = new Float64Array(0);
  private _gridSumW = new Float64Array(0);
  private _gridSumV = new Float64Array(0);
  private _gridMaxV = new Float64Array(0);
  private _gridHotW = new Float64Array(0);
  private _gridRgba = new Uint8Array(0);
  private readonly _onMove = (): void => this.#markMoving();
  private readonly _onSettle = (): void => this.#settle();

  constructor(points: Iterable<WebGLHeatInput> = [], options: WebGLHeatLayerOptions = {}) {
    super({
      pane: "overlay",
      attribution: "",
      radius: 22,
      blur: 16,
      minRadius: 4,
      maxRadius: 96,
      maxZoom: 18,
      max: 1,
      intensity: 0.6,
      opacity: 0.7,
      minOpacity: 0.02,
      maxDpr: 1.5,
      interactionDpr: 1,
      field: "density",
      aggregate: true,
      aggregateCellFactor: 0.22,
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
        const m = projectMercator01(next.lat, next.lng);
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
        const m = projectMercator01(next.lat, next.lng);
        values.push(m.x, m.y, next.weight);
      }
      this._dataBuf = new Float32Array(values);
      this.data = this._dataBuf;
      this._count = values.length / 3;
    }
    this._aggZoom = Number.NaN;
    this._bufferDirty = true;
    this._packedMerc = null;
    this._packedN = -1;
    this._packedHasWeights = false;
    this._forceGpu = true;
    this.render();
    return this;
  }

  /**
   * Load pre-projected mercator 0..1 pairs (Float64 x,y) without JS [lat,lng] tuples.
   * Used by ObjectManager heatmap at 100k–1M.
   */
  setPackedMercator(merc64: Float64Array, pointCount: number, weights?: ArrayLike<number> | null): this {
    const n = Math.max(0, Math.min(pointCount, Math.floor(merc64.length / 2)));
    const hasWeights = Boolean(weights);
    // Same packed buffer, no per-point weights: camera-only. Do not rebuild the KDE.
    if (this._packedMerc === merc64 && this._packedN === n && !hasWeights && !this._packedHasWeights) {
      this.render();
      return this;
    }
    this._packedMerc = merc64;
    this._packedN = n;
    this._packedHasWeights = hasWeights;
    const need = n * 3;
    if (this._dataBuf.length < need) this._dataBuf = new Float32Array(Math.max(need, 12));
    const buf = this._dataBuf;
    let write = 0;
    if (weights) {
      // Keep explicit 0 (falsy) — `|| 1` would paint every cool sensor as full heat.
      // Drop near-zero weights so the value field only stamps real readings.
      for (let i = 0; i < n; i++) {
        const raw = Number(weights[i]);
        const w = Number.isFinite(raw) ? Math.max(0, raw) : 0;
        if (w <= 1e-6) continue;
        buf[write++] = merc64[i * 2];
        buf[write++] = merc64[i * 2 + 1];
        buf[write++] = w;
      }
    } else {
      for (let i = 0; i < n; i++) {
        buf[write++] = merc64[i * 2];
        buf[write++] = merc64[i * 2 + 1];
        buf[write++] = 1;
      }
    }
    this.data = buf.subarray(0, write);
    this._count = write / 3;
    this._aggZoom = Number.NaN;
    this._bufferDirty = true;
    this._forceGpu = true;
    this.render();
    return this;
  }

  setLatLngs(points: Iterable<WebGLHeatInput>): this {
    return this.setData(points);
  }

  clear(): this {
    this.#releaseCpuBuffers();
    this._gpuBytes = 0;
    this._hasPainted = false;
    this._forceGpu = true;
    this.render();
    return this;
  }

  override onAdd(map: Orihon): void {
    assertMercator(map.crs);
    this._disposed = false;
    super.onAdd(map);
    const pane = this.getPane();
    if (!pane) throw new Error(`Orihon pane not found: ${this.options.pane}`);
    this.canvas = createEl("canvas", "oh-webgl-heat-layer", pane);
    this.canvas.style.position = "absolute";
    this.canvas.style.left = "0";
    this.canvas.style.top = "0";
    this.canvas.style.pointerEvents = "none";
    this.canvas.style.willChange = "transform";
    this.canvas.style.transformOrigin = "0 0";
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
    // Keep source points (`data` / `_count`) so remove→add toggles still draw.
    // Drop only derived GPU-facing caches; call `clear()` to wipe points.
    this._aggData = new Float32Array(0);
    this._aggCount = 0;
    this._aggZoom = Number.NaN;
    this._aggViewKey = "";
    this._aggCellMerc = 0;
    this._aggCoversWorld = false;
    this._drawData = new Float32Array(0);
    this._drawn = 0;
    this._drawSignature = "";
    this._bufferDirty = true;
    this._cssW = 0;
    this._cssH = 0;
    this._hasPainted = false;
    this._forceGpu = true;
    this._paintedZoom = Number.NaN;
    super.onRemove();
  }

  override wantsFrameRender(): boolean {
    return this.renderer === "webgl" && this._count > 0;
  }

  override render(): void {
    if (this._disposed || !this.map || !this.canvas || this.renderer !== "webgl") return;
    const cssW = this.map.size.width;
    const cssH = this.map.size.height;
    const zoom = this.map.zoom;
    const ox = this.map.pixelOrigin.x;
    const oy = this.map.pixelOrigin.y;
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const pad = this.#overscanPad(cssW, cssH);
    const drawW = cssW + pad * 2;
    const drawH = cssH + pad * 2;

    const canWarp =
      this._hasPainted &&
      Number.isFinite(this._paintedZoom) &&
      !this._forceGpu &&
      this._cssW === cssW &&
      this._cssH === cssH;

    if (canWarp) {
      const s = 2 ** (zoom - this._paintedZoom);
      // Canvas 0,0 is the overscanned draw origin (viewport origin − pad), not
      // the map origin. Scaling about 0,0 with the viewport origin drifts by
      // pad*(s-1) — the field leaves the city it was painted on.
      const drawOx = ox - this._paintedPad;
      const drawOy = oy - this._paintedPad;
      const tx = this._paintedOriginX * s - drawOx;
      const ty = this._paintedOriginY * s - drawOy;
      const cover = Math.max(24, this._paintedPad * 0.4);
      // Value fields: warp across ~±1 zoom so fixed weights do not reshuffle reds.
      const uncovered = heatWarpNeedsGpu(s, tx, ty, cover, {
        zoomLevels: this.options.field === "value" ? 1 : 0
      });
      // Prefer a fresh field over a stretched soft edge (aureoles on scroll/zoom).
      const throttled = uncovered && now - this._lastGpuMs < (s < 1 || s > 1 ? 48 : 72);
      if (!uncovered || throttled) {
        if (s === 1 && tx * tx + ty * ty < 1e-4) return;
        this.canvas.style.left = `${-this._paintedPad}px`;
        this.canvas.style.top = `${-this._paintedPad}px`;
        this.canvas.style.transformOrigin = "0 0";
        this.canvas.style.transform = `translate3d(${tx}px,${ty}px,0) scale(${s})`;
        return;
      }
    }

    const dprCap = this._moving
      ? Math.min(this.options.interactionDpr, this.options.maxDpr)
      : this.options.maxDpr;
    // Cap backing store — full-retina FBOs on large maps blow GPU memory across re-runs.
    const maxEdge = 1600;
    const rawDpr = Math.min(dprCap, window.devicePixelRatio || 1);
    const dpr = Math.min(rawDpr, maxEdge / Math.max(drawW, drawH, 1));
    const width = Math.max(1, Math.round(drawW * dpr));
    const height = Math.max(1, Math.round(drawH * dpr));
    this.canvas.style.left = `${-pad}px`;
    this.canvas.style.top = `${-pad}px`;
    this.canvas.style.width = `${drawW}px`;
    this.canvas.style.height = `${drawH}px`;
    this.canvas.style.transform = "none";
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    this._cssW = cssW;
    this._cssH = cssH;
    this.#ensureFbo(width, height);
    this.#renderWebGL(dpr, cssW, cssH, pad);
    this._paintedZoom = zoom;
    this._paintedOriginX = ox - pad;
    this._paintedOriginY = oy - pad;
    this._paintedPad = pad;
    this._hasPainted = true;
    this._forceGpu = false;
    this._lastGpuMs = now;
  }

  #overscanPad(cssW: number, cssH: number): number {
    if (this._count < 32) return 0;
    const frac = this.options.field === "value" ? 0.28 : 0.18;
    const cap = this.options.field === "value" ? 320 : 220;
    return Math.round(Math.min(cap, Math.max(80, Math.min(cssW, cssH) * frac)));
  }

  #markMoving(): void {
    if (this._disposed) return;
    this._moving = true;
    this.#armSettle();
  }

  #settle(): void {
    if (this._disposed) return;
    // Re-arm the same debounce so sync setView(moveend) does not force full-res every frame.
    this.#armSettle();
  }

  #armSettle(): void {
    if (this._settleTimer != null) clearTimeout(this._settleTimer);
    this._settleTimer = setTimeout(() => {
      this._settleTimer = null;
      if (this._disposed) return;
      this._moving = false;
      this._aggZoom = Number.NaN;
      const map = this.map;
      // Value field: if the last paint still covers this camera within ~±1 zoom,
      // keep CSS-warping it. Rebuilding would reshuffle reds with the same weights.
      if (
        map &&
        this.options.field === "value" &&
        this._hasPainted &&
        Number.isFinite(this._paintedZoom)
      ) {
        const s = 2 ** (map.zoom - this._paintedZoom);
        const drawOx = map.pixelOrigin.x - this._paintedPad;
        const drawOy = map.pixelOrigin.y - this._paintedPad;
        const tx = this._paintedOriginX * s - drawOx;
        const ty = this._paintedOriginY * s - drawOy;
        const cover = Math.max(24, this._paintedPad * 0.4);
        if (!heatWarpNeedsGpu(s, tx, ty, cover, { zoomLevels: 1 })) {
          this._forceGpu = false;
          this.render();
          return;
        }
      }
      this._forceGpu = true;
      this.render();
    }, SETTLE_MS);
  }

  #initWebGL(): boolean {
    const gl = this.gl;
    if (!gl) return false;
    const range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as { 0: number; 1: number } | number[] | Float32Array;
    const hi = Number(range?.[1]);
    this._maxPointSize = Number.isFinite(hi) && hi > 1 ? hi : 64;

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
      uniform float u_valueField;
      uniform float u_accum;
      void main() {
        vec2 c = gl_PointCoord * 2.0 - 1.0;
        float d = length(c);
        if (d > 1.0) discard;
        float falloff = 1.0 - d;
        float k = falloff * falloff;
        if (u_valueField > 0.5) {
          float a = k * u_accum;
          gl_FragColor = vec4(v_weight * a, a, 0.0, 1.0);
        } else {
          float a = v_weight * k;
          gl_FragColor = vec4(a, a, a, 1.0);
        }
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
      uniform float u_valueField;
      uniform float u_max;
      uniform float u_preNormalized;
      void main() {
        // Intensity pass already maps CSS Y-down → NDC Y-up, so FBO v matches
        // screen NDC. Do not flip again here (that mirrors heat about mid-Y and
        // makes blobs drift opposite the basemap on zoom).
        vec4 s = texture2D(u_intensity, v_uv);
        float t;
        float alpha;
        if (u_valueField > 0.5) {
          float cover = s.g;
          if (cover < u_minOpacity) discard;
          t = u_preNormalized > 0.5
            ? clamp(s.r, 0.0, 1.0)
            : clamp(s.r / max(cover, 1.0e-6) / max(u_max, 1.0e-6), 0.0, 1.0);
          alpha = u_opacity * smoothstep(0.0, max(u_minOpacity * 4.0, 0.02), cover);
        } else {
          t = s.r;
          if (t < u_minOpacity) discard;
          t = clamp(t, 0.0, 1.0);
          alpha = t * u_opacity;
        }
        // Kill canvas-rim glow when CSS-warping: clamp/soft cover at the overscan
        // border otherwise stretches into a visible aureole around the field.
        float edge = min(min(v_uv.x, 1.0 - v_uv.x), min(v_uv.y, 1.0 - v_uv.y));
        alpha *= smoothstep(0.0, 0.035, edge);
        if (alpha < 0.004) discard;
        vec4 color = texture2D(u_gradient, vec2(t, 0.5));
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
      uIntensity: gl.getUniformLocation(this._intensityProgram, "u_intensity"),
      uValueField: gl.getUniformLocation(this._intensityProgram, "u_valueField"),
      uAccum: gl.getUniformLocation(this._intensityProgram, "u_accum")
    };
    this._colorizeLocs = {
      aPos: gl.getAttribLocation(this._colorizeProgram, "a_pos"),
      uIntensity: gl.getUniformLocation(this._colorizeProgram, "u_intensity"),
      uGradient: gl.getUniformLocation(this._colorizeProgram, "u_gradient"),
      uMinOpacity: gl.getUniformLocation(this._colorizeProgram, "u_minOpacity"),
      uOpacity: gl.getUniformLocation(this._colorizeProgram, "u_opacity"),
      uValueField: gl.getUniformLocation(this._colorizeProgram, "u_valueField"),
      uMax: gl.getUniformLocation(this._colorizeProgram, "u_max"),
      uPreNormalized: gl.getUniformLocation(this._colorizeProgram, "u_preNormalized")
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

  #kernelAt(zoom: number, dpr = 1): ReturnType<typeof heatKernelAtZoom> {
    const baseCss = this.options.radius + this.options.blur * 0.5;
    const glMaxCss = this._maxPointSize / (2 * Math.max(dpr, 1e-6));
    const maxCss = Math.min(this.options.maxRadius, glMaxCss);
    return heatKernelAtZoom(zoom, this.scaleZoom ?? zoom, baseCss, {
      minRadiusCss: this.options.minRadius,
      maxRadiusCss: maxCss
    });
  }

  /** Geographic kernel in CSS px. Value fields clamp so the blob stays on the sensor. */
  #geographicRadiusCss(zoom: number): number {
    const baseCss = this.options.radius + this.options.blur * 0.5;
    const scaleZoom = this.scaleZoom ?? zoom;
    if (this.options.field !== "value") {
      return Math.max(baseCss, 1e-6) * 2 ** (zoom - scaleZoom);
    }
    return heatKernelAtZoom(zoom, scaleZoom, baseCss, {
      minRadiusCss: this.options.minRadius,
      maxRadiusCss: this.options.maxRadius
    }).radiusCss;
  }

  /**
   * Value field on a screen grid. Color blends kernel **mean** toward **peak**
   * by the local share of alarm-weight mass: ~2% stay green, ~20% pull yellow/red.
   * Coverage/alpha still uses kernel mass.
   */
  #rasterizeValueField(
    gl: WebGLRenderingContext,
    drawW: number,
    drawH: number,
    originX: number,
    originY: number,
    scale: number,
    radiusCss: number
  ): boolean {
    if (!this._intensityTex) return false;
    const src = this._drawData;
    const n = this._drawn;
    const maxVal = Math.max(this.options.max, 1e-6);
    const alarmWeight = Math.min(maxVal, maxVal * 0.5);
    const cellPx = Math.max(3, Math.min(8, radiusCss / 12));
    let gw = Math.max(96, Math.min(320, Math.round(drawW / cellPx)));
    let gh = Math.max(72, Math.min(240, Math.round(drawH / cellPx)));
    while (gw * gh > 60_000) {
      gw = Math.max(96, Math.ceil(gw * 0.85));
      gh = Math.max(72, Math.ceil(gh * 0.85));
    }
    const cells = gw * gh;
    if (this._gridSumW.length < cells) {
      this._gridSumW = new Float64Array(cells);
      this._gridSumV = new Float64Array(cells);
      this._gridMaxV = new Float64Array(cells);
      this._gridHotW = new Float64Array(cells);
    } else {
      this._gridSumW.fill(0, 0, cells);
      this._gridSumV.fill(0, 0, cells);
      this._gridMaxV.fill(0, 0, cells);
      this._gridHotW.fill(0, 0, cells);
    }
    const sumW = this._gridSumW;
    const sumV = this._gridSumV;
    const maxV = this._gridMaxV;
    const hotW = this._gridHotW;
    const xScale = gw / drawW;
    const yScale = gh / drawH;
    const rCellsX = radiusCss * xScale;
    const rCellsY = radiusCss * yScale;
    const splatCost = n * Math.PI * rCellsX * rCellsY;
    const gatherCost = n * cells;
    const useGather = n > 0 && gatherCost < splatCost && gatherCost < 8_000_000;

    const accumulate = (row: number, k: number, value: number): void => {
      sumW[row] += k;
      sumV[row] += k * value;
      if (value > maxV[row]) maxV[row] = value;
      if (value > alarmWeight) hotW[row] += k;
    };

    if (n > 0 && useGather) {
      const invR = 1 / Math.max(radiusCss, 1e-6);
      for (let gy = 0; gy < gh; gy++) {
        const cy = ((gy + 0.5) / gh) * drawH;
        for (let gx = 0; gx < gw; gx++) {
          const cx = ((gx + 0.5) / gw) * drawW;
          let w = 0;
          let v = 0;
          let peak = 0;
          let hot = 0;
          for (let i = 0; i < src.length; i += 3) {
            const value = src[i + 2];
            if (value <= 1e-6) continue;
            const px = src[i] * scale - originX;
            const py = src[i + 1] * scale - originY;
            const dx = (cx - px) * invR;
            const dy = (cy - py) * invR;
            const d2 = dx * dx + dy * dy;
            if (d2 >= 1) continue;
            const k = Math.exp(-4 * d2) - 0.01831563888;
            if (k <= 0) continue;
            w += k;
            v += k * value;
            if (value > peak) peak = value;
            if (value > alarmWeight) hot += k;
          }
          const row = (gh - 1 - gy) * gw + gx;
          sumW[row] = w;
          sumV[row] = v;
          maxV[row] = peak;
          hotW[row] = hot;
        }
      }
    } else if (n > 0) {
      // Keep the geographic kernel for falloff — screen-cell caps used to shrink
      // stamps at mass scales and reshuffled red zones on every zoom rebuild.
      // Cost is controlled by stride sampling instead.
      const fullR = Math.max(rCellsX, rCellsY);
      const rx = fullR;
      const ry = fullR;
      const rPad = Math.ceil(Math.max(rx, ry)) + 1;
      const splatR = Math.max(radiusCss, 1e-6);
      const stride =
        n > 600_000 ? 14 : n > 250_000 ? 9 : n > 120_000 ? 5 : n > 40_000 ? 2 : 1;
      const step = 3 * stride;
      for (let i = 0; i < src.length; i += step) {
        const value = src[i + 2];
        if (value <= 1e-6) continue;
        const px = src[i] * scale - originX;
        const py = src[i + 1] * scale - originY;
        const gx0 = Math.max(0, Math.floor(px * xScale - rx));
        const gx1 = Math.min(gw - 1, Math.ceil(px * xScale + rx));
        const gy0 = Math.max(0, Math.floor(py * yScale - ry));
        const gy1 = Math.min(gh - 1, Math.ceil(py * yScale + ry));
        if (gx1 < gx0 || gy1 < gy0) continue;
        if (gx1 - gx0 > rPad * 2 + 8 || gy1 - gy0 > rPad * 2 + 8) continue;
        for (let gy = gy0; gy <= gy1; gy++) {
          const cy = ((gy + 0.5) / gh) * drawH;
          const dy = (cy - py) / splatR;
          for (let gx = gx0; gx <= gx1; gx++) {
            const cx = ((gx + 0.5) / gw) * drawW;
            const dx = (cx - px) / splatR;
            const d2 = dx * dx + dy * dy;
            if (d2 >= 1) continue;
            const k = Math.exp(-4 * d2) - 0.01831563888;
            if (k <= 0) continue;
            accumulate((gh - 1 - gy) * gw + gx, k, value);
          }
        }
      }
    }

    const rgbaNeed = cells * 4;
    if (this._gridRgba.length < rgbaNeed) this._gridRgba = new Uint8Array(rgbaNeed);
    const rgba = this._gridRgba;
    for (let i = 0; i < cells; i++) {
      const w = sumW[i];
      const o = i * 4;
      if (w < 1e-6) {
        rgba[o] = 0;
        rgba[o + 1] = 0;
        rgba[o + 2] = 0;
        rgba[o + 3] = 0;
        continue;
      }
      const mean = sumV[i] / w / maxVal;
      const peak = maxV[i] / maxVal;
      const hotFrac = hotW[i] / w;
      const t = valueHeatTone(mean, peak, hotFrac);
      const cover = Math.min(1, w / 0.42);
      rgba[o] = (t * 255) | 0;
      rgba[o + 1] = (cover * 255) | 0;
      rgba[o + 2] = 0;
      rgba[o + 3] = 255;
    }

    gl.bindTexture(gl.TEXTURE_2D, this._intensityTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gw, gh, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba.subarray(0, rgbaNeed));
    this._fboW = gw;
    this._fboH = gh;
    return true;
  }

  #ensureAggregate(
    zoom: number,
    view?: { scale: number; originX: number; originY: number; cssW: number; cssH: number; padCss: number }
  ): void {
    const zoomKey = Math.floor(zoom);
    const viewKey = view
      ? `${Math.round(view.originX)}|${Math.round(view.originY)}|${Math.round(view.cssW)}x${Math.round(view.cssH)}`
      : "";
    // Continuous stress oscillates zoom every frame — rebuilding a 50k Map each time OOMs.
    // Keep the last field while the camera is moving *and* the new view is still
    // inside that cull. Zoom-out / long pan reveal sensors the last field never saw.
    if (
      this._moving &&
      Number.isFinite(this._aggZoom) &&
      this._aggCount > 0 &&
      this.#aggregateCoversView(view)
    ) {
      return;
    }
    if (
      zoomKey === this._aggZoom &&
      viewKey === this._aggViewKey &&
      this._aggData.length >= this._aggCount * 3
    ) {
      return;
    }

    if (!this.options.aggregate || this._count === 0) {
      this.#adoptSourceField(this.data, this._count, zoomKey, viewKey, 0);
      this.#rememberAggregateView();
      return;
    }

    const scale = view?.scale ?? TILE_SIZE * 2 ** zoom;
    const kernelCss =
      this.options.field === "value" ? this.#geographicRadiusCss(zoom) : this.#kernelAt(zoom).radiusCss;
    const factor = this.options.aggregateCellFactor;
    const intendedCellMerc = Math.max(1e-7, (kernelCss * factor) / scale);
    // Cells must stay inside the kernel. Enlarging to a global 24k cap turns the
    // field into a cluster grid (one red disc per cell) — that is not a heatmap.
    const maxCellMerc = Math.max(intendedCellMerc, (kernelCss * 0.32) / scale);
    const maxDraw = 16_000;

    let src = this.data;
    let count = this._count;
    if (view) {
      count = this.#cullSource(view.scale, view.originX, view.originY, view.cssW, view.cssH, view.padCss);
      src = this._viewBuf;
    }

    if (count === 0) {
      this.#adoptSourceField(src, 0, zoomKey, viewKey, 0);
      this.#rememberAggregateView(view);
      return;
    }

    // Value field: the raster already averages every sensor. Collapsing to
    // city-sized centroids first paints one tile per hub, not the real field.
    if (this.options.field === "value") {
      this.#adoptSourceField(src, count, zoomKey, viewKey, 0);
      this.#rememberAggregateView(view);
      return;
    }

    // Fine cells buy nothing. Density mode may splat a drawable viewport raw.
    if (intendedCellMerc * scale < 1.25 || (view && count <= maxDraw)) {
      this.#adoptSourceField(src, count, zoomKey, viewKey, 0);
      this.#rememberAggregateView(view);
      return;
    }

    let cellMerc = intendedCellMerc;
    let slots = this.#aggregateIntoBuffers(cellMerc, src, count);
    if (slots > maxDraw && cellMerc < maxCellMerc) {
      cellMerc = Math.min(maxCellMerc, cellMerc * Math.sqrt(slots / maxDraw));
      this._aggIndex.clear();
      slots = this.#aggregateIntoBuffers(cellMerc, src, count);
    }

    if (slots > maxDraw) {
      // Still too many: stride-sample the visible points. Keeps a noisy KDE,
      // not a handful of cluster centroids.
      this.#sampleSourceField(src, count, maxDraw, zoomKey, viewKey);
      this.#rememberAggregateView(view);
      return;
    }

    const need = slots * 3;
    if (this._aggBuf.length < need) this._aggBuf = new Float32Array(need);
    const out = this._aggBuf;
    const areaCorr = cellMerc > intendedCellMerc * 1.02 ? (intendedCellMerc / cellMerc) ** 2 : 1;
    let write = 0;
    for (let i = 0; i < slots; i++) {
      const w = this._aggSumW[i];
      const invW = w > 0 ? 1 / w : 0;
      out[write++] = this._aggSumX[i] * invW;
      out[write++] = this._aggSumY[i] * invW;
      out[write++] = w * areaCorr;
    }
    this._aggIndex.clear();
    this._aggData = out.subarray(0, write);
    this._aggCount = write / 3;
    this._aggZoom = zoomKey;
    this._aggViewKey = viewKey;
    this._aggCellMerc = cellMerc;
    this.#rememberAggregateView(view);
  }

  #rememberAggregateView(
    view?: { scale: number; originX: number; originY: number; cssW: number; cssH: number; padCss: number }
  ): void {
    if (!view) {
      this._aggCoversWorld = true;
      return;
    }
    const scale = Math.max(view.scale, 1e-9);
    this._aggCoversWorld = false;
    this._aggMinMx = (view.originX - view.padCss) / scale;
    this._aggMaxMx = (view.originX + view.cssW + view.padCss) / scale;
    this._aggMinMy = (view.originY - view.padCss) / scale;
    this._aggMaxMy = (view.originY + view.cssH + view.padCss) / scale;
  }

  #aggregateCoversView(
    view?: { scale: number; originX: number; originY: number; cssW: number; cssH: number; padCss: number }
  ): boolean {
    if (this._aggCoversWorld) return true;
    if (!view) return false;
    const scale = Math.max(view.scale, 1e-9);
    const minMx = (view.originX - view.padCss) / scale;
    const maxMx = (view.originX + view.cssW + view.padCss) / scale;
    const minMy = (view.originY - view.padCss) / scale;
    const maxMy = (view.originY + view.cssH + view.padCss) / scale;
    const slackX = Math.max(1e-7, (this._aggMaxMx - this._aggMinMx) * 0.03);
    const slackY = Math.max(1e-7, (this._aggMaxMy - this._aggMinMy) * 0.03);
    return (
      minMx >= this._aggMinMx - slackX &&
      maxMx <= this._aggMaxMx + slackX &&
      minMy >= this._aggMinMy - slackY &&
      maxMy <= this._aggMaxMy + slackY
    );
  }

  #adoptSourceField(
    src: Float32Array,
    count: number,
    zoomKey: number,
    viewKey: string,
    cellMerc: number
  ): void {
    const need = count * 3;
    if (src === this.data && count === this._count) {
      this._aggData = this.data;
    } else {
      if (this._aggBuf.length < need) this._aggBuf = new Float32Array(Math.max(need, 12));
      this._aggBuf.set(src.subarray(0, need));
      this._aggData = this._aggBuf.subarray(0, need);
    }
    this._aggCount = count;
    this._aggZoom = zoomKey;
    this._aggViewKey = viewKey;
    this._aggCellMerc = cellMerc;
  }

  #sampleSourceField(src: Float32Array, count: number, maxKeep: number, zoomKey: number, viewKey: string): void {
    const stride = Math.max(1, Math.ceil(count / maxKeep));
    const keep = Math.ceil(count / stride);
    const need = keep * 3;
    if (this._aggBuf.length < need) this._aggBuf = new Float32Array(need);
    const out = this._aggBuf;
    const valueField = this.options.field === "value";
    const weight = valueField ? 1 : stride;
    let write = 0;
    for (let i = 0; i < count; i += stride) {
      const o = i * 3;
      out[write++] = src[o];
      out[write++] = src[o + 1];
      out[write++] = src[o + 2] * weight;
    }
    this._aggData = out.subarray(0, write);
    this._aggCount = write / 3;
    this._aggZoom = zoomKey;
    this._aggViewKey = viewKey;
    this._aggCellMerc = 0;
  }

  #cullSource(
    scale: number,
    originX: number,
    originY: number,
    cssW: number,
    cssH: number,
    padCss: number
  ): number {
    const src = this.data;
    const need = this._count * 3;
    if (this._viewBuf.length < need) this._viewBuf = new Float32Array(Math.max(need, 64));
    const out = this._viewBuf;
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
    return write / 3;
  }

  /** Numeric aggregation — no per-cell object literals (avoids GC blow-ups). */
  #aggregateIntoBuffers(cellMerc: number, src: Float32Array, count: number): number {
    const inv = 1 / cellMerc;
    const strideY = 1_048_576;
    const index = this._aggIndex;
    index.clear();
    let n = 0;
    if (this._aggSumX.length < count) {
      this._aggSumX = new Float64Array(count);
      this._aggSumY = new Float64Array(count);
      this._aggSumW = new Float64Array(count);
      this._aggSumN = new Float64Array(count);
    }
    const sumX = this._aggSumX;
    const sumY = this._aggSumY;
    const sumW = this._aggSumW;
    const sumN = this._aggSumN;
    const valueField = this.options.field === "value";
    const end = count * 3;

    for (let i = 0; i < end; i += 3) {
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
        if (valueField) {
          sumX[slot] = mx;
          sumY[slot] = my;
          sumW[slot] = w;
          sumN[slot] = 1;
        } else {
          sumX[slot] = mx * w;
          sumY[slot] = my * w;
          sumW[slot] = w;
          sumN[slot] = 1;
        }
      } else if (valueField) {
        sumX[slot] += mx;
        sumY[slot] += my;
        sumW[slot] += w;
        sumN[slot] += 1;
      } else {
        sumX[slot] += mx * w;
        sumY[slot] += my * w;
        sumW[slot] += w;
        sumN[slot] += 1;
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

  #renderWebGL(dpr: number, cssW: number, cssH: number, pad: number): void {
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
    const valueField = this.options.field === "value";
    const kernel = this.#kernelAt(zoom, dpr);
    const radiusCss = valueField ? this.#geographicRadiusCss(zoom) : kernel.radiusCss;
    const pointSize = Math.min(this._maxPointSize, Math.max(1, radiusCss * dpr * 2));
    const zoomIntensity = valueField
      ? 1
      : (this.options.intensity / Math.max(this.options.max, 1e-6)) * kernel.intensityScale;
    const originX = map.pixelOrigin.x - pad;
    const originY = map.pixelOrigin.y - pad;
    const drawW = cssW + pad * 2;
    const drawH = cssH + pad * 2;
    const padCss = pad + pointSize / (2 * Math.max(dpr, 1e-6));

    this.#ensureAggregate(zoom, {
      scale,
      originX,
      originY,
      cssW: drawW,
      cssH: drawH,
      padCss
    });
    this.#cullToDraw(scale, originX, originY, drawW, drawH, padCss);

    const preNormalized = valueField && this.#rasterizeValueField(gl, drawW, drawH, originX, originY, scale, radiusCss);

    if (!preNormalized) {
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
        gl.uniform2f(intensityLocs.uOrigin, originX, originY);
        gl.uniform2f(intensityLocs.uResolution, width, height);
        gl.uniform1f(intensityLocs.uDpr, dpr);
        gl.uniform1f(intensityLocs.uPointSize, pointSize);
        gl.uniform1f(intensityLocs.uIntensity, zoomIntensity);
        gl.uniform1f(intensityLocs.uValueField, 0);
        gl.uniform1f(intensityLocs.uAccum, 0.035);

        gl.disable(gl.DEPTH_TEST);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.drawArrays(gl.POINTS, 0, this._drawn);
        gl.disableVertexAttribArray(intensityLocs.aMerc);
        gl.disableVertexAttribArray(intensityLocs.aWeight);
      }
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
    gl.uniform1f(colorizeLocs.uValueField, valueField ? 1 : 0);
    gl.uniform1f(colorizeLocs.uMax, Math.max(this.options.max, 1e-6));
    gl.uniform1f(colorizeLocs.uPreNormalized, preNormalized ? 1 : 0);

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
    this._viewBuf = new Float32Array(0);
    this._drawBuf = new Float32Array(0);
    this._drawData = new Float32Array(0);
    this._aggSumX = new Float64Array(0);
    this._aggSumY = new Float64Array(0);
    this._aggSumW = new Float64Array(0);
    this._aggSumN = new Float64Array(0);
    this._gridSumW = new Float64Array(0);
    this._gridSumV = new Float64Array(0);
    this._gridMaxV = new Float64Array(0);
    this._gridHotW = new Float64Array(0);
    this._gridRgba = new Uint8Array(0);
    this._aggIndex.clear();
    this._count = 0;
    this._aggCount = 0;
    this._drawn = 0;
    this._aggZoom = Number.NaN;
    this._aggViewKey = "";
    this._aggCellMerc = 0;
    this._aggCoversWorld = false;
    this._drawSignature = "";
    this._bufferDirty = true;
    this._packedMerc = null;
    this._packedN = -1;
    this._packedHasWeights = false;
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
