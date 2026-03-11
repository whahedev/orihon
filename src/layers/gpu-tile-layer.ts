/**
 * Unified GPU raster basemap (Advanced tier) — WebGPU with WebGL fallback.
 *
 * Perf notes (vs DOM tiles / MapLibre):
 * - Coalesce texture uploads → one rAF redraw (never render() per onload)
 * - Same-zoom pan: CSS translate of the last framebuffer when the needed set is unchanged
 * - Draw only needed + retained tiles (not the whole LRU)
 * - Debounce integer zoom switches during continuous camera stress
 */

import { createEl } from "../dom.js";
import { cameraWarpCoversViewport, cameraWarpCss } from "../camera.js";
import { TILE_SIZE, LatLngBounds, unproject, type LatLngBoundsLike } from "../geo.js";
import { Layer, type LayerOptions } from "../layer.js";
import type { RasterTileEventDetail } from "./tile-layer.js";
import type { Orihon } from "../map.js";
import { assertMercator } from "../crs.js";
import { compileShader } from "../webgl-utils.js";
import { modulo, nativeTileZoom, normalizeTileBounds, type TileTemplate } from "./tile-layer.js";
import {
  forEachTileInRect,
  forEachTileRectDelta,
  forEachMissingNeeded,
  MinHeap,
  nearestReadyAncestorKey,
  tileLookaheadPadding,
  tilePriority,
  tileSetCoverage,
  type TileRect
} from "./tile-grid.js";
import { WTinyLfu } from "../services/tiny-lfu.js";

export type GPUTileBackend = "auto" | "webgpu" | "webgl";

export interface GPUTileLayerOptions extends LayerOptions {
  /** Preferred renderer. Auto selects WebGPU, then WebGL. */
  backend?: GPUTileBackend;
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
    GPUTileLayerOptions,
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
    | "backend"
  >
> &
  GPUTileLayerOptions;

export interface GPUTileLayerStats {
  renderer: "webgpu" | "webgl" | "none";
  needed: number;
  visibleReady: number;
  preloadNeeded: number;
  preloadReady: number;
  coveragePct: number;
  ready: number;
  loading: number;
  cached: number;
  gpuBytesApprox: number;
}

interface WebGpuTexture { destroy(): void; createView(): object }
interface WebGpuBindGroup {}
interface WebGpuBuffer { destroy(): void }
interface WebGpuSampler {}
interface WebGpuRenderPipeline { getBindGroupLayout(index: number): object }
interface WebGpuCanvasContext { configure(options: object): void; getCurrentTexture(): { createView(): object } }
interface WebGpuRenderPass {
  setPipeline(pipeline: WebGpuRenderPipeline): void;
  setBindGroup(index: number, group: WebGpuBindGroup): void;
  draw(vertexCount: number): void;
  end(): void;
}
interface WebGpuDevice {
  createShaderModule(desc: { code: string }): object;
  createRenderPipeline(desc: object): WebGpuRenderPipeline;
  createSampler(desc: object): WebGpuSampler;
  createTexture(desc: object): WebGpuTexture;
  createBuffer(desc: object): WebGpuBuffer;
  createBindGroup(desc: object): WebGpuBindGroup;
  createCommandEncoder(): { beginRenderPass(desc: object): WebGpuRenderPass; finish(): object };
  queue: {
    copyExternalImageToTexture(source: object, dest: object, size: object): void;
    writeBuffer(buffer: WebGpuBuffer, offset: number, data: BufferSource): void;
    submit(commands: object[]): void;
  };
}
interface WebGpuAdapter { requestDevice(): Promise<WebGpuDevice> }
interface WebGpuApi { requestAdapter(): Promise<WebGpuAdapter | null>; getPreferredCanvasFormat?(): string }

const GPU_TEXTURE_USAGE = { TEXTURE_BINDING: 0x04, COPY_DST: 0x02, RENDER_ATTACHMENT: 0x10 };
const GPU_BUFFER_USAGE = { UNIFORM: 0x40, COPY_DST: 0x08 };
const WEBGPU_UNIFORM_FLOATS = 12;
const WEBGPU_SHADER = `
struct Uniforms { origin: vec2f, resolution: vec2f, tileXY: vec2f, tilePixelSize: f32, dpr: f32, opacity: f32, _pad: f32 };
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) index: u32) -> VSOut {
  var uvs = array<vec2f, 4>(vec2f(0.0,0.0), vec2f(1.0,0.0), vec2f(0.0,1.0), vec2f(1.0,1.0));
  let uv = uvs[index];
  let pixel = (u.tileXY + uv) * u.tilePixelSize - u.origin;
  let clip = ((pixel * u.dpr) / u.resolution) * 2.0 - 1.0;
  return VSOut(vec4f(clip.x, -clip.y, 0.0, 1.0), uv);
}
@fragment fn fs(input: VSOut) -> @location(0) vec4f { return textureSample(tex, samp, input.uv) * u.opacity; }
`;

interface GpuTile {
  key: string;
  x: number;
  y: number;
  z: number;
  url: string;
  texture: WebGLTexture | WebGpuTexture | null;
  bindGroup: WebGpuBindGroup | null;
  uniform: WebGpuBuffer | null;
  image: HTMLImageElement | null;
  /** 0 idle · 1 loading · 2 ready · 3 error */
  state: 0 | 1 | 2 | 3;
  lastUsed: number;
  byteSize: number;
  generation: number;
  slot: number;
  priority: number;
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

interface GL2Locs {
  aUv: number;
  aTileXY: number;
  aTilePixelSize: number;
  aSlot: number;
  uOrigin: WebGLUniformLocation | null;
  uResolution: WebGLUniformLocation | null;
  uDpr: WebGLUniformLocation | null;
  uOpacity: WebGLUniformLocation | null;
  uTexture: WebGLUniformLocation | null;
}

export interface GPUTileLayerEventMap {
  tileloadstart: Omit<RasterTileEventDetail, "tile">;
  tileload: Omit<RasterTileEventDetail, "tile">;
  tileerror: Omit<RasterTileEventDetail, "tile">;
  tileabort: Omit<RasterTileEventDetail, "tile">;
}

export class GPUTileLayer extends Layer<ResolvedOptions, GPUTileLayerEventMap> {
  template: TileTemplate;
  canvas: HTMLCanvasElement | null = null;
  gl: WebGLRenderingContext | null = null;
  gl2: WebGL2RenderingContext | null = null;
  renderer: "webgpu" | "webgl" | "none" = "none";

