import { LatLngBounds, bounds, project, TILE_SIZE, type LatLngBoundsLike } from "../geo.js";
import { TileLayer } from "../layers/tile-layer.js";

const DEFAULT_MAX_TILES = 4096;
const DEFAULT_PREFETCH_CONCURRENCY = 8;

export interface OfflineTileCacheOptions {
  cacheName?: string;
  fetcher?: typeof fetch;
  maxTiles?: number;
  /** Maximum simultaneous network requests. Clamped to 1..32; default 8. */
  concurrency?: number;
  /** Same allowlist as the Service Worker. Empty = app-owned explicit URLs, still rejects javascript/data/blob/file. */
  urlPrefixes?: string[];
}

export interface OfflineTileCacheStats {
  cacheName: string;
  supported: boolean;
  queued: number;
  cached: number;
  failed: number;
}

export interface OfflineServiceWorkerOptions {
  cacheName?: string;
  scope?: string;
  path?: string;
  /** Only these URL prefixes are network-cached. Empty = serve cache hits only, never cache new GETs. */
  urlPrefixes?: string[];
}

export interface PrefetchTileLayerOptions {
  bounds?: LatLngBoundsLike;
  zooms: number[];
  xRange?: [number, number];
  yRange?: [number, number];
  maxTiles?: number;
}

export class OfflineTileCache {
  readonly cacheName: string;
  readonly fetcher: typeof fetch;
  readonly maxTiles: number;
  readonly concurrency: number;
  readonly urlPrefixes: string[];
  queued = 0;
  cached = 0;
  failed = 0;

  constructor(options: OfflineTileCacheOptions = {}) {
    this.cacheName = options.cacheName ?? "Orihon-tiles-v1";
    this.fetcher = options.fetcher ?? fetch;
    this.maxTiles = positiveInteger(options.maxTiles, DEFAULT_MAX_TILES);
    this.concurrency = Math.min(32, positiveInteger(options.concurrency, DEFAULT_PREFETCH_CONCURRENCY));
    this.urlPrefixes = (options.urlPrefixes ?? []).map(String);
  }

  get supported(): boolean {
    return typeof caches !== "undefined" && typeof this.fetcher === "function";
  }

  getStats(): OfflineTileCacheStats {
    return {
      cacheName: this.cacheName,
      supported: this.supported,
      queued: this.queued,
      cached: this.cached,
      failed: this.failed
    };
  }

