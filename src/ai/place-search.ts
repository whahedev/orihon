import { AIError, toAIError } from "./errors.js";
import type { AILLMExecutableTool } from "./agent.js";
import type { AIPosition, AIResult } from "./types.js";

export interface AIPlaceSearchImage {
  url: string;
  alt?: string;
}

export type AIPlaceSearchProfile = "visit" | "any";
export type AIPlaceSearchResultMode = "compact" | "full";

export interface AIPlaceSearchCandidate {
  id: string;
  title: string;
  position: AIPosition;
  query?: string;
  displayName?: string;
  category?: string;
  image?: AIPlaceSearchImage;
  summary?: string;
}

export interface AIPlaceSearchProvider {
  search(input: {
    query: string;
    limit: number;
    area?: string;
    city?: string;
    profile?: AIPlaceSearchProfile;
  }, options?: { signal?: AbortSignal }): Promise<AIPlaceSearchCandidate[]>;
}

export interface AIPlaceSearchRequest {
  queries: string[];
  area?: string;
  city?: string;
  limitPerQuery?: number;
  includeImages?: boolean;
  includeSummaries?: boolean;
  profile?: AIPlaceSearchProfile;
  resultMode?: AIPlaceSearchResultMode;
}

export interface AIPlaceSearchSuccess {
  area?: string;
  city?: string;
  profile: AIPlaceSearchProfile;
  places: AIPlaceSearchCandidate[];
  missing: string[];
  imagesMissing?: string[];
}

export interface NominatimPlaceSearchOptions {
  endpoint?: string;
  userAgent: string;
  fetch?: typeof globalThis.fetch;
  minIntervalMs?: number;
  wikipediaEndpoint?: string;
  wikipediaRestEndpoint?: string;
}

type NominatimProviderWithMedia = AIPlaceSearchProvider & {
  attachImages?: (places: AIPlaceSearchCandidate[], options?: { signal?: AbortSignal }) => Promise<AIPlaceSearchCandidate[]>;
  attachMedia?: (
    places: AIPlaceSearchCandidate[],
    options?: { signal?: AbortSignal; images?: boolean; summaries?: boolean }
  ) => Promise<AIPlaceSearchCandidate[]>;
};

const VISIT_REJECT_TYPES = new Set([
  "administrative", "college", "school", "university", "kindergarten",
  "bicycle_rental", "motorcycle_rental", "car_rental", "parking", "fuel",
  "bus_stop", "residential", "house", "apartments",
  "neighbourhood", "suburb", "county", "state", "country", "postcode",
  "municipality", "region", "province", "hamlet"
]);

const VISIT_REJECT_CLASSES = new Set(["boundary", "office", "highway", "railway", "shop"]);

const VISIT_PREFERRED_TYPES = new Set([
  "museum", "attraction", "archaeological_site", "ruins", "monument", "memorial",
  "castle", "palace", "fort", "city_gate", "viewpoint", "peak", "volcano",
  "canyon", "cliff", "cave_entrance", "beach", "island", "islet", "national_park",
  "nature_reserve", "park", "zoo", "theme_park", "artwork", "gallery", "cathedral",
  "basilica", "monastery", "temple", "shrine", "pyramid", "wreck", "lighthouse",
  "square", "pedestrian", "fountain", "waterfall", "hot_spring"
]);

const VISIT_PREFERRED_CLASSES = new Set(["tourism", "historic", "natural", "leisure", "waterway"]);

const VISIT_WEAK_TYPES = new Set(["city", "town", "village", "square", "pedestrian", "island"]);

function requiredText(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim() === "") throw new AIError("INVALID_TYPE", path, "Expected a non-empty string", value);
  const text = value.trim();
  if (text.length > maxLength) throw new AIError("INVALID_VALUE", path, `Text must not exceed ${maxLength} characters`, text.length);
  return text;
}

function optionalText(value: unknown, path: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  return requiredText(value, path, maxLength);
}

function httpsAsset(url: string | undefined): string | undefined {
  const clean = url?.split("?")[0];
  return clean?.startsWith("https://") ? clean : undefined;
}

