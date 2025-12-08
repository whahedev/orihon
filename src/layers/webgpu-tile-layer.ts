/**
 * Optional WebGPU raster basemap (`orihon/webgpu`).
 * Self-contained — does not import WebGLTileLayer. Node / missing GPU → renderer "none".
 */

import { createEl } from "../dom.js";
import { cameraWarpCss } from "../camera.js";
import { TILE_SIZE, LatLngBounds, latLngBounds, unproject, type LatLngBoundsLike } from "../geo.js";
import { Layer, type LayerOptions } from "../layer.js";
import type { Orihon } from "../map.js";
import { assertMercator } from "../crs.js";
import { modulo, nativeTileZoom, type TileTemplate } from "./tile-layer.js";
import { forEachTileInRect, forEachTileRectDelta, forEachMissingNeeded, MinHeap, tilePriority, type TileRect } from "./tile-grid.js";
import { WTinyLfu } from "../services/tiny-lfu.js";

export interface WebGPUTileLayerOptions extends LayerOptions {
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
    WebGPUTileLayerOptions,
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
  WebGPUTileLayerOptions;

export interface WebGPUTileLayerStats {
  renderer: "webgpu" | "none";
  needed: number;
  ready: number;
  loading: number;
  cached: number;
  gpuBytesApprox: number;
}

interface GpuTexture {
  destroy(): void;
  createView(): object;
}
interface GpuBindGroup {}
interface GpuBuffer {
  destroy(): void;
}
interface GpuSampler {}
interface GpuRenderPipeline {
  getBindGroupLayout(index: number): object;
}
interface GpuCanvasContext {
  configure(options: object): void;
  getCurrentTexture(): { createView(): object };
}
interface GpuCommandEncoder {
  beginRenderPass(desc: object): GpuRenderPass;
  finish(): object;
}
interface GpuRenderPass {
  setPipeline(pipeline: GpuRenderPipeline): void;
  setBindGroup(index: number, group: GpuBindGroup): void;
  draw(vertexCount: number): void;
  end(): void;
}
interface GpuDevice {
  createShaderModule(desc: { code: string }): object;
  createRenderPipeline(desc: object): GpuRenderPipeline;
  createSampler(desc: object): GpuSampler;
  createTexture(desc: object): GpuTexture;
  createBuffer(desc: object): GpuBuffer;
  createBindGroup(desc: object): GpuBindGroup;
  createCommandEncoder(): GpuCommandEncoder;
  queue: {
    copyExternalImageToTexture(source: object, dest: object, size: object): void;
    writeBuffer(buffer: GpuBuffer, offset: number, data: BufferSource): void;
    submit(commands: object[]): void;
  };
}
interface GpuAdapter {
  requestDevice(): Promise<GpuDevice>;
}
interface Gpu {
  requestAdapter(): Promise<GpuAdapter | null>;
  getPreferredCanvasFormat?(): string;
}

const GPUTextureUsage = { TEXTURE_BINDING: 0x04, COPY_DST: 0x02, RENDER_ATTACHMENT: 0x10 };
const GPUBufferUsage = { UNIFORM: 0x40, COPY_DST: 0x08 };

interface GpuTile {
  key: string;
  x: number;
  y: number;
  z: number;
  url: string;
  texture: GpuTexture | null;
  bindGroup: GpuBindGroup | null;
  uniform: GpuBuffer | null;
  image: HTMLImageElement | null;
  state: 0 | 1 | 2 | 3;
  lastUsed: number;
  byteSize: number;
  generation: number;
  priority: number;
}

const UNIFORM_FLOATS = 12;
const WGSL = `
struct Uniforms {
  origin: vec2f,
  resolution: vec2f,
  tileXY: vec2f,
  tilePixelSize: f32,
  dpr: f32,
  opacity: f32,
  _pad: f32,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};
@vertex
fn vs(@builtin(vertex_index) index: u32) -> VSOut {
  var uvs = array<vec2f, 4>(vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0), vec2f(1.0, 1.0));
  let uv = uvs[index];
  let pixel = (u.tileXY + uv) * u.tilePixelSize - u.origin;
  let clip = ((pixel * u.dpr) / u.resolution) * 2.0 - 1.0;
  return VSOut(vec4f(clip.x, -clip.y, 0.0, 1.0), uv);
}
@fragment
fn fs(input: VSOut) -> @location(0) vec4f {
  return textureSample(tex, samp, input.uv) * u.opacity;
}
`;

function normalizeBounds(value: unknown): LatLngBounds | null {
  if (!value) return null;
  const bounds = latLngBounds(value as LatLngBoundsLike);
  if (!bounds.isValid()) throw new TypeError("WebGPUTileLayer bounds must be a valid LatLngBounds");
  return bounds;
}

export class WebGPUTileLayer extends Layer<ResolvedOptions> {
  template: TileTemplate;
  canvas: HTMLCanvasElement | null = null;
  renderer: "webgpu" | "none" = "none";
  readonly tiles = new Map<string, GpuTile>();

