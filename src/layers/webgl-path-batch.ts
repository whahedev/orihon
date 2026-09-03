import { createEl, listenTap } from "../dom.js";
import { nonNegativeFinite, rejectLegacyUnit } from "../units.js";
import { cameraWarpCss } from "../camera.js";
import { TILE_SIZE, LatLngBounds, latLng, projectMercator01, type LatLngLike } from "../geo.js";
import { InteractiveLayer } from "../interactive-layer.js";
import { type LayerOptions, type QueryHit, type ResolvedQueryOptions } from "../layer.js";
import type { Orihon } from "../map.js";
import { assertMercator } from "../crs.js";
import { compileShader, linkProgram, parseCssColor, type RgbColor } from "../webgl-utils.js";
import { ringContainsPoint, segmentDistance, type PathOptions } from "./vector.js";
import { rejectStyleAliases } from "../style-contract.js";

/** Retained per path so the batch can answer a click; the GPU buffer has no feature boundaries. */
interface WebGLPathRecord {
  rings: LatLngLike[][];
  closed: boolean;
  filled: boolean;
  strokeWidth: number;
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
  feature?: unknown;
}

export interface WebGLPathBatchOptions extends LayerOptions, PathOptions {
  className?: string;
  maxDpr?: number;
  /** Fall back to Canvas 2D if WebGL init fails. Default true. */
  fallbackCanvas?: boolean;
  /** Minimum time between exact GPU camera redraws while moving. Default 250 ms; 0 redraws every frame. */
  cameraRedrawIntervalMs?: number;
  /** Idle time before the final exact GPU camera redraw. Default 120 ms. */
  cameraSettleDelayMs?: number;
}

type ResolvedOptions = Required<
  Pick<
    WebGLPathBatchOptions,
    | "pane"
    | "stroke"
    | "strokeWidth"
    | "strokeOpacity"
    | "maxDpr"
    | "fallbackCanvas"
    | "className"
    | "cameraRedrawIntervalMs"
    | "cameraSettleDelayMs"
  >
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

type InstancedExt = {
  vertexAttribDivisorANGLE(index: number, divisor: number): void;
  drawArraysInstancedANGLE(mode: number, first: number, count: number, primcount: number): void;
};

/**
 * GPU stroked polylines: mercator segments uploaded once, camera via uniforms.
 * Uses ANGLE_instanced_arrays when available (one instance per segment).
 */
export class WebGLPathBatch extends InteractiveLayer<ResolvedOptions> {
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
  private _records: WebGLPathRecord[] = [];
  private _interactionUnsub: (() => void) | null = null;
  private _segmentCount = 0;
  private _bufferDirty = true;
  private _gpuBytes = 0;
  private _cssW = 0;
  private _cssH = 0;
  private _attribsBound = false;
  private _drawnZoom = Number.NaN;
  private _drawnOriginX = 0;
  private _drawnOriginY = 0;
  private _hasDrawn = false;
  private _forceGpu = false;
  private _lastGpuMs = 0;
  private _redrawFrame = 0;
  private _settleTimer: ReturnType<typeof setTimeout> | null = null;
  private color: RgbColor;
  private _minLat = Number.POSITIVE_INFINITY;
  private _maxLat = Number.NEGATIVE_INFINITY;
  private _minLng = Number.POSITIVE_INFINITY;
  private _maxLng = Number.NEGATIVE_INFINITY;

  constructor(options: WebGLPathBatchOptions = {}) {
    rejectStyleAliases(options, "line");
    super({
      pane: "overlay",
      className: "oh-webgl-path-batch",
      stroke: "#0f766e",
      strokeWidth: 1.5,
      strokeOpacity: 0.7,
      maxDpr: 1,
      fallbackCanvas: true,
      cameraRedrawIntervalMs: 250,
      cameraSettleDelayMs: 120,
      interactive: false,
      ...options
    } as ResolvedOptions);
    rejectLegacyUnit(options, "cameraRedrawInterval", "cameraRedrawIntervalMs");
    rejectLegacyUnit(options, "cameraSettleDelay", "cameraSettleDelayMs");
    nonNegativeFinite(this.options.cameraRedrawIntervalMs, "cameraRedrawIntervalMs");
    nonNegativeFinite(this.options.cameraSettleDelayMs, "cameraSettleDelayMs");
    this.color = parseCssColor(String(this.options.stroke ?? "#0f766e"), { r: 15, g: 118, b: 110 });
  }

