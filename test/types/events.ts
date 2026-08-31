// Check the shipped declarations, not just source-level inference.
import {
  Evented, type Orihon, type LatLng, type Point, type Marker, type Circle,
  type MapEventMap, type MarkerEventMap, type EventFor, type EventHandler
} from "orihon";
import type { RoutingLayer, SuggestWidget, PerformanceInspector, RouteResult } from "orihon/advanced";
import type { ObjectManager, RemoteObjectManager } from "orihon/object-manager";
import type { EventFor as CoreEventFor, MapEventMap as CoreMapEventMap } from "orihon/core";
import type { MarkerEventMap as StandardMarkerEventMap } from "orihon/standard";
import { type DrawHandler, type DrawControl, type DrawMode } from "orihon/draw";
import { useMapEvent, type MapProps } from "orihon/react";

declare const map: Orihon;
declare const pin: Marker;
declare const draw: DrawHandler;
declare const control: DrawControl;
declare const manager: ObjectManager;
declare const remote: RemoteObjectManager;
declare const routing: RoutingLayer;
declare const suggest: SuggestWidget<{ label: string; id: number }>;
declare const inspector: PerformanceInspector;
declare const dynamicName: string;
declare const unionName: "zoom" | "move";

const click: EventHandler<EventFor<MapEventMap, "click", Orihon>> = (event) => {
  const position: LatLng = event.latlng;
  const point: Point = event.containerPoint;
  const target: Orihon = event.target;
  const name: "click" = event.type;
  // @ts-expect-error Mirrored detail bags are gone — use flat fields.
  const legacy: LatLng = event.detail.latlng;
  // @ts-expect-error Unknown fields are unknown, not any.
  const missing: number = event.missing;
  // @ts-expect-error The source may be a propagated child, not necessarily a map.
  const source: Orihon = event.sourceTarget;
};
map.on("click", click).once("click", click).off("click", click).off("click").off();
const coreClick: EventHandler<CoreEventFor<CoreMapEventMap, "click", Orihon>> = click;
const standardClick: EventHandler<EventFor<StandardMarkerEventMap, "click", Marker>> =
  (event: EventFor<MarkerEventMap, "click", Marker>) => {};
pin.on("click", standardClick);
pin.on("drag", (event) => {
  const position: LatLng = event.latlng;
  const target: Marker = event.target;
  // @ts-expect-error Drag does not emit an originalEvent.
  const original: MouseEvent = event.originalEvent;
});
pin.on("add", (event) => { const owner: Orihon = event.map; });
map.once("zoom", (event) => { const zoom: number = event.zoom; });
map.on(unionName, (event) => {
  if (event.type === "zoom") { const zoom: number = event.zoom; }
  else { const center: LatLng = event.center; }
});
map.on(dynamicName, (event) => {
  // @ts-expect-error Dynamic names cannot promise a payload.
  const zoom: number = event.zoom;
});
map.on("plugin:unregistered", (event) => {
  // @ts-expect-error Custom names without an event-map entry remain unknown.
  const value: number = event.value;
});
// @ts-expect-error A wrong callback must not widen the known literal name.
map.on("zoom", (event: { type: "zoom"; zoom: string }) => {});
// @ts-expect-error once has the same contract as on.
map.once("zoom", (event: { type: "zoom"; zoom: string }) => {});
// @ts-expect-error off also checks the callback payload.
map.off("zoom", (event: { type: "zoom"; zoom: string }) => {});
// @ts-expect-error The generic parameter is now an event name, not an asserted event shape.
map.on<{ type: "zoom"; zoom: string }>("zoom", () => {});

interface PluginEvents { ready: { value: number }; }
class Plugin extends Evented<PluginEvents> {}
new Plugin().on("ready", (event) => {
  const value: number = event.value;
  const detail: number = event.value;
  const target: Plugin = event.target;
});
// Event maps can also be augmented by a plugin at the owning module.
declare module "orihon" { interface MapEventMap { "plugin:ready": { value: number }; } }
map.on("plugin:ready", (event) => { const value: number = event.value; });

draw.on("modechange", (event) => {
  const mode: DrawMode = event.mode;
  const previous: DrawMode = event.previous;
});
control.once("drawcomplete", (event) => {
  const type: "Feature" = event.geojson.type;
  const target: DrawHandler = event.target;
  // @ts-expect-error The control delegates subscriptions to its handler.
  const notTarget: DrawControl = event.target;
});
draw.on("editvertex", (event) => {
  if (event.role === "radius") {
    const circle: Circle = event.layer;
    const meters: number | undefined = event.radiusMeters;
    const units: number | undefined = event.radiusMapUnits;
  }
});
manager.on("objectstatechange", (event) => { const keys: string[] = event.changedKeys; });
manager.on("error", (event) => { const phase: "layout" = event.phase; });
manager.on("hover", (event) => {
  // @ts-expect-error Hover-out may have no position or a null position.
  const position: LatLng = event.latlng;
});
remote.on("load", (event) => { const reason: "add" | "move" | "reload" = event.context.reason; });
remote.on("error", (event) => {
  // @ts-expect-error A layout failure has no request context.
  const signal: AbortSignal = event.context.signal;
  if (event.phase !== "layout") { const signal: AbortSignal = event.context.signal; }
  // @ts-expect-error Providers may reject arbitrary values, not just Error objects.
  const message: string = event.error.message;
});
routing.on("select", (event) => { const route: RouteResult = event.route; });
routing.on("add", (event) => { const owner: Orihon = event.map; });
suggest.on("select", (event) => { const id: number = event.item.id; });
suggest.on("results", (event) => { const labels: string[] = event.items.map((item) => item.label); });
inspector.on("measure", (event) => { const fps: number | null = event.snapshot.fps; });

useMapEvent("click", (event) => { const position: LatLng = event.latlng; });
useMapEvent("zoom", (event) => { const zoom: number = event.zoom; });
// @ts-expect-error React does not widen known names to accept an incompatible callback.
useMapEvent("zoom", (event: { type: "zoom"; zoom: string }) => {});
const props: MapProps = { center: { lat: 0, lng: 0 }, zoom: 3, onClick: (event) => { const position: LatLng = event.latlng; } };
