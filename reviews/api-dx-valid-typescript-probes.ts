import {
  GeometryWorkerPool,
  Layer,
  createGeometryWorkerPool,
  createMap,
  geometryWorkerPool,
  icon,
  marker,
  objectManager,
  type DivIconOptions,
  type IconOptions,
  type ManagedObject,
  type ObjectManagerOptions,
  type PointObjectManagerOptions,
  type RemoteObjectManagerOptions
} from "../dist/index.js";
import { createMap as createEasyMap } from "../dist/easy-entry.js";
import { FeatureSource, createFeatureSource, featureSource } from "../dist/feature-source.js";

declare const host: HTMLElement;
declare const existingLayer: Layer;

// GeoJSON is longitude/latitude; LatLngLike tuples are latitude/longitude.
const externalGeoJsonCoordinate: [number, number] = [37.6176, 55.7558];
marker(externalGeoJsonCoordinate); // Valid, but Moscow is interpreted near Somalia.

const map = createMap(host);
map.center.lat = 0;
map.zoom = 99;
map.options.zoom = -10;
map.layers.clear(); // All compile; none follows the normal camera/layer lifecycle.

const path = marker([55.7558, 37.6176]);
path.options.opacity = 0.1; // Compiles; direct mutation does not update a mounted marker DOM node.

marker([55.7558, 37.6176], {
  content: "A",
  html: "<strong>B</strong>",
  icon: icon({ content: "C" }),
  shape: "diamond",
  color: "red"
}); // icon wins; content/html/shape/color are ignored. `html` would be textContent anyway.

map.flyTo([55.7558, 37.6176], 12, { duration: 1 }); // seconds
objectManager().moveObject("train", [55.7558, 37.6176], { duration: 1 }); // milliseconds

const easy = createEasyMap(host);
const mapResult = easy.add(existingLayer); // EasyMap
const layerResult = easy.add({ type: "marker", position: [55.7558, 37.6176] }); // Marker
void [mapResult, layerResult];

easy.add({
  type: "polyline",
  coordinates: [[55.75, 37.60], [55.77, 37.65]],
  style: { width: 20, strokeWidth: 2, opacity: 0.1, strokeOpacity: 0.9 }
}); // Canonical properties silently win over aliases.

const bothIconModes: IconOptions & DivIconOptions = {
  iconUrl: "/pin.png",
  content: "ignored"
};
icon(bothIconModes); // Image Icon; content is ignored by runtime property dispatch.

const bothManagerModes: RemoteObjectManagerOptions & PointObjectManagerOptions = {
  loader: async () => [] as ManagedObject[],
  points: [[55.7558, 37.6176]]
};
objectManager(bothManagerModes); // RemoteObjectManager; points are ignored.

objectManager().add({
  id: "moscow",
  coordinates: [55.7558, 37.6176], // legacy [lat, lng]
  geometry: { type: "Point", coordinates: [13.405, 52.52] } // GeoJSON [lng, lat], silently wins
});

map.on("clik", () => {}); // Typo is accepted.
map.on<{ type: string; target: typeof map; sourceTarget: typeof map; detail: { impossible: true } }>(
  "click",
  event => event.detail.impossible
); // Caller can assert an unrelated payload for any event name.

const a = featureSource();
const b = createFeatureSource();
const c = new FeatureSource();
const p1 = createGeometryWorkerPool();
const p2 = geometryWorkerPool();
const p3 = new GeometryWorkerPool();
void [a, b, c, p1, p2, p3];

declare const regularOptions: ObjectManagerOptions;
objectManager(regularOptions);