  readonly tiles = new Map<string, GpuTile>();

  private program: WebGLProgram | null = null;
  private program2: WebGLProgram | null = null;
  private quadBuffer: WebGLBuffer | null = null;
  private instanceBuffer: WebGLBuffer | null = null;
  private locs: GLLocs | null = null;
  private locs2: GL2Locs | null = null;
  private _gpuDevice: WebGpuDevice | null = null;
  private _gpuContext: WebGpuCanvasContext | null = null;
  private _gpuPipeline: WebGpuRenderPipeline | null = null;
  private _gpuSampler: WebGpuSampler | null = null;
  private _gpuFormat = "bgra8unorm";
  private _gpuIniting = false;
  private _useArray = false;
  private _arrayTex: WebGLTexture | null = null;
  private _arrayDim = 0;
  private _arrayLayers = 0;
  private _freeSlots: number[] = [];
  private _instanceData = new Float32Array(0);
  private _tileZoom: number | null = null;
  private _needed = new Set<string>();
  private _neededCount = 0;
  private _retained = new Set<string>();
  /** Next coarser viewport, loaded at low priority for seamless zoom-out. */
  private _preload = new Set<string>();
  /** Coarsest level at the start of a zoom-in round-trip, pinned for instant zoom-back. */
  private _zoomBackstop = new Set<string>();
  private _zoomBackstopZoom: number | null = null;
  /** View tiles visited during the active zoom round-trip; released at its floor. */
  private _zoomHistory = new Set<string>();
  private _drawList: GpuTile[] = [];
  private _generation = 0;
  private _loading = 0;
  private _cssW = 0;
  private _cssH = 0;
  private _gpuBytes = 0;
  private _queue = new MinHeap<GpuTile>((tile) => tile.priority);
  private _queuedKeys = new Set<string>();
  private _rect: TileRect | null = null;
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
  private readonly _lfu: WTinyLfu;

  constructor(template: TileTemplate, options: GPUTileLayerOptions = {}) {
    super({
      pane: "tile",
      minZoom: 0,
      maxZoom: 19,
      maxNativeZoom: undefined,
      tileSize: TILE_SIZE,
      buffer: 0,
      cacheSize: 256,
      maxRequests: 16,
      maxNewPerFrame: 12,
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
      className: "oh-gpu-tile-layer",
      maxDpr: 1,
      backend: "auto",
      ...options
    } as ResolvedOptions);
    this.template = template;
    this._bounds = normalizeTileBounds(this.options.bounds, "GPUTileLayer bounds must be a valid LatLngBounds");
    this._retina = Boolean(
      this.options.detectRetina && typeof devicePixelRatio !== "undefined" && devicePixelRatio > 1
    );
    this._lfu = new WTinyLfu(Math.max(16, this.options.cacheSize));
  }

