import type { GeoJSONFeature, GeoJSONFeatureCollection, GeoJSONGeometry } from "../layers/geojson.js";

/** JSON-safe latitude/longitude pair. Arrays are deliberately not accepted. */
export interface AIPosition {
  lat: number;
  lng: number;
}

export interface AITextContent {
  text: string;
}

export interface AIPathStyle {
  stroke?: string;
  strokeWidth?: number;
  strokeOpacity?: number;
  fill?: string;
  fillOpacity?: number;
  lineCap?: "butt" | "round" | "square";
  lineJoin?: "bevel" | "round" | "miter";
  dashArray?: string | number[] | null;
  dashOffset?: number;
  geodesic?: boolean;
  arrow?: boolean | "end" | "start" | "both";
  arrowSize?: number;
  interactive?: boolean;
}

export interface AIMarkerAppearance {
  shape?: "pin" | "circle" | "square" | "dot" | "diamond" | "triangle";
  color?: string;
  strokeColor?: string;
  size?: number;
  strokeWidth?: number;
}

interface AILayerBase {
  id: string;
  attribution?: string;
  popup?: AITextContent;
  tooltip?: AITextContent;
}

export interface AIMarkerLayer extends AILayerBase {
  type: "marker";
  position: AIPosition;
  title?: string;
  appearance?: AIMarkerAppearance;
  opacity?: number;
  zIndexOffset?: number;
  interactive?: boolean;
  rotation?: number;
}

export interface AIPolylineLayer extends AILayerBase {
  type: "polyline";
  coordinates: AIPosition[];
  style?: AIPathStyle;
}

export interface AIPolygonLayer extends AILayerBase {
  type: "polygon";
  /** Outer ring, or an array whose first ring is the exterior and the rest are holes. */
  rings: AIPosition[] | AIPosition[][];
  style?: AIPathStyle;
}

export interface AIGeoJSONLayer extends AILayerBase {
  type: "geojson";
  data: GeoJSONGeometry | GeoJSONFeature | GeoJSONFeatureCollection;
  style?: AIPathStyle;
  renderer?: "svg" | "canvas" | "auto";
  maxFeatures?: number;
}

export interface AIRasterLayer extends AILayerBase {
  type: "raster";
  url: string;
  minZoom?: number;
  maxZoom?: number;
  maxNativeZoom?: number;
  tileSize?: number;
  opacity?: number;
  subdomains?: string | string[];
  noWrap?: boolean;
  tms?: boolean;
}

export type AILayerSpec =
  | AIMarkerLayer
  | AIPolylineLayer
  | AIPolygonLayer
  | AIGeoJSONLayer
  | AIRasterLayer;

export type AILayerDescription =
  | Omit<AIMarkerLayer, "id">
  | Omit<AIPolylineLayer, "id">
  | Omit<AIPolygonLayer, "id">
  | Omit<AIGeoJSONLayer, "id">
  | Omit<AIRasterLayer, "id">;

export interface AICameraSpec {
  center: AIPosition;
  zoom: number;
}

export interface AIBasemapSpec {
  type: "raster";
  url: string;
  attribution?: string;
  minZoom?: number;
  maxZoom?: number;
  maxNativeZoom?: number;
  tileSize?: number;
  opacity?: number;
  subdomains?: string | string[];
  noWrap?: boolean;
  tms?: boolean;
}

export interface AISceneSpec {
  version: 1;
  camera?: AICameraSpec;
  /** `null` removes the basemap owned by this AI session. Omission leaves it unchanged. */
  basemap?: AIBasemapSpec | null;
  layers: AILayerSpec[];
}

export type AICommand =
  | { op: "set_view"; center: AIPosition; zoom: number }
  | { op: "fly_to"; center: AIPosition; zoom?: number; durationMs?: number }
  | { op: "add"; id: string; layer: AILayerDescription }
  | { op: "update"; id: string; patch: Record<string, unknown> }
  | { op: "remove"; id: string }
  | { op: "clear"; ids?: string[] }
  | { op: "fit"; ids?: string[]; padding?: number; animation?: "none" | "fly"; durationMs?: number }
  | { op: "query"; ids?: string[] }
  | { op: "apply_scene"; scene: AISceneSpec };

