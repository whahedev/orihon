import { FeatureGroup } from "../layer-group.js";
import { nonNegativeFinite, rejectLegacyUnit } from "../units.js";
import { Polyline, polyline, type PathOptions } from "../layers/vector.js";
import { LatLng, distance, latLng, type LatLngLike } from "../geo.js";
import { AbortableOperation, isAbortError } from "./abortable-operation.js";

export interface RouteWaypoint {
  latlng: LatLngLike;
  name?: string;
}

export interface RouteResult {
  id?: string | number;
  name?: string;
  coordinates: LatLngLike[];
  distance?: number;
  /** Estimated travel time in milliseconds (convert provider seconds at the boundary). */
  durationMs?: number;
  properties?: Record<string, unknown>;
}

export interface RoutingContext {
  /** Aborting rejects route() with AbortError, even if the provider ignores the signal. */
  signal?: AbortSignal;
  alternatives?: boolean;
  [key: string]: unknown;
}

export type RoutingProvider = (
  waypoints: RouteWaypoint[],
  context: RoutingContext
) => Promise<RouteResult[] | null | undefined> | RouteResult[] | null | undefined;

export interface RoutingLayerOptions {
  provider: RoutingProvider;
  alternatives?: boolean;
  routeStyle?: PathOptions | ((route: RouteResult, index: number) => PathOptions);
  selectedStyle?: PathOptions;
}

type ResolvedRoutingLayerOptions = Required<RoutingLayerOptions>;

export interface RoutingEventMap {
  loading: { waypoints: RouteWaypoint[] };
  load: { routes: RouteResult[]; waypoints: RouteWaypoint[] };
  abort: { error: unknown; waypoints: RouteWaypoint[] };
  error: { error: unknown; waypoints: RouteWaypoint[] };
  select: { index: number; route: RouteResult };
  routeclick: { index: number; route: RouteResult; layer: Polyline; latlng?: LatLngLike; originalEvent?: MouseEvent | PointerEvent };
}

export class RoutingLayer extends FeatureGroup<RoutingEventMap> {
  readonly routingOptions: ResolvedRoutingLayerOptions;
  routes: RouteResult[] = [];
  selectedIndex = 0;
  #operation: AbortableOperation | null = null;

  constructor(options: RoutingLayerOptions) {
    super();
    if (typeof options.provider !== "function") throw new TypeError("RoutingLayer provider is required");
    this.routingOptions = {
      alternatives: true,
      routeStyle: (_, index) => ({
        stroke: index === 0 ? "#0f766e" : "#64748b",
        strokeWidth: index === 0 ? 5 : 3,
        strokeOpacity: index === 0 ? 0.95 : 0.65,
        fill: "none"
      }),
      selectedStyle: { stroke: "#d97706", strokeWidth: 6, strokeOpacity: 0.98, fill: "none" },
      ...options
    };
  }

