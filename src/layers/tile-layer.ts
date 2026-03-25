import { geoTransformCss, tileCornerLayerTransform, tileLevelWarpCss } from "../camera.js";
import { createEl } from "../dom.js";
import { TILE_SIZE, LatLngBounds, bounds, type LatLngBoundsLike } from "../geo.js";
import type { Layer } from "../layer.js";
import type { Orihon } from "../map.js";
import { GridLayer, type GridLayerOptions, type ResolvedGridLayerOptions } from "./grid-layer.js";
import {
  forEachTileInRect,
  forEachTileRectDelta,
  forEachMissingNeeded,
  tileLookaheadPadding,
  tilePriority,
  type TileRect
} from "./tile-grid.js";

const EMPTY_TILE = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

export function modulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

export interface TileCoordinates {
  x: number;
  y: number;
  z: number;
  s: string;
  r: string;
  retina: boolean;
}

export type TileTemplate = string | ((coordinates: TileCoordinates) => string);

/** Common redraw flag for raster URL/param updates. Prefer `{ redraw }` over polarity-inverted booleans. */
export type TileRedrawFlag = boolean | { redraw?: boolean };

export function shouldRedrawTiles(flag: TileRedrawFlag | undefined, defaultRedraw = true): boolean {
  if (flag == null) return defaultRedraw;
  if (typeof flag === "object") return flag.redraw !== false;
  return Boolean(flag);
}

export type RasterTileRendererKind = "dom" | "webgl" | "webgpu" | "none";

/**
 * Diagnostics every raster basemap reports. This is the supported way to observe tile
 * bookkeeping: the tile maps themselves are implementation detail and stay private.
 */
export interface RasterTileStats {
  /** Which raster implementation is running. */
  renderer: RasterTileRendererKind;
  /** Zoom the attached tiles were requested at; `null` before the first render. */
  tileZoom: number | null;
  /** Tiles attached for the active zoom. */
  active: number;
  /** Tiles kept from the previous zoom while the new level fills in. */
  retained: number;
  /** Tiles held for reuse without being drawn. */
  cached: number;
  /** Tile requests in flight. */
  loading: number;
}

/**
 * Shared public contract for DOM and GPU raster basemaps returned by `tileLayer()`.
 * Runtime may be `TileLayer` or `GPUTileLayer`; use `rendererKind` to discriminate.
 */
export interface RasterTileLayer extends Layer {
  readonly rendererKind: RasterTileRendererKind;
  getTileUrl(x: number, y: number, z: number): string;
  setUrl(template: TileTemplate, redraw?: TileRedrawFlag): this;
  setOpacity(opacity: number): this;
  redraw(): this;
  getStats(): RasterTileStats;
}

export interface TileLayerOptions extends GridLayerOptions {
  minZoom?: number;
  maxZoom?: number;
  maxNativeZoom?: number;
  tileSize?: number;
  buffer?: number;
  cacheSize?: number;
  maxRequests?: number;
  subdomains?: string | string[];
  crossOrigin?: string;
  referrerPolicy?: ReferrerPolicy | "";
  opacity?: number;
  errorTileUrl?: string;
  noWrap?: boolean;
  tms?: boolean;
  detectRetina?: boolean;
  bounds?: LatLngBoundsLike | null;
  /**
   * Defaults to `"dom"` in every tier, so the same `tileLayer(url)` call builds the same
   * renderer from `orihon/core`, `orihon/standard` and `orihon`. GPU rasters are opt-in.
   * `"auto"` prefers WebGPU when `navigator.gpu` exists, then WebGL, then DOM; it needs a
   * registered GPU implementation (the Advanced `orihon` entry, or `orihon/webgpu` on top of
   * Standard). Without one, `"auto"` / `"webgl"` / `"webgpu"` fall back to DOM rather than throw.
   */
  renderer?: "auto" | "dom" | "webgl" | "webgpu";
  /** GPU path: maximum new tile textures uploaded in one frame. */
  maxNewPerFrame?: number;
  /** GPU path: upper device-pixel-ratio used by the framebuffer. */
  maxDpr?: number;
}

