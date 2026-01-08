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
};

export type UnifiedObjectManagerOptions =
  | ObjectManagerOptions
  | RemoteObjectManagerOptions
  | PointObjectManagerOptions;

export function objectManager(options: RemoteObjectManagerOptions): RemoteObjectManager;
export function objectManager(options: PointObjectManagerOptions): MarkerCollection;
export function objectManager(options?: ObjectManagerOptions): ObjectManager;
export function objectManager(options: UnifiedObjectManagerOptions = {}): ObjectManager | RemoteObjectManager | MarkerCollection {
  if ("loader" in options && typeof options.loader === "function") {
    return new RemoteObjectManager(options);
  }
  if ("points" in options) {
    const { points, ...markerOptions } = options;
    return new MarkerCollection(points, markerOptions);
  }
  return new ObjectManager(options);
}