  private _device: GpuDevice | null = null;
  private _context: GpuCanvasContext | null = null;
  private _pipeline: GpuRenderPipeline | null = null;
  private _sampler: GpuSampler | null = null;
  private _format = "bgra8unorm";
  private _tileZoom: number | null = null;
  private _needed = new Set<string>();
  private _neededCount = 0;
  private _retained = new Set<string>();
  private _drawList: GpuTile[] = [];
  private _queue = new MinHeap<GpuTile>((tile) => tile.priority);
  private _queuedKeys = new Set<string>();
  private _loading = 0;
  private _gpuBytes = 0;
  private _generation = 0;
  private _dirty = true;
  private _cssW = 0;
  private _cssH = 0;
  private _rect: TileRect | null = null;
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
  private readonly _lfu: WTinyLfu;
  private _initing = false;

  constructor(template: TileTemplate, options: WebGPUTileLayerOptions = {}) {
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
      className: "oh-webgpu-tile-layer",
      maxDpr: 1,
      ...options
    } as ResolvedOptions);
    this.template = template;
    this._bounds = normalizeBounds(this.options.bounds);
    this._retina = Boolean(
      this.options.detectRetina && typeof devicePixelRatio !== "undefined" && devicePixelRatio > 1
    );
    this._lfu = new WTinyLfu(Math.max(16, this.options.cacheSize));
  }

  getStats(): WebGPUTileLayerStats {
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
    this.canvas = createEl("canvas", this.options.className ?? "oh-webgpu-tile-layer", pane);
    this.canvas.style.position = "absolute";
    this.canvas.style.left = "0";
    this.canvas.style.top = "0";
    this.canvas.style.pointerEvents = "none";
    this.canvas.style.willChange = "transform";
    this.canvas.style.opacity = String(this.options.opacity);
    void this.#initGpu();
  }

  override onRemove(): void {
    if (this._redrawFrame && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this._redrawFrame);
      this._redrawFrame = 0;
    }
    this.#clearSettleTimer();
    this.#clearZoomSwitchTimer();
    this.#disposeAllTiles();
    this._pipeline = null;
    this._sampler = null;
    this._context = null;
    this._device = null;
    this.renderer = "none";
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
    this._rect = null;
    this._retained.clear();
    this._drawList = [];
    this._hasDrawn = false;
    super.onRemove();
  }

  override render(): void {
    if (!this.map || !this.canvas) return;
    if (this.renderer !== "webgpu" || !this._device || !this._context || !this._pipeline) {
      if (!this._initing) this.#syncTileGrid();
      return;
    }
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
      this._context.configure({
        device: this._device,
        format: this._format,
        alphaMode: "premultiplied",
        usage: GPUTextureUsage.RENDER_ATTACHMENT
      });
      this._dirty = true;
      this._hasDrawn = false;
      this._drawnZoom = Number.NaN;
    }

    const displayZoom = Math.round(this.map.zoom);
    if (displayZoom < this.options.minZoom || displayZoom > this.options.maxZoom) {
      this.canvas.style.transform = "";
      return;
    }

    this.#syncTileGrid();

    const zoom = this.map.zoom;
    const ox = this.map.pixelOrigin.x;
    const oy = this.map.pixelOrigin.y;
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const canWarp = this._hasDrawn && Number.isFinite(this._drawnZoom);
    const gpuDue = this._forceGpu || !canWarp || (this._dirty && now - this._lastGpuMs > 80);

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

  async #initGpu(): Promise<void> {
    if (!this.canvas || this._initing || this.renderer === "webgpu") return;
    const gpu = (navigator as Navigator & { gpu?: Gpu }).gpu;
    if (!gpu || typeof this.canvas.getContext !== "function") return;
    this._initing = true;
    try {
      const adapter = await gpu.requestAdapter();
      if (!adapter || !this.canvas) return;
      const device = await adapter.requestDevice();
      const context = (this.canvas as HTMLCanvasElement & { getContext(id: "webgpu"): GpuCanvasContext | null }).getContext("webgpu");
      if (!context) return;
      this._format = gpu.getPreferredCanvasFormat?.() ?? "bgra8unorm";
      const shader = device.createShaderModule({ code: WGSL });
      const pipeline = device.createRenderPipeline({
        layout: "auto",
        vertex: { module: shader, entryPoint: "vs" },
        fragment: {
          module: shader,
          entryPoint: "fs",
          targets: [{
            format: this._format,
            blend: {
              color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
              alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" }
            }
          }]
        },
        primitive: { topology: "triangle-strip" }
      });
      this._device = device;
      this._context = context;
      this._pipeline = pipeline;
      this._sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
      this.renderer = "webgpu";
      this._dirty = true;
      this.render();
    } catch {
      this.renderer = "none";
    } finally {
      this._initing = false;
    }
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

  #syncTileGrid(): void {
    if (!this.map) return;
    const nativeLimit = nativeTileZoom(this.options.maxNativeZoom, this.options.maxZoom);
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

    const nextRect: TileRect = { z: activeZoom, left, top, right, bottom };
    const candidates: Array<{ x: number; y: number; key: string; distance: number }> = [];
    const centerX = tileOriginX / size + this.map.size.width / displayScale / size / 2;
    const centerY = tileOriginY / size + this.map.size.height / displayScale / size / 2;
    const now = performance.now();
    const vx = this.map.panVelocity.x;
    const vy = this.map.panVelocity.y;

    const consider = (x: number, y: number): void => {
      if (y < 0 || y > worldMax) return;
      if (this.options.noWrap && (x < 0 || x > worldMax)) return;
      if (!this.#tileIntersectsBounds(x, y, activeZoom)) return;
      const key = `${activeZoom}:${x}:${y}`;
      this._needed.add(key);
      const existing = this.tiles.get(key);
      const distance = tilePriority(x, y, centerX, centerY, vx, vy, size);
      if (existing) {
        existing.lastUsed = now;
        existing.priority = distance;
        this._lfu.hit(key);
        if (existing.state === 0) this.#enqueue(existing);
      }
    };

    if (!this._rect || this._rect.z !== nextRect.z) {
      this._needed.clear();
      forEachTileInRect(nextRect, consider);
    } else {
      forEachTileRectDelta(this._rect, nextRect, consider, (x, y) => {
        this._needed.delete(`${activeZoom}:${x}:${y}`);
      });
    }
    this._rect = nextRect;

    forEachMissingNeeded(this._needed, (key) => this.tiles.has(key), (x, y, key) => {
      candidates.push({ x, y, key, distance: tilePriority(x, y, centerX, centerY, vx, vy, size) });
    });

    if (candidates.length > 1) candidates.sort((a, b) => a.distance - b.distance);
    const maxNew = Math.max(1, this.options.maxNewPerFrame);
    for (let i = 0; i < candidates.length && i < maxNew; i++) {
      const c = candidates[i];
      this.#createTile(c.x, c.y, activeZoom, c.key, c.distance);
    }
    if (candidates.length > maxNew) this.#scheduleRedraw();

    this._neededCount = this._needed.size;
    this.#pumpQueue();
    this.#evictLru();
  }

  #switchZoom(sourceZoom: number): void {
    this._retained = new Set(this._needed);
    this._tileZoom = sourceZoom;
    this._dirty = true;
    this._drawnZoom = Number.NaN;
    this._rect = null;
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

  #createTile(x: number, y: number, z: number, key: string, priority = 0): void {
    if (this.tiles.has(key)) return;
    const tile: GpuTile = {
      key,
      x,
      y,
      z,
      url: this.getTileUrl(x, y, z),
      texture: null,
      bindGroup: null,
      uniform: null,
      image: null,
      state: 0,
      lastUsed: performance.now(),
      byteSize: 0,
      generation: this._generation,
      priority
    };
    this.tiles.set(key, tile);
    const evicted = this._lfu.add(key);
    if (evicted && evicted !== key) {
      const old = this.tiles.get(evicted);
      if (old && !this._needed.has(evicted) && !this._retained.has(evicted)) this.#disposeTile(old);
    }
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
      const tile = this._queue.pop()!;
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
      const done = (source: ImageBitmap | HTMLImageElement, close?: () => void) => {
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

  #uploadTexture(tile: GpuTile, image: ImageBitmap | HTMLImageElement): boolean {
    const device = this._device;
    const pipeline = this._pipeline;
    const sampler = this._sampler;
    if (!device || !pipeline || !sampler) return false;
    const width = Math.max(1, image.width);
    const height = Math.max(1, image.height);
    const texture = device.createTexture({
      size: { width, height },
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
    });
    try {
      device.queue.copyExternalImageToTexture({ source: image }, { texture }, { width, height });
    } catch {
      texture.destroy();
      return false;
    }
    if (tile.texture) {
      tile.texture.destroy();
      this._gpuBytes = Math.max(0, this._gpuBytes - tile.byteSize);
    }
    tile.uniform?.destroy();
    tile.texture = texture;
    tile.byteSize = width * height * 4;
    this._gpuBytes += tile.byteSize;
    const uniforms = device.createBuffer({
      size: UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    tile.bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniforms } },
        { binding: 1, resource: texture.createView() },
        { binding: 2, resource: sampler }
      ]
    });
    tile.uniform = uniforms;
    return true;
  }

  #evictLru(): void {
    const limit = Math.max(16, this.options.cacheSize);
    if (this.tiles.size <= limit) return;
    const pinned = new Set<string>(this._needed);
    for (const key of this._retained) pinned.add(key);
    while (this.tiles.size > limit) {
      const key = this._lfu.evictExcept(pinned);
      if (!key) break;
      const tile = this.tiles.get(key);
      if (tile) this.#disposeTile(tile);
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
    const device = this._device;
    const context = this._context;
    const pipeline = this._pipeline;
    const map = this.map;
    if (!device || !context || !pipeline || !map || !this.canvas) return;
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: context.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: "clear",
        storeOp: "store"
      }]
    });
    pass.setPipeline(pipeline);
    const pad = this.options.tileSize;
    const viewW = map.size.width;
    const viewH = map.size.height;
    const zoom = map.zoom;
    const tileSize = this.options.tileSize;
    const data = new Float32Array(UNIFORM_FLOATS);
    data[0] = originX;
    data[1] = originY;
    data[2] = this.canvas.width;
    data[3] = this.canvas.height;
    data[7] = dpr;
    data[8] = this.options.opacity;
    for (const tile of this._drawList) {
      const tilePixelSize = tileSize * 2 ** (zoom - tile.z);
      const left = tile.x * tilePixelSize - originX;
      const top = tile.y * tilePixelSize - originY;
      if (left > viewW + pad || top > viewH + pad || left + tilePixelSize < -pad || top + tilePixelSize < -pad) {
        continue;
      }
      const bindGroup = tile.bindGroup;
      const uniform = tile.uniform;
      if (!bindGroup || !uniform) continue;
      data[4] = tile.x;
      data[5] = tile.y;
      data[6] = tilePixelSize;
      device.queue.writeBuffer(uniform, 0, data);
      pass.setBindGroup(0, bindGroup);
      pass.draw(4);
    }
    pass.end();
    device.queue.submit([encoder.finish()]);
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
    if (tile.texture) {
      tile.texture.destroy();
      this._gpuBytes = Math.max(0, this._gpuBytes - tile.byteSize);
    }
    tile.uniform?.destroy();
    tile.uniform = null;
    tile.texture = null;
    tile.bindGroup = null;
    this.tiles.delete(tile.key);
    this._lfu.delete(tile.key);
    this._queuedKeys.delete(tile.key);
    this._retained.delete(tile.key);
    this._queue.removeWhere((item) => item === tile);
  }

  #disposeAllTiles(): void {
    for (const tile of [...this.tiles.values()]) this.#disposeTile(tile);
    this.tiles.clear();
    this._queue.clear();
    this._queuedKeys.clear();
    this._loading = 0;
    this._gpuBytes = 0;
    this._drawList = [];
    this._rect = null;
  }
}

export function webgpuTileLayer(template: TileTemplate, options?: WebGPUTileLayerOptions): WebGPUTileLayer {
  return new WebGPUTileLayer(template, options);
}