function isDisambiguation(title?: string, extract?: string): boolean {
  if (title && /\(disambiguation\)$/i.test(title)) return true;
  if (!extract) return false;
  return /\bmay refer to\b/i.test(extract) || /\bdisambiguation page\b/i.test(extract);
}

function usableSummary(extract?: string, title?: string): string | undefined {
  const text = extract?.trim();
  if (!text || isDisambiguation(title, text)) return undefined;
  return text;
}

function mediaLookupKeys(place: AIPlaceSearchCandidate): string[] {
  return [...new Set([place.query, place.title].map((value) => value?.trim()).filter(Boolean))] as string[];
}

function visitScore(osmClass: string | undefined, type: string | undefined): number {
  const cls = osmClass?.toLowerCase() ?? "";
  const kind = type?.toLowerCase() ?? "";
  if (VISIT_REJECT_TYPES.has(kind) || VISIT_REJECT_CLASSES.has(cls)) return -1;
  if (VISIT_PREFERRED_TYPES.has(kind) || VISIT_PREFERRED_CLASSES.has(cls)) return 2;
  if (VISIT_WEAK_TYPES.has(kind) || cls === "place") return 1;
  return 0;
}

type RankedPlace = AIPlaceSearchCandidate & { osmClass?: string };

function pickVisitMatches(rows: RankedPlace[], limit: number): AIPlaceSearchCandidate[] {
  const scored = rows
    .map((place) => ({ place, score: visitScore(place.osmClass, place.category) }))
    .filter(({ score }) => score >= 0)
    .sort((a, b) => b.score - a.score);
  const preferred = scored.filter(({ score }) => score >= 2);
  const chosen = preferred.length ? preferred : scored.filter(({ score }) => score >= 1);
  const pool = chosen.length ? chosen : scored;
  return pool.slice(0, limit).map(({ place }) => {
    const { osmClass: _osmClass, ...rest } = place;
    return rest;
  });
}

function compactPlace(place: AIPlaceSearchCandidate, mode: AIPlaceSearchResultMode): AIPlaceSearchCandidate {
  if (mode === "full") return place;
  return {
    id: place.id,
    title: place.title,
    position: { ...place.position },
    ...(place.query ? { query: place.query } : {}),
    ...(place.category ? { category: place.category } : {}),
    ...(place.image ? { image: { ...place.image } } : {}),
    ...(place.summary ? { summary: place.summary } : {})
  };
}

function resolveWikiTitle(
  title: string,
  normalized: Map<string, string>,
  redirects: Map<string, string>
): string {
  let key = title;
  if (normalized.has(key)) key = normalized.get(key)!;
  if (redirects.has(key)) key = redirects.get(key)!;
  return key;
}

async function fetchJson(
  fetcher: typeof globalThis.fetch,
  url: string | URL,
  options: { userAgent: string; signal?: AbortSignal; retries?: number; retryDelayMs?: number }
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const retries = options.retries ?? 2;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await fetcher(url, {
      headers: { "user-agent": options.userAgent, accept: "application/json" },
      signal: options.signal
    });
    if (response.status === 429 && attempt < retries) {
      await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs ?? 200 * (attempt + 1)));
      continue;
    }
    if (!response.ok) return { ok: false, status: response.status, json: undefined };
    return { ok: true, status: response.status, json: await response.json() };
  }
  return { ok: false, status: 429, json: undefined };
}

