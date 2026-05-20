import { createMap } from "orihon/easy";
import "orihon/orihon.css";
import "./style.css";

const map = createMap("map", {
  center: { lat: 52.52, lng: 13.405 },
  zoom: 12,
  basemap: {
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    // Tile providers require credit. Keep this when you switch to your own basemap.
    attribution: "© OpenStreetMap contributors"
  }
});

map.addMarker({
  position: { lat: 52.52, lng: 13.405 },
  appearance: { shape: "pin", color: "#0f766e" },
  popup: "Berlin"
});
