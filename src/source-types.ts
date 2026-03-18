export type FeatureId = string | number;

export interface SourceSnapshot<TFeature> {
  readonly version: number;
  readonly features: readonly TFeature[];
}

/** Fine-grained mutation without a version (used inside `batch` payloads). */
export type FeatureSourceDelta<TFeature> =
  | { readonly type: "add"; readonly features: readonly TFeature[] }
  | { readonly type: "update"; readonly features: readonly TFeature[] }
  | { readonly type: "remove"; readonly ids: readonly FeatureId[] };

export type FeatureSourceChange<TFeature> =
  | { readonly type: "add"; readonly features: readonly TFeature[]; readonly version: number }
  | { readonly type: "update"; readonly features: readonly TFeature[]; readonly version: number }
  | { readonly type: "remove"; readonly ids: readonly FeatureId[]; readonly version: number }
  | { readonly type: "batch"; readonly version: number; readonly changes: readonly FeatureSourceDelta<TFeature>[] }
  | { readonly type: "reset"; readonly version: number };

export type FeatureSourceListener<TFeature> = (change: FeatureSourceChange<TFeature>) => void;

/** Read-only structural protocol consumed by renderer layers. */
export interface ReadonlyFeatureSource<TFeature = unknown> {
  getSnapshot(): SourceSnapshot<TFeature>;
  subscribe(listener: FeatureSourceListener<TFeature>): () => void;
}