  getStats(): GPUTileLayerStats {
    let ready = 0;
    for (const tile of this.tiles.values()) if (tile.state === 2) ready += 1;
    let visibleReady = 0;
    for (const key of this._needed) if (this.tiles.get(key)?.state === 2) visibleReady += 1;
    let preloadReady = 0;
    for (const key of this._preload) if (this.tiles.get(key)?.state === 2) preloadReady += 1;
    const isReady = (key: string) => this.tiles.get(key)?.state === 2;
    return {
      renderer: this.renderer,
      needed: this._neededCount,
      visibleReady,
      preloadNeeded: this._preload.size,
      preloadReady,
      coveragePct: tileSetCoverage(this._needed, isReady) * 100,
      ready,
      loading: this._loading,
      cached: this.tiles.size,
      gpuBytesApprox: this._gpuBytes + (this._useArray ? this._arrayDim * this._arrayDim * 4 * this._arrayLayers : 0)
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
    this.canvas = createEl("canvas", this.options.className ?? "oh-gpu-tile-layer", pane);
    this.canvas.style.position = "absolute";
    this.canvas.style.left = "0";
    this.canvas.style.top = "0";
    this.canvas.style.pointerEvents = "none";
    this.canvas.style.willChange = "transform";
    this.canvas.style.opacity = String(this.options.opacity);
    this._dirty = true;
    const wantsWebGpu = this.options.backend !== "webgl" && this.#webGpuAvailable();
    if (wantsWebGpu) void this.#initWebGpu();
    else if (this.options.backend !== "webgpu") this.#initWebGl();
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
    this._rect = null;
    this._retained.clear();
    this._preload.clear();
    this._zoomBackstop.clear();
    this._zoomBackstopZoom = null;
    this._zoomHistory.clear();
    this._drawList = [];
    this._hasDrawn = false;
    super.onRemove();
  }

  override render(): void {
    if (!this.map || !this.canvas || this.renderer === "none") return;
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
    const warpCoversViewport = canWarp && cameraWarpCoversViewport(
      { x: this._drawnOriginX, y: this._drawnOriginY },
      this._drawnZoom,
      { x: ox, y: oy },
      zoom,
      { width, height }
    );
    const gpuDue = this._forceGpu || !warpCoversViewport || (this._dirty && now - this._lastGpuMs > 80);

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
    if (this.renderer === "webgpu") this.#drawFrameWebGpu(dpr, ox, oy);
    else this.#drawFrame(dpr, ox, oy);
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

  #webGpuAvailable(): boolean {
    return typeof navigator !== "undefined" && Boolean((navigator as Navigator & { gpu?: unknown }).gpu);
  }

  #initWebGl(): boolean {
    if (!this.canvas) return false;
    const glAttrs: WebGLContextAttributes = {
      antialias: false,
      alpha: true,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      powerPreference: "high-performance",
      preserveDrawingBuffer: false
    };
    this.gl2 = this.canvas.getContext("webgl2", glAttrs) as WebGL2RenderingContext | null;
    this.gl = this.gl2 || this.canvas.getContext("webgl", glAttrs);
    if (!this.gl || !this.#initPipeline()) {
      this.renderer = "none";
      this.gl = null;
      this.gl2 = null;
      return false;
    }
    this.renderer = "webgl";
    if (this.gl2) this.#initPipelineGL2();
    this._dirty = true;
    this.render();
    return true;
  }

