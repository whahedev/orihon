import type { IdentifiedGeoJSONFeature } from "./geojson-types.js";
import type {
  FeatureId,
  FeatureSourceChange,
  FeatureSourceDelta,
  FeatureSourceListener,
  ReadonlyFeatureSource,
  SourceSnapshot
} from "./source-types.js";

export type FeatureCollectionInput<TFeature extends IdentifiedGeoJSONFeature> = {
  type: "FeatureCollection";
  features: TFeature[];
  bbox?: number[];
};

export type FeatureSourceInput<TFeature extends IdentifiedGeoJSONFeature> =
  | TFeature
  | FeatureCollectionInput<TFeature>
  | Iterable<TFeature>;

export type FeatureUpdate<TFeature extends IdentifiedGeoJSONFeature> =
  | TFeature
  | Partial<Omit<TFeature, "type" | "id">>;

type PendingFeatureSourceChange<TFeature> =
  | { type: "add"; features: readonly TFeature[] }
  | { type: "update"; features: readonly TFeature[] }
  | { type: "remove"; ids: readonly FeatureId[] }
  | { type: "reset" };

/**
 * What a batch did to one id, as endpoints rather than as a last-write-wins verb.
 * Collapsing to the final verb loses the starting point, and the delta a subscriber needs is
 * a function of both: a `remove` followed by an `add` is an `update` for anyone holding the
 * old feature, and an `add` followed by a `remove` of a pre-existing id is still a `remove`.
 */
interface BatchState<TFeature> {
  /** Whether the id existed in the source when this batch first touched it. */
  readonly initiallyPresent: boolean;
  currentlyPresent: boolean;
  /** Latest value; always set while `currentlyPresent` is true. */
  feature?: TFeature;
}

/** Reactive, renderer-independent GeoJSON feature storage. */
export class FeatureSource<TFeature extends IdentifiedGeoJSONFeature = IdentifiedGeoJSONFeature>
implements ReadonlyFeatureSource<TFeature> {
  readonly #features = new Map<FeatureId, TFeature>();
  readonly #listeners = new Set<FeatureSourceListener<TFeature>>();
  #version = 0;
  #batchDepth = 0;
  #batchReset = false;
  #batchIntents: Map<FeatureId, BatchState<TFeature>> | null = null;
  #snapshot: SourceSnapshot<TFeature> | null = null;

  constructor(input?: FeatureSourceInput<TFeature> | null) {
    if (input) this.#insert(input, false);
  }

  get size(): number { return this.#features.size; }
  get version(): number { return this.#version; }
  has(id: FeatureId): boolean { return this.#features.has(id); }
  get(id: FeatureId): TFeature | undefined { return this.#features.get(id); }

  getSnapshot(): SourceSnapshot<TFeature> {
    if (!this.#snapshot) {
      this.#snapshot = {
        version: this.#version,
        features: [...this.#features.values()]
      };
    }
    return this.#snapshot;
  }

  /** Return only the feature collection, without the snapshot version. */
  getFeatures(): readonly TFeature[] { return this.getSnapshot().features; }

  toGeoJSON(): FeatureCollectionInput<TFeature> {
    return { type: "FeatureCollection", features: [...this.getSnapshot().features] };
  }

  add(feature: TFeature): this { return this.#insert(feature, true); }
  addMany(features: Iterable<TFeature>): this { return this.#insert(features, true); }

  /**
   * Shallow-merge a full feature or a patch into an existing id.
   * Both overloads preserve unspecified optional fields from the current value.
   */
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

  /** Run synchronous nested mutations as one versioned `batch` (or `reset`). */
  batch(callback: () => void): this {
    this.#batchDepth++;
    try {
      const result = callback() as unknown;
      if (result != null && typeof (result as PromiseLike<unknown>).then === "function") {
        throw new TypeError("FeatureSource.batch() callback must be synchronous");
      }
    } finally {
      this.#batchDepth--;
      if (this.#batchDepth === 0) this.#flushBatch();
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
      this.#recordBatchChange(change);
      return;
    }
    this.#invalidateSnapshot();
    this.#dispatch({ ...change, version: ++this.#version } as FeatureSourceChange<TFeature>);
  }

  #recordBatchChange(change: PendingFeatureSourceChange<TFeature>): void {
    if (change.type === "reset") {
      this.#batchReset = true;
      this.#batchIntents = null;
      return;
    }
    if (this.#batchReset) return;
    if (!this.#batchIntents) this.#batchIntents = new Map();
    if (change.type === "remove") {
      for (const id of change.ids) {
        const state = this.#batchIntents.get(id);
        // `remove` only reports ids it actually deleted, so an untouched id was present.
        if (state) {
          state.currentlyPresent = false;
          state.feature = undefined;
        } else {
          this.#batchIntents.set(id, { initiallyPresent: true, currentlyPresent: false });
        }
      }
      return;
    }
    for (const feature of change.features) {
      const state = this.#batchIntents.get(feature.id);
      if (state) {
        state.currentlyPresent = true;
        state.feature = feature;
      } else {
        // The first change for an id reveals what the batch started from: `add` refuses a
        // duplicate id, and `update` refuses a missing one.
        this.#batchIntents.set(feature.id, {
          initiallyPresent: change.type === "update",
          currentlyPresent: true,
          feature
        });
      }
    }
  }

  #flushBatch(): void {
    if (this.#batchReset) {
      this.#batchReset = false;
      this.#batchIntents = null;
      this.#invalidateSnapshot();
      this.#dispatch({ type: "reset", version: ++this.#version });
      return;
    }
    const intents = this.#batchIntents;
    this.#batchIntents = null;
    if (!intents?.size) return;
    const added: TFeature[] = [];
    const updated: TFeature[] = [];
    const removed: FeatureId[] = [];
    for (const [id, state] of intents) {
      // absent -> present = add; present -> present = update; present -> absent = remove;
      // absent -> absent leaves the source exactly as the batch found it, so it emits nothing.
      if (state.currentlyPresent) {
        if (state.initiallyPresent) updated.push(state.feature as TFeature);
        else added.push(state.feature as TFeature);
      } else if (state.initiallyPresent) {
        removed.push(id);
      }
    }
    const changes: FeatureSourceDelta<TFeature>[] = [];
    if (added.length) changes.push({ type: "add", features: added });
    if (updated.length) changes.push({ type: "update", features: updated });
    if (removed.length) changes.push({ type: "remove", ids: removed });
    if (!changes.length) return;
    this.#invalidateSnapshot();
    this.#dispatch({ type: "batch", version: ++this.#version, changes });
  }

  #invalidateSnapshot(): void {
    this.#snapshot = null;
  }

  #dispatch(change: FeatureSourceChange<TFeature>): void {
    for (const listener of [...this.#listeners]) listener(change);
  }
}

export function featureSource<TFeature extends IdentifiedGeoJSONFeature = IdentifiedGeoJSONFeature>(
  input?: FeatureSourceInput<TFeature> | null
): FeatureSource<TFeature> {
  return new FeatureSource(input);
}

export type { IdentifiedGeoJSONFeature } from "./geojson-types.js";

export type {
  FeatureId,
  FeatureSourceChange,
  FeatureSourceDelta,
  FeatureSourceListener,
  ReadonlyFeatureSource,
  SourceSnapshot
} from "./source-types.js";
