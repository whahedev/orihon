export type FeatureId = string | number;

export interface SourceSnapshot<TFeature> {
  readonly version: number;
  readonly features: readonly TFeature[];
}

export type FeatureSourceChange<TFeature> =
  | { readonly type: "add" | "update"; readonly features: readonly TFeature[]; readonly version: number }
  | { readonly type: "remove"; readonly ids: readonly FeatureId[]; readonly version: number }
  | { readonly type: "reset"; readonly version: number };

export type FeatureSourceListener<TFeature> = (change: FeatureSourceChange<TFeature>) => void;

/** Read-only structural protocol consumed by renderer layers. */
export interface ReadonlyFeatureSource<TFeature = unknown> {
  getSnapshot(): SourceSnapshot<TFeature>;
  subscribe(listener: FeatureSourceListener<TFeature>): () => void;
}