interface ResolvedTileOptions extends ResolvedGridLayerOptions {
  pane: string;
  minZoom: number;
  maxZoom: number;
  maxNativeZoom?: number;
  tileSize: number;
  buffer: number;
  cacheSize: number;
  maxRequests: number;
  subdomains: string | string[];
  attribution: string;
  crossOrigin: string;
  referrerPolicy: ReferrerPolicy | "";
  opacity: number;
  zIndex: number;
  className: string;
  errorTileUrl: string;
  noWrap: boolean;
  tms: boolean;
  detectRetina: boolean;
  bounds: LatLngBounds | null;
}

interface TileRecord {
  el: HTMLImageElement;
  x: number;
  y: number;
  z: number;
  key: string;
  generation: number;
  url: string;
  loaded: boolean;
  settled: boolean;
  fallback: boolean;
  started: boolean;
  priority: number;
}

/** Internal normalization shared by DOM and GPU raster tile implementations. */
export function normalizeTileBounds(value: unknown, errorMessage: string): LatLngBounds | null {
  if (!value) return null;
  try {
    const normalized = bounds(value as LatLngBoundsLike);
    if (normalized.isValid()) return normalized;
  } catch {
    // Normalize malformed coordinate forms to the caller's public error.
  }
  throw new TypeError(errorMessage);
}

/** Shared raster payload: GPU backends do not provide a DOM image. */
export interface RasterTileEventDetail {
  x: number;
  y: number;
  z: number;
  url: string;
  tile?: HTMLImageElement;
}

export interface TileLayerEventMap {
  tileloadstart: RasterTileEventDetail;
  tileload: RasterTileEventDetail;
  tileerror: RasterTileEventDetail;
  tileabort: RasterTileEventDetail;
  load: {};
}

export class TileLayer<TEvents extends object = {}> extends GridLayer<ResolvedTileOptions, TileLayerEventMap & TEvents> implements RasterTileLayer {
  /** URL template. Subclasses build their own request URLs from it; apps use `setUrl` / `getTileUrl`. */
  protected template: TileTemplate;
  #tiles = new Map<string, TileRecord>();
  #previousTiles = new Map<string, TileRecord>();
  readonly #cache = new Map<number, HTMLImageElement>();
  #tileZoom: number | null = null;
  #generation = 0;
  #cacheId = 0;
  #loading = 0;
  #loadCycleActive = false;
  #needed = new Set<string>();
  #queue: TileRecord[] = [];
  #pendingSourceZoom: number | null = null;
  #zoomSwitchTimer: ReturnType<typeof setTimeout> | null = null;
  #fillFrame = 0;
  #fillPending = false;
  #rect: TileRect | null = null;
  /** Throttle DOM tile create/release during continuous camera (setView every frame). */
  #lastHeavyMs = 0;
  /** Level-local origin in world pixels at the active tile zoom (snapped to tile grid). */
  #levelOriginX = 0;
  #levelOriginY = 0;
  /** Current-zoom tile plane; camera applied once via CSS transform. */
  #level: HTMLDivElement | null = null;
  readonly #retina: boolean;
  readonly rendererKind: RasterTileRendererKind = "dom";

