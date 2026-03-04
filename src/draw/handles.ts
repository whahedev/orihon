import { latLng, type LatLngLike } from "../geo.js";
import { Marker, marker } from "../layers/marker.js";

export type DrawHandleKind = "vertex" | "midpoint";

export interface DrawHandle {
  marker: Marker;
  kind: DrawHandleKind;
  ring: number;
  index: number;
}

export function drawHandle(position: LatLngLike, kind: DrawHandleKind, ring: number, index: number): DrawHandle {
  return {
    marker: marker(position, {
      className: `oh-draw-handle oh-draw-${kind}-handle`,
      anchor: [6, 6],
      // Explicit empty content lets draw CSS render the handle without a pin.
      content: "",
      draggable: true,
      keyboard: false,
      title: kind === "vertex" ? "Vertex" : "Insert vertex"
    }),
    kind,
    ring,
    index
  };
}

export function midpoint(a: LatLngLike, b: LatLngLike): LatLngLike {
  const first = latLng(a);
  const second = latLng(b);
  return { lat: (first.lat + second.lat) / 2, lng: (first.lng + second.lng) / 2 };
}
