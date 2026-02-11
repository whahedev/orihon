import { FeatureGroup } from "../layer-group.js";
import { nonNegativeFinite, rejectLegacyUnit } from "../units.js";
import { Polyline, polyline, type PathOptions } from "../layers/vector.js";
import { LatLng, distance, latLng, type LatLngLike } from "../geo.js";

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

export class RoutingLayer extends FeatureGroup {
  readonly routingOptions: ResolvedRoutingLayerOptions;
  routes: RouteResult[] = [];
  selectedIndex = 0;
  _controller: AbortController | null = null;

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

  async route(waypoints: Array<RouteWaypoint | LatLngLike>, context: RoutingContext = {}): Promise<RouteResult[]> {
    this.cancel();
    const normalized = waypoints.map((waypoint) => this.#normalizeWaypoint(waypoint));
    if (normalized.length < 2) {
      this.routes = [];
      this.clearLayers();
      return [];
    }
    const controller = new AbortController();
    this._controller = controller;
    this.emit("loading", { waypoints: normalized });
    try {
      const result = await this.routingOptions.provider(normalized, {
        alternatives: this.routingOptions.alternatives,
        ...context,
        signal: controller.signal
      });
      if (controller.signal.aborted) return [];
      for (const route of result ?? []) {
        rejectLegacyUnit(route, "duration", "durationMs");
        if (route.durationMs !== undefined) nonNegativeFinite(route.durationMs, "durationMs");
      }
      this.routes = result || [];
      this.selectedIndex = 0;
      this.#renderRoutes();
      this.emit("load", { routes: this.routes, waypoints: normalized });
      return this.routes;
    } catch (error) {
      if (controller.signal.aborted) {
        this.emit("abort", { waypoints: normalized });
        return [];
      }
      this.emit("error", { error, waypoints: normalized });
      throw error;
    } finally {
      if (this._controller === controller) this._controller = null;
    }
  }

  cancel(): this {
    this._controller?.abort();
    this._controller = null;
    return this;
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