  constructor(template: TileTemplate, options: TileLayerOptions = {}) {
    const resolved = {
      pane: "tile",
      minZoom: 0,
      maxZoom: 19,
      maxNativeZoom: undefined,
      tileSize: TILE_SIZE,
      buffer: 1,
      cacheSize: 128,
      maxRequests: 16,
      subdomains: "abc",
      attribution: "",
      className: "oh-tile-layer",
      crossOrigin: "",
      referrerPolicy: "",
      opacity: 1,
      zIndex: 0,
      errorTileUrl: "",
      noWrap: false,
      tms: false,
      detectRetina: false,
      bounds: null,
      ...options
    } as ResolvedTileOptions;
    resolved.bounds = normalizeTileBounds(
      resolved.bounds,
      "TileLayer bounds must contain south, west, north and east"
    );
    super(resolved);
    this.template = template;
    this.#retina = Boolean(
      this.options.detectRetina && typeof devicePixelRatio !== "undefined" && devicePixelRatio > 1
    );
  }

  override onAdd(map: Orihon): void {
    super.onAdd(map);
    if (this.container && !this.#level) {
      this.#level = createEl("div", "oh-tile-level", this.container);
    }
    this.render();
  }

  override onRemove(): void {
    this.#clearZoomSwitchTimer();
    this.#clearFillFrame();
    this.#generation++;
    this.#clearTileMap(this.#tiles, false);
    this.#clearTileMap(this.#previousTiles, false);
    for (const element of this.#cache.values()) this.#resetElement(element);
    this.#cache.clear();
    this.#tileZoom = null;
    this.#pendingSourceZoom = null;
    this.#needed.clear();
    this.#queue.length = 0;
    this.#rect = null;
    this.#loading = 0;
    this.#loadCycleActive = false;
    this.#level = null;
    super.onRemove();
  }

  getTileUrl(x: number, y: number, z: number): string {
    const worldSize = 2 ** z;
    const urlX = this.options.noWrap || this.map?.crs.wrapLng === false ? x : modulo(x, worldSize);
    const urlY = this.options.tms ? worldSize - y - 1 : y;
    const subdomains = Array.isArray(this.options.subdomains)
      ? this.options.subdomains
      : String(this.options.subdomains || "").split("");
    const s = subdomains[modulo(x + y, Math.max(1, subdomains.length))] || "";
    const r = this.#retina ? "@2x" : "";
    if (typeof this.template === "function") {
      return this.template({ x: urlX, y: urlY, z, s, r, retina: this.#retina });
    }
    const values = { x: urlX, y: urlY, z, s, r };
    let url = this.template;
    for (const [name, value] of Object.entries(values)) url = url.split(`{${name}}`).join(String(value));
    return url;
  }

  setUrl(template: TileTemplate, redraw: TileRedrawFlag = true): this {
    this.template = template;
    if (shouldRedrawTiles(redraw, true)) this.redraw();
    return this;
  }

  redraw(): this {
    if (!this.map) return this;
    this.#resetView();
    this.render();
    return this;
  }

  getStats(): RasterTileStats {
    return {
      renderer: this.rendererKind,
      tileZoom: this.#tileZoom,
      active: this.#tiles.size,
      retained: this.#previousTiles.size,
      cached: this.#cache.size,
      loading: this.#loading
    };
  }

  override render(): void {
    if (!this.map || !this.container) return;
    const displayZoom = Math.round(this.map.zoom);
    if (displayZoom < this.options.minZoom || displayZoom > this.options.maxZoom) {
      this.container.hidden = true;
      this.#resetView();
      return;
    }

    this.container.hidden = false;
    const nativeLimit = nativeTileZoom(this.options.maxNativeZoom, this.options.maxZoom);
    const sourceZoom = Math.max(0, Math.min(nativeLimit, displayZoom + (this.#retina ? 1 : 0)));
    if (this.#tileZoom === null) {
      this.#clearZoomSwitchTimer();
      this.#switchZoom(sourceZoom);
    } else if (sourceZoom !== this.#tileZoom) {
      // Continuous zoom (bench / wheel): keep current tiles and CSS-scale them until zoom settles.
      // Large jumps still switch immediately so discrete setView stays sharp.
      if (Math.abs(sourceZoom - this.#tileZoom) > 2) {
        this.#clearZoomSwitchTimer();
        this.#switchZoom(sourceZoom);
      } else {
        this.#scheduleZoomSwitch(sourceZoom);
      }
    }

    const activeZoom = this.#tileZoom;
    if (activeZoom === null || !this.#level) return;

    const size = this.options.tileSize;
    const liveZoom = this.map.zoom;
    const displayScale = 2 ** (liveZoom - activeZoom);
    const origin = this.map.pixelOrigin;
    // Always update the level CSS transform — cheap and keeps tiles glued to the camera.
    const levelOriginX = Math.floor(origin.x / displayScale / size) * size;
    const levelOriginY = Math.floor(origin.y / displayScale / size) * size;
    // During continuous setView stress, skip DOM churn most frames: keep the previous snap
    // origin and only translate/scale. Heavy pass (~every 32ms) refreshes tile coverage.
    // If the last pass still has uncreated needed tiles, do not skip — otherwise holes stick.
    // After #switchZoom the level origin is invalid (NaN) until a heavy pass — never CSS-warp with NaN.
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const levelOriginValid = Number.isFinite(this.#levelOriginX) && Number.isFinite(this.#levelOriginY);
    const heavyDue = !levelOriginValid || now - this.#lastHeavyMs >= 32 || this.#fillPending;
    if (!heavyDue) {
      this.#level.style.transform = tileLevelWarpCss(
        { x: this.#levelOriginX, y: this.#levelOriginY },
        activeZoom,
        origin,
        liveZoom
      );
      for (const tile of this.#previousTiles.values()) this.#positionRetainedTile(tile);
      this.#scheduleFillFrame();
      return;
    }
    this.#lastHeavyMs = now;

    const originMoved = levelOriginX !== this.#levelOriginX || levelOriginY !== this.#levelOriginY;
    this.#levelOriginX = levelOriginX;
    this.#levelOriginY = levelOriginY;
    this.#level.style.transform = tileLevelWarpCss(
      { x: levelOriginX, y: levelOriginY },
      activeZoom,
      origin,
      liveZoom
    );

    const tileOrigin = { x: origin.x / displayScale, y: origin.y / displayScale };
    const vx = this.map.panVelocity.x;
    const vy = this.map.panVelocity.y;
    const lead = tileLookaheadPadding(vx, vy, size);
    const left = Math.floor(tileOrigin.x / size) - this.options.buffer - lead.left;
    const top = Math.floor(tileOrigin.y / size) - this.options.buffer - lead.top;
    const right = Math.floor((tileOrigin.x + this.map.size.width / displayScale) / size) + this.options.buffer + lead.right;
    const bottom = Math.floor((tileOrigin.y + this.map.size.height / displayScale) / size) + this.options.buffer + lead.bottom;
    const worldMax = 2 ** activeZoom - 1;
    const nextRect: TileRect = { z: activeZoom, left, top, right, bottom };

    const candidates: Array<{ x: number; y: number; key: string; distance: number }> = [];
    const centerX = tileOrigin.x / size + this.map.size.width / displayScale / size / 2;
    const centerY = tileOrigin.y / size + this.map.size.height / displayScale / size / 2;
    const wrapLocked = this.options.noWrap || this.map.crs.wrapLng === false;

    const consider = (x: number, y: number): void => {
      if (y < 0 || y > worldMax) return;
      if (wrapLocked && (x < 0 || x > worldMax)) return;
      if (!this.#tileIntersectsBounds(x, y, activeZoom)) return;
      const key = `${activeZoom}:${x}:${y}`;
      this.#needed.add(key);
    };
    const forget = (x: number, y: number): void => {
      const key = `${activeZoom}:${x}:${y}`;
      this.#needed.delete(key);
      const tile = this.#tiles.get(key);
      if (tile) this.#releaseTile(key, tile);
    };

    if (!this.#rect || this.#rect.z !== nextRect.z) {
      this.#needed.clear();
      forEachTileInRect(nextRect, consider);
    } else {
      forEachTileRectDelta(this.#rect, nextRect, consider, forget);
    }
    this.#rect = nextRect;

    forEachMissingNeeded(this.#needed, (key) => this.#tiles.has(key), (x, y, key) => {
      candidates.push({ x, y, key, distance: tilePriority(x, y, centerX, centerY, vx, vy, size) });
    });

    if (candidates.length > 1) candidates.sort((a, b) => a.distance - b.distance);
    const maxNew = 6;
    const n = Math.min(candidates.length, maxNew);
    for (let i = n - 1; i >= 0; i--) {
      const candidate = candidates[i];
      this.#addTile(candidate.x, candidate.y, activeZoom, candidate.key, candidate.distance);
    }
    this.#fillPending = candidates.length > maxNew;
    if (this.#fillPending) this.#scheduleFillFrame();

    if (originMoved) {
      for (const tile of this.#tiles.values()) this.#placeTileOnLevel(tile);
    }

    for (const [key, tile] of this.#tiles) if (!this.#needed.has(key)) this.#releaseTile(key, tile);
    for (const tile of this.#previousTiles.values()) this.#positionRetainedTile(tile);
    this.#pumpQueue();
    this.#checkLoadComplete();
    this.#retirePreviousWhenReady();
  }

  #scheduleFillFrame(): void {
    if (this.#fillFrame) return;
    if (typeof requestAnimationFrame !== "function") {
      queueMicrotask(() => {
        if (this.map) this.render();
      });
      return;
    }
    this.#fillFrame = requestAnimationFrame(() => {
      this.#fillFrame = 0;
      if (this.map) this.render();
    });
  }

  #clearFillFrame(): void {
    if (this.#fillFrame && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this.#fillFrame);
    }
    this.#fillFrame = 0;
  }

  #scheduleZoomSwitch(sourceZoom: number): void {
    this.#pendingSourceZoom = sourceZoom;
    if (this.#zoomSwitchTimer != null) return;
    this.#zoomSwitchTimer = setTimeout(() => {
      this.#zoomSwitchTimer = null;
      const pending = this.#pendingSourceZoom;
      this.#pendingSourceZoom = null;
      if (pending == null || !this.map || pending === this.#tileZoom) return;
      this.#switchZoom(pending);
      this.render();
    }, 140);
  }

  #clearZoomSwitchTimer(): void {
    if (this.#zoomSwitchTimer != null) {
      clearTimeout(this.#zoomSwitchTimer);
      this.#zoomSwitchTimer = null;
    }
    this.#pendingSourceZoom = null;
  }

  #switchZoom(sourceZoom: number): void {
    this.#clearTileMap(this.#previousTiles, true);
    const retained = new Map<string, TileRecord>();
    for (const [key, tile] of this.#tiles) {
      if (tile.loaded) {
        tile.el.onload = null;
        tile.el.onerror = null;
        tile.el.classList.add("oh-tile-retained");
        // Move out of the scaled level onto the root so retained tiles keep world positioning.
        this.container?.appendChild(tile.el);
        retained.set(key, tile);
      } else {
        this.#disposeTile(tile, true, false);
      }
    }
    this.#previousTiles = retained;
    this.#tiles = new Map();
    this.#tileZoom = sourceZoom;
    this.#generation++;
    // Invalidate level snap so the next render() must take the heavy path (never warp with NaN).
    this.#levelOriginX = Number.NaN;
    this.#levelOriginY = Number.NaN;
    this.#lastHeavyMs = 0;
    this.#needed = new Set();
    this.#loading = 0;
    this.#queue.length = 0;
    this.#rect = null;
    this.#fillPending = false;
    this.#loadCycleActive = false;
  }

  #resetView(): void {
    if (this.#tileZoom === null && !this.#tiles.size && !this.#previousTiles.size) return;
    this.#clearZoomSwitchTimer();
    this.#clearFillFrame();
    this.#generation++;
    this.#clearTileMap(this.#tiles, true);
    this.#clearTileMap(this.#previousTiles, true);
    this.#tileZoom = null;
    this.#needed.clear();
    this.#loading = 0;
    this.#queue.length = 0;
    this.#rect = null;
    this.#fillPending = false;
    this.#loadCycleActive = false;
  }

  #addTile(x: number, y: number, z: number, key: string, priority = 0): void {
    if (!this.container || !this.#level || this.#tiles.has(key)) return;
    const element = this.#takeTile();
    const size = this.options.tileSize;
    const generation = this.#generation;
    const url = this.getTileUrl(x, y, z);
    const tile: TileRecord = {
      el: element,
      x,
      y,
      z,
      key,
      generation,
      url,
      loaded: false,
      settled: false,
      fallback: false,
      started: false,
      priority
    };

    element.width = size;
    element.height = size;
    element.style.width = `${size}px`;
    element.style.height = `${size}px`;
    element.alt = "";
    element.decoding = "async";
    element.loading = "eager";
    if (this.options.crossOrigin) element.crossOrigin = this.options.crossOrigin;
    else element.removeAttribute("crossorigin");
    if (this.options.referrerPolicy) element.referrerPolicy = this.options.referrerPolicy;
    else element.removeAttribute("referrerpolicy");
    element.className = "oh-tile";
    element.style.visibility = "hidden";
    element.style.opacity = "0";
    this.#placeTileOnLevel(tile);

    this.#tiles.set(key, tile);
    this.#level.appendChild(element);
    this.#loadCycleActive = true;
    this.#queue.push(tile);

    element.onload = () => {
      if (!this.#isCurrent(tile)) return;
      tile.loaded = true;
      tile.settled = true;
      element.style.visibility = "";
      element.style.opacity = "";
      element.classList.add("oh-tile-loaded");
      this.#loading = Math.max(0, this.#loading - 1);
      this.emit("tileload", { tile: element, x, y, z, url: element.currentSrc || element.src });
      this.#pumpQueue();
      this.#checkLoadComplete();
      this.#retirePreviousWhenReady();
    };

    element.onerror = () => {
      if (!this.#isCurrent(tile)) return;
      this.emit("tileerror", { tile: element, x, y, z, url: element.currentSrc || element.src });
      if (!tile.fallback && this.options.errorTileUrl) {
        tile.fallback = true;
        element.src = this.options.errorTileUrl;
        return;
      }
      tile.settled = true;
      this.#loading = Math.max(0, this.#loading - 1);
      this.#pumpQueue();
      this.#checkLoadComplete();
    };
    this.#pumpQueue();
  }

  #pumpQueue(): void {
    const maxRequests = Math.max(1, this.options.maxRequests);
    while (this.#loading < maxRequests && this.#queue.length) {
      const tile = this.#queue.pop()!;
      if (!this.#isCurrent(tile) || tile.started) continue;
      tile.started = true;
      this.#loading++;
      this.emit("tileloadstart", { tile: tile.el, x: tile.x, y: tile.y, z: tile.z, url: tile.url });
      tile.el.src = tile.url;
    }
  }

  /** Place tile in level-local pixel space; camera scale/translation is on `.oh-tile-level`. */
  #placeTileOnLevel(tile: TileRecord): void {
    const size = this.options.tileSize;
    tile.el.style.transform = geoTransformCss(
      tile.x * size - this.#levelOriginX,
      tile.y * size - this.#levelOriginY
    );
  }

  /** Retained tiles sit on the root container and need full world→screen transforms. */
  #positionRetainedTile(tile: TileRecord): void {
    if (!this.map) return;
    const size = this.options.tileSize;
    const placed = tileCornerLayerTransform(
      tile.x,
      tile.y,
      size,
      tile.z,
      this.map.pixelOrigin,
      this.map.zoom
    );
    tile.el.style.transform = placed.css;
  }

  #isCurrent(tile: TileRecord): boolean {
    return Boolean(this.map && tile.generation === this.#generation && this.#tiles.get(tile.key) === tile);
  }

  #releaseTile(key: string, tile: TileRecord): void {
    this.#tiles.delete(key);
    this.#disposeTile(tile, !tile.settled, true);
    this.#checkLoadComplete();
  }

  #disposeTile(tile: TileRecord, aborted: boolean, keepCache: boolean): void {
    tile.el.onload = null;
    tile.el.onerror = null;
    this.#queue = this.#queue.filter((candidate) => candidate !== tile);
    if (aborted) {
      tile.settled = true;
      if (tile.started) this.#loading = Math.max(0, this.#loading - 1);
      this.emit("tileabort", { tile: tile.el, x: tile.x, y: tile.y, z: tile.z, url: tile.url });
    }
    tile.el.remove();
    if (keepCache) this.#cacheElement(tile.el);
    else this.#resetElement(tile.el);
  }

  #clearTileMap(tileMap: Map<string, TileRecord>, keepCache: boolean): void {
    for (const tile of tileMap.values()) this.#disposeTile(tile, !tile.settled, keepCache);
    tileMap.clear();
  }

  #retirePreviousWhenReady(): void {
    if (!this.#previousTiles.size) return;
    for (const key of this.#needed) if (!this.#tiles.get(key)?.loaded) return;
    this.#clearTileMap(this.#previousTiles, true);
  }

  #checkLoadComplete(): void {
    if (!this.#loadCycleActive || this.#loading !== 0 || this.#queue.length !== 0) return;
    this.#loadCycleActive = false;
    this.emit("load");
  }

  #tileIntersectsBounds(x: number, y: number, z: number): boolean {
    const bounds = this.options.bounds;
    if (!bounds) return true;
    const worldSize = 2 ** z;
    if (!this.map) return true;
    const normalizedX = this.map.crs.wrapLng ? modulo(x, worldSize) : x;
    const northWest = this.map.crs.unproject({ x: normalizedX * this.options.tileSize, y: y * this.options.tileSize }, z);
    const southEast = this.map.crs.unproject({ x: (normalizedX + 1) * this.options.tileSize, y: (y + 1) * this.options.tileSize }, z);
    const tileWest = Math.min(northWest.lng, southEast.lng);
    const tileEast = Math.max(northWest.lng, southEast.lng);
    const tileNorth = Math.max(northWest.lat, southEast.lat);
    const tileSouth = Math.min(northWest.lat, southEast.lat);
    if (tileSouth > bounds.north || tileNorth < bounds.south) return false;
    if (bounds.west <= bounds.east) return tileEast >= bounds.west && tileWest <= bounds.east;
    return tileEast >= bounds.west || tileWest <= bounds.east;
  }

  #cacheElement(element: HTMLImageElement): void {
    this.#resetElement(element);
    if (this.options.cacheSize <= 0) return;
    while (this.#cache.size >= this.options.cacheSize) {
      const oldest = this.#cache.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      this.#cache.delete(oldest);
    }
    this.#cache.set(++this.#cacheId, element);
  }

  #resetElement(element: HTMLImageElement): void {
    element.onload = null;
    element.onerror = null;
    element.className = "oh-tile";
    element.style.visibility = "hidden";
    element.style.opacity = "0";
    if (element.src !== EMPTY_TILE) element.src = EMPTY_TILE;
  }

  #takeTile(): HTMLImageElement {
    for (const [key, element] of this.#cache) {
      this.#cache.delete(key);
      return element;
    }
    return document.createElement("img");
  }
}

export function nativeTileZoom(maxNativeZoom: unknown, maxZoom: number): number {
  if (maxNativeZoom === "" || maxNativeZoom == null) return maxZoom;
  const native = Number(maxNativeZoom);
  return Number.isFinite(native) ? native : maxZoom;
}

export function tileLayer(template: TileTemplate, options?: TileLayerOptions): RasterTileLayer {
  // DOM is the tier-independent default. Importing the Advanced entry registers a GPU
  // implementation, but it must never change what an existing `tileLayer(url)` call builds:
  // behaviour follows the arguments, not the module graph.
  const requested = options?.renderer ?? "dom";
  if (requested === "dom") return new TileLayer(template, options);
  const available = requested === "webgpu" ? gpuContextAvailable()
    : requested === "webgl" ? webglContextAvailable()
      : gpuContextAvailable() || webglContextAvailable();
  if (gpuTileFactory && available) {
    return gpuTileFactory(template, options) as RasterTileLayer;
  }
  return new TileLayer(template, options);
}

/**
 * Optional GPU raster basemap (Advanced tier).
 * Standard/Core keep DOM `<img>` tiles — register from `orihon` entry, not `orihon/core`.
 */
export type GPUTileFactory = (template: TileTemplate, options?: TileLayerOptions) => RasterTileLayer;

let gpuTileFactory: GPUTileFactory | null = null;

/** Advanced entry registers the unified WebGPU/WebGL raster implementation. */
export function registerGpuTileFactory(factory: GPUTileFactory | null): void {
  gpuTileFactory = factory;
}

function gpuContextAvailable(): boolean {
  return typeof navigator !== "undefined" && Boolean((navigator as Navigator & { gpu?: unknown }).gpu);
}

/**
 * Probes WebGL once per document and releases the probe context immediately.
 * Browsers cap live WebGL contexts; leaking one per `tileLayer()` call would
 * force the oldest contexts — including real map layers — to be lost.
 */
let webglProbe: boolean | null = null;

function webglContextAvailable(): boolean {
  if (webglProbe !== null) return webglProbe;
  if (typeof document === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    const gl = (canvas.getContext("webgl2")
      || canvas.getContext("webgl")
      || canvas.getContext("experimental-webgl")) as WebGLRenderingContext | null;
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    webglProbe = Boolean(gl);
  } catch {
    webglProbe = false;
  }
  return webglProbe;
}