  get count(): number {
    return this._segmentCount;
  }

  /**
   * Hit test over the paths this batch drew.
   *
   * The GPU knows nothing about features, so the test runs on the retained records: reject on the
   * box, then the same even-odd and stroke-distance rules the SVG and canvas paths use, so a
   * consumer reads `hit.feature` the same way whatever renderer the layer happens to have picked.
   */
  queryHit(target: { x: number; y: number }, options: ResolvedQueryOptions): QueryHit | null {
    if (!this.map || !this.options.interactive) return null;
    for (let index = this._records.length - 1; index >= 0; index -= 1) {
      const record = this._records[index];
      const tolerance = options.tolerance + record.strokeWidth / 2;
      const a = this.map.latLngToContainerPoint({ lat: record.minLat, lng: record.minLng });
      const b = this.map.latLngToContainerPoint({ lat: record.maxLat, lng: record.maxLng });
      const padding = tolerance + 1;
      if (target.x < Math.min(a.x, b.x) - padding || target.x > Math.max(a.x, b.x) + padding
        || target.y < Math.min(a.y, b.y) - padding || target.y > Math.max(a.y, b.y) + padding) continue;

      const projected = record.rings.map((ring) => ring.map((value) => this.map!.latLngToContainerPoint(value)));
      let inside = false;
      if (record.filled) for (const ring of projected) if (ringContainsPoint(target, ring)) inside = !inside;
      const onStroke = projected.some((ring) => {
        const segments = record.closed ? ring.length : ring.length - 1;
        for (let segment = 0; segment < segments; segment += 1) {
          if (segmentDistance(target, ring[segment], ring[(segment + 1) % ring.length]) <= tolerance) return true;
        }
        return false;
      });
      if (!inside && !onStroke) continue;
      const id = (record.feature as { id?: string | number } | undefined)?.id;
      return {
        layer: this,
        latlng: this.map.containerPointToLatLng(target),
        source: "webgl",
        index,
        ...(id !== undefined ? { id } : {}),
        feature: record.feature
      };
    }
    return null;
  }

  getBounds(): LatLngBounds {
    const bounds = new LatLngBounds();
    if (!Number.isFinite(this._minLat)) return bounds;
    bounds.extend({ lat: this._minLat, lng: this._minLng });
    bounds.extend({ lat: this._maxLat, lng: this._maxLng });
    return bounds;
  }

  clearPaths(): this {
    this._segBuf = new Float32Array(0);
    this._records = [];
    this._segmentCount = 0;
    this._bufferDirty = true;
    this._minLat = Number.POSITIVE_INFINITY;
    this._maxLat = Number.NEGATIVE_INFINITY;
    this._minLng = Number.POSITIVE_INFINITY;
    this._maxLng = Number.NEGATIVE_INFINITY;
    this._drawnZoom = Number.NaN;
    this._forceGpu = true;
    this.render();
    return this;
  }

