import type { GeoJSONFeature } from "./layers/geojson.js";
import type {
  FeatureId,
  FeatureSourceChange,
  FeatureSourceListener,
  ReadonlyFeatureSource,
  SourceSnapshot
} from "./source-types.js";

export type FeatureCollectionInput<TFeature extends GeoJSONFeature> = {
  type: "FeatureCollection";
  features: TFeature[];
  bbox?: number[];
};

export type FeatureSourceInput<TFeature extends GeoJSONFeature> =
  | TFeature
  | FeatureCollectionInput<TFeature>
  | Iterable<TFeature>;

export type FeatureUpdate<TFeature extends GeoJSONFeature> =
  | TFeature
  | Partial<Omit<TFeature, "type" | "id">>;

type PendingFeatureSourceChange<TFeature> =
  | { type: "add" | "update"; features: readonly TFeature[] }
  | { type: "remove"; ids: readonly FeatureId[] }
  | { type: "reset" };

/** Reactive, renderer-independent GeoJSON feature storage. */
export class FeatureSource<TFeature extends GeoJSONFeature = GeoJSONFeature>
implements ReadonlyFeatureSource<TFeature> {
  readonly #features = new Map<FeatureId, TFeature>();
  readonly #listeners = new Set<FeatureSourceListener<TFeature>>();
  #version = 0;
  #batchDepth = 0;
  #batchChanged = false;

  constructor(input?: FeatureSourceInput<TFeature> | null) {
    if (input) this.#insert(input, false);
  }

  get size(): number { return this.#features.size; }
  get version(): number { return this.#version; }
  has(id: FeatureId): boolean { return this.#features.has(id); }
  get(id: FeatureId): TFeature | undefined { return this.#features.get(id); }

  getSnapshot(): SourceSnapshot<TFeature> {
    return { version: this.#version, features: [...this.#features.values()] };
  }

  /** Convenience alias for callers that need only the snapshot features. */
  getFeatures(): readonly TFeature[] { return this.getSnapshot().features; }

  toGeoJSON(): FeatureCollectionInput<TFeature> {
    return { type: "FeatureCollection", features: [...this.#features.values()] };
  }

  add(feature: TFeature): this { return this.#insert(feature, true); }
  addMany(features: Iterable<TFeature>): this { return this.#insert(features, true); }

  update(feature: TFeature): this;
  update(id: FeatureId, update: FeatureUpdate<TFeature>): this;
  update(idOrFeature: FeatureId | TFeature, update?: FeatureUpdate<TFeature>): this {
    const id = typeof idOrFeature === "object" ? idOrFeature.id : idOrFeature;
    if (id == null) throw new TypeError("FeatureSource.update requires feature.id");
    const current = this.#features.get(id);
    if (!current) throw new RangeError(`FeatureSource: feature "${String(id)}" does not exist`);
    const patch = typeof idOrFeature === "object" ? idOrFeature : update;
    if (!patch) throw new TypeError("FeatureSource.update requires a feature or patch");
    const feature = { ...current, ...patch, type: "Feature", id } as TFeature;
    this.#features.set(id, feature);
    this.#emit({ type: "update", features: [feature] });
    return this;
  }

  remove(id: FeatureId | Iterable<FeatureId>): this {
    const input = typeof id === "string" || typeof id === "number" ? [id] : id;
    const ids: FeatureId[] = [];
    for (const candidate of input) if (this.#features.delete(candidate)) ids.push(candidate);
    if (ids.length) this.#emit({ type: "remove", ids });
    return this;
  }

  replace(input: FeatureSourceInput<TFeature>): this {
    const next = this.#prepare(input, new Map());
    this.#features.clear();
    for (const [id, feature] of next) this.#features.set(id, feature);
    this.#emit({ type: "reset" });
    return this;
  }

  clear(): this {
    if (!this.#features.size) return this;
    this.#features.clear();
    this.#emit({ type: "reset" });
    return this;
  }

  batch(callback: () => void): this {
    this.#batchDepth++;
    try {
      callback();
    } finally {
      this.#batchDepth--;
      if (this.#batchDepth === 0 && this.#batchChanged) {
        this.#batchChanged = false;
        this.#dispatch({ type: "reset", version: ++this.#version });
      }
    }
    return this;
  }

  subscribe(listener: FeatureSourceListener<TFeature>): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  #insert(input: FeatureSourceInput<TFeature>, notify: boolean): this {
    const staged = this.#prepare(input, this.#features);
    for (const [id, feature] of staged) this.#features.set(id, feature);
    if (notify && staged.size) this.#emit({ type: "add", features: [...staged.values()] });
    return this;
  }

  #prepare(input: FeatureSourceInput<TFeature>, existing: ReadonlyMap<FeatureId, TFeature>): Map<FeatureId, TFeature> {
    const staged = new Map<FeatureId, TFeature>();
    for (const feature of this.#normalizeInput(input)) {
      if (!feature || feature.type !== "Feature") throw new TypeError("FeatureSource accepts GeoJSON Feature objects");
      if (feature.id == null) throw new TypeError("FeatureSource requires feature.id");
      if (existing.has(feature.id) || staged.has(feature.id)) {
        throw new TypeError(`FeatureSource: duplicate feature id "${String(feature.id)}"`);
      }
      staged.set(feature.id, feature);
    }
    return staged;
  }

  #normalizeInput(input: FeatureSourceInput<TFeature>): Iterable<TFeature> {
    if (!input || typeof input !== "object") {
      throw new TypeError("FeatureSource accepts a Feature, FeatureCollection, or iterable of Features");
    }
    if ((input as FeatureCollectionInput<TFeature>).type === "FeatureCollection") {
      return (input as FeatureCollectionInput<TFeature>).features;
    }
    if ((input as TFeature).type === "Feature") return [input as TFeature];
    if (typeof (input as Iterable<TFeature>)[Symbol.iterator] === "function") return input as Iterable<TFeature>;
    throw new TypeError("FeatureSource accepts a Feature, FeatureCollection, or iterable of Features");
  }

  #emit(change: PendingFeatureSourceChange<TFeature>): void {
    if (this.#batchDepth > 0) {
      this.#batchChanged = true;
      return;
    }
    this.#dispatch({ ...change, version: ++this.#version } as FeatureSourceChange<TFeature>);
  }

  #dispatch(change: FeatureSourceChange<TFeature>): void {
    for (const listener of [...this.#listeners]) listener(change);
  }
}

export function featureSource<TFeature extends GeoJSONFeature = GeoJSONFeature>(
  input?: FeatureSourceInput<TFeature> | null
): FeatureSource<TFeature> {
  return new FeatureSource(input);
}

export const createFeatureSource = featureSource;

export type {
  FeatureId,
  FeatureSourceChange,
  FeatureSourceListener,
  ReadonlyFeatureSource,
  SourceSnapshot
} from "./source-types.js";
