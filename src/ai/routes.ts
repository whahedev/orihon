import { distance, latLng } from "../geo.js";
import { createStraightLineRoutingProvider, type RouteWaypoint } from "../services/routing.js";
import { AIError } from "./errors.js";
import type {
  AIObjectFeature,
  AIRoutePlanCommand,
  AIRoutePlanState,
  AIPosition
} from "./types.js";

const MAX_ROUTE_STOPS = 100;

interface RouteStop {
  id: string | number;
  position: AIPosition;
  name?: string;
}

export interface PlannedAIRoute {
  state: AIRoutePlanState;
  objects: AIObjectFeature[];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function pathDistance(stops: readonly RouteStop[], closeLoop: boolean): number {
  let total = 0;
  for (let index = 1; index < stops.length; index++) {
    total += distance(stops[index - 1].position, stops[index].position);
  }
  if (closeLoop && stops.length > 1) total += distance(stops.at(-1)!.position, stops[0].position);
  return total;
}

function greedyOrder(stops: readonly RouteStop[], start: RouteStop, end?: RouteStop): RouteStop[] {
  const remaining = stops.filter((stop) => stop !== start && stop !== end);
  const ordered = [start];
  while (remaining.length > 0) {
    const current = ordered.at(-1)!;
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < remaining.length; index++) {
      const candidateDistance = distance(current.position, remaining[index].position);
      if (candidateDistance < bestDistance) {
        bestDistance = candidateDistance;
        bestIndex = index;
      }
    }
    ordered.push(remaining.splice(bestIndex, 1)[0]);
  }
  if (end) ordered.push(end);
  return ordered;
}

function improveTwoOpt(stops: RouteStop[], closeLoop: boolean, fixedEnd: boolean): RouteStop[] {
  let best = stops;
  let bestDistance = pathDistance(best, closeLoop);
  for (let pass = 0; pass < 8; pass++) {
    let improved = false;
    const lastMovable = best.length - 1 - (fixedEnd ? 1 : 0);
    for (let start = 1; start < lastMovable; start++) {
      for (let end = start + 1; end <= lastMovable; end++) {
        const candidate = [
          ...best.slice(0, start),
          ...best.slice(start, end + 1).reverse(),
          ...best.slice(end + 1)
        ];
        const candidateDistance = pathDistance(candidate, closeLoop);
        if (candidateDistance + 0.01 < bestDistance) {
          best = candidate;
          bestDistance = candidateDistance;
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return best;
}

function pointStop(feature: AIObjectFeature, path: string): RouteStop {
  if (feature.geometry.type !== "Point") {
    throw new AIError("INVALID_VALUE", path, `Route stop "${String(feature.id)}" must have Point geometry`, feature.geometry.type);
  }
  const [lng, lat] = feature.geometry.coordinates;
  const title = feature.properties?.title;
  return {
    id: feature.id,
    position: { lat, lng },
    ...(typeof title === "string" ? { name: title.replace(/^\d+\.\s*/, "") } : {})
  };
}

function selectedStops(command: AIRoutePlanCommand, objects: readonly AIObjectFeature[]): RouteStop[] {
  const byId = new Map(objects.map((feature) => [feature.id, feature]));
  const selected = command.ids ?? objects.filter((feature) => feature.geometry.type === "Point").map(({ id }) => id);
  if (selected.length < 2) {
    throw new AIError("EMPTY_SELECTION", "$command.ids", "A route requires at least two point objects", selected);
  }
  if (selected.length > MAX_ROUTE_STOPS) {
    throw new AIError("INVALID_VALUE", "$command.ids", `A route supports at most ${MAX_ROUTE_STOPS} stops`, selected.length);
  }
  return selected.map((id, index) => {
    const feature = byId.get(id);
    if (!feature) throw new AIError("NOT_FOUND", `$command.ids[${index}]`, `Object "${String(id)}" does not exist`, id);
    return pointStop(feature, `$command.ids[${index}]`);
  });
}

function stopById(stops: readonly RouteStop[], id: string | number | undefined, path: string): RouteStop | undefined {
  if (id === undefined) return undefined;
  const stop = stops.find((candidate) => candidate.id === id);
  if (!stop) throw new AIError("NOT_FOUND", path, `Route stop "${String(id)}" is not selected`, id);
  return stop;
}

function optimizeStops(command: AIRoutePlanCommand, stops: RouteStop[]): RouteStop[] {
  const requestedStart = stopById(stops, command.startId, "$command.startId");
  const requestedEnd = stopById(stops, command.endId, "$command.endId");
  if (requestedStart && requestedEnd && requestedStart === requestedEnd) {
    throw new AIError("INVALID_VALUE", "$command.endId", "startId and endId must be different", command.endId);
  }
  if (command.closeLoop && requestedEnd) {
    throw new AIError("INVALID_VALUE", "$command.endId", "endId cannot be combined with closeLoop", command.endId);
  }

  const candidates = requestedStart
    ? [requestedStart]
    : stops.filter((stop) => stop !== requestedEnd).sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const starts = candidates.length <= 30 ? candidates : candidates.slice(0, 1);
  let best: RouteStop[] | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const start of starts) {
    const ordered = improveTwoOpt(greedyOrder(stops, start, requestedEnd), command.closeLoop === true, Boolean(requestedEnd));
    const candidateDistance = pathDistance(ordered, command.closeLoop === true);
    if (candidateDistance < bestDistance) {
      best = ordered;
      bestDistance = candidateDistance;
    }
  }
  return best!;
}

/** Plan an AI route using the existing RoutingProvider/RouteResult contract. */
export function planAIRoute(
  command: AIRoutePlanCommand,
  collectionObjects: readonly AIObjectFeature[]
): PlannedAIRoute {
  const stops = optimizeStops(command, selectedStops(command, collectionObjects));
  const waypoints: RouteWaypoint[] = stops.map((stop) => ({ latlng: stop.position, name: stop.name }));
  if (command.closeLoop) waypoints.push({ ...waypoints[0] });
  const providerResult = createStraightLineRoutingProvider()(waypoints, { alternatives: false });
  if (!Array.isArray(providerResult)) throw new Error("The built-in straight-line routing provider must be synchronous");
  const routes = providerResult.map((route) => ({
    ...clone(route),
    coordinates: route.coordinates.map((coordinate) => {
      const value = latLng(coordinate);
      return { lat: value.lat, lng: value.lng };
    })
  }));
  const objects = collectionObjects.map((feature) => {
    const previous = feature.properties ?? {};
    if (previous.routeId !== command.routeId) return clone(feature);
    const properties = { ...previous };
    delete properties.routeId;
    delete properties.visitOrder;
    return { ...clone(feature), properties };
  });
  if (command.annotateStops !== false) {
    const indexes = new Map(objects.map((feature, index) => [feature.id, index]));
    stops.forEach((stop, index) => {
      const objectIndex = indexes.get(stop.id)!;
      const feature = objects[objectIndex];
      objects[objectIndex] = {
        ...feature,
        properties: { ...(feature.properties ?? {}), routeId: command.routeId, visitOrder: index + 1 }
      };
    });
  }
  return {
    state: {
      id: command.routeId,
      collection: command.collection,
      waypointIds: stops.map(({ id }) => id),
      routes,
      selectedIndex: 0,
      request: clone(command)
    },
    objects
  };
}