/** Stable GeoJSON object consumed incrementally by FeatureSource/ObjectManager. */
export interface AIObjectFeature {
  type: "Feature";
  id: string | number;
  geometry: GeoJSONGeometry;
  properties?: Record<string, unknown> | null;
}

export type AIObjectBatchChange =
  | { type: "add"; objects: AIObjectFeature[] }
  | { type: "update"; objects: AIObjectFeature[] }
  | { type: "remove"; ids: Array<string | number> };

/** Commands for large, frequently changing object collections. */
export type AIObjectCommand =
  | { op: "objects.add"; collection: string; objects: AIObjectFeature[] }
  | { op: "objects.update"; collection: string; objects: AIObjectFeature[] }
  | { op: "objects.remove"; collection: string; ids: Array<string | number> }
  | { op: "objects.replace"; collection: string; objects: AIObjectFeature[] }
  | { op: "objects.clear"; collection: string }
  | { op: "objects.batch"; collection: string; changes: AIObjectBatchChange[] };

export type AIPointCategory = "alpha" | "beta" | "gamma" | "alert";

/** Safe image metadata for a declarative point popup. */
export interface AIPopupImage {
  /** An HTTPS URL or a local root-/document-relative URL. */
  url: string;
  alt?: string;
  caption?: string;
}

/** Rich point popup rendered through Orihon popupContent(), never as raw HTML. */
export interface AIRichPointPopup {
  text?: string;
  image?: AIPopupImage;
}

export type AIPointPopup = string | AIRichPointPopup;

export interface AIPointVisualImage {
  /** HTTPS or local URL. Rendered as a DOM image, not injected HTML. */
  url: string;
  alt?: string;
  shape?: "circle" | "rectangle";
  fit?: "cover" | "contain" | "fill";
  borderColor?: string;
  borderWidth?: number;
}

export interface AIPointVisualLabel {
  /** Defaults to the point title when omitted. */
  text?: string;
  /** Hover is the AI default; always opts into the persistent label layer. */
  display?: "hover" | "always";
  fontSize?: number;
  fontWeight?: number;
  color?: string;
  haloColor?: string;
  haloWidth?: number;
  offset?: { x: number; y: number };
  priority?: number;
  minZoom?: number;
  maxZoom?: number;
}

/** Marker presentation, independent from popup content. */
export interface AIPointVisual {
  image?: AIPointVisualImage;
  label?: string | AIPointVisualLabel;
  size?: number;
  collisionMode?: "auto" | "always" | "hide";
}

export interface AIPointSpec {
  id: string | number;
  position: AIPosition;
  title?: string;
  /** Safe plain text or declarative text/image content rendered by ObjectManager. */
  popup?: AIPointPopup;
  /** Optional photo/icon and hover-first map label. */
  visual?: AIPointVisual;
  category?: AIPointCategory;
}

/** Shared marker chrome applied when a point omits fields; image.url still comes from the point. */
export interface AIPointVisualDefaults {
  image?: Omit<AIPointVisualImage, "url"> & { url?: string };
  label?: string | AIPointVisualLabel;
  size?: number;
  collisionMode?: "auto" | "always" | "hide";
}

export interface AIPointDefaults {
  category?: AIPointCategory;
  visual?: AIPointVisualDefaults;
}

/** Partial point update for update_points intents. */
export interface AIPointPatch {
  id: string | number;
  position?: AIPosition;
  title?: string;
  popup?: AIPointPopup;
  visual?: AIPointVisual;
  category?: AIPointCategory;
}

export interface AIPointViewport {
  mode: "fit";
  padding?: number;
  animation?: "none" | "fly";
  durationMs?: number;
}

/** Viewport intent retained for recovery from the revision that created it. */
export interface AIEngineViewport extends AIPointViewport {
  collection: string;
  revision: number;
}

/** Compact command for static or moderately sized point collections. */
export interface AIPointsReplaceCommand {
  op: "points.replace";
  collection: string;
  points: AIPointSpec[];
  defaults?: AIPointDefaults;
  viewport?: AIPointViewport;
  /** Clear all AI-owned scene layers and collections before installing these points. */
  clearMap?: boolean;
}

