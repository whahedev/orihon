import { createEl, setTransform } from "../dom.js";
import { TILE_SIZE, LatLngBounds, latLngBounds, unproject, type LatLngBoundsLike } from "../geo.js";
import type { Orihon } from "../map.js";
import { GridLayer, type GridLayerOptions, type ResolvedGridLayerOptions } from "./grid-layer.js";

const EMPTY_TILE = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

function modulo(value: number, divisor: number): number {
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
}

function normalizeBounds(value: unknown): LatLngBounds | null {
  if (!value) return null;
  try {
    const normalized = latLngBounds(value as LatLngBoundsLike);
    if (normalized.isValid()) return normalized;
  } catch {
    // Normalize all malformed forms to the same public error.
  }
  throw new TypeError("TileLayer bounds must contain south, west, north and east");
}

export class TileLayer extends GridLayer<ResolvedTileOptions> {
  template: TileTemplate;
  tiles = new Map<string, TileRecord>();
  previousTiles = new Map<string, TileRecord>();
  readonly cache = new Map<number, HTMLImageElement>();
  _tileZoom: number | null = null;
  _generation = 0;
  _cacheId = 0;
  _loading = 0;
  _loadCycleActive = false;
  _needed = new Set<string>();
  _queue: TileRecord[] = [];
  _pendingSourceZoom: number | null = null;
  _zoomSwitchTimer: ReturnType<typeof setTimeout> | null = null;
  _fillFrame = 0;
  /** Current-zoom tile plane; camera applied once via CSS transform. */
  level: HTMLDivElement | null = null;
  readonly _retina: boolean;

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
    resolved.bounds = normalizeBounds(resolved.bounds);
    super(resolved);
    this.template = template;
    this._retina = Boolean(
      this.options.detectRetina && typeof devicePixelRatio !== "undefined" && devicePixelRatio > 1
    );
  }

  override onAdd(map: Orihon): void {
    super.onAdd(map);
    if (this.container && !this.level) {
      this.level = createEl("div", "oh-tile-level", this.container);
    }
    this.render();
  }

  override onRemove(): void {
    this.#clearZoomSwitchTimer();
    this.#clearFillFrame();
    this._generation++;
    this.#clearTileMap(this.tiles, false);
    this.#clearTileMap(this.previousTiles, false);
    for (const element of this.cache.values()) this.#resetElement(element);
    this.cache.clear();
    this._tileZoom = null;
    this._pendingSourceZoom = null;
    this._needed.clear();
    this._loading = 0;
    this._loadCycleActive = false;
    this.level = null;
    super.onRemove();
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
    const values = { x: urlX, y: urlY, z, s, r };
    let url = this.template;
    for (const [name, value] of Object.entries(values)) url = url.split(`{${name}}`).join(String(value));
    return url;
  }

  setUrl(template: TileTemplate, redraw = true): this {
    this.template = template;
    if (redraw) this.redraw();
    return this;
  }

  setOpacity(opacity: number): this {
    this.options.opacity = Math.max(0, Math.min(1, Number(opacity)));
    if (this.container) this.container.style.opacity = String(this.options.opacity);
    return this;
  }

  redraw(): this {
    if (!this.map) return this;
    this.#resetView();
    this.render();
    return this;
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
    const nativeLimit = typeof this.options.maxNativeZoom === "number" ? this.options.maxNativeZoom : this.options.maxZoom;
    const sourceZoom = Math.max(0, Math.min(nativeLimit, displayZoom + (this._retina ? 1 : 0)));
    if (this._tileZoom === null) {
      this.#clearZoomSwitchTimer();
      this.#switchZoom(sourceZoom);
    } else if (sourceZoom !== this._tileZoom) {
      // Continuous zoom (bench / wheel): keep current tiles and CSS-scale them until zoom settles.
      // Large jumps still switch immediately so discrete setView stays sharp.
      if (Math.abs(sourceZoom - this._tileZoom) > 2) {
        this.#clearZoomSwitchTimer();
        this.#switchZoom(sourceZoom);
      } else {
        this.#scheduleZoomSwitch(sourceZoom);
      }
    }

    const activeZoom = this._tileZoom;
    if (activeZoom === null || !this.level) return;

    const size = this.options.tileSize;
    const displayScale = 2 ** (this.map.zoom - activeZoom);
    const origin = this.map.pixelOrigin;
    // One transform for the whole level — avoids rewriting every tile style each frame.
    this.level.style.transform = `translate3d(${-origin.x}px,${-origin.y}px,0) scale(${displayScale})`;

    const tileOrigin = { x: origin.x / displayScale, y: origin.y / displayScale };
    const left = Math.floor(tileOrigin.x / size) - this.options.buffer;
    const top = Math.floor(tileOrigin.y / size) - this.options.buffer;
    const right = Math.floor((tileOrigin.x + this.map.size.width / displayScale) / size) + this.options.buffer;
    const bottom = Math.floor((tileOrigin.y + this.map.size.height / displayScale) / size) + this.options.buffer;
    const worldMax = 2 ** activeZoom - 1;
    const needed = new Set<string>();

    const candidates: Array<{ x: number; y: number; key: string; distance: number }> = [];
    const centerX = tileOrigin.x / size + this.map.size.width / displayScale / size / 2;
    const centerY = tileOrigin.y / size + this.map.size.height / displayScale / size / 2;
    for (let y = top; y <= bottom; y++) {
      if (y < 0 || y > worldMax) continue;
      for (let x = left; x <= right; x++) {
        if (this.options.noWrap && (x < 0 || x > worldMax)) continue;
        if (!this.#tileIntersectsBounds(x, y, activeZoom)) continue;
        const key = `${activeZoom}:${x}:${y}`;
        needed.add(key);
        if (!this.tiles.has(key)) {
          candidates.push({ x, y, key, distance: Math.hypot(x + 0.5 - centerX, y + 0.5 - centerY) });
        }
      }
    }

    if (candidates.length > 1) candidates.sort((a, b) => a.distance - b.distance);
    // Cap new DOM tile creates per frame so fast pan/zoom stress doesn't stall the main thread,
    // then schedule another pass until the viewport is fully covered.
    const maxNew = 6;
    for (let i = 0; i < candidates.length && i < maxNew; i++) {
      const candidate = candidates[i];
      this.#addTile(candidate.x, candidate.y, activeZoom, candidate.key);
    }
    if (candidates.length > maxNew) this.#scheduleFillFrame();

    for (const [key, tile] of this.tiles) if (!needed.has(key)) this.#releaseTile(key, tile);
    // Retained tiles from the previous zoom live on the root container (not the scaled level).
    for (const tile of this.previousTiles.values()) this.#positionRetainedTile(tile);
    this._needed = needed;
    this.#pumpQueue();
    this.#checkLoadComplete();
    this.#retirePreviousWhenReady();
  }

  #scheduleFillFrame(): void {
    if (this._fillFrame) return;
    if (typeof requestAnimationFrame !== "function") {
      queueMicrotask(() => {
        if (this.map) this.render();
      });
      return;
    }
    this._fillFrame = requestAnimationFrame(() => {
      this._fillFrame = 0;
      if (this.map) this.render();
    });
  }

  #clearFillFrame(): void {
    if (this._fillFrame && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this._fillFrame);
    }
    this._fillFrame = 0;
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
      this.render();
    }, 140);
  }

  #clearZoomSwitchTimer(): void {
    if (this._zoomSwitchTimer != null) {
      clearTimeout(this._zoomSwitchTimer);
      this._zoomSwitchTimer = null;
    }
    this._pendingSourceZoom = null;
  }

  #switchZoom(sourceZoom: number): void {
    this.#clearTileMap(this.previousTiles, true);
    const retained = new Map<string, TileRecord>();
    for (const [key, tile] of this.tiles) {
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
    this.previousTiles = retained;
    this.tiles = new Map();
    this._tileZoom = sourceZoom;
    this._generation++;
    this._needed = new Set();
    this._loading = 0;
    this._queue = [];
    this._loadCycleActive = false;
  }

  #resetView(): void {
    if (this._tileZoom === null && !this.tiles.size && !this.previousTiles.size) return;
    this.#clearZoomSwitchTimer();
    this.#clearFillFrame();
    this._generation++;
    this.#clearTileMap(this.tiles, true);
    this.#clearTileMap(this.previousTiles, true);
    this._tileZoom = null;
    this._needed.clear();
    this._loading = 0;
    this._queue = [];
    this._loadCycleActive = false;
  }

  #addTile(x: number, y: number, z: number, key: string): void {
    if (!this.container || !this.level) return;
    const element = this.#takeTile();
    const size = this.options.tileSize;
    const generation = this._generation;
    const url = this.getTileUrl(x, y, z);
    const tile: TileRecord = { el: element, x, y, z, key, generation, url, loaded: false, settled: false, fallback: false, started: false };

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

    this.tiles.set(key, tile);
    this.level.appendChild(element);
    this._loadCycleActive = true;
    this._queue.push(tile);

    element.onload = () => {
      if (!this.#isCurrent(tile)) return;
      tile.loaded = true;
      tile.settled = true;
      element.style.visibility = "";
      element.style.opacity = "";
      element.classList.add("oh-tile-loaded");
      this._loading = Math.max(0, this._loading - 1);
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
      this._loading = Math.max(0, this._loading - 1);
      this.#pumpQueue();
      this.#checkLoadComplete();
    };
    this.#pumpQueue();
  }

  #pumpQueue(): void {
    const maxRequests = Math.max(1, this.options.maxRequests);
    while (this._loading < maxRequests && this._queue.length) {
      const tile = this._queue.shift()!;
      if (!this.#isCurrent(tile) || tile.started) continue;
      tile.started = true;
      this._loading++;
      this.emit("tileloadstart", { tile: tile.el, x: tile.x, y: tile.y, z: tile.z, url: tile.url });
      tile.el.src = tile.url;
    }
  }

  /** Place tile in level-local pixel space; camera scale/translation is on `.oh-tile-level`. */
  #placeTileOnLevel(tile: TileRecord): void {
    const size = this.options.tileSize;
    setTransform(tile.el, tile.x * size, tile.y * size, 1);
  }

  /** Retained tiles sit on the root container and need full world→screen transforms. */
  #positionRetainedTile(tile: TileRecord): void {
    if (!this.map) return;
    const size = this.options.tileSize;
    const displayScale = 2 ** (this.map.zoom - tile.z);
    setTransform(
      tile.el,
      tile.x * size * displayScale - this.map.pixelOrigin.x,
      tile.y * size * displayScale - this.map.pixelOrigin.y,
      displayScale
    );
  }

  #isCurrent(tile: TileRecord): boolean {
    return Boolean(this.map && tile.generation === this._generation && this.tiles.get(tile.key) === tile);
  }

  #releaseTile(key: string, tile: TileRecord): void {
    this.tiles.delete(key);
    this.#disposeTile(tile, !tile.settled, true);
    this.#checkLoadComplete();
  }

  #disposeTile(tile: TileRecord, aborted: boolean, keepCache: boolean): void {
    tile.el.onload = null;
    tile.el.onerror = null;
    this._queue = this._queue.filter((candidate) => candidate !== tile);
    if (aborted) {
      tile.settled = true;
      if (tile.started) this._loading = Math.max(0, this._loading - 1);
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
    if (!this.previousTiles.size) return;
    for (const key of this._needed) if (!this.tiles.get(key)?.loaded) return;
    this.#clearTileMap(this.previousTiles, true);
  }

  #checkLoadComplete(): void {
    if (!this._loadCycleActive || this._loading !== 0 || this._queue.length !== 0) return;
    this._loadCycleActive = false;
    this.emit("load");
  }

  #tileIntersectsBounds(x: number, y: number, z: number): boolean {
    const bounds = this.options.bounds;
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

  #cacheElement(element: HTMLImageElement): void {
    this.#resetElement(element);
    if (this.options.cacheSize <= 0) return;
    while (this.cache.size >= this.options.cacheSize) {
      const oldest = this.cache.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    this.cache.set(++this._cacheId, element);
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
    for (const [key, element] of this.cache) {
      this.cache.delete(key);
      return element;
    }
    return document.createElement("img");
  }
}

export function tileLayer(template: TileTemplate, options?: TileLayerOptions): TileLayer {
  return new TileLayer(template, options);
}