  /** Supersedes the previous request. Cancellation rejects and retains the last successful routes. */
  async route(waypoints: Array<RouteWaypoint | LatLngLike>, context: RoutingContext = {}): Promise<RouteResult[]> {
    const normalized = waypoints.map((waypoint) => this.#normalizeWaypoint(waypoint));
    const previous = this.#operation;
    const operation = new AbortableOperation("RoutingLayer request", context.signal);
    this.#operation = operation;
    previous?.cancel();
    try {
      const result = await operation.run(() => {
        if (normalized.length < 2) return [];
        this.emit("loading", { waypoints: normalized });
        operation.throwIfAborted();
        return this.routingOptions.provider(normalized, {
          alternatives: this.routingOptions.alternatives,
          ...context,
          signal: operation.signal
        });
      });
      operation.throwIfAborted();
      this.setRoutes(result || []);
      if (normalized.length >= 2) this.emit("load", { routes: this.routes, waypoints: normalized });
      return this.routes;
    } catch (error) {
      this.emit(isAbortError(error) ? "abort" : "error", { error, waypoints: normalized });
      throw error;
    } finally {
      operation.dispose();
      if (this.#operation === operation) this.#operation = null;
    }
  }

  cancel(): this {
    const operation = this.#operation;
    this.#operation = null;
    operation?.cancel();
    return this;
  }

  override remove(): this {
    this.cancel();
    return super.remove();
  }

  override onRemove(): void {
    this.cancel();
    super.onRemove();
  }

  select(index: number): this {
    if (index < 0 || index >= this.routes.length) return this;
    this.selectedIndex = Math.floor(index);
    this.#renderRoutes();
    this.emit("select", { index: this.selectedIndex, route: this.routes[this.selectedIndex] });
    return this;
  }

  /** Install already computed provider results, for snapshots, caches and server-side planners. */
  setRoutes(routes: readonly RouteResult[], selectedIndex = 0): this {
    for (const route of routes) {
      rejectLegacyUnit(route, "duration", "durationMs");
      if (route.durationMs !== undefined) nonNegativeFinite(route.durationMs, "durationMs");
    }
    this.routes = routes.map((route) => ({
      ...route,
      coordinates: [...route.coordinates],
      ...(route.properties ? { properties: { ...route.properties } } : {})
    }));
    this.selectedIndex = this.routes.length === 0
      ? 0
      : Math.min(Math.max(0, Math.floor(selectedIndex)), this.routes.length - 1);
    this.#renderRoutes();
    return this;
  }

  getRoutes(): RouteResult[] {
    return this.routes.map((route) => ({ ...route, coordinates: route.coordinates.map((value) => latLng(value)) }));
  }

  #renderRoutes(): void {
    this.clearLayers();
    this.routes.forEach((route, index) => {
      const style = index === this.selectedIndex
        ? this.routingOptions.selectedStyle
        : typeof this.routingOptions.routeStyle === "function"
          ? this.routingOptions.routeStyle(route, index)
          : this.routingOptions.routeStyle;
      const layer = polyline(route.coordinates, style);
      layer.on("click", (event) => {
        this.select(index);
        this.emit("routeclick", { ...event, index, route, layer });
      });
      this.addLayer(layer);
    });
  }

  #normalizeWaypoint(waypoint: RouteWaypoint | LatLngLike): RouteWaypoint {
    if (Array.isArray(waypoint) || waypoint instanceof LatLng || "lat" in waypoint) {
      return { latlng: latLng(waypoint as LatLngLike) };
    }
    return { ...waypoint, latlng: latLng(waypoint.latlng) };
  }
}

export function routingLayer(options: RoutingLayerOptions): RoutingLayer {
  return new RoutingLayer(options);
}

export function createStraightLineRoutingProvider(): RoutingProvider {
  return (waypoints, context) => {
    const coordinates = waypoints.map((waypoint) => latLng(waypoint.latlng));
    const directDistance = routeDistance(coordinates);
    const routes: RouteResult[] = [{
      id: "direct",
      name: "Direct",
      coordinates,
      distance: directDistance,
      durationMs: directDistance / 13.9 * 1000,
      properties: { kind: "direct" }
    }];
    if (context.alternatives && coordinates.length >= 2) {
      const start = coordinates[0];
      const end = coordinates[coordinates.length - 1];
      const alternative = [
        start,
        latLng({ lat: (start.lat + end.lat) / 2 + 0.08, lng: (start.lng + end.lng) / 2 }),
        end
      ];
      const alternativeDistance = routeDistance(alternative);
      routes.push({
        id: "arc",
        name: "Alternative",
        coordinates: alternative,
        distance: alternativeDistance,
        durationMs: alternativeDistance / 11.2 * 1000,
        properties: { kind: "alternative" }
      });
    }
    return routes;
  };
}

function routeDistance(coordinates: LatLngLike[]): number {
  let total = 0;
  for (let index = 1; index < coordinates.length; index++) {
    total += distance(coordinates[index - 1], coordinates[index]);
  }
  return total;
}