/** Ask the engine to order an existing point collection and build a route through it. */
export interface AIRoutePlanCommand {
  op: "route.plan";
  routeId: string;
  collection: string;
  /** Optional subset of point IDs. Omission uses every point in the collection. */
  ids?: Array<string | number>;
  startId?: string | number;
  endId?: string | number;
  optimize?: "shortest";
  closeLoop?: boolean;
  /** Add visitOrder and routeId to the source objects. Default true. */
  annotateStops?: boolean;
  /** Recompute the route when its source collection changes. Default false. */
  reactive?: boolean;
}

export interface AIRouteResult {
  id?: string | number;
  name?: string;
  coordinates: AIPosition[];
  distance?: number;
  durationMs?: number;
  properties?: Record<string, unknown>;
}

export interface AIRoutePlanState {
  id: string;
  collection: string;
  waypointIds: Array<string | number>;
  routes: AIRouteResult[];
  selectedIndex: number;
  /** Normalized request retained so the engine can react to collection changes. */
  request?: AIRoutePlanCommand;
}

export interface AIRouteSummary {
  id: string;
  stops: number;
  distance?: number;
  durationMs?: number;
}

export type AICollectionCommand = AIObjectCommand | AIPointsReplaceCommand;
export type AIRouteCommand = AIRoutePlanCommand;
export type AIEngineCommand = AICommand | AICollectionCommand | AIRouteCommand;

export interface AIEngineSnapshot {
  version: 1;
  revision: number;
  scene: AISceneSpec;
  collections: Record<string, AIObjectFeature[]>;
  routes?: Record<string, AIRoutePlanState>;
  /** Applied only when its revision matches the snapshot, avoiding stale camera resets. */
  viewport?: AIEngineViewport;
}

export type AIEngineMutationEvent =
  | { type: "scene"; revision: number; command: Exclude<AICommand, { op: "query" }> }
  | {
    type: "objects";
    revision: number;
    collection: string;
    command: AICollectionCommand;
    /** Routes recomputed by the engine after a reactive collection mutation. */
    routes?: AIRoutePlanState[];
    removedRouteIds?: string[];
  }
  | { type: "route"; revision: number; route: AIRoutePlanState; command: AIRouteCommand };

export interface AIEngineTransactionEvent {
  type: "transaction";
  revision: number;
  transactionId: string;
  operation: string;
  commands: AIEngineCommand[];
  /** Ordered engine deltas. A single-command transaction can be projected without a full resync. */
  events: AIEngineMutationEvent[];
  /** Multi-command plans retain a complete atomic projection snapshot. */
  snapshot?: AIEngineSnapshot;
}

export type AIEngineEvent = AIEngineMutationEvent | AIEngineTransactionEvent;

export interface AIEngineExecuteOptions {
  /** Optimistic concurrency guard. The command fails if this is not the current revision. */
  baseRevision?: number;
}

export interface AIEngineCommandSuccess {
  op: AIEngineCommand["op"];
  revision: number;
  event?: AIEngineEvent;
  snapshot?: AIEngineSnapshot;
  route?: AIRouteSummary;
}

export interface AIEngineTransactionOptions extends AIEngineExecuteOptions {
  transactionId?: string;
  operation?: string;
}

export interface AIEngineTransactionPreview {
  revision: number;
  commands: AIEngineCommand[];
  snapshot: AIEngineSnapshot;
}

export interface AIEngineTransactionSuccess {
  op: "transaction";
  revision: number;
  event: AIEngineTransactionEvent;
  snapshot: AIEngineSnapshot;
}

/** Small model-facing response; full events continue over HTTP/SSE. */
export interface AIEngineToolSuccess {
  op: AIEngineCommand["op"];
  revision: number;
  snapshot?: AIEngineSnapshot;
  route?: AIRouteSummary;
}

