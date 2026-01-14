import type { ReadonlyFeatureSource } from "./source-types.js";

export function isReadonlyFeatureSource<TFeature>(value: unknown): value is ReadonlyFeatureSource<TFeature> {
  if (!value || typeof value !== "object") return false;
  const source = value as Partial<ReadonlyFeatureSource<TFeature>>;
  return typeof source.getSnapshot === "function" && typeof source.subscribe === "function";
}
