import { createEl, listen, listenTap } from "../dom.js";
import { cameraWarpCoversViewport } from "../camera.js";
import { TILE_SIZE, latLng, projectMercator01, type LatLngLike, type Point } from "../geo.js";
import { InteractiveLayer } from "../interactive-layer.js";
import { type LayerOptions, type QueryHit, type ResolvedQueryOptions } from "../layer.js";
import type { Orihon } from "../map.js";
import { assertMercator } from "../crs.js";
import type { OverlayContent, PopupOptions } from "../overlays/div-overlay.js";
import { SpatialGridIndex } from "../services/spatial-grid-index.js";
import {
  isAsyncIterable,
  resolveAsyncBatchOptions,
  throwIfAsyncAborted,
  yieldAsyncBatch,
  type AsyncBatchOptions
} from "../services/async-batch.js";
import { compileShader, linkProgram, parseCssColor, type RgbColor } from "../webgl-utils.js";

export type WebGLPointInput = LatLngLike | { coordinates?: LatLngLike; latlng?: LatLngLike; lat?: number; lng?: number };

export interface WebGLPointDataOptions {
  /** Interleaved RGBA floats in 0..1, length = pointCount * 4. */
  colors?: ArrayLike<number> | null;
  /** Per-point sizes in CSS pixels, length = pointCount. */
  sizes?: ArrayLike<number> | null;
  /**
   * Take ownership of `latlng` / `merc64` typed arrays (no copy).
   * Callers must not reuse those buffers after `setPackedData`.
   */
  adopt?: boolean;
}

export interface WebGLPointAsyncDataOptions extends WebGLPointDataOptions, AsyncBatchOptions {}

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
  aSize: number;
  uScale: WebGLUniformLocation | null;
  uOrigin: WebGLUniformLocation | null;
  uResolution: WebGLUniformLocation | null;
  uDpr: WebGLUniformLocation | null;
  uPointSize: WebGLUniformLocation | null;
  uColor: WebGLUniformLocation | null;
  uUseVertexColor: WebGLUniformLocation | null;
  uUseVertexSize: WebGLUniformLocation | null;
  uCenter: WebGLUniformLocation | null;
  uRotate: WebGLUniformLocation | null;
  uPitch: WebGLUniformLocation | null;
  uRound: WebGLUniformLocation | null;
}

export interface WebGLPointLayerStats {
  points: number;
  rendered: number;
  renderer: "webgl" | "canvas" | "none";
  bufferBytes: number;
  vertexColors: boolean;
  vertexSizes: boolean;
  /** Spatial pick-index size; 0 when `interactive` is false. */
  pickIndex: number;
}

export interface WebGLPointEventMap {
  click: { originalEvent: MouseEvent | PointerEvent; latlng: LatLngLike; containerPoint: { x: number; y: number }; index: number; data: WebGLPointInput | undefined };
  hover: { originalEvent: MouseEvent; latlng: LatLngLike | null; containerPoint: { x: number; y: number } | null; index: number; data: WebGLPointInput | null | undefined };
}

