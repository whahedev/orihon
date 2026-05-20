import { Map, TileLayer, Marker, Popup } from "orihon/react";

const berlin = { lat: 52.52, lng: 13.405 };

export default function App() {
  return (
    <Map className="orihon-map" center={berlin} zoom={12}>
      <TileLayer
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        // Tile providers require credit. Keep this when you switch to your own basemap.
        attribution="© OpenStreetMap contributors"
      />
      <Marker position={berlin} shape="pin" color="#0f766e">
        <Popup>Berlin</Popup>
      </Marker>
    </Map>
  );
}