  addPath(rings: LatLngLike[][], closed = false, style: PathOptions = {}, feature?: unknown): this {
    if (style.stroke) this.color = parseCssColor(String(style.stroke), { r: 15, g: 118, b: 110 });
    if (style.strokeWidth != null) this.writableOptions.strokeWidth = style.strokeWidth;
    if (style.strokeOpacity != null) this.writableOptions.strokeOpacity = style.strokeOpacity;

    // The GPU buffer is one flat run of segments with no feature boundaries in it, so hit testing
    // needs its own record. Kept beside the buffer rather than inside it: the draw path stays
    // untouched, and the cost is a reference to the rings plus a box per path.
    const record: WebGLPathRecord = {
      rings,
      closed,
      filled: closed && (style.fill ?? this.options.fill) !== "none",
      strokeWidth: Number(style.strokeWidth ?? this.options.strokeWidth ?? 1.5),
      minLat: Number.POSITIVE_INFINITY,
      maxLat: Number.NEGATIVE_INFINITY,
      minLng: Number.POSITIVE_INFINITY,
      maxLng: Number.NEGATIVE_INFINITY,
      feature
    };

    for (const ring of rings) {
      if (ring.length < 2) continue;
      const segments = ring.length - 1;
      this.#ensureCapacity((this._segmentCount + segments) * 4);
      let write = this._segmentCount * 4;
      const buf = this._segBuf;
      let prevX = 0;
      let prevY = 0;
      for (let i = 0; i < ring.length; i++) {
        const p = latLng(ring[i]);
        const m = projectMercator01(p.lat, p.lng);
        if (p.lat < this._minLat) this._minLat = p.lat;
        if (p.lat > this._maxLat) this._maxLat = p.lat;
        if (p.lng < this._minLng) this._minLng = p.lng;
        if (p.lng > this._maxLng) this._maxLng = p.lng;
        if (p.lat < record.minLat) record.minLat = p.lat;
        if (p.lat > record.maxLat) record.maxLat = p.lat;
        if (p.lng < record.minLng) record.minLng = p.lng;
        if (p.lng > record.maxLng) record.maxLng = p.lng;
        if (i > 0) {
          buf[write++] = prevX;
          buf[write++] = prevY;
          buf[write++] = m.x;
          buf[write++] = m.y;
        }
        prevX = m.x;
        prevY = m.y;
      }
      this._segmentCount = write / 4;
    }
    if (Number.isFinite(record.minLat)) this._records.push(record);
    this._bufferDirty = true;
    this._drawnZoom = Number.NaN;
    this._forceGpu = true;
    if (this.map) this.#scheduleRedraw();
    return this;
  }