  async prefetch(urls: Iterable<string>): Promise<OfflineTileCacheStats> {
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const input of urls) {
      const url = String(input);
      if (seen.has(url)) continue;
      seen.add(url);
      if (!prefetchUrlAllowed(url, this.urlPrefixes)) {
        this.failed++;
        continue;
      }
      unique.push(url);
      if (unique.length > this.maxTiles) {
        throw new RangeError(`OfflineTileCache prefetch exceeds maxTiles (${unique.length} > ${this.maxTiles})`);
      }
    }
    this.queued += unique.length;
    if (!this.supported) return this.getStats();
    const cache = await caches.open(this.cacheName);
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < unique.length) {
        const url = unique[cursor++];
        try {
          // Prefetch targets are explicit tile URLs; no-cors yields opaque responses that Cache Storage can still serve.
          const response = await this.fetcher(url, { mode: "no-cors" });
          await cache.put(url, response.clone());
          this.cached++;
        } catch {
          this.failed++;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, unique.length) }, worker));
    return this.getStats();
  }

  async prefetchTileLayer(
    layer: TileLayer,
    options: PrefetchTileLayerOptions
  ): Promise<OfflineTileCacheStats> {
    if (!options.bounds && !options.xRange && !options.yRange) {
      throw new TypeError("prefetchTileLayer requires bounds or explicit xRange/yRange (refuses world-wide prefetch)");
    }
    const tileSize = layer.getTileSize?.() ?? TILE_SIZE;
    const urls: string[] = [];
    for (const zoom of options.zooms) {
      const max = 2 ** zoom - 1;
      const fromBounds = options.bounds ? tileRangeForBounds(bounds(options.bounds), zoom, tileSize) : null;
      const xRange = options.xRange ?? fromBounds?.xRange;
      const yRange = options.yRange ?? fromBounds?.yRange;
      if (!xRange || !yRange) {
        throw new TypeError("prefetchTileLayer requires bounds or both xRange and yRange");
      }
      const x0 = Math.max(0, Math.min(xRange[0], xRange[1]));
      const x1 = Math.min(max, Math.max(xRange[0], xRange[1]));
      const y0 = Math.max(0, Math.min(yRange[0], yRange[1]));
      const y1 = Math.min(max, Math.max(yRange[0], yRange[1]));
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          urls.push(layer.getTileUrl(x, y, zoom));
          if (urls.length > (options.maxTiles ?? this.maxTiles)) {
            throw new RangeError(`OfflineTileCache prefetch exceeds maxTiles (${options.maxTiles ?? this.maxTiles})`);
          }
        }
      }
    }
    return this.prefetch(urls);
  }

  async match(url: string): Promise<Response | undefined> {
    if (!this.supported) return undefined;
    const cache = await caches.open(this.cacheName);
    return cache.match(url);
  }

  async clear(): Promise<void> {
    if (typeof caches !== "undefined") await caches.delete(this.cacheName);
    this.queued = 0;
    this.cached = 0;
    this.failed = 0;
  }

  createServiceWorkerScript(options: OfflineServiceWorkerOptions = {}): string {
    const cacheName = JSON.stringify(options.cacheName ?? this.cacheName);
    const prefixes = JSON.stringify(options.urlPrefixes ?? this.urlPrefixes);
    return `
const ORIHON_CACHE = ${cacheName};
const ORIHON_URL_PREFIXES = ${prefixes};
function orihonAllowed(url) {
  if (!ORIHON_URL_PREFIXES.length) return false;
  let candidate;
  try { candidate = new URL(url, self.location.href); } catch { return false; }
  if (candidate.protocol !== "http:" && candidate.protocol !== "https:") return false;
  return ORIHON_URL_PREFIXES.some((prefix) => {
    try {
      const allowed = new URL(prefix, self.location.href);
      return candidate.origin === allowed.origin && candidate.href.startsWith(allowed.href);
    } catch { return false; }
  });
}
self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = request.url;
  const allowed = orihonAllowed(url);
  event.respondWith((async () => {
    const cache = await caches.open(ORIHON_CACHE);
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (allowed && response.ok && response.type !== "opaque") {
      await cache.put(request, response.clone());
    }
    return response;
  })());
});
`.trim();
  }

  async registerServiceWorker(options: OfflineServiceWorkerOptions = {}): Promise<ServiceWorkerRegistration | null> {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
    const path = options.path;
    if (path) return navigator.serviceWorker.register(path, { scope: options.scope });
    const blob = new Blob([this.createServiceWorkerScript(options)], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    try {
      return await navigator.serviceWorker.register(url, { scope: options.scope });
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

export function offlineTileCache(options?: OfflineTileCacheOptions): OfflineTileCache {
  return new OfflineTileCache(options);
}

export function prefetchUrlAllowed(url: string, prefixes: readonly string[] = []): boolean {
  const base = typeof document !== "undefined" && document.baseURI
    ? document.baseURI
    : "https://orihon.invalid/";
  let candidate: URL;
  try {
    candidate = new URL(String(url), base);
  } catch {
    return false;
  }
  if (candidate.protocol !== "http:" && candidate.protocol !== "https:") return false;
  if (!prefixes.length) return true;
  return prefixes.some((prefix) => {
    try {
      const allowed = new URL(String(prefix), base);
      return candidate.origin === allowed.origin && candidate.href.startsWith(allowed.href);
    } catch {
      return false;
    }
  });
}

function positiveInteger(value: number | undefined, fallback: number): number {
  const numeric = Number(value ?? fallback);
  return Number.isFinite(numeric) ? Math.max(1, Math.floor(numeric)) : fallback;
}

export function tileRangeForBounds(
  bounds: LatLngBounds,
  zoom: number,
  tileSize = TILE_SIZE
): { xRange: [number, number]; yRange: [number, number] } {
  const max = 2 ** zoom - 1;
  const nw = project([bounds.north, bounds.west], zoom);
  const se = project([bounds.south, bounds.east], zoom);
  const x0 = Math.floor(nw.x / tileSize);
  const x1 = Math.floor(Math.max(nw.x, se.x - 1e-9) / tileSize);
  const y0 = Math.floor(nw.y / tileSize);
  const y1 = Math.floor(Math.max(nw.y, se.y - 1e-9) / tileSize);
  return {
    xRange: [Math.max(0, Math.min(x0, x1, max)), Math.min(max, Math.max(x0, x1, 0))],
    yRange: [Math.max(0, Math.min(y0, y1, max)), Math.min(max, Math.max(y0, y1, 0))]
  };
}