  async #initWebGpu(): Promise<void> {
    if (!this.canvas || this._gpuIniting || this.renderer === "webgpu") return;
    this._gpuIniting = true;
    try {
      const gpu = (navigator as Navigator & { gpu?: WebGpuApi }).gpu;
      if (!gpu) throw new Error("WebGPU unavailable");
      const adapter = await gpu.requestAdapter();
      const device = await adapter?.requestDevice();
      if (!device) throw new Error("WebGPU device unavailable");
      const context = this.canvas.getContext("webgpu") as unknown as WebGpuCanvasContext | null;
      if (!context || !this.canvas || !this.map) throw new Error("WebGPU initialization failed");
      this._gpuFormat = gpu.getPreferredCanvasFormat?.() ?? "bgra8unorm";
      context.configure({ device, format: this._gpuFormat, alphaMode: "premultiplied" });
      const shader = device.createShaderModule({ code: WEBGPU_SHADER });
      const pipeline = device.createRenderPipeline({
        layout: "auto",
        vertex: { module: shader, entryPoint: "vs" },
        fragment: {
          module: shader,
          entryPoint: "fs",
          targets: [{
            format: this._gpuFormat,
            blend: {
              color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
              alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" }
            }
          }]
        },
        primitive: { topology: "triangle-strip" }
      });
      this._gpuDevice = device;
      this._gpuContext = context;
      this._gpuPipeline = pipeline;
      this._gpuSampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
      this.renderer = "webgpu";
      this._dirty = true;
      this.render();
    } catch {
      this.renderer = "none";
      // A visible tile layer must not disappear merely because navigator.gpu
      // exists while adapter/device creation fails. Preserve the complete GPU
      // tile feature set through the shared WebGL implementation.
      this.#initWebGl();
    } finally {
      this._gpuIniting = false;
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

  #initPipelineGL2(): boolean {
    const gl = this.gl2;
    if (!gl) return false;
    const vertex = compileShader(gl, gl.VERTEX_SHADER, `#version 300 es
      in vec2 a_uv;
      in vec2 a_tileXY;
      in float a_tilePixelSize;
      in float a_slot;
      uniform vec2 u_origin;
      uniform vec2 u_resolution;
      uniform float u_dpr;
      out vec2 v_uv;
      out float v_slot;
      void main() {
        v_uv = a_uv;
        v_slot = a_slot;
        vec2 pixel = (a_tileXY + a_uv) * a_tilePixelSize - u_origin;
        vec2 clip = ((pixel * u_dpr) / u_resolution) * 2.0 - 1.0;
        gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
      }
    `);
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, `#version 300 es
      precision mediump float;
      precision highp sampler2DArray;
      in vec2 v_uv;
      in float v_slot;
      uniform sampler2DArray u_texture;
      uniform float u_opacity;
      out vec4 fragColor;
      void main() {
        fragColor = texture(u_texture, vec3(v_uv, v_slot)) * u_opacity;
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
    const dim = this._retina ? this.options.tileSize * 2 : this.options.tileSize;
    const maxLayers = Math.min(gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) || 64, Math.max(32, this.options.cacheSize));
    const texture = gl.createTexture();
    if (!texture) {
      gl.deleteProgram(program);
      return false;
    }
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    try {
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, dim, dim, maxLayers);
    } catch {
      gl.deleteTexture(texture);
      gl.deleteProgram(program);
      return false;
    }
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this.program2 = program;
    this._arrayTex = texture;
    this._arrayDim = dim;
    this._arrayLayers = maxLayers;
    this._freeSlots = Array.from({ length: maxLayers }, (_, i) => i);
    this.instanceBuffer = gl.createBuffer();
    this.locs2 = {
      aUv: gl.getAttribLocation(program, "a_uv"),
      aTileXY: gl.getAttribLocation(program, "a_tileXY"),
      aTilePixelSize: gl.getAttribLocation(program, "a_tilePixelSize"),
      aSlot: gl.getAttribLocation(program, "a_slot"),
      uOrigin: gl.getUniformLocation(program, "u_origin"),
      uResolution: gl.getUniformLocation(program, "u_resolution"),
      uDpr: gl.getUniformLocation(program, "u_dpr"),
      uOpacity: gl.getUniformLocation(program, "u_opacity"),
      uTexture: gl.getUniformLocation(program, "u_texture")
    };
    this._useArray = true;
    return true;
  }

  #disposePipeline(): void {
    const gl = this.gl;
    if (gl) {
      try {
        if (this.quadBuffer) gl.deleteBuffer(this.quadBuffer);
        if (this.instanceBuffer) gl.deleteBuffer(this.instanceBuffer);
        if (this._arrayTex) gl.deleteTexture(this._arrayTex);
        if (this.program2) gl.deleteProgram(this.program2);
        if (this.program) gl.deleteProgram(this.program);
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      } catch {
        /* ignore */
      }
    }
    this.quadBuffer = null;
    this.instanceBuffer = null;
    this._arrayTex = null;
    this.program2 = null;
    this.program = null;
    this.locs = null;
    this.locs2 = null;
    this.gl = null;
    this.gl2 = null;
    this._useArray = false;
    this._freeSlots = [];
    this._gpuDevice = null;
    this._gpuContext = null;
    this._gpuPipeline = null;
    this._gpuSampler = null;
    this.renderer = "none";
  }

  #clear(): void {
    if (this.renderer === "webgpu") {
      this._drawList = [];
      this.#drawFrameWebGpu(1, 0, 0);
      return;
    }
    const gl = this.gl;
    if (!gl || !this.canvas) return;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
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
    const vx = this.map.panVelocity.x;
    const vy = this.map.panVelocity.y;
    const lead = tileLookaheadPadding(vx, vy, size);
    const left = Math.floor(tileOriginX / size) - this.options.buffer - lead.left;
    const top = Math.floor(tileOriginY / size) - this.options.buffer - lead.top;
    const right = Math.floor((tileOriginX + this.map.size.width / displayScale) / size) + this.options.buffer + lead.right;
    const bottom = Math.floor((tileOriginY + this.map.size.height / displayScale) / size) + this.options.buffer + lead.bottom;
    const worldMax = 2 ** activeZoom - 1;

    const nextRect: TileRect = { z: activeZoom, left, top, right, bottom };
    const candidates: Array<{ x: number; y: number; z: number; key: string; distance: number }> = [];
    const centerX = tileOriginX / size + this.map.size.width / displayScale / size / 2;
    const centerY = tileOriginY / size + this.map.size.height / displayScale / size / 2;
    const now = performance.now();

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
        if (existing.state === 0) this.#reprioritize(existing);
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
      candidates.push({ x, y, z: activeZoom, key, distance: tilePriority(x, y, centerX, centerY, vx, vy, size) });
    });

    // Preload the next coarser viewport. Unlike retaining the previous
    // framebuffer, these tiles also cover the geographic area newly revealed
    // by zooming out, so the canvas never collapses into a central mosaic.
    const preload = new Set<string>();
    const preloadDepth = Math.min(1, activeZoom);
    for (let depth = 1; depth <= preloadDepth; depth++) {
      const z = activeZoom - depth;
      // Preserve the fractional zoom while looking `depth` levels ahead:
      // future display zoom = current display zoom - depth.
      const scaleAtZ = 2 ** (this.map.zoom - activeZoom);
      const centerAtZ = this.map.crs.project(this.map.center, z);
      const viewWidth = this.map.size.width / scaleAtZ;
      const viewHeight = this.map.size.height / scaleAtZ;
      const preloadLeft = Math.floor((centerAtZ.x - viewWidth / 2) / size);
      const preloadTop = Math.floor((centerAtZ.y - viewHeight / 2) / size);
      const preloadRight = Math.floor((centerAtZ.x + viewWidth / 2) / size);
      const preloadBottom = Math.floor((centerAtZ.y + viewHeight / 2) / size);
      const preloadWorldMax = 2 ** z - 1;
      forEachTileInRect(
        { z, left: preloadLeft, top: preloadTop, right: preloadRight, bottom: preloadBottom },
        (x, y) => {
          if (y < 0 || y > preloadWorldMax) return;
          if (this.options.noWrap && (x < 0 || x > preloadWorldMax)) return;
          if (!this.#tileIntersectsBounds(x, y, z)) return;
          const key = `${z}:${x}:${y}`;
          preload.add(key);
          const distance = 100 + depth * 16 + Math.hypot(x + 0.5 - centerAtZ.x / size, y + 0.5 - centerAtZ.y / size);
          const existing = this.tiles.get(key);
          if (existing) {
            existing.lastUsed = now;
            existing.priority = distance;
            this._lfu.hit(key);
            if (existing.state === 0) this.#reprioritize(existing);
          } else {
            candidates.push({ x, y, z, key, distance });
          }
        }
      );
    }
    this._preload = preload;

    if (candidates.length > 1) candidates.sort((a, b) => a.distance - b.distance);
    const maxNew = Math.max(1, this.options.maxNewPerFrame);
    for (let i = 0; i < candidates.length && i < maxNew; i++) {
      const c = candidates[i];
      this.#createTile(c.x, c.y, c.z, c.key, c.distance);
    }
    if (candidates.length > maxNew) this.#scheduleRedraw();

    this._neededCount = this._needed.size;
    this.#pumpQueue();
    this.#evictLru();
  }

  #switchZoom(sourceZoom: number): void {
    const previousZoom = this._tileZoom;
    if (previousZoom != null && sourceZoom > previousZoom) {
      if (this._zoomBackstopZoom == null || previousZoom <= this._zoomBackstopZoom) {
        this._zoomBackstop = new Set(this._needed);
        this._zoomBackstopZoom = previousZoom;
      }
      for (const key of this._needed) this._zoomHistory.add(key);
      for (const key of this._preload) this._zoomHistory.add(key);
    } else if (this._zoomBackstopZoom != null) {
      for (const key of this._needed) this._zoomHistory.add(key);
      if (sourceZoom <= this._zoomBackstopZoom) {
        this._zoomBackstop.clear();
        this._zoomBackstopZoom = null;
        this._zoomHistory.clear();
      }
    }
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
      slot: -1,
      priority
    };
    this.tiles.set(key, tile);
    const evicted = this._lfu.add(key);
    if (evicted && evicted !== key) {
      const old = this.tiles.get(evicted);
      if (
        old
        && !this._needed.has(evicted)
        && !this._retained.has(evicted)
        && !this._preload.has(evicted)
        && !this._zoomBackstop.has(evicted)
        && !this._zoomHistory.has(evicted)
      ) this.#disposeTile(old);
    }
    this.#enqueue(tile);
  }

  #enqueue(tile: GpuTile): void {
    if (tile.state !== 0 || this._queuedKeys.has(tile.key)) return;
    this._queuedKeys.add(tile.key);
    this._queue.push(tile);
  }

  #reprioritize(tile: GpuTile): void {
    if (tile.state !== 0) return;
    if (this._queuedKeys.has(tile.key)) {
      this._queue.removeWhere((queued) => queued === tile);
      this._queuedKeys.delete(tile.key);
    }
    this.#enqueue(tile);
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
    this.emit("tileloadstart", { x: tile.x, y: tile.y, z: tile.z, url: tile.url });
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
        if (uploaded) {
          this.emit("tileload", { x: tile.x, y: tile.y, z: tile.z, url: tile.url });
          this.#scheduleRedraw();
        } else {
          this.emit("tileerror", { x: tile.x, y: tile.y, z: tile.z, url: tile.url });
        }
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
      this.emit("tileerror", { x: tile.x, y: tile.y, z: tile.z, url: tile.url });
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
    if (this.renderer === "webgpu") return this.#uploadTextureWebGpu(tile, image);
    const gl2 = this.gl2;
    if (
      this._useArray
      && gl2
      && this._arrayTex
      && image.width === this._arrayDim
      && image.height === this._arrayDim
    ) {
      let slot = tile.slot;
      if (slot < 0) slot = this._freeSlots.pop() ?? -1;
      if (slot >= 0) {
        gl2.bindTexture(gl2.TEXTURE_2D_ARRAY, this._arrayTex);
        gl2.pixelStorei(gl2.UNPACK_FLIP_Y_WEBGL, 0);
        gl2.pixelStorei(gl2.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
        try {
          gl2.texSubImage3D(
            gl2.TEXTURE_2D_ARRAY,
            0,
            0,
            0,
            slot,
            this._arrayDim,
            this._arrayDim,
            1,
            gl2.RGBA,
            gl2.UNSIGNED_BYTE,
            image
          );
        } catch {
          this._freeSlots.push(slot);
          return false;
        }
        if (tile.texture && this.gl) {
          this.gl.deleteTexture(tile.texture as WebGLTexture);
          this._gpuBytes = Math.max(0, this._gpuBytes - tile.byteSize);
          tile.texture = null;
        }
        tile.slot = slot;
        tile.byteSize = 0;
        return true;
      }
    }
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
      gl.deleteTexture(tile.texture as WebGLTexture);
      this._gpuBytes = Math.max(0, this._gpuBytes - tile.byteSize);
    }
    tile.texture = texture;
    tile.byteSize = Math.max(1, image.width) * Math.max(1, image.height) * 4;
    this._gpuBytes += tile.byteSize;
    return true;
  }

  #uploadTextureWebGpu(tile: GpuTile, image: TexImageSource & { width: number; height: number }): boolean {
    const device = this._gpuDevice;
    const pipeline = this._gpuPipeline;
    const sampler = this._gpuSampler;
    if (!device || !pipeline || !sampler) return false;
    const width = Math.max(1, image.width);
    const height = Math.max(1, image.height);
    const texture = device.createTexture({
      size: { width, height },
      format: "rgba8unorm",
      usage: GPU_TEXTURE_USAGE.TEXTURE_BINDING | GPU_TEXTURE_USAGE.COPY_DST | GPU_TEXTURE_USAGE.RENDER_ATTACHMENT
    });
    try {
      device.queue.copyExternalImageToTexture({ source: image }, { texture }, { width, height });
    } catch {
      texture.destroy();
      return false;
    }
    if (tile.texture) {
      (tile.texture as WebGpuTexture).destroy();
      this._gpuBytes = Math.max(0, this._gpuBytes - tile.byteSize);
    }
    tile.uniform?.destroy();
    tile.texture = texture;
    tile.byteSize = width * height * 4;
    this._gpuBytes += tile.byteSize;
    const uniform = device.createBuffer({
      size: WEBGPU_UNIFORM_FLOATS * 4,
      usage: GPU_BUFFER_USAGE.UNIFORM | GPU_BUFFER_USAGE.COPY_DST
    });
    tile.bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: texture.createView() },
        { binding: 2, resource: sampler }
      ]
    });
    tile.uniform = uniform;
    return true;
  }

  #evictLru(): void {
    const limit = Math.max(16, this.options.cacheSize);
    if (this.tiles.size <= limit) return;
    const pinned = new Set<string>(this._needed);
    for (const key of this._retained) pinned.add(key);
    for (const key of this._preload) pinned.add(key);
    for (const key of this._zoomBackstop) pinned.add(key);
    for (const key of this._zoomHistory) pinned.add(key);
    while (this.tiles.size > limit) {
      const key = this._lfu.evictExcept(pinned) ?? this.#oldestUnpinnedTile(pinned);
      if (!key) break;
      const tile = this.tiles.get(key);
      if (tile) this.#disposeTile(tile);
    }
  }

  #oldestUnpinnedTile(pinned: ReadonlySet<string>): string | undefined {
    let oldest: GpuTile | undefined;
    for (const tile of this.tiles.values()) {
      if (pinned.has(tile.key)) continue;
      if (!oldest || tile.lastUsed < oldest.lastUsed) oldest = tile;
    }
    return oldest?.key;
  }

  #rebuildDrawList(): void {
    const selected = new Set<string>();
    const isReady = (key: string): boolean => {
      const tile = this.tiles.get(key);
      return Boolean(tile && tile.state === 2 && (tile.texture || tile.slot >= 0));
    };
    const select = (key: string): void => {
      if (isReady(key)) selected.add(key);
    };

    // Coarse-to-fine painter's order: a ready parent/backstop fills every gap,
    // then retained/detail tiles replace it as soon as their textures arrive.
    for (const key of this._preload) select(key);
    for (const key of this._zoomBackstop) select(key);
    for (const key of this._needed) {
      const ancestor = nearestReadyAncestorKey(key, isReady);
      if (ancestor) selected.add(ancestor);
    }
    for (const key of this._retained) select(key);
    for (const key of this._needed) select(key);

    this._drawList = [...selected]
      .map((key) => this.tiles.get(key))
      .filter((tile): tile is GpuTile => Boolean(tile))
      .sort((a, b) => a.z - b.z);
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

    const pad = this.options.tileSize;
    const viewW = map.size.width;
    const viewH = map.size.height;
    const zoom = map.zoom;
    const tileSize = this.options.tileSize;
    const visible: GpuTile[] = [];
    for (let i = 0; i < this._drawList.length; i++) {
      const tile = this._drawList[i];
      const tilePixelSize = tileSize * 2 ** (zoom - tile.z);
      const left = tile.x * tilePixelSize - originX;
      const top = tile.y * tilePixelSize - originY;
      if (left > viewW + pad || top > viewH + pad || left + tilePixelSize < -pad || top + tilePixelSize < -pad) {
        continue;
      }
      visible.push(tile);
    }

    const arrayTiles: GpuTile[] = [];
    const classic: GpuTile[] = [];
    if (this._useArray && this.gl2 && this.program2 && this.locs2 && this._arrayTex) {
      for (const tile of visible) {
        if (tile.slot >= 0) arrayTiles.push(tile);
        else classic.push(tile);
      }
    } else {
      classic.push(...visible);
    }

    if (arrayTiles.length) this.#drawArrayTiles(arrayTiles, dpr, originX, originY, zoom, tileSize);
    if (!classic.length) return;

    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(locs.aUv);
    gl.vertexAttribPointer(locs.aUv, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(locs.uOrigin, originX, originY);
    gl.uniform2f(locs.uResolution, this.canvas.width, this.canvas.height);
    gl.uniform1f(locs.uDpr, dpr);
    gl.uniform1f(locs.uOpacity, 1);
    gl.uniform1i(locs.uTexture, 0);
    gl.activeTexture(gl.TEXTURE0);

    for (let i = 0; i < classic.length; i++) {
      const tile = classic[i];
      if (!tile.texture) continue;
      gl.bindTexture(gl.TEXTURE_2D, tile.texture);
      gl.uniform2f(locs.uTileXY, tile.x, tile.y);
      gl.uniform1f(locs.uTilePixelSize, tileSize * 2 ** (zoom - tile.z));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  #drawArrayTiles(
    tiles: GpuTile[],
    dpr: number,
    originX: number,
    originY: number,
    zoom: number,
    tileSize: number
  ): void {
    const gl = this.gl2;
    const locs = this.locs2;
    if (!gl || !locs || !this.program2 || !this.quadBuffer || !this.instanceBuffer || !this._arrayTex || !this.canvas) {
      return;
    }
    const count = tiles.length;
    const floats = count * 4;
    if (this._instanceData.length < floats) this._instanceData = new Float32Array(Math.max(floats, 64));
    const data = this._instanceData;
    for (let i = 0; i < count; i++) {
      const tile = tiles[i];
      const o = i * 4;
      data[o] = tile.x;
      data[o + 1] = tile.y;
      data[o + 2] = tileSize * 2 ** (zoom - tile.z);
      data[o + 3] = tile.slot;
    }
    gl.useProgram(this.program2);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(locs.aUv);
    gl.vertexAttribPointer(locs.aUv, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(locs.aUv, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, floats), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(locs.aTileXY);
    gl.vertexAttribPointer(locs.aTileXY, 2, gl.FLOAT, false, 16, 0);
    gl.vertexAttribDivisor(locs.aTileXY, 1);
    gl.enableVertexAttribArray(locs.aTilePixelSize);
    gl.vertexAttribPointer(locs.aTilePixelSize, 1, gl.FLOAT, false, 16, 8);
    gl.vertexAttribDivisor(locs.aTilePixelSize, 1);
    gl.enableVertexAttribArray(locs.aSlot);
    gl.vertexAttribPointer(locs.aSlot, 1, gl.FLOAT, false, 16, 12);
    gl.vertexAttribDivisor(locs.aSlot, 1);

    gl.uniform2f(locs.uOrigin, originX, originY);
    gl.uniform2f(locs.uResolution, this.canvas.width, this.canvas.height);
    gl.uniform1f(locs.uDpr, dpr);
    gl.uniform1f(locs.uOpacity, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this._arrayTex);
    gl.uniform1i(locs.uTexture, 0);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);

    gl.vertexAttribDivisor(locs.aTileXY, 0);
    gl.vertexAttribDivisor(locs.aTilePixelSize, 0);
    gl.vertexAttribDivisor(locs.aSlot, 0);
    gl.disableVertexAttribArray(locs.aTileXY);
    gl.disableVertexAttribArray(locs.aTilePixelSize);
    gl.disableVertexAttribArray(locs.aSlot);
  }

  #drawFrameWebGpu(dpr: number, originX: number, originY: number): void {
    const device = this._gpuDevice;
    const context = this._gpuContext;
    const pipeline = this._gpuPipeline;
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
    const data = new Float32Array(WEBGPU_UNIFORM_FLOATS);
    data[0] = originX;
    data[1] = originY;
    data[2] = this.canvas.width;
    data[3] = this.canvas.height;
    data[7] = dpr;
    data[8] = 1;
    for (const tile of this._drawList) {
      const tilePixelSize = tileSize * 2 ** (zoom - tile.z);
      const left = tile.x * tilePixelSize - originX;
      const top = tile.y * tilePixelSize - originY;
      if (left > viewW + pad || top > viewH + pad || left + tilePixelSize < -pad || top + tilePixelSize < -pad) continue;
      if (!tile.bindGroup || !tile.uniform) continue;
      data[4] = tile.x;
      data[5] = tile.y;
      data[6] = tilePixelSize;
      device.queue.writeBuffer(tile.uniform, 0, data);
      pass.setBindGroup(0, tile.bindGroup);
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
      if (tile.state === 1) {
        this.emit("tileabort", { x: tile.x, y: tile.y, z: tile.z, url: tile.url });
      }
      tile.image.onload = null;
      tile.image.onerror = null;
      tile.image.src = "";
      tile.image = null;
      if (tile.state === 1) this._loading = Math.max(0, this._loading - 1);
    }
    if (this.renderer === "webgpu" && tile.texture) {
      (tile.texture as WebGpuTexture).destroy();
      this._gpuBytes = Math.max(0, this._gpuBytes - tile.byteSize);
    } else if (this.gl && tile.texture) {
      this.gl.deleteTexture(tile.texture as WebGLTexture);
      this._gpuBytes = Math.max(0, this._gpuBytes - tile.byteSize);
    }
    tile.uniform?.destroy();
    tile.uniform = null;
    tile.bindGroup = null;
    if (tile.slot >= 0) {
      this._freeSlots.push(tile.slot);
      tile.slot = -1;
    }
    tile.texture = null;
    this.tiles.delete(tile.key);
    this._lfu.delete(tile.key);
    this._queuedKeys.delete(tile.key);
    this._retained.delete(tile.key);
    this._preload.delete(tile.key);
    this._zoomBackstop.delete(tile.key);
    this._zoomHistory.delete(tile.key);
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

export function gpuTileLayer(template: TileTemplate, options?: GPUTileLayerOptions): GPUTileLayer {
  return new GPUTileLayer(template, options);
}
