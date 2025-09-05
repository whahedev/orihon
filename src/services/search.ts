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

export class SearchProvider<TResult extends SearchResult = SearchResult> {
  readonly adapter: SearchAdapter<TResult>;
  readonly limit: number;

  constructor(adapter: SearchAdapter<TResult>, options: { limit?: number } = {}) {
    this.adapter = adapter;
    this.limit = Math.max(1, Number(options.limit ?? 8));
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

  async reverse(center: LatLngLike, context: SearchContext = {}): Promise<TResult | null> {
    if (this.adapter.reverse) return await this.adapter.reverse(center, context) ?? null;
    const point = latLng(center);
    return {
      name: `${point.lat.toFixed(6)}, ${point.lng.toFixed(6)}`,
      center: point
    } as TResult;
  }
}

export function createSearchProvider<TResult extends SearchResult>(
  adapter: SearchAdapter<TResult>,
  options?: { limit?: number }
): SearchProvider<TResult> {
  return new SearchProvider(adapter, options);
}

export function createArraySearchProvider<TResult extends SearchResult>(
  items: TResult[],
  options: { limit?: number; text?: (item: TResult) => string } = {}
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