  override onAdd(map: Orihon): void {
    assertMercator(map.crs);
    super.onAdd(map);
    const pane = this.getPane();
    if (!pane) throw new Error(`Orihon pane not found: ${this.options.pane}`);
    this.canvas = createEl("canvas", this.options.className ?? "oh-webgl-path-batch", pane);
    this.canvas.style.position = "absolute";
    this.canvas.style.left = "0";
    this.canvas.style.top = "0";
    this.canvas.style.pointerEvents = this.options.interactive ? "auto" : "none";
    this.canvas.style.willChange = "transform";
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
      this.canvas.style.pointerEvents = this.options.interactive ? "auto" : "none";
      this.canvas.style.willChange = "transform";
      this.renderer = "canvas";
      this.gl = null;
    } else {
      this.renderer = "none";
    }
    this.#syncInteraction();
    this.render();
  }

  /**
   * Click delivery for the batch.
   *
   * Mirrors `CanvasPathBatch`: one tap listener on the canvas, one `queryHit`, and a `click` event
   * carrying the feature — which is what lets `bindPopup` on a GeoJSON layer work in this renderer
   * at all. Nothing is attached when the layer is not interactive.
   */
  #syncInteraction(): void {
    this._interactionUnsub?.();
    this._interactionUnsub = null;
    if (!this.canvas) return;
    // Without this class the map takes pointer capture on pointerdown, which retargets pointerup
    // and click to the container — the tap below would never fire.
    this.canvas.classList.toggle("oh-interactive", this.options.interactive === true);
    if (!this.options.interactive) return;
    this._interactionUnsub = listenTap(this.canvas, (event) => {
      if (!this.map || !this.canvas) return;
      const rect = this.canvas.getBoundingClientRect();
      const hit = this.queryHit(
        { x: event.clientX - rect.left, y: event.clientY - rect.top },
        { tolerance: 8, layers: [this], pane: "", limit: 1 }
      );
      if (!hit) return;
      event.stopPropagation();
      this.emit("click", {
        originalEvent: event,
        latlng: hit.latlng,
        feature: hit.feature,
        index: hit.index
      });
    });
  }

  override onRemove(): void {
    this._interactionUnsub?.();
    this._interactionUnsub = null;
    if (this._redrawFrame && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this._redrawFrame);
      this._redrawFrame = 0;
    }
    this.#clearSettleTimer();
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
    this._hasDrawn = false;
    this._forceGpu = false;
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
      this._hasDrawn = false;
      this._forceGpu = true;
    }
    if (this.renderer === "webgl") {
      const zoom = this.map.zoom;
      const ox = this.map.pixelOrigin.x;
      const oy = this.map.pixelOrigin.y;
      const cameraChanged = zoom !== this._drawnZoom || ox !== this._drawnOriginX || oy !== this._drawnOriginY;
      if (!cameraChanged && this._hasDrawn && !this._bufferDirty && !this._forceGpu) {
        this.canvas.style.transform = "";
        return;
      }
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      const baseInterval = Math.max(0, Number(this.options.cameraRedrawIntervalMs) || 0);
      // A long submit can itself delay the next rAF beyond the base interval.
      // Scale the cadence with batch size so a heavy layer gets cheap camera
      // warps between exact frames instead of immediately submitting again.
      const interval = baseInterval === 0
        ? 0
        : baseInterval * Math.max(1, this._segmentCount / 15_000);
      const canWarp = this._hasDrawn && Number.isFinite(this._drawnZoom) && !this._bufferDirty;
      const gpuDue =
        this._forceGpu ||
        !canWarp ||
        interval === 0 ||
        now - this._lastGpuMs >= interval;
      if (!gpuDue) {
        this.canvas.style.transformOrigin = "0 0";
        this.canvas.style.transform = cameraWarpCss(
          { x: this._drawnOriginX, y: this._drawnOriginY },
          this._drawnZoom,
          { x: ox, y: oy },
          zoom
        );
        this.#scheduleSettledGpu();
        return;
      }
      this.canvas.style.transform = "";
      this.#renderWebGL(dpr);
      this._drawnZoom = zoom;
      this._drawnOriginX = ox;
      this._drawnOriginY = oy;
      this._hasDrawn = true;
      this._forceGpu = false;
      this._lastGpuMs = typeof performance !== "undefined" ? performance.now() : Date.now();
      this.#clearSettleTimer();
    } else {
      this.canvas.style.transform = "";
      this.#renderCanvas(dpr);
    }
  }

  #scheduleRedraw(): void {
    if (this._redrawFrame) return;
    if (typeof requestAnimationFrame !== "function") {
      this.render();
      return;
    }
    this._redrawFrame = requestAnimationFrame(() => {
      this._redrawFrame = 0;
      this.render();
    });
  }

  #scheduleSettledGpu(): void {
    this.#clearSettleTimer();
    const delay = Math.max(0, Number(this.options.cameraSettleDelayMs) || 0);
    this._settleTimer = setTimeout(() => {
      this._settleTimer = null;
      this._forceGpu = true;
      this.#scheduleRedraw();
    }, delay);
  }

  #clearSettleTimer(): void {
    if (this._settleTimer != null) {
      clearTimeout(this._settleTimer);
      this._settleTimer = null;
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
    const program = linkProgram(gl, vertex, fragment);
    if (!program) return false;
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
    if (!gl || !locs || !ext || !this.program || !map) return;

    this.#uploadIfNeeded();
    gl.viewport(0, 0, this.canvas!.width, this.canvas!.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    if (!this._segmentCount) return;
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
    const scale = TILE_SIZE * 2 ** this.map.zoom;
    const ox = this.map.pixelOrigin.x;
    const oy = this.map.pixelOrigin.y;
    const data = this._segBuf;
    ctx.beginPath();
    for (let i = 0; i < this._segmentCount * 4; i += 4) {
      ctx.moveTo(data[i] * scale - ox, data[i + 1] * scale - oy);
      ctx.lineTo(data[i + 2] * scale - ox, data[i + 3] * scale - oy);
    }
    ctx.stroke();
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