async function wikipediaMedia(
  titles: string[],
  options: {
    endpoint: string;
    restEndpoint: string;
    fetch: typeof globalThis.fetch;
    signal?: AbortSignal;
    userAgent: string;
    images: boolean;
    summaries: boolean;
  }
): Promise<Map<string, { image?: string; summary?: string; wikiTitle?: string }>> {
  const unique = [...new Set(titles.map((title) => title.trim()).filter(Boolean))].slice(0, 20);
  const map = new Map<string, { image?: string; summary?: string; wikiTitle?: string }>();
  if (unique.length === 0 || (!options.images && !options.summaries)) return map;

  const readPage = (page: { title?: string; thumbnail?: { source?: string }; extract?: string }) => {
    if (!page.title || isDisambiguation(page.title, page.extract)) return undefined;
    const image = options.images ? httpsAsset(page.thumbnail?.source) : undefined;
    const summary = options.summaries ? usableSummary(page.extract, page.title) : undefined;
    if (!image && !summary) return undefined;
    return { wikiTitle: page.title, ...(image ? { image } : {}), ...(summary ? { summary } : {}) };
  };

  const assignFromQuery = (payload: {
    query?: {
      pages?: Record<string, { title?: string; thumbnail?: { source?: string }; extract?: string }>;
      redirects?: Array<{ from: string; to: string }>;
      normalized?: Array<{ from: string; to: string }>;
    };
  }) => {
    const pages = payload.query?.pages ?? {};
    const byTitle = new Map<string, NonNullable<ReturnType<typeof readPage>>>();
    for (const page of Object.values(pages)) {
      const parsed = readPage(page);
      if (parsed && page.title) byTitle.set(page.title, parsed);
    }
    const redirects = new Map((payload.query?.redirects ?? []).map((row) => [row.from, row.to]));
    const normalized = new Map((payload.query?.normalized ?? []).map((row) => [row.from, row.to]));
    for (const title of unique) {
      const resolved = byTitle.get(resolveWikiTitle(title, normalized, redirects));
      if (resolved) map.set(title, resolved);
    }
  };

  const fillProps = (url: URL) => {
    url.searchParams.set("action", "query");
    url.searchParams.set("format", "json");
    url.searchParams.set("redirects", "1");
    const props = [];
    if (options.images) {
      props.push("pageimages");
      url.searchParams.set("piprop", "thumbnail");
      url.searchParams.set("pithumbsize", "500");
    }
    if (options.summaries) {
      props.push("extracts");
      url.searchParams.set("exintro", "1");
      url.searchParams.set("explaintext", "1");
      url.searchParams.set("exchars", "500");
    }
    url.searchParams.set("prop", props.join("|"));
  };

  const url = new URL(options.endpoint);
  fillProps(url);
  url.searchParams.set("titles", unique.join("|"));
  const batch = await fetchJson(options.fetch, url, {
    userAgent: options.userAgent,
    signal: options.signal,
    retries: 2
  });
  if (batch.ok && batch.json && typeof batch.json === "object") assignFromQuery(batch.json as Parameters<typeof assignFromQuery>[0]);

  const stillMissing = () => unique.filter((title) => {
    const got = map.get(title);
    return (options.images && !got?.image) || (options.summaries && !got?.summary);
  });

  for (const title of stillMissing()) {
    const rest = new URL(`${options.restEndpoint.replace(/\/$/, "")}/${encodeURIComponent(title)}`);
    const page = await fetchJson(options.fetch, rest, {
      userAgent: options.userAgent,
      signal: options.signal,
      retries: 2
    });
    if (!page.ok || !page.json || typeof page.json !== "object") continue;
    const raw = page.json as {
      title?: string;
      thumbnail?: { source?: string };
      extract?: string;
      query?: { pages?: Record<string, { title?: string; thumbnail?: { source?: string }; extract?: string }> };
    };
    const row = raw.query?.pages ? Object.values(raw.query.pages)[0] ?? raw : raw;
    const parsed = readPage({ title: row.title ?? title, thumbnail: row.thumbnail, extract: row.extract });
    if (!parsed) continue;
    const current = map.get(title) ?? {};
    map.set(title, {
      wikiTitle: parsed.wikiTitle ?? current.wikiTitle,
      ...(current.image || parsed.image ? { image: current.image ?? parsed.image } : {}),
      ...(current.summary || parsed.summary ? { summary: current.summary ?? parsed.summary } : {})
    });
  }

  for (const title of stillMissing()) {
    const searchUrl = new URL(options.endpoint);
    searchUrl.searchParams.set("action", "query");
    searchUrl.searchParams.set("format", "json");
    searchUrl.searchParams.set("list", "search");
    searchUrl.searchParams.set("srnamespace", "0");
    searchUrl.searchParams.set("srlimit", "3");
    searchUrl.searchParams.set("srsearch", title);
    const search = await fetchJson(options.fetch, searchUrl, {
      userAgent: options.userAgent,
      signal: options.signal,
      retries: 2
    });
    const hits = search.ok && search.json && typeof search.json === "object"
      ? (search.json as { query?: { search?: Array<{ title?: string }> } }).query?.search ?? []
      : [];
    const hit = hits.find((row) => row.title && !isDisambiguation(row.title));
    if (!hit?.title) continue;
    const pageUrl = new URL(options.endpoint);
    fillProps(pageUrl);
    pageUrl.searchParams.set("titles", hit.title);
    const page = await fetchJson(options.fetch, pageUrl, {
      userAgent: options.userAgent,
      signal: options.signal,
      retries: 2
    });
    if (page.ok && page.json && typeof page.json === "object") {
      const pages = (page.json as { query?: { pages?: Record<string, { title?: string; thumbnail?: { source?: string }; extract?: string }> } }).query?.pages ?? {};
      for (const row of Object.values(pages)) {
        const parsed = readPage(row);
        if (parsed) map.set(title, parsed);
      }
    }
  }
  return map;
}

