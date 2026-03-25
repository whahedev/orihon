import type { LatLngLike } from "../geo.js";
import {
  MarkerCollection,
  type MarkerCollectionOptions
} from "../layers/marker-collection.js";
import {
  ObjectManager,
  type ObjectManagerOptions
} from "./object-manager.js";
import {
  RemoteObjectManager,
  type RemoteObjectManagerOptions
} from "./remote-object-manager.js";

export type PointObjectManagerOptions = MarkerCollectionOptions & {
  points: Iterable<LatLngLike>;
  loader?: never;
  source?: never;
  debounceMs?: never;
  replace?: never;
  clusterize?: never;
  clusterRenderer?: never;
  style?: never;
};

export type LocalObjectManagerOptions = ObjectManagerOptions & {
  loader?: never;
  points?: never;
  debounceMs?: never;
  replace?: never;
};

export type UnifiedObjectManagerOptions =
  | LocalObjectManagerOptions
  | RemoteObjectManagerOptions
  | PointObjectManagerOptions;

/** Remote object manager driven by a `loader`. Prefer this over `objectManager({ loader })`. */
export function remoteObjectManager(options: RemoteObjectManagerOptions): RemoteObjectManager {
  return objectManager(options);
}

/** Lightweight point collection. Prefer this over `objectManager({ points })`. */
export function markerCollection(
  points: Iterable<LatLngLike>,
  options: MarkerCollectionOptions = {}
): MarkerCollection {
  return objectManager({ ...options, points } as PointObjectManagerOptions);
}

/**
 * Option-shape facade over three different classes: `loader` → `RemoteObjectManager`,
 * `points` → `MarkerCollection`, neither → `ObjectManager`. A factory whose runtime type depends
 * on which key is present is hard to predict, especially for options assembled dynamically, so
 * prefer `remoteObjectManager()` / `markerCollection()` by name and keep `objectManager()` for
 * the plain local manager. Mixed configurations are rejected rather than resolved by precedence.
 */
export function objectManager(options: RemoteObjectManagerOptions): RemoteObjectManager;
export function objectManager(options: PointObjectManagerOptions): MarkerCollection;
export function objectManager(options?: LocalObjectManagerOptions): ObjectManager;
export function objectManager(options: UnifiedObjectManagerOptions): ObjectManager | RemoteObjectManager | MarkerCollection;
export function objectManager(options: UnifiedObjectManagerOptions = {}): ObjectManager | RemoteObjectManager | MarkerCollection {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new TypeError("objectManager options must be an object");
  if ("loader" in options && "points" in options) throw new TypeError("objectManager accepts either loader or points, not both");
  if ("loader" in options) {
    if (typeof options.loader !== "function") throw new TypeError("objectManager loader must be a function");
    return new RemoteObjectManager(options as RemoteObjectManagerOptions);
  }
  if (options.debounceMs !== undefined || options.replace !== undefined) {
    throw new TypeError("objectManager debounceMs and replace require loader mode");
  }
  if ("points" in options) {
    if (!options.points || typeof options.points[Symbol.iterator] !== "function") throw new TypeError("objectManager points must be an iterable of named coordinates");
    for (const key of ["source", "clusterize", "clusterRenderer", "style"] as const) {
      if (options[key] !== undefined) throw new TypeError(`objectManager points mode does not accept ${key}`);
    }
    const { points, ...markerOptions } = options;
    return new MarkerCollection(points, markerOptions);
  }
  return new ObjectManager(options as LocalObjectManagerOptions);
}
