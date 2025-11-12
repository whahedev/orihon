/**
 * WebGL raster basemap (Advanced tier) — textured tile quads.
 *
 * Perf notes (vs DOM tiles / MapLibre):
 * - Coalesce texture uploads → one rAF redraw (never render() per onload)
 * - Same-zoom pan: CSS translate of the last framebuffer when the needed set is unchanged
 * - Draw only needed + retained tiles (not the whole LRU)
 * - Debounce integer zoom switches during continuous camera stress
 */

import { createEl } from "../dom.js";
import { TILE_SIZE, LatLngBounds, latLngBounds, unproject, type LatLngBoundsLike } from "../geo.js";
import { Layer, type LayerOptions } from "../layer.js";
import type { Orihon } from "../map.js";
import { assertMercator } from "../crs.js";
import { compileShader } from "../webgl-utils.js";
import { modulo, type TileTemplate } from "./tile-layer.js";

export interface WebGLTileLayerOptions extends LayerOptions {
  minZoom?: number;
  maxZoom?: number;
  maxNativeZoom?: number;
  tileSize?: number;
  buffer?: number;
  cacheSize?: number;
  maxRequests?: number;
  maxNewPerFrame?: number;
  subdomains?: string | string[];
  crossOrigin?: string;
  referrerPolicy?: ReferrerPolicy | "";
  opacity?: number;
  errorTileUrl?: string;
  noWrap?: boolean;
  tms?: boolean;
  detectRetina?: boolean;
  bounds?: LatLngBoundsLike | null;
  className?: string;
  maxDpr?: number;
}

type ResolvedOptions = Required<
  Pick<
    WebGLTileLayerOptions,
    | "pane"
    | "minZoom"
    | "maxZoom"
    | "tileSize"
    | "buffer"
    | "cacheSize"
    | "maxRequests"
    | "maxNewPerFrame"
    | "subdomains"
    | "attribution"
    | "crossOrigin"
    | "referrerPolicy"
    | "opacity"
    | "errorTileUrl"
    | "noWrap"
    | "tms"
    | "detectRetina"
    | "className"
    | "maxDpr"
  >
> &
  WebGLTileLayerOptions;

export interface WebGLTileLayerStats {
  renderer: "webgl" | "none";
  needed: number;
  ready: number;
  loading: number;
  cached: number;
  gpuBytesApprox: number;
}

interface GpuTile {
  key: string;
  x: number;
  y: number;
  z: number;
  url: string;
  texture: WebGLTexture | null;
  image: HTMLImageElement | null;
  /** 0 idle · 1 loading · 2 ready · 3 error */
  state: 0 | 1 | 2 | 3;
  lastUsed: number;
  byteSize: number;
  generation: number;
}

interface GLLocs {
  aUv: number;
  uOrigin: WebGLUniformLocation | null;
  uResolution: WebGLUniformLocation | null;
  uDpr: WebGLUniformLocation | null;
  uTileXY: WebGLUniformLocation | null;
  uTilePixelSize: WebGLUniformLocation | null;
  uOpacity: WebGLUniformLocation | null;
  uTexture: WebGLUniformLocation | null;
}

function normalizeBounds(value: unknown): LatLngBounds | null {
  if (!value) return null;
  const bounds = latLngBounds(value as LatLngBoundsLike);
  if (!bounds.isValid()) throw new TypeError("WebGLTileLayer bounds must be a valid LatLngBounds");
  return bounds;
}

export class WebGLTileLayer extends Layer<ResolvedOptions> {
  template: TileTemplate;
  canvas: HTMLCanvasElement | null = null;
  gl: WebGLRenderingContext | null = null;
  renderer: "webgl" | "none" = "none";

  readonly tiles = new Map<string, GpuTile>();

  private program: WebGLProgram | null = null;
  private quadBuffer: WebGLBuffer | null = null;
  private locs: GLLocs | null = null;
  private _tileZoom: number | null = null;
  private _needed = new Set<string>();
  private _neededCount = 0;
  private _retained = new Set<string>();
  private _drawList: GpuTile[] = [];
  private _generation = 0;
  private _loading = 0;
  private _cssW = 0;
  private _cssH = 0;
  private _gpuBytes = 0;
  private _queue: GpuTile[] = [];
  private _queuedKeys = new Set<string>();
  private _dirty = true;
  private _forceGpu = false;
  private _hasDrawn = false;
  private _redrawFrame = 0;
  private _settleTimer: ReturnType<typeof setTimeout> | null = null;
  private _lastGpuMs = 0;
  private _drawnZoom = Number.NaN;
  private _drawnOriginX = 0;
  private _drawnOriginY = 0;
  private _pendingSourceZoom: number | null = null;
  private _zoomSwitchTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly _retina: boolean;
  private readonly _bounds: LatLngBounds | null;