function clonePlace(place: AIPlaceSearchCandidate): AIPlaceSearchCandidate {
  return {
    ...place,
    position: { ...place.position },
    ...(place.image ? { image: { ...place.image } } : {})
  };
}

/** Server-side geocoder. Callers must identify their application according to Nominatim policy. */
export function createNominatimPlaceSearchProvider(options: NominatimPlaceSearchOptions): NominatimProviderWithMedia {
  const userAgent = requiredText(options?.userAgent, "$options.userAgent", 200);
  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") throw new TypeError("A Fetch-compatible implementation is required");
  const baseURL = options.endpoint ?? "https://nominatim.openstreetmap.org/search";
  const wikipediaEndpoint = options.wikipediaEndpoint ?? "https://en.wikipedia.org/w/api.php";
  const wikipediaRestEndpoint = options.wikipediaRestEndpoint ?? "https://en.wikipedia.org/api/rest_v1/page/summary";
  const minIntervalMs = options.minIntervalMs ?? 1_050;
  if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0 || minIntervalMs > 60_000) throw new RangeError("minIntervalMs is invalid");
  const cache = new Map<string, AIPlaceSearchCandidate[]>();
  let queue = Promise.resolve();
  let lastStartedAt = 0;

  const attachMedia = async (
    places: AIPlaceSearchCandidate[],
    runOptions: { signal?: AbortSignal; images?: boolean; summaries?: boolean } = {}
  ) => {
    const images = runOptions.images !== false;
    const summaries = runOptions.summaries === true;
    const media = await wikipediaMedia(places.flatMap(mediaLookupKeys), {
      endpoint: wikipediaEndpoint,
      restEndpoint: wikipediaRestEndpoint,
      fetch: fetcher,
      signal: runOptions.signal,
      userAgent,
      images,
      summaries
    });
    return places.map((place) => {
      const extra = mediaLookupKeys(place).map((key) => media.get(key)).find((value) => value?.image || value?.summary);
      const title = extra?.wikiTitle ?? place.title;
      return {
        ...place,
        title,
        ...(extra?.image ? { image: { url: extra.image, alt: title } } : {}),
        ...(extra?.summary ? { summary: extra.summary } : {})
      };
    });
  };

  return Object.freeze({
    search(input: {
      query: string;
      limit: number;
      area?: string;
      city?: string;
      profile?: AIPlaceSearchProfile;
    }, runOptions: { signal?: AbortSignal } = {}) {
      const query = requiredText(input.query, "$input.query", 200);
      const area = (input.area ?? input.city)?.trim() ? (input.area ?? input.city)!.trim() : undefined;
      const profile = input.profile === "any" ? "any" : "visit";
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 5) {
        return Promise.reject(new AIError("INVALID_VALUE", "$input.limit", "limit must be an integer from 1 to 5", input.limit));
      }
      const fetchLimit = profile === "visit" ? Math.min(10, Math.max(5, input.limit * 4)) : input.limit;
      const key = `${profile}\n${area ?? ""}\n${query}\n${input.limit}`.toLocaleLowerCase();
      const cached = cache.get(key);
      if (cached) return Promise.resolve(cached.map(clonePlace));

      const work = queue.then(async () => {
        const waitMs = Math.max(0, minIntervalMs - (Date.now() - lastStartedAt));
        if (waitMs > 0) await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(resolve, waitMs);
          runOptions.signal?.addEventListener("abort", () => { clearTimeout(timeout); reject(new DOMException("Search aborted", "AbortError")); }, { once: true });
        });
        lastStartedAt = Date.now();
        const url = new URL(baseURL);
        url.searchParams.set("format", "jsonv2");
        url.searchParams.set("limit", String(fetchLimit));
        url.searchParams.set("namedetails", "1");
        url.searchParams.set("q", area ? `${query}, ${area}` : query);
        const response = await fetcher(url, { headers: { "user-agent": userAgent, accept: "application/json" }, signal: runOptions.signal });
        if (!response.ok) throw new AIError("EXECUTION_ERROR", "$placeSearch", `Nominatim returned HTTP ${response.status}`);
        const payload = await response.json() as unknown;
        if (!Array.isArray(payload)) throw new AIError("EXECUTION_ERROR", "$placeSearch", "Nominatim response must be an array", payload);
        const parsed = payload.flatMap((item): RankedPlace[] => {
          if (!item || typeof item !== "object" || Array.isArray(item)) return [];
          const row = item as Record<string, unknown>;
          const lat = Number(row.lat);
          const lng = Number(row.lon);
          if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return [];
          const displayName = typeof row.display_name === "string" ? row.display_name : query;
          const osmType = typeof row.osm_type === "string" ? row.osm_type : "place";
          const osmId = typeof row.osm_id === "number" || typeof row.osm_id === "string" ? String(row.osm_id) : String(row.place_id ?? `${lat}-${lng}`);
          const osmClass = typeof row.category === "string" ? row.category : typeof row.class === "string" ? row.class : undefined;
          const type = typeof row.type === "string" ? row.type : undefined;
          const namedetails = row.namedetails && typeof row.namedetails === "object" && !Array.isArray(row.namedetails)
            ? row.namedetails as Record<string, unknown>
            : {};
          const englishName = typeof namedetails["name:en"] === "string" ? namedetails["name:en"].trim() : "";
          return [{
            id: `osm-${osmType}-${osmId}`,
            title: englishName || displayName.split(",")[0].trim() || query,
            position: { lat, lng },
            displayName,
            query,
            ...(type ? { category: type } : {}),
            ...(osmClass ? { osmClass } : {})
          }];
        });
        const places = profile === "visit" ? pickVisitMatches(parsed, input.limit) : parsed.slice(0, input.limit).map((place) => {
          const { osmClass: _osmClass, ...rest } = place;
          return rest;
        });
        cache.set(key, places);
        return places.map(clonePlace);
      });
      queue = work.then(() => undefined, () => undefined);
      return work;
    },
    attachMedia,
    attachImages(places: AIPlaceSearchCandidate[], runOptions: { signal?: AbortSignal } = {}) {
      return attachMedia(places, { ...runOptions, images: true, summaries: false });
    }
  });
}