export class WebGLPointLayer extends InteractiveLayer<ResolvedWebGLPointLayerOptions, WebGLPointEventMap> {
  canvas: HTMLCanvasElement | null = null;
  gl: WebGLRenderingContext | null = null;
  program: WebGLProgram | null = null;
  buffer: WebGLBuffer | null = null;
  colorBuffer: WebGLBuffer | null = null;
  sizeBuffer: WebGLBuffer | null = null;
  /** Packed lat/lng pairs for hit-testing and canvas fallback. */
  points: Float32Array = new Float32Array();
  /**
   * GPU upload buffer: mercator relative to the current camera ref (float32).
   * Absolute world mercator lives in `_merc64` (float64) to avoid high-zoom collapse.
   */
  mercator: Float32Array = new Float32Array();
  /** Interleaved RGBA bytes (0..255) when per-point colors are enabled. */
  colors: Uint8Array = new Uint8Array();
  /** Per-point sizes in CSS pixels when vertex sizes are enabled. */
  sizes: Float32Array = new Float32Array();
  pointData: WebGLPointInput[] = [];
  renderer: "webgl" | "canvas" | "none" = "none";
  readonly color: RgbColor;
  private _interactionUnsub: (() => void) | null = null;
  private _lastRendered = 0;
  private _glLocations: GLLocations | null = null;
  private _bufferDirty = true;
  private _colorDirty = true;
  private _sizeDirty = true;
  private _useVertexColor = false;
  private _useVertexSize = false;
  private _scratch: Float32Array = new Float32Array(0);
  private _scratchColors: Float32Array = new Float32Array(0);
  private _latlngBuf = new Float32Array(0);
  private _merc64 = new Float64Array(0);
  private _drawMerc = new Float32Array(0);
  private _colorBuf = new Uint8Array(0);
  private _colorFloat = new Float32Array(0);
  private _sizeBuf = new Float32Array(0);
  /** Reused sorted GPU-slot scratch for batched style updates. */
  private _stylePatchIndexScratch = new Uint32Array(0);
  private _gpuMercBytes = 0;
  private _gpuColorBytes = 0;
  private _gpuSizeBytes = 0;
  private _refMx = 0;
  private _refMy = 0;
  private _refZoom = Number.NaN;
  private _refOriginX = 0;
  private _refOriginY = 0;
  private _pickIndex = new SpatialGridIndex<number, number>(1);
  private _maxVertexSize = 0;
  /** True when `_latlngBuf` / `_merc64` were adopted from the caller (may be shared). */
  private _packedAdopted = false;
  private _hidden = false;
  private _forceGpu = true;
  private _hasPainted = false;
  private _paintedZoom = Number.NaN;
  private _paintedOriginX = 0;
  private _paintedOriginY = 0;
  private _paintedPad = 0;
  private _lastGpuMs = 0;
  private _settleTimer: ReturnType<typeof setTimeout> | null = null;

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
    this.canvas.style.willChange = "transform";
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
    this.#clearSettleTimer();
    if (this.gl) {
      try {
        if (this.buffer) this.gl.deleteBuffer(this.buffer);
        if (this.colorBuffer) this.gl.deleteBuffer(this.colorBuffer);
        if (this.sizeBuffer) this.gl.deleteBuffer(this.sizeBuffer);
        if (this.program) this.gl.deleteProgram(this.program);
        this.gl.getExtension("WEBGL_lose_context")?.loseContext();
      } catch {
        /* context may already be lost */
      }
    }
    this.buffer = null;
    this.colorBuffer = null;
    this.sizeBuffer = null;
    this.program = null;
    this.gl = null;
    this._glLocations = null;
    this._gpuMercBytes = 0;
    this._gpuColorBytes = 0;
    this._gpuSizeBytes = 0;
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
    this.colors = new Uint8Array();
    this.sizes = new Float32Array();
    this._merc64 = new Float64Array(0);
    this._drawMerc = new Float32Array(0);
    this._colorBuf = new Uint8Array(0);
    this._colorFloat = new Float32Array(0);
    this._sizeBuf = new Float32Array(0);
    this.pointData = [];
    this._latlngBuf = new Float32Array(0);
    this._scratch = new Float32Array(0);
    this._scratchColors = new Float32Array(0);
    this._useVertexColor = false;
    this._useVertexSize = false;
    this._maxVertexSize = 0;
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
      // slice() copied the whole array even when nothing had been filtered out, which is the usual
      // case. Truncating in place costs nothing and keeps the same array when every point was kept.
      if (!keepData) this.pointData = [];
      else {
        if (kept !== data.length) data.length = kept;
        this.pointData = data;
      }
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
    this.#applySizes(options.sizes, keptCount);
    this.#rebuildPickIndex();
    this._refZoom = Number.NaN;
    this._bufferDirty = true;
    this._forceGpu = true;
    this.render();
    return this;
  }

  /**
   * Project and pack a large point iterable across bounded main-thread tasks,
   * then replace the live GPU dataset atomically.
   */
  async setDataAsync(
    points: Iterable<WebGLPointInput> | AsyncIterable<WebGLPointInput>,
    options: WebGLPointAsyncDataOptions = {}
  ): Promise<this> {
    const resolved = resolveAsyncBatchOptions(options, 50_000);
    const total = Array.isArray(points) ? points.length : null;
    throwIfAsyncAborted(resolved.signal);

    // Preserve source objects for the small interactive path just like setData().
    if (Array.isArray(points) && this.options.interactive && points.length <= 40_000) {
      this.setData(points, options);
      resolved.onProgress?.(points.length, points.length);
      return this;
    }

    let latlngBuffer = total == null ? null : new Float32Array(total * 2);
    let mercatorBuffer = total == null ? null : new Float64Array(total * 2);
    const latlngValues: number[] = [];
    const mercatorValues: number[] = [];
    let processed = 0;
    let write = 0;
    const append = (item: WebGLPointInput): void => {
      const next = normalizePoint(item);
      if (!next) return;
      const mercator = projectMercator01(next.lat, next.lng);
      if (latlngBuffer && mercatorBuffer) {
        latlngBuffer[write] = next.lat;
        latlngBuffer[write + 1] = next.lng;
        mercatorBuffer[write] = mercator.x;
        mercatorBuffer[write + 1] = mercator.y;
      } else {
        latlngValues.push(next.lat, next.lng);
        mercatorValues.push(mercator.x, mercator.y);
      }
      write += 2;
    };
    const checkpoint = async (final: boolean): Promise<void> => {
      resolved.onProgress?.(processed, total);
      if (!final) await yieldAsyncBatch(resolved.yieldMode);
      throwIfAsyncAborted(resolved.signal);
    };

    if (Array.isArray(points)) {
      for (let index = 0; index < points.length; index++) {
        append(points[index]);
        processed++;
        if (processed % resolved.chunkSize === 0) await checkpoint(index === points.length - 1);
      }
    } else if (isAsyncIterable<WebGLPointInput>(points)) {
      for await (const item of points) {
        append(item);
        processed++;
        if (processed % resolved.chunkSize === 0) await checkpoint(false);
      }
    } else {
      for (const item of points) {
        append(item);
        processed++;
        if (processed % resolved.chunkSize === 0) await checkpoint(false);
      }
    }
    if (processed % resolved.chunkSize !== 0) await checkpoint(true);

    if (!latlngBuffer || !mercatorBuffer) {
      latlngBuffer = new Float32Array(latlngValues);
      mercatorBuffer = new Float64Array(mercatorValues);
    } else if (write !== latlngBuffer.length) {
      latlngBuffer = latlngBuffer.slice(0, write);
      mercatorBuffer = mercatorBuffer.slice(0, write);
    }
    this.setPackedData(latlngBuffer, mercatorBuffer, {
      colors: options.colors,
      sizes: options.sizes,
      adopt: true
    });
    return this;
  }

  /** Replace per-point RGBA (0..1). Pass null to fall back to uniform `color`. */
  setColors(colors: ArrayLike<number> | null): this {
    this.#applyColors(colors, this.points.length / 2);
    this.render();
    return this;
  }

  /** Replace per-point sizes in CSS pixels. Pass null to fall back to uniform `pointSize`. */
  setSizes(sizes: ArrayLike<number> | null): this {
    this.#applySizes(sizes, this.points.length / 2);
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
    if (this.options.interactive) this._pickIndex.set(index, { lat: lat, lng: lng }, index);
    if (this._drawMerc.length >= i + 2 && Number.isFinite(this._refMx)) {
      this._drawMerc[i] = m.x - this._refMx;
      this._drawMerc[i + 1] = m.y - this._refMy;
      this.#uploadMercatorRange(i, 2);
    } else {
      this._bufferDirty = true;
    }
    // Moving a point has to ask for a repaint, exactly as changing its colour or size does.
    // Without this the new coordinates sit in the GPU buffer and `render()` takes its
    // camera-unchanged shortcut, so positions only appeared the next time the camera moved.
    this.#requestGpuPaint();
    return this;
  }

  /** Patch one vertex RGBA (0..1) without rebuilding the full color buffer. */
  patchColor(index: number, rgba: ArrayLike<number>): this {
    if (!this._useVertexColor || index < 0 || index * 4 + 3 >= this.colors.length) return this;
    const o = index * 4;
    this._colorBuf[o] = floatToByte(Number(rgba[0]) || 0);
    this._colorBuf[o + 1] = floatToByte(Number(rgba[1]) || 0);
    this._colorBuf[o + 2] = floatToByte(Number(rgba[2]) || 0);
    this._colorBuf[o + 3] = floatToByte(Number(rgba[3]) || this.options.opacity);
    this.#uploadColorRange(o, 4);
    this.#requestGpuPaint();
    return this;
  }

  /** Patch one vertex size without rebuilding coordinates or color buffers. */
  patchSize(index: number, size: number): this {
    if (!this._useVertexSize || index < 0 || index >= this.sizes.length) return this;
    const next = normalizePointSize(size, this.options.pointSize);
    const prev = this._sizeBuf[index];
    if (next === prev) return this;
    this._sizeBuf[index] = next;
    if (next > this._maxVertexSize) {
      this._maxVertexSize = next;
    } else if (prev === this._maxVertexSize && next < prev) {
      this.#recomputeMaxVertexSize();
    }
    this.#uploadSizeRange(index, 1);
    this.#requestGpuPaint();
    return this;
  }

  /**
   * Patch many vertex colors/sizes in one pass. GPU writes are merged into
   * contiguous ranges and large/fragmented batches fall back to one full upload.
   */
  patchStyles(
    indices: ArrayLike<number>,
    colors: ArrayLike<number> | null = null,
    sizes: ArrayLike<number> | null = null,
    count = indices.length
  ): this {
    const n = Math.min(indices.length, Math.max(0, Math.floor(count)));
    if (n <= 0 || (!colors && !sizes)) return this;

    if (this._stylePatchIndexScratch.length < n) {
      this._stylePatchIndexScratch = new Uint32Array(n);
    }

    let maxCouldShrink = false;
    let dirtyCount = 0;
    let hasColorPatch = false;
    let hasSizePatch = false;

    for (let i = 0; i < n; i++) {
      const index = Math.trunc(Number(indices[i]));
      if (!Number.isFinite(index) || index < 0 || index >= this.points.length / 2) continue;

      let patched = false;
      if (colors && this._useVertexColor && index * 4 + 3 < this.colors.length && i * 4 + 3 < colors.length) {
        const src = i * 4;
        const dst = index * 4;
        this._colorBuf[dst] = floatToByte(Number(colors[src]) || 0);
        this._colorBuf[dst + 1] = floatToByte(Number(colors[src + 1]) || 0);
        this._colorBuf[dst + 2] = floatToByte(Number(colors[src + 2]) || 0);
        this._colorBuf[dst + 3] = floatToByte(Number(colors[src + 3]) || this.options.opacity);
        hasColorPatch = true;
        patched = true;
      }

      if (sizes && this._useVertexSize && index < this.sizes.length && i < sizes.length) {
        const prev = this._sizeBuf[index];
        const next = normalizePointSize(sizes[i], this.options.pointSize);
        if (next !== prev) {
          if (prev === this._maxVertexSize && next < prev) maxCouldShrink = true;
          this._sizeBuf[index] = next;
          if (next > this._maxVertexSize) this._maxVertexSize = next;
        }
        hasSizePatch = true;
        patched = true;
      }

      if (patched) this._stylePatchIndexScratch[dirtyCount++] = index;
    }

    if (dirtyCount <= 0) return this;
    if (maxCouldShrink) this.#recomputeMaxVertexSize();

    const dirty = this._stylePatchIndexScratch.subarray(0, dirtyCount);
    dirty.sort();
    if (hasColorPatch) this.#uploadColorPatchRanges(dirty);
    if (hasSizePatch) this.#uploadSizePatchRanges(dirty);
    this.#requestGpuPaint();
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
    if (options.adopt) {
      if (even === latlng.length && even === merc64.length) {
        this._latlngBuf = latlng as Float32Array<ArrayBuffer>;
        this._merc64 = merc64 as Float64Array<ArrayBuffer>;
      } else {
        this._latlngBuf = new Float32Array(even);
        this._merc64 = new Float64Array(even);
        this._latlngBuf.set(latlng.subarray(0, even));
        this._merc64.set(merc64.subarray(0, even));
      }
      if (this._drawMerc.length < even) this._drawMerc = new Float32Array(even);
      this._packedAdopted = true;
    } else {
      if (this._packedAdopted || this._latlngBuf.length < even) {
        this._latlngBuf = new Float32Array(even);
        this._merc64 = new Float64Array(even);
        this._packedAdopted = false;
      }
      if (this._drawMerc.length < even) this._drawMerc = new Float32Array(even);
      this._latlngBuf.set(latlng.subarray(0, even));
      this._merc64.set(merc64.subarray(0, even));
    }
    this.points = this._latlngBuf.subarray(0, even);
    this.mercator = this._drawMerc.subarray(0, even);
    this.pointData = [];
    this.#applyColors(options.colors, even / 2);
    this.#applySizes(options.sizes, even / 2);
    this.#rebuildPickIndex();
    this._refZoom = Number.NaN;
    this._bufferDirty = true;
    this._forceGpu = true;
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

  /** Interleaved RGBA floats in 0..1 (converted from the packed GPU bytes). */
  getColorBuf(): Float32Array {
    const n = this.colors.length;
    if (this._colorFloat.length < n) this._colorFloat = new Float32Array(n);
    const src = this._colorBuf;
    const dst = this._colorFloat;
    for (let i = 0; i < n; i++) dst[i] = src[i] * (1 / 255);
    return dst.subarray(0, n);
  }

  getSizeBuf(): Float32Array {
    return this._sizeBuf.subarray(0, this.sizes.length);
  }

  addData(points: Iterable<WebGLPointInput>): this {
    const existing: WebGLPointInput[] = [];
    for (let i = 0; i < this.points.length; i += 2) {
      existing.push({ lat: this.points[i], lng: this.points[i + 1] });
    }
    for (const item of points) existing.push(item);
    return this.setData(existing);
  }

  clear(): this {
    this.points = new Float32Array();
    this.mercator = new Float32Array();
    this.colors = new Uint8Array();
    this.sizes = new Float32Array();
    this._merc64 = new Float64Array(0);
    this._drawMerc = new Float32Array(0);
    this._colorBuf = new Uint8Array(0);
    this._colorFloat = new Float32Array(0);
    this._sizeBuf = new Float32Array(0);
    this.pointData = [];
    this._gpuMercBytes = 0;
    this._gpuColorBytes = 0;
    this._gpuSizeBytes = 0;
    this._useVertexColor = false;
    this._useVertexSize = false;
    this._maxVertexSize = 0;
    this._refZoom = Number.NaN;
    this._bufferDirty = true;
    this._colorDirty = true;
    this._sizeDirty = true;
    this._hasPainted = false;
    this._forceGpu = true;
    this.#clearSettleTimer();
    this.render();
    return this;
  }

  override bindPopup(content: OverlayContent, options?: PopupOptions): this {
    this.setInteractive(true);
    return super.bindPopup(content, options);
  }

  setInteractive(enabled: boolean): this {
    const next = Boolean(enabled);
    const was = this.options.interactive;
    this.writableOptions.interactive = next;
    if (this.canvas) this.canvas.style.pointerEvents = next ? "auto" : "none";
    if (next && !was) this.#rebuildPickIndex();
    else if (!next && was) this._pickIndex.clear();
    this.#syncInteraction();
    return this;
  }

  setViewTransform(options: { rotation?: number; pitch?: number }): this {
    if (typeof options.rotation === "number") this.writableOptions.rotation = options.rotation;
    if (typeof options.pitch === "number") this.writableOptions.pitch = Math.max(0, Math.min(60, options.pitch));
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
      bufferBytes: this.points.byteLength + merc64Bytes + this.mercator.byteLength + this.colors.byteLength + this.sizes.byteLength,
      vertexColors: this._useVertexColor,
      vertexSizes: this._useVertexSize,
      pickIndex: this._pickIndex.size
    };
  }

  /** Hide the canvas without dropping GPU buffers (heatmap / cluster overlays). */
  setHidden(hidden: boolean): this {
    this._hidden = hidden;
    if (hidden) this.#clearSettleTimer();
    if (this.canvas) {
      this.canvas.style.display = hidden ? "none" : "";
      if (!hidden) {
        this.canvas.style.transform = "none";
        this._forceGpu = true;
      }
    }
    return this;
  }

  override wantsFrameRender(): boolean {
    return !this._hidden && this.points.length > 0;
  }

  override render(): void {
    if (this._hidden || !this.map || !this.canvas) return;
    const dpr = Math.min(this.options.maxDpr, window.devicePixelRatio || 1);
    const cssW = this.map.size.width;
    const cssH = this.map.size.height;
    const pad = this.#overscanPad(cssW, cssH);
    const drawW = cssW + pad * 2;
    const drawH = cssH + pad * 2;
    const width = Math.max(1, Math.round(drawW * dpr));
    const height = Math.max(1, Math.round(drawH * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this._forceGpu = true;
      this._hasPainted = false;
    }

    const zoom = this.map.zoom;
    const ox = this.map.pixelOrigin.x;
    const oy = this.map.pixelOrigin.y;
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const canWarp =
      this.renderer === "webgl" &&
      this._hasPainted &&
      Number.isFinite(this._paintedZoom) &&
      !this._forceGpu &&
      !this._bufferDirty &&
      !this._colorDirty &&
      !this._sizeDirty;

    if (canWarp) {
      const warpCovers = cameraWarpCoversViewport(
        { x: this._paintedOriginX, y: this._paintedOriginY },
        this._paintedZoom,
        { x: ox, y: oy },
        zoom,
        { width: cssW, height: cssH },
        undefined,
        this._paintedPad
      );
      // A large layer cannot repaint every frame of a gesture: a 1M-point GPU pass overruns the
      // frame budget, and the repaint path resets the transform, so a stalled frame shows the
      // stale surface unwarped — points visibly jump and snap back when the pass lands. While
      // the budget is spent, keep warping the exact frame we have even though it no longer
      // covers the viewport: briefly missing overdraw at the edges beats a moving picture.
      const minInterval = this.points.length / 2 >= 250_000 ? 150 : 80;
      const throttled = !warpCovers && now - this._lastGpuMs < minInterval;
      if (warpCovers || throttled) {
        const s = 2 ** (zoom - this._paintedZoom);
        // The canvas sits at `-paintedPad`, so its own origin is that far outside the container and
        // scaling about it moves that offset too: without the last term every point lands
        // `paintedPad * (s - 1)` px away — 120 px at one zoom level in — and snaps back when the
        // repaint lands. Panning kept `s === 1`, which is why only zoom showed it.
        const tx = this._paintedOriginX * s - ox - this._paintedPad * (s - 1);
        const ty = this._paintedOriginY * s - oy - this._paintedPad * (s - 1);
        if (s === 1 && tx * tx + ty * ty < 1e-4) return;
        this.canvas.style.left = `${-this._paintedPad}px`;
        this.canvas.style.top = `${-this._paintedPad}px`;
        this.canvas.style.transformOrigin = "0 0";
        this.canvas.style.transform = `translate3d(${tx}px,${ty}px,0) scale(${s})`;
        this.#scheduleSettledGpu(throttled ? Math.max(16, minInterval - (now - this._lastGpuMs)) : 120);
        return;
      }
    }

    this.canvas.style.left = `${-pad}px`;
    this.canvas.style.top = `${-pad}px`;
    this.canvas.style.width = `${drawW}px`;
    this.canvas.style.height = `${drawH}px`;
    this.canvas.style.transform = "none";
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    if (this.renderer === "webgl") this.#renderWebGL(dpr, pad);
    else if (this.renderer === "canvas") this.#renderCanvas(dpr);
    this._paintedZoom = zoom;
    this._paintedOriginX = ox;
    this._paintedOriginY = oy;
    this._paintedPad = pad;
    this._hasPainted = true;
    this._forceGpu = false;
    this._lastGpuMs = now;
    this.#clearSettleTimer();
  }

  #overscanPad(cssW: number, cssH: number): number {
    if (this.renderer !== "webgl") return 0;
    const count = this.points.length / 2;
    if (count < 8_000) return 0;
    return Math.round(Math.min(280, Math.max(120, Math.min(cssW, cssH) * 0.24)));
  }

  #cameraMovedFromPaint(): boolean {
    if (!this.map || !this._hasPainted) return false;
    return (
      this.map.zoom !== this._paintedZoom ||
      this.map.pixelOrigin.x !== this._paintedOriginX ||
      this.map.pixelOrigin.y !== this._paintedOriginY
    );
  }

  /** Color/size patches: draw now when idle, wait for CSS-warp settle while gesturing. */
  #requestGpuPaint(): void {
    if (this.#cameraMovedFromPaint()) this.#scheduleSettledGpu();
    else this._forceGpu = true;
  }

  #scheduleSettledGpu(delay = 120): void {
    this.#clearSettleTimer();
    this._settleTimer = setTimeout(() => {
      this._settleTimer = null;
      this._forceGpu = true;
      this.render();
    }, delay);
  }

  #clearSettleTimer(): void {
    if (this._settleTimer == null) return;
    clearTimeout(this._settleTimer);
    this._settleTimer = null;
  }

  #applyColors(colors: ArrayLike<number> | null | undefined, pointCount: number): void {
    if (!colors || pointCount <= 0) {
      this._useVertexColor = false;
      this.colors = new Uint8Array();
      this._colorBuf = new Uint8Array(0);
      this._colorDirty = true;
      this._gpuColorBytes = 0;
      return;
    }
    const need = pointCount * 4;
    if (this._colorBuf.length < need) this._colorBuf = new Uint8Array(need);
    const dst = this._colorBuf;
    const n = Math.min(need, colors.length);
    for (let i = 0; i < n; i++) dst[i] = floatToByte(Number(colors[i]) || 0);
    const alphaByte = floatToByte(this.options.opacity);
    for (let i = n; i < need; i++) dst[i] = i % 4 === 3 ? alphaByte : 0;
    this.colors = dst.subarray(0, need);
    this._useVertexColor = true;
    this._colorDirty = true;
  }

  #applySizes(sizes: ArrayLike<number> | null | undefined, pointCount: number): void {
    if (!sizes || pointCount <= 0) {
      this._useVertexSize = false;
      this.sizes = new Float32Array();
      this._sizeBuf = new Float32Array(0);
      this._sizeDirty = true;
      this._gpuSizeBytes = 0;
      this._maxVertexSize = 0;
      return;
    }
    if (this._sizeBuf.length < pointCount) this._sizeBuf = new Float32Array(pointCount);
    const dst = this._sizeBuf;
    const fallback = this.options.pointSize;
    let maxSize = 0;
    const n = Math.min(pointCount, sizes.length);
    for (let i = 0; i < n; i++) {
      const size = normalizePointSize(sizes[i], fallback);
      dst[i] = size;
      if (size > maxSize) maxSize = size;
    }
    for (let i = n; i < pointCount; i++) {
      dst[i] = fallback;
      if (fallback > maxSize) maxSize = fallback;
    }
    this.sizes = dst.subarray(0, pointCount);
    this._useVertexSize = true;
    this._maxVertexSize = maxSize;
    this._sizeDirty = true;
  }

  #recomputeMaxVertexSize(): void {
    let maxSize = 0;
    const sizes = this.sizes;
    for (let i = 0; i < sizes.length; i++) {
      if (sizes[i] > maxSize) maxSize = sizes[i];
    }
    this._maxVertexSize = maxSize;
  }

  #initWebGL(): void {
    const gl = this.gl;
    if (!gl) return;
    const vertex = compileShader(gl, gl.VERTEX_SHADER, `
      attribute vec2 a_merc;
      attribute vec4 a_color;
      attribute float a_size;
      uniform float u_scale;
      uniform vec2 u_origin;
      uniform vec2 u_resolution;
      uniform float u_dpr;
      uniform float u_pointSize;
      uniform vec2 u_center;
      uniform float u_rotate;
      uniform float u_pitch;
      uniform float u_useVertexColor;
      uniform float u_useVertexSize;
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
        float pointSize = (u_useVertexSize > 0.5 ? a_size : u_pointSize);
        vec2 cssRes = u_resolution / max(u_dpr, 0.0001);
        if (pixel.x < -pointSize || pixel.y < -pointSize || pixel.x > cssRes.x + pointSize || pixel.y > cssRes.y + pointSize) {
          gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
          gl_PointSize = 0.0;
          v_color = vec4(0.0);
          return;
        }
        gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
        gl_PointSize = pointSize * u_dpr;
        v_color = u_useVertexColor > 0.5 ? a_color : u_color;
      }
    `);
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, `
      precision mediump float;
      varying vec4 v_color;
      uniform float u_round;
      void main() {
        if (u_round > 0.5) {
          vec2 offset = gl_PointCoord - vec2(0.5);
          if (dot(offset, offset) > 0.25) discard;
        }
        gl_FragColor = v_color;
      }
    `);
    if (!vertex || !fragment) {
      this.renderer = this.options.fallbackCanvas ? "canvas" : "none";
      return;
    }
    this.program = linkProgram(gl, vertex, fragment);
    if (!this.program) {
      this.renderer = this.options.fallbackCanvas ? "canvas" : "none";
      return;
    }
    this.buffer = gl.createBuffer();
    this.colorBuffer = gl.createBuffer();
    this.sizeBuffer = gl.createBuffer();
    this._glLocations = {
      aMerc: gl.getAttribLocation(this.program, "a_merc"),
      aColor: gl.getAttribLocation(this.program, "a_color"),
      aSize: gl.getAttribLocation(this.program, "a_size"),
      uScale: gl.getUniformLocation(this.program, "u_scale"),
      uOrigin: gl.getUniformLocation(this.program, "u_origin"),
      uResolution: gl.getUniformLocation(this.program, "u_resolution"),
      uDpr: gl.getUniformLocation(this.program, "u_dpr"),
      uPointSize: gl.getUniformLocation(this.program, "u_pointSize"),
      uColor: gl.getUniformLocation(this.program, "u_color"),
      uUseVertexColor: gl.getUniformLocation(this.program, "u_useVertexColor"),
      uUseVertexSize: gl.getUniformLocation(this.program, "u_useVertexSize"),
      uCenter: gl.getUniformLocation(this.program, "u_center"),
      uRotate: gl.getUniformLocation(this.program, "u_rotate"),
      uPitch: gl.getUniformLocation(this.program, "u_pitch"),
      uRound: gl.getUniformLocation(this.program, "u_round")
    };
    this._bufferDirty = true;
    this._colorDirty = true;
    this._sizeDirty = true;
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

  #uploadSizesIfNeeded(): void {
    const gl = this.gl;
    if (!gl || !this.sizeBuffer || !this._sizeDirty) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.sizeBuffer);
    if (!this._useVertexSize || !this.sizes.length) {
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(0), gl.DYNAMIC_DRAW);
      this._gpuSizeBytes = 0;
      this._sizeDirty = false;
      return;
    }
    const bytes = this.sizes.byteLength;
    if (bytes > 0 && bytes === this._gpuSizeBytes) {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.sizes);
    } else {
      gl.bufferData(gl.ARRAY_BUFFER, this.sizes, gl.DYNAMIC_DRAW);
      this._gpuSizeBytes = bytes;
    }
    this._sizeDirty = false;
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

  #uploadColorRange(byteOffset: number, byteCount: number): void {
    const gl = this.gl;
    if (!gl || !this.colorBuffer || byteCount <= 0 || !this._useVertexColor) return;
    if (this._gpuColorBytes !== this.colors.byteLength) {
      this._colorDirty = true;
      return;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
    gl.bufferSubData(
      gl.ARRAY_BUFFER,
      byteOffset,
      this._colorBuf.subarray(byteOffset, byteOffset + byteCount)
    );
  }

  #uploadSizeRange(floatOffset: number, floatCount: number): void {
    const gl = this.gl;
    if (!gl || !this.sizeBuffer || floatCount <= 0 || !this._useVertexSize) return;
    if (this._gpuSizeBytes !== this.sizes.byteLength) {
      this._sizeDirty = true;
      return;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.sizeBuffer);
    gl.bufferSubData(
      gl.ARRAY_BUFFER,
      floatOffset * 4,
      this._sizeBuf.subarray(floatOffset, floatOffset + floatCount)
    );
  }

  #uploadColorPatchRanges(indices: Uint32Array): void {
    const pointCount = this.colors.length / 4;
    if (pointCount <= 0 || indices.length <= 0) return;
    this.#uploadPatchRanges(indices, pointCount, (start, count) => this.#uploadColorRange(start * 4, count * 4));
  }

  #uploadSizePatchRanges(indices: Uint32Array): void {
    const pointCount = this.sizes.length;
    if (pointCount <= 0 || indices.length <= 0) return;
    this.#uploadPatchRanges(indices, pointCount, (start, count) => this.#uploadSizeRange(start, count));
  }

  #uploadPatchRanges(
    indices: Uint32Array,
    pointCount: number,
    upload: (start: number, count: number) => void
  ): void {
    // Merge nearby slots to amortize WebGL driver calls, but do not promote a
    // sparse batch to a full-buffer upload merely because it has many ranges.
    // The old `rangeCount > 256` rule turned 1k scattered updates on a 1M-point
    // layer into a ~4 MB upload. Estimate driver-call overhead in point units
    // and choose the cheaper plan instead.
    const mergeGap = 8;
    const fullUploadRatio = 0.15;
    const callPenaltyPoints = 512;

    let uniqueCount = 0;
    let rangeCount = 0;
    let coveredPoints = 0;
    let rangeStart = -1;
    let rangeEnd = -1;

    for (let i = 0; i < indices.length; i++) {
      const index = indices[i];
      if (index === rangeEnd) continue;
      uniqueCount += 1;

      if (rangeStart < 0) {
        rangeStart = index;
        rangeEnd = index;
        rangeCount = 1;
        continue;
      }
      if (index <= rangeEnd + mergeGap + 1) {
        rangeEnd = index;
        continue;
      }

      coveredPoints += rangeEnd - rangeStart + 1;
      rangeStart = index;
      rangeEnd = index;
      rangeCount += 1;
    }
    if (rangeStart >= 0) coveredPoints += rangeEnd - rangeStart + 1;

    const denseEnoughForFullUpload = uniqueCount >= Math.ceil(pointCount * fullUploadRatio);
    const estimatedPartialCost = coveredPoints + rangeCount * callPenaltyPoints;
    if (denseEnoughForFullUpload || estimatedPartialCost >= pointCount) {
      upload(0, pointCount);
      return;
    }

    let start = -1;
    let end = -1;
    for (let i = 0; i < indices.length; i++) {
      const index = indices[i];
      if (index === end) continue;
      if (start < 0) {
        start = index;
        end = index;
        continue;
      }
      if (index <= end + mergeGap + 1) {
        end = index;
        continue;
      }
      upload(start, end - start + 1);
      start = index;
      end = index;
    }
    if (start >= 0) upload(start, end - start + 1);
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
    const padding = (this._useVertexSize ? Math.max(this.options.pointSize, this._maxVertexSize) : this.options.pointSize) + 2;
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
    if (!this.options.interactive) return;
    const pts = this.points;
    const n = pts.length;
    for (let i = 0; i < n; i += 2) this._pickIndex.set(i / 2, { lat: pts[i], lng: pts[i + 1] }, i / 2);
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
    const useVertexSize = this._useVertexSize && this.sizes.length > 0;
    const defaultRadius = Math.max(0, hitTolerance) + this.options.pointSize / 2;
    const maxRadius = useVertexSize
      ? Math.max(0, hitTolerance) + Math.max(this.options.pointSize, this._maxVertexSize) / 2
      : defaultRadius;
    const maxDistance = maxRadius * maxRadius;
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
    const consider = (index: number, point: { x: number; y: number }): void => {
      const radius = useVertexSize
        ? Math.max(0, hitTolerance) + (this.sizes[index] || this.options.pointSize) / 2
        : defaultRadius;
      const limit = radius * radius;
      const distance = (point.x - targetX) ** 2 + (point.y - targetY) ** 2;
      if (distance > limit || distance > nearestDistance) return;
      nearest = index;
      nearestDistance = distance;
      nearestPoint = point;
    };
    if (rotated || pointCount <= 256) {
      for (let index = 0; index < count; index += 2) {
        const point = this.#mercatorToScreen(merc[index], merc[index + 1], scale, originX, originY);
        consider(index / 2, point);
      }
    } else {
      const ll = this.map.containerPointToLatLng({ x: targetX, y: targetY });
      const pad = Math.max(0.002, (maxRadius / scale) * 360);
      for (const i of this._pickIndex.searchIds([{ lat: ll.lat - pad, lng: ll.lng - pad }, { lat: ll.lat + pad, lng: ll.lng + pad }])) {
        const point = this.#mercatorToScreen(merc[i * 2], merc[i * 2 + 1], scale, originX, originY);
        consider(i, point);
      }
    }
    if (nearest < 0) return null;
    return {
      index: nearest,
      latlng: { lat: this.points[nearest * 2], lng: this.points[nearest * 2 + 1] },
      containerPoint: nearestPoint
    };
  }

  #renderWebGL(dpr: number, pad = 0): void {
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
    this.#uploadSizesIfNeeded();

    const scale = TILE_SIZE * 2 ** this.map.zoom;
    const rotation = (this.options.rotation * Math.PI) / 180;
    const pitch = Math.cos((this.options.pitch * Math.PI) / 180);
    // Residual origin after relative encoding — stays small between re-encodes.
    const originX = this.map.pixelOrigin.x - this._refMx * scale - pad;
    const originY = this.map.pixelOrigin.y - this._refMy * scale - pad;

    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.enableVertexAttribArray(locs.aMerc);
    gl.vertexAttribPointer(locs.aMerc, 2, gl.FLOAT, false, 0, 0);

    if (this._useVertexColor && this.colorBuffer && locs.aColor >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
      gl.enableVertexAttribArray(locs.aColor);
      gl.vertexAttribPointer(locs.aColor, 4, gl.UNSIGNED_BYTE, true, 0, 0);
    } else if (locs.aColor >= 0) {
      gl.disableVertexAttribArray(locs.aColor);
      gl.vertexAttrib4f(locs.aColor, this.color.r / 255, this.color.g / 255, this.color.b / 255, this.options.opacity);
    }

    if (this._useVertexSize && this.sizeBuffer && locs.aSize >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.sizeBuffer);
      gl.enableVertexAttribArray(locs.aSize);
      gl.vertexAttribPointer(locs.aSize, 1, gl.FLOAT, false, 0, 0);
    } else if (locs.aSize >= 0) {
      gl.disableVertexAttribArray(locs.aSize);
      gl.vertexAttrib1f(locs.aSize, this.options.pointSize);
    }

    gl.uniform1f(locs.uScale, scale);
    gl.uniform2f(locs.uOrigin, originX, originY);
    gl.uniform2f(locs.uResolution, this.canvas.width, this.canvas.height);
    gl.uniform1f(locs.uDpr, dpr);
    gl.uniform1f(locs.uPointSize, this.options.pointSize);
    gl.uniform4f(
      locs.uColor,
      this.color.r / 255,
      this.color.g / 255,
      this.color.b / 255,
      this.options.opacity
    );
    gl.uniform1f(locs.uUseVertexColor, this._useVertexColor ? 1 : 0);
    gl.uniform1f(locs.uUseVertexSize, this._useVertexSize ? 1 : 0);
    gl.uniform2f(locs.uCenter, this.map.size.width / 2 + pad, this.map.size.height / 2 + pad);
    gl.uniform1f(locs.uRotate, rotation);
    gl.uniform1f(locs.uPitch, pitch);
    // Circles cost a discard per fragment; squares are cheaper at mass scale.
    gl.uniform1f(locs.uRound, count < 80_000 ? 1 : 0);

    gl.disable(gl.DITHER);
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
    const useVertexColor = this._useVertexColor && this.colors.length >= indices.length * 4;
    const useVertexSize = this._useVertexSize && this.sizes.length > 0;
    const defaultRadius = Math.max(1, (this.options.pointSize * dpr) / 2);
    for (let i = 0; i < indices.length; i++) {
      const pointIndex = indices[i];
      if (useVertexColor) {
        const c = pointIndex * 4;
        context.globalAlpha = this.colors[c + 3] / 255;
        context.fillStyle = `rgb(${this.colors[c]},${this.colors[c + 1]},${this.colors[c + 2]})`;
      } else {
        context.globalAlpha = this.options.opacity;
        context.fillStyle = `rgb(${this.color.r},${this.color.g},${this.color.b})`;
      }
      const radius = useVertexSize
        ? Math.max(1, ((this.sizes[pointIndex] || this.options.pointSize) * dpr) / 2)
        : defaultRadius;
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
  if (!Array.isArray(source) && (!Number.isFinite(source.lat) || !Number.isFinite(source.lng))) return null;
  const point = latLng(source);
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return null;
  return point;
}

function normalizePointSize(value: unknown, fallback: number): number {
  const size = Number(value);
  if (!Number.isFinite(size)) return fallback;
  return Math.max(1, Math.min(256, size));
}

function floatToByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value * 255)));
}
