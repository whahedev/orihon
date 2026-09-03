export { ObjectManager, OBJECT_MANAGER_PALETTE } from "./services/object-manager.js";
export { RemoteObjectManager } from "./services/remote-object-manager.js";
export { MarkerCollection } from "./layers/marker-collection.js";
export { objectManager, remoteObjectManager, markerCollection } from "./services/object-manager-factory.js";

export type {
  ClusterIconFactory,
  ClusterRenderer,
  ManagedObject,
  ManagedGeometry,
  ManagedPointGeometry,
  ManagedLineStringGeometry,
  ManagedPolygonGeometry,
  ObjectId,
  ObjectFilter,
  ObjectManagerAsyncOptions,
  ObjectManagerOptions,
  ObjectManagerStats,
  ObjectManagerEventMap,
  ObjectPopupContent,
  ObjectPopupContext,
  ObjectState,
  ObjectStateValue,
  ObjectStyle,
  ObjectStyleContext,
  ObjectStyleResolver,
  ObjectLabelStyle,
  ObjectLineStyle,
  ObjectPolygonStyle,
  ObjectTrailStyle,
  ObjectCollisionMode,
  ObjectGradientStop,
  ObjectImageStyle,
  ObjectSearchOptions,
  ObjectSearchResult,
  ClusterPropertiesConfig,
  ClusterPropertyDefinition,
  ObjectVisualizationMode,
  ObjectVisualizationByZoom,
  ClusterPopupContent,
  ClusterPopupContext
} from "./services/object-manager.js";
export type {
  RemoteObjectLoadContext,
  RemoteObjectLoader,
  RemoteObjectManagerOptions,
  RemoteObjectReloadOptions,
  RemoteObjectManagerEventMap
} from "./services/remote-object-manager.js";
export type {
  LocalObjectManagerOptions,
  PointObjectManagerOptions,
  UnifiedObjectManagerOptions
} from "./services/object-manager-factory.js";
export type { MarkerCollectionOptions, MarkerCollectionRenderer } from "./layers/marker-collection.js";