  constructor(template: TileTemplate, options: WebGLTileLayerOptions = {}) {
    super({
      pane: "tile",
      minZoom: 0,
      maxZoom: 19,
      maxNativeZoom: undefined,
      tileSize: TILE_SIZE,
      buffer: 1,
      cacheSize: 96,
      maxRequests: 8,
      maxNewPerFrame: 4,
      subdomains: "abc",
      attribution: "",
      crossOrigin: "anonymous",
      referrerPolicy: "",
      opacity: 1,
      errorTileUrl: "",
      noWrap: false,
      tms: false,
      detectRetina: false,
      bounds: null,
      className: "oh-webgl-tile-layer",
      maxDpr: 1,
      ...options
    } as ResolvedOptions);
    this.template = template;
    this._bounds = normalizeBounds(this.options.bounds);
    this._retina = Boolean(
      this.options.detectRetina && typeof devicePixelRatio !== "undefined" && devicePixelRatio > 1
    );
  }

  getStats(): WebGLTileLayerStats {
    let ready = 0;
    for (const tile of this.tiles.values()) if (tile.state === 2) ready += 1;
    return {
      renderer: this.renderer,
      needed: this._neededCount,
      ready,
      loading: this._loading,
      cached: this.tiles.size,
      gpuBytesApprox: this._gpuBytes
    };
  }

  getTileUrl(x: number, y: number, z: number): string {
    const worldSize = 2 ** z;
    const urlX = this.options.noWrap ? x : modulo(x, worldSize);
    const urlY = this.options.tms ? worldSize - y - 1 : y;
    const subdomains = Array.isArray(this.options.subdomains)
      ? this.options.subdomains
      : String(this.options.subdomains || "").split("");
    const s = subdomains[modulo(x + y, Math.max(1, subdomains.length))] || "";
    const r = this._retina ? "@2x" : "";
    if (typeof this.template === "function") {
      return this.template({ x: urlX, y: urlY, z, s, r, retina: this._retina });
    }
    return this.template
      .replace(/\{s\}/g, s)
      .replace(/\{z\}/g, String(z))
      .replace(/\{x\}/g, String(urlX))
      .replace(/\{y\}/g, String(urlY))
      .replace(/\{r\}/g, r);
  }

  redraw(): this {
    this._generation += 1;
    this._dirty = true;
    this.render();
    return this;
  }

  setUrl(template: TileTemplate, redraw = true): this {
    this.template = template;
    if (redraw) this.redraw();
    return this;
  }

  setOpacity(opacity: number): this {
    const next = Number(opacity);
    this.options.opacity = Number.isFinite(next) ? Math.max(0, Math.min(1, next)) : 1;
    if (this.canvas) this.canvas.style.opacity = String(this.options.opacity);
    this._forceGpu = true;
    this._dirty = true;
    this.#scheduleRedraw();
    return this;
  }

  override onAdd(map: Orihon): void {
    assertMercator(map.crs);
    super.onAdd(map);
    const pane = this.getPane();
    if (!pane) throw new Error(`Orihon pane not found: ${this.options.pane}`);
    this.canvas = createEl("canvas", this.options.className ?? "oh-webgl-tile-layer", pane);
    this.canvas.style.position = "absolute";
    this.canvas.style.left = "0";
    this.canvas.style.top = "0";
    this.canvas.style.pointerEvents = "none";
    this.canvas.style.willChange = "transform";
    this.canvas.style.opacity = String(this.options.opacity);
    this.gl = this.canvas.getContext("webgl", {
      antialias: false,
      alpha: true,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      powerPreference: "high-performance",
      preserveDrawingBuffer: false
    });
    if (this.gl && this.#initPipeline()) {
      this.renderer = "webgl";
    } else {
      this.renderer = "none";
      this.gl = null;
    }
    this._dirty = true;
    this.render();
  }