export async function executeAIPlaceSearch(
  provider: NominatimProviderWithMedia,
  input: unknown,
  runOptions: { signal?: AbortSignal } = {}
): Promise<AIResult<AIPlaceSearchSuccess>> {
  try {
    if (!provider || typeof provider.search !== "function") throw new TypeError("executeAIPlaceSearch requires a provider");
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new AIError("INVALID_TYPE", "$input", "Expected an object", input);
    const source = input as Record<string, unknown>;
    for (const key of Object.keys(source)) {
      if (
        key !== "city" && key !== "area" && key !== "queries" && key !== "limitPerQuery"
        && key !== "includeImages" && key !== "includeSummaries" && key !== "profile" && key !== "resultMode"
      ) {
        throw new AIError("UNKNOWN_PROPERTY", `$input.${key}`, `Unknown property "${key}"`, source[key]);
      }
    }
    const city = optionalText(source.city, "$input.city", 120);
    const area = optionalText(source.area, "$input.area", 120) ?? city;
    if (!Array.isArray(source.queries) || source.queries.length < 1 || source.queries.length > 20) {
      throw new AIError("INVALID_VALUE", "$input.queries", "Expected 1 to 20 place queries", source.queries);
    }
    const queries = source.queries.map((query, index) => requiredText(query, `$input.queries[${index}]`, 200));
    const limit = source.limitPerQuery === undefined ? 1 : Number(source.limitPerQuery);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5) throw new AIError("INVALID_VALUE", "$input.limitPerQuery", "Expected an integer from 1 to 5", source.limitPerQuery);
    const includeImages = source.includeImages === true;
    const includeSummaries = source.includeSummaries === true;
    const profile = source.profile === "any" ? "any" : "visit";
    const resultMode = source.resultMode === "full" ? "full" : "compact";
    let places: AIPlaceSearchCandidate[] = [];
    const missing: string[] = [];
    const ids = new Set<string>();
    for (const query of queries) {
      const matches = await provider.search({ query, limit, profile, ...(area ? { area } : {}) }, runOptions);
      if (matches.length === 0) missing.push(query);
      for (const place of matches) {
        if (ids.has(place.id)) continue;
        ids.add(place.id);
        places.push({ ...place, query: place.query ?? query });
      }
    }
    if (includeImages || includeSummaries) {
      try {
        if (typeof provider.attachMedia === "function") {
          places = await provider.attachMedia(places, { signal: runOptions.signal, images: includeImages, summaries: includeSummaries });
        } else if (includeImages && typeof provider.attachImages === "function") {
          places = await provider.attachImages(places, runOptions);
        }
      } catch (error) {
        if (runOptions.signal?.aborted) throw error;
      }
    }
    const imagesMissing = includeImages
      ? [...new Set(places.filter((place) => !place.image?.url).map((place) => place.query ?? place.title))]
      : undefined;
    return {
      ok: true,
      value: {
        ...(area ? { area } : {}),
        ...(city ? { city } : {}),
        profile,
        places: places.map((place) => compactPlace(place, resultMode)),
        missing,
        ...(imagesMissing && imagesMissing.length ? { imagesMissing } : {})
      }
    };
  } catch (error) {
    return { ok: false, error: toAIError(error).toJSON() };
  }
}