export type AIErrorCode =
  | "NOT_JSON"
  | "INVALID_TYPE"
  | "INVALID_VALUE"
  | "INVALID_COORDINATE"
  | "REQUIRED_PROPERTY"
  | "UNKNOWN_PROPERTY"
  | "DUPLICATE_ID"
  | "NOT_FOUND"
  | "EMPTY_SELECTION"
  | "REVISION_CONFLICT"
  | "EXECUTION_ERROR";

export interface AIErrorDetails {
  code: AIErrorCode;
  path: string;
  message: string;
  received?: unknown;
}

export type AIResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: AIErrorDetails };

export interface AICommandSuccess {
  op: AICommand["op"];
  ids?: string[];
  scene?: AISceneSpec;
}

export interface AICapabilityOperationDescription {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** A model-native operation exposed by one Orihon subsystem. */
export interface AICapabilityDescription {
  id: string;
  version: 1;
  model: "object-manager" | "route-model" | "scene" | "interaction" | "spatial-analysis";
  description: string;
  operations: AICapabilityOperationDescription[];
}

export interface AIResourceReference {
  kind: "collection" | "route";
  id: string;
  revision?: number;
}

export interface AIPlanStep {
  id: string;
  capability: string;
  operation: string;
  dependsOn: string[];
  input: Record<string, unknown>;
  produces?: AIResourceReference[];
}

export interface AIPlan {
  version: 1;
  id: string;
  goal: AIIntent["goal"];
  baseRevision: number;
  steps: AIPlanStep[];
}

export interface AICreateVisitRouteIntent {
  goal: "create_visit_route";
  collection: string;
  routeId: string;
  points: AIPointSpec[];
  route?: {
    ids?: Array<string | number>;
    startId?: string | number;
    endId?: string | number;
    optimize?: "shortest";
    closeLoop?: boolean;
    annotateStops?: boolean;
    /** Semantic routes are reactive by default. */
    reactive?: boolean;
  };
  presentation?: {
    clearMap?: boolean;
    viewport?: AIPointViewport;
    defaults?: AIPointDefaults;
  };
}

/** Patch existing ObjectManager points by id without resending the whole collection. */
export interface AIUpdatePointsIntent {
  goal: "update_points";
  collection: string;
  points: AIPointPatch[];
  presentation?: {
    viewport?: AIPointViewport;
  };
}

export interface AIVisualizationStressIntent {
  goal: "create_visualization_stress_test";
  collection: string;
  routeId: string;
  center: AIPosition;
  objectCount: number;
  routeStops: number;
  seed?: number;
  spreadKm?: number;
}

export interface AIVisualizationStressUpdateIntent {
  goal: "update_visualization_stress_test";
  collection: string;
  center: AIPosition;
  updateCount: number;
  tick: number;
  seed?: number;
  spreadKm?: number;
}

export type AIIntent =
  | AICreateVisitRouteIntent
  | AIUpdatePointsIntent
  | AIVisualizationStressIntent
  | AIVisualizationStressUpdateIntent;

export interface AIContextCollectionSummary {
  ref: AIResourceReference;
  count: number;
  geometryTypes: string[];
  /** Truncated stable ids so agents can patch without downloading a snapshot. */
  ids: Array<string | number>;
}

export interface AIContextRouteSummary extends AIRouteSummary {
  ref: AIResourceReference;
  collection: string;
  reactive: boolean;
}

/** Compact model-facing view; details remain queryable through capabilities. */
export interface AIAgentContext {
  version: 1;
  revision: number;
  scene: { layers: number; hasBasemap: boolean; hasCamera: boolean };
  collections: AIContextCollectionSummary[];
  routes: AIContextRouteSummary[];
  capabilities: Array<{ id: string; operations: string[] }>;
}

export interface AIPlanExecution {
  plan: AIPlan;
  revision: number;
  resources: AIResourceReference[];
  context: AIAgentContext;
}

/** Compact model/HTTP facing result — omits echoed point payloads. */
export interface AIIntentCommitSuccess {
  goal: AIIntent["goal"];
  revision: number;
  resources: AIResourceReference[];
  context: AIAgentContext;
  /** Present for preview, or when resultMode is full. */
  plan?: AIPlan;
}
