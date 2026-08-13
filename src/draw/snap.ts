import { latLng, type LatLngLike } from "../geo.js";
import type { Layer } from "../layer.js";
import { FeatureGroup } from "../layer-group.js";
import { Marker } from "../layers/marker.js";
import { Circle, Polygon, Polyline } from "../layers/vector.js";
import type { Orihon } from "../map.js";

export interface DrawSnapOptions {
  enabled?: boolean;
  pixelTolerance?: number;
  grid?: boolean;
}

export interface SnapResult {
  latlng: ReturnType<typeof latLng>;
  layer?: Layer;
  snapped: boolean;
}

function layerVertices(layer: Layer): LatLngLike[] {
  if (layer instanceof Marker || layer instanceof Circle) return [layer.getLatLng()];
  if (layer instanceof Polygon) return layer.getLatLngs().flat();
  if (layer instanceof Polyline) return layer.getLatLngs() as ReturnType<Polyline["getLatLngs"]> as LatLngLike[];
  if (layer instanceof FeatureGroup) return layer.getLayers().flatMap(layerVertices);
  return [];
}

export function snapLatLng(
  map: Orihon,
  value: LatLngLike,
  layers: Iterable<Layer>,
  options: DrawSnapOptions = {}
): SnapResult {
  const source = latLng(value);
  if (options.enabled === false) return { latlng: source, snapped: false };
  const point = map.latLngToContainerPoint(source);
  const tolerance = Math.max(0, Number(options.pixelTolerance ?? 12));
  let bestDistance = tolerance;
  let best: SnapResult | null = null;
  for (const layer of layers) {
    for (const vertex of layerVertices(layer)) {
      const candidate = map.latLngToContainerPoint(vertex);
      const distance = candidate.distanceTo(point);
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = { latlng: latLng(vertex), layer, snapped: true };
      }
    }
  }
  if (best) return best;
  if (options.grid) {
    const gridSize = 10;
    return {
      latlng: map.containerPointToLatLng([
        Math.round(point.x / gridSize) * gridSize,
        Math.round(point.y / gridSize) * gridSize
      ]),
      snapped: true
    };
  }
  return { latlng: source, snapped: false };
}