export function createAIPlaceSearchTool(provider: NominatimProviderWithMedia): AILLMExecutableTool {
  if (!provider || typeof provider.search !== "function") throw new TypeError("createAIPlaceSearchTool requires a provider");
  return Object.freeze({
    definition: Object.freeze({
      name: "orihon_search_places",
      description: "Resolve candidate place names to verified coordinates (and optional photos/summaries) before creating an Orihon map plan. Default profile is visit: skip administrative and service POIs. City is optional; pass area for a country or region. Compact results omit displayName.",
      inputSchema: Object.freeze({
        type: "object",
        required: ["queries"],
        additionalProperties: false,
        properties: {
          city: { type: "string", minLength: 1, maxLength: 120 },
          area: { type: "string", minLength: 1, maxLength: 120 },
          queries: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", minLength: 1, maxLength: 200 } },
          limitPerQuery: { type: "integer", minimum: 1, maximum: 5 },
          includeImages: { type: "boolean" },
          includeSummaries: { type: "boolean" },
          profile: { enum: ["visit", "any"] },
          resultMode: { enum: ["compact", "full"] }
        }
      })
    }),
    execute(input: unknown, runOptions: { signal?: AbortSignal } = {}) {
      return executeAIPlaceSearch(provider, input, runOptions);
    }
  });
}

export const ORIHON_AI_AGENT_SYSTEM_PROMPT = `Use orihon_search_places (or POST /api/orihon/places) before orihon_plan whenever a request needs real-world places or coordinates. Propose specific candidate names, resolve them through search, and use only returned coordinates. Never invent coordinates. City is optional — pass area for a country or region. Default search profile is visit. Set includeImages true when the user wants photo markers; copy returned image.url into visual.image and keep popup as plain text (or returned summary) so the map popup reuses the photo. If imagesMissing is present, search a more precise name — do not invent image URLs. Then call orihon_plan once with stable IDs, clearMap true when replacing the map, viewport fit, presentation.defaults.visual for shared circle chrome, and engine-side route optimization. Use update_points to patch existing ids. Labels omit display unless the user asks for persistent text. Never send raw HTML. If search misses a candidate, omit it or search for a more precise name. After the map tool succeeds, answer briefly with what changed and the measured tool usage when available.`;