  override onRemove(): void {
    if (this._redrawFrame && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this._redrawFrame);
      this._redrawFrame = 0;
    }
    this.#clearSettleTimer();
    this.#clearZoomSwitchTimer();
    this.#disposeAllTiles();
    this.#disposePipeline();
    if (this.canvas) {
      this.canvas.width = 0;
      this.canvas.height = 0;
      this.canvas.remove();
    }
    this.canvas = null;
    this._cssW = 0;
    this._cssH = 0;
    this._tileZoom = null;
    this._neededCount = 0;
    this._needed.clear();
    this._retained.clear();
    this._drawList = [];
    this._hasDrawn = false;
    super.onRemove();
  }

  override render(): void {
    if (!this.map || !this.canvas || this.renderer !== "webgl" || !this.gl) return;
    const { width, height } = this.map.size;
    const dpr = Math.min(
      this.options.maxDpr ?? 1,
      typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1
    );
    if (width !== this._cssW || height !== this._cssH) {
      this._cssW = width;
      this._cssH = height;
      this.canvas.style.width = `${width}px`;
      this.canvas.style.height = `${height}px`;
      this.canvas.width = Math.max(1, Math.round(width * dpr));
      this.canvas.height = Math.max(1, Math.round(height * dpr));
      this._dirty = true;
      this._hasDrawn = false;
      this._drawnZoom = Number.NaN;
    }

    const displayZoom = Math.round(this.map.zoom);
    if (displayZoom < this.options.minZoom || displayZoom > this.options.maxZoom) {
      this.canvas.style.transform = "";
      this.#clear();
      return;
    }

    // Prefetch only — camera motion uses CSS warp; GPU redraw is throttled / settled.
    this.#syncTileGrid();

    const zoom = this.map.zoom;
    const ox = this.map.pixelOrigin.x;
    const oy = this.map.pixelOrigin.y;
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const canWarp = this._hasDrawn && Number.isFinite(this._drawnZoom);
    // While gesturing: prefer CSS translate+scale; GPU at most ~12Hz for new textures, or on settle.
    const gpuDue = this._forceGpu || !canWarp || (this._dirty && now - this._lastGpuMs > 80);

    if (!gpuDue) {
      const s = 2 ** (zoom - this._drawnZoom);
      this.canvas.style.transformOrigin = "0 0";
      this.canvas.style.transform =
        `translate3d(${this._drawnOriginX * s - ox}px,${this._drawnOriginY * s - oy}px,0) scale(${s})`;
      this.#scheduleSettledGpu();
      return;
    }

    this.canvas.style.transform = "";
    this.#rebuildDrawList();
    this.#drawFrame(dpr, ox, oy);
    this._drawnZoom = zoom;
    this._drawnOriginX = ox;
    this._drawnOriginY = oy;
    this._dirty = false;
    this._forceGpu = false;
    this._hasDrawn = true;
    this._lastGpuMs = now;
    this.#clearSettleTimer();
  }

  #scheduleRedraw(): void {
    this._dirty = true;
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
    this._settleTimer = setTimeout(() => {
      this._settleTimer = null;
      this._forceGpu = true;
      this._dirty = true;
      this.#scheduleRedraw();
    }, 120);
  }

  #clearSettleTimer(): void {
    if (this._settleTimer != null) {
      clearTimeout(this._settleTimer);
      this._settleTimer = null;
    }
  }

  #initPipeline(): boolean {
    const gl = this.gl;
    if (!gl) return false;
    const vertex = compileShader(gl, gl.VERTEX_SHADER, `
      attribute vec2 a_uv;
      uniform vec2 u_origin;
      uniform vec2 u_resolution;
      uniform float u_dpr;
      uniform vec2 u_tileXY;
      uniform float u_tilePixelSize;
      varying vec2 v_uv;
      void main() {
        v_uv = a_uv;
        vec2 pixel = (u_tileXY + a_uv) * u_tilePixelSize - u_origin;
        vec2 clip = ((pixel * u_dpr) / u_resolution) * 2.0 - 1.0;
        gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
      }
    `);
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, `
      precision mediump float;
      varying vec2 v_uv;
      uniform sampler2D u_texture;
      uniform float u_opacity;
      void main() {
        vec4 color = texture2D(u_texture, v_uv);
        gl_FragColor = color * u_opacity;
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

    const quad = new Float32Array([0, 0, 0, 1, 1, 0, 1, 1]);
    this.quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);

    this.locs = {
      aUv: gl.getAttribLocation(program, "a_uv"),
      uOrigin: gl.getUniformLocation(program, "u_origin"),
      uResolution: gl.getUniformLocation(program, "u_resolution"),
      uDpr: gl.getUniformLocation(program, "u_dpr"),
      uTileXY: gl.getUniformLocation(program, "u_tileXY"),
      uTilePixelSize: gl.getUniformLocation(program, "u_tilePixelSize"),
      uOpacity: gl.getUniformLocation(program, "u_opacity"),
      uTexture: gl.getUniformLocation(program, "u_texture")
    };
    return true;
  }

  #disposePipeline(): void {
    const gl = this.gl;
    if (gl) {
      try {
        if (this.quadBuffer) gl.deleteBuffer(this.quadBuffer);
        if (this.program) gl.deleteProgram(this.program);
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      } catch {
        /* ignore */
      }
    }
    this.quadBuffer = null;
    this.program = null;
    this.locs = null;
    this.gl = null;
    this.renderer = "none";
  }

  #clear(): void {
    const gl = this.gl;
    if (!gl || !this.canvas) return;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  #syncTileGrid(): void {
    if (!this.map) return;
    const nativeLimit =
      typeof this.options.maxNativeZoom === "number" ? this.options.maxNativeZoom : this.options.maxZoom;
    const displayZoom = Math.round(this.map.zoom);
    const sourceZoom = Math.max(0, Math.min(nativeLimit, displayZoom + (this._retina ? 1 : 0)));

    if (this._tileZoom === null) {
      this.#clearZoomSwitchTimer();
      this._tileZoom = sourceZoom;
      this._dirty = true;
    } else if (sourceZoom !== this._tileZoom) {
      if (Math.abs(sourceZoom - this._tileZoom) > 2) {
        this.#clearZoomSwitchTimer();
        this.#switchZoom(sourceZoom);
      } else {
        this.#scheduleZoomSwitch(sourceZoom);
      }
    }

    const activeZoom = this._tileZoom;
    if (activeZoom === null) return;

    const size = this.options.tileSize;
    const displayScale = 2 ** (this.map.zoom - activeZoom);
    const origin = this.map.pixelOrigin;
    const tileOriginX = origin.x / displayScale;
    const tileOriginY = origin.y / displayScale;
    const left = Math.floor(tileOriginX / size) - this.options.buffer;
    const top = Math.floor(tileOriginY / size) - this.options.buffer;
    const right = Math.floor((tileOriginX + this.map.size.width / displayScale) / size) + this.options.buffer;
    const bottom = Math.floor((tileOriginY + this.map.size.height / displayScale) / size) + this.options.buffer;
    const worldMax = 2 ** activeZoom - 1;

    const needed = new Set<string>();
    const candidates: Array<{ x: number; y: number; key: string; distance: number }> = [];
    const centerX = tileOriginX / size + this.map.size.width / displayScale / size / 2;
    const centerY = tileOriginY / size + this.map.size.height / displayScale / size / 2;
    const now = performance.now();

    for (let y = top; y <= bottom; y++) {
      if (y < 0 || y > worldMax) continue;
      for (let x = left; x <= right; x++) {
        if (this.options.noWrap && (x < 0 || x > worldMax)) continue;
        if (!this.#tileIntersectsBounds(x, y, activeZoom)) continue;
        const key = `${activeZoom}:${x}:${y}`;
        needed.add(key);
        const existing = this.tiles.get(key);
        if (existing) {
          existing.lastUsed = now;
          if (existing.state === 0) this.#enqueue(existing);
        } else {
          candidates.push({ x, y, key, distance: Math.hypot(x + 0.5 - centerX, y + 0.5 - centerY) });
        }
      }
    }

    if (candidates.length > 1) candidates.sort((a, b) => a.distance - b.distance);
    const maxNew = Math.max(1, this.options.maxNewPerFrame);
    for (let i = 0; i < candidates.length && i < maxNew; i++) {
      const c = candidates[i];
      this.#createTile(c.x, c.y, activeZoom, c.key);
    }
    if (candidates.length > maxNew) this.#scheduleRedraw();

    this._needed = needed;
    this._neededCount = needed.size;
    this.#pumpQueue();
    this.#evictLru();
  }

  #switchZoom(sourceZoom: number): void {
    this._retained = new Set(this._needed);
    this._tileZoom = sourceZoom;
    this._dirty = true;
    this._drawnZoom = Number.NaN;
  }

  #scheduleZoomSwitch(sourceZoom: number): void {
    this._pendingSourceZoom = sourceZoom;
    if (this._zoomSwitchTimer != null) return;
    this._zoomSwitchTimer = setTimeout(() => {
      this._zoomSwitchTimer = null;
      const pending = this._pendingSourceZoom;
      this._pendingSourceZoom = null;
      if (pending == null || !this.map || pending === this._tileZoom) return;
      this.#switchZoom(pending);
      this.#scheduleRedraw();
    }, 140);
  }

  #clearZoomSwitchTimer(): void {
    if (this._zoomSwitchTimer != null) {
      clearTimeout(this._zoomSwitchTimer);
      this._zoomSwitchTimer = null;
    }
    this._pendingSourceZoom = null;
  }

  #createTile(x: number, y: number, z: number, key: string): void {
    if (this.tiles.has(key)) return;
    const tile: GpuTile = {
      key,
      x,
      y,
      z,
      url: this.getTileUrl(x, y, z),
      texture: null,
      image: null,
      state: 0,
      lastUsed: performance.now(),
      byteSize: 0,
      generation: this._generation
    };
    this.tiles.set(key, tile);
    this.#enqueue(tile);
  }

  #enqueue(tile: GpuTile): void {
    if (tile.state !== 0 || this._queuedKeys.has(tile.key)) return;
    this._queuedKeys.add(tile.key);
    this._queue.push(tile);
  }

  #pumpQueue(): void {
    const maxRequests = Math.max(1, this.options.maxRequests);
    while (this._loading < maxRequests && this._queue.length) {
      const tile = this._queue.shift()!;
      this._queuedKeys.delete(tile.key);
      if (!this.tiles.has(tile.key) || tile.state !== 0) continue;
      this.#startLoad(tile);
    }
  }

  #startLoad(tile: GpuTile): void {
    const image = new Image();
    tile.image = image;
    tile.state = 1;
    this._loading += 1;
    if (this.options.crossOrigin) image.crossOrigin = this.options.crossOrigin;
    if (this.options.referrerPolicy) image.referrerPolicy = this.options.referrerPolicy;
    image.onload = () => {
      const done = (source: TexImageSource & { width: number; height: number }, close?: () => void) => {
        if (!this.tiles.has(tile.key) || tile.generation !== this._generation) {
          close?.();
          this.#finishLoad(tile, true);
          return;
        }
        const uploaded = this.#uploadTexture(tile, source);
        close?.();
        tile.state = uploaded ? 2 : 3;
        this.#finishLoad(tile, true);
        if (uploaded) this.#scheduleRedraw();
      };
      if (typeof createImageBitmap === "function") {
        createImageBitmap(image).then((bitmap) => done(bitmap, () => bitmap.close()), () => done(image));
        return;
      }
      done(image);
    };
    image.onerror = () => {
      if (!this.tiles.has(tile.key)) {
        this.#finishLoad(tile, false);
        return;
      }
      if (this.options.errorTileUrl && tile.url !== this.options.errorTileUrl) {
        tile.url = this.options.errorTileUrl;
        tile.state = 0;
        this.#finishLoad(tile, false);
        this.#enqueue(tile);
        this.#pumpQueue();
        return;
      }
      tile.state = 3;
      this.#finishLoad(tile, true);
    };
    image.src = tile.url;
  }

  #finishLoad(tile: GpuTile, clearImage: boolean): void {
    this._loading = Math.max(0, this._loading - 1);
    if (clearImage) {
      if (tile.image) {
        tile.image.onload = null;
        tile.image.onerror = null;
      }
      tile.image = null;
    }
    this.#pumpQueue();
  }

  #uploadTexture(tile: GpuTile, image: TexImageSource & { width: number; height: number }): boolean {
    const gl = this.gl;
    if (!gl) return false;
    const texture = gl.createTexture();
    if (!texture) return false;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    } catch {
      gl.deleteTexture(texture);
      return false;
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    if (tile.texture) {
      gl.deleteTexture(tile.texture);
      this._gpuBytes = Math.max(0, this._gpuBytes - tile.byteSize);
    }
    tile.texture = texture;
    tile.byteSize = Math.max(1, image.width) * Math.max(1, image.height) * 4;
    this._gpuBytes += tile.byteSize;
    return true;
  }

  #evictLru(): void {
    const limit = Math.max(16, this.options.cacheSize);
    if (this.tiles.size <= limit) return;
    const victims: GpuTile[] = [];
    for (const tile of this.tiles.values()) {
      if (!this._needed.has(tile.key) && !this._retained.has(tile.key)) victims.push(tile);
    }
    victims.sort((a, b) => a.lastUsed - b.lastUsed);
    for (const tile of victims) {
      if (this.tiles.size <= limit) break;
      this.#disposeTile(tile);
    }
  }

  #rebuildDrawList(): void {
    const list: GpuTile[] = [];
    for (const key of this._retained) {
      if (this._needed.has(key)) continue;
      const tile = this.tiles.get(key);
      if (tile && tile.state === 2 && tile.texture) list.push(tile);
    }
    for (const key of this._needed) {
      const tile = this.tiles.get(key);
      if (tile && tile.state === 2 && tile.texture) list.push(tile);
    }
    this._drawList = list;
  }

  #drawFrame(dpr: number, originX: number, originY: number): void {
    const gl = this.gl;
    const locs = this.locs;
    const map = this.map;
    if (!gl || !locs || !this.program || !this.quadBuffer || !map || !this.canvas) return;

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.program);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(locs.aUv);
    gl.vertexAttribPointer(locs.aUv, 2, gl.FLOAT, false, 0, 0);

    gl.uniform2f(locs.uOrigin, originX, originY);
    gl.uniform2f(locs.uResolution, this.canvas.width, this.canvas.height);
    gl.uniform1f(locs.uDpr, dpr);
    // Layer opacity is applied via canvas.style.opacity so live setOpacity is immediate
    // even while the camera is CSS-warping a previous GPU frame.
    gl.uniform1f(locs.uOpacity, 1);
    gl.uniform1i(locs.uTexture, 0);
    gl.activeTexture(gl.TEXTURE0);

    const pad = this.options.tileSize;
    const viewW = map.size.width;
    const viewH = map.size.height;
    const zoom = map.zoom;
    const tileSize = this.options.tileSize;

    for (let i = 0; i < this._drawList.length; i++) {
      const tile = this._drawList[i];
      if (!tile.texture) continue;
      const tilePixelSize = tileSize * 2 ** (zoom - tile.z);
      const left = tile.x * tilePixelSize - originX;
      const top = tile.y * tilePixelSize - originY;
      if (left > viewW + pad || top > viewH + pad || left + tilePixelSize < -pad || top + tilePixelSize < -pad) {
        continue;
      }
      gl.bindTexture(gl.TEXTURE_2D, tile.texture);
      gl.uniform2f(locs.uTileXY, tile.x, tile.y);
      gl.uniform1f(locs.uTilePixelSize, tilePixelSize);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  #tileIntersectsBounds(x: number, y: number, z: number): boolean {
    const bounds = this._bounds;
    if (!bounds) return true;
    const worldSize = 2 ** z;
    const normalizedX = modulo(x, worldSize);
    const tileWest = (normalizedX / worldSize) * 360 - 180;
    const tileEast = ((normalizedX + 1) / worldSize) * 360 - 180;
    const tileNorth = unproject({ x: 0, y: y * this.options.tileSize }, z).lat;
    const tileSouth = unproject({ x: 0, y: (y + 1) * this.options.tileSize }, z).lat;
    if (tileSouth > bounds.north || tileNorth < bounds.south) return false;
    if (bounds.west <= bounds.east) return tileEast >= bounds.west && tileWest <= bounds.east;
    return tileEast >= bounds.west || tileWest <= bounds.east;
  }

  #disposeTile(tile: GpuTile): void {
    if (tile.image) {
      tile.image.onload = null;
      tile.image.onerror = null;
      tile.image.src = "";
      tile.image = null;
      if (tile.state === 1) this._loading = Math.max(0, this._loading - 1);
    }
    if (this.gl && tile.texture) {
      this.gl.deleteTexture(tile.texture);
      this._gpuBytes = Math.max(0, this._gpuBytes - tile.byteSize);
    }
    tile.texture = null;
    this.tiles.delete(tile.key);
    this._queuedKeys.delete(tile.key);
    this._retained.delete(tile.key);
    this._queue = this._queue.filter((item) => item !== tile);
  }

  #disposeAllTiles(): void {
    for (const tile of [...this.tiles.values()]) this.#disposeTile(tile);
    this.tiles.clear();
    this._queue = [];
    this._queuedKeys.clear();
    this._loading = 0;
    this._gpuBytes = 0;
    this._drawList = [];
  }
}

export function webglTileLayer(template: TileTemplate, options?: WebGLTileLayerOptions): WebGLTileLayer {
  // Explicit GPU factory — always constructs WebGLTileLayer (does not go through tileLayer auto/fallback).
  return new WebGLTileLayer(template, options);
}
