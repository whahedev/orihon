import { latLng, type LatLngLike } from "../geo.js";

export interface SearchResult {
  name: string;
  center: LatLngLike;
  description?: string;
  bbox?: unknown;
  properties?: Record<string, unknown>;
}

export interface SearchContext {
  limit?: number;
  signal?: AbortSignal;
  center?: LatLngLike;
  [key: string]: unknown;
}

export interface SearchAdapter<TResult extends SearchResult = SearchResult> {
  search(query: string, context: SearchContext): Promise<TResult[] | null | undefined> | TResult[] | null | undefined;
  geocode?(query: string, context: SearchContext): Promise<TResult | null | undefined> | TResult | null | undefined;
  reverse?(center: LatLngLike, context: SearchContext): Promise<TResult | null | undefined> | TResult | null | undefined;
}

/**
 * What `reverse()` should do when the adapter implements no reverse geocoding.
 * `"none"` (default) reports the missing capability as `null`. `"coordinates"` restores the
 * older behaviour: a synthetic result whose `name` is the formatted latitude/longitude, which
 * is useful for a UI field but is not a reverse-geocoded place.
 */
export type ReverseFallback = "none" | "coordinates";

export interface SearchProviderConfig {
  limit?: number;
  fallbackReverse?: ReverseFallback;
}

export class SearchProvider<TResult extends SearchResult = SearchResult> {
  readonly adapter: SearchAdapter<TResult>;
  readonly limit: number;
  readonly fallbackReverse: ReverseFallback;

  constructor(adapter: SearchAdapter<TResult>, options: SearchProviderConfig = {}) {
    this.adapter = adapter;
    this.limit = Math.max(1, Number(options.limit ?? 8));
    this.fallbackReverse = options.fallbackReverse ?? "none";
  }

  async search(query: string, context: SearchContext = {}): Promise<TResult[]> {
    const text = String(query || "").trim();
    if (!text) return [];
    const result = await this.adapter.search(text, { limit: this.limit, ...context });
    return (result || []).slice(0, context.limit ?? this.limit);
  }

  async geocode(query: string, context: SearchContext = {}): Promise<TResult | null> {
    const text = String(query || "").trim();
    if (!text) return null;
    if (this.adapter.geocode) return await this.adapter.geocode(text, context) ?? null;
    return (await this.search(text, { ...context, limit: 1 }))[0] ?? null;
  }

  /**
   * `null` means "no reverse-geocoded place" — including the case where the adapter has no
   * `reverse()` at all. An unsupported capability stays observable instead of being dressed up
   * as a successful lookup; opt into the coordinate placeholder with `fallbackReverse`.
   */
  async reverse(center: LatLngLike, context: SearchContext = {}): Promise<TResult | null> {
    if (this.adapter.reverse) return await this.adapter.reverse(center, context) ?? null;
    if (this.fallbackReverse !== "coordinates") return null;
    const point = latLng(center);
    return {
      name: `${point.lat.toFixed(6)}, ${point.lng.toFixed(6)}`,
      center: point
    } as TResult;
  }
}

export function createSearchProvider<TResult extends SearchResult>(
  adapter: SearchAdapter<TResult>,
  options?: SearchProviderConfig
): SearchProvider<TResult> {
  return new SearchProvider(adapter, options);
}

export function createArraySearchProvider<TResult extends SearchResult>(
  items: TResult[],
  options: SearchProviderConfig & { text?: (item: TResult) => string } = {}
): SearchProvider<TResult> {
  const text = options.text ?? ((item) => `${item.name} ${item.description || ""}`);
  return new SearchProvider<TResult>({
    search(query, context) {
      const normalized = query.toLocaleLowerCase();
      return items
        .filter((item) => text(item).toLocaleLowerCase().includes(normalized))
        .slice(0, context.limit ?? options.limit ?? 8);
    }
  }, options);
}

export type SearchProviderSource<TResult extends SearchResult> = SearchAdapter<TResult> | TResult[];
export type SearchProviderOptions<TResult extends SearchResult> = SearchProviderConfig & {
  text?: (item: TResult) => string;
};

export function searchProvider<TResult extends SearchResult>(
  source: TResult[],
  options?: SearchProviderOptions<TResult>
): SearchProvider<TResult>;
export function searchProvider<TResult extends SearchResult>(
  source: SearchAdapter<TResult>,
  options?: SearchProviderConfig
): SearchProvider<TResult>;
export function searchProvider<TResult extends SearchResult>(
  source: SearchProviderSource<TResult>,
  options: SearchProviderOptions<TResult> = {}
): SearchProvider<TResult> {
  return Array.isArray(source)
    ? createArraySearchProvider(source, options)
    : createSearchProvider(source, options);
}
