import React from "react";
import { createRoot } from "react-dom/client";
import { GeoJSON, Map, Marker, ObjectManager, Popup, TileLayer } from "orihon/react";
import "orihon/orihon.css";

const area = { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[13.32, 52.47], [13.5, 52.47], [13.5, 52.57], [13.32, 52.47]]] } } as const;

function seeded(seed: number) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = seeded(0xc0ffee);
const hubs: Array<[number, number]> = [
  [52.52, 13.405],
  [52.50, 13.38],
  [52.54, 13.42],
  [52.49, 13.45],
  [52.53, 13.35]
];
const objects = Array.from({ length: 100 }, (_, id) => {
  const hub = hubs[id % hubs.length];
  const angle = rand() * Math.PI * 2;
  const radius = 0.004 + rand() * rand() * 0.035;
  return {
    id,
    coordinates: ({ lat: hub[0] + Math.cos(angle) * radius, lng: hub[1] + Math.sin(angle) * radius * 1.4 }) as [number, number]
  };
});

function App() {
  return <Map center={[52.52, 13.405]} zoom={11} style={{ height: "100vh" }}>
    <TileLayer url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="© OpenStreetMap contributors" />
    <GeoJSON data={area} style={{ dashArray: "8 4", fillOpacity: .08 }} />
    <Marker position={[52.52, 13.405]} title="Berlin"><Popup>Berlin</Popup></Marker>
    <ObjectManager objects={objects} clusterize />
  </Map>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
