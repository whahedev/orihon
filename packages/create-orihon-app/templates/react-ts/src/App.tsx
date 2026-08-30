import { useEffect, useRef } from "react";
import { createMap } from "orihon/easy";
import {
  circle,
  circleMarker,
  rectangle,
  textLayer,
  imageOverlay,
  videoOverlay,
  featureGroup,
  marker
} from "orihon";

// Map centre — change these, or pass --center when you scaffold.
const center = { lat: __ORIHON_CENTER_LAT__, lng: __ORIHON_CENTER_LNG__ };

export default function App() {
  const host = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!host.current) return;

    const map = createMap(host.current, {
      center,
      zoom: 13,
      locale: __ORIHON_LOCALE__,
      basemap: {
        url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
        // Tile providers require credit. Keep this when you switch to your own basemap.
        attribution: "© OpenStreetMap contributors"
      }
    });
    
    // ---------------------------------------------------------------------------
    // Demo layers — Easy map methods + a few Standard factories (.addTo(map)).
    // Delete any block you do not need, or edit coordinates / styles for your data.
    // ---------------------------------------------------------------------------
    
    // Marker (Easy) — pin with a popup.
    map.addMarker({
      position: center,
      appearance: { shape: "pin", color: "#0f766e" },
      popup: "Marker — pin at the centre. Edit or delete."
    });
    
    // Marker with HTML content (Easy) — pass a DOM node (a string is shown as plain text).
    const htmlBadge = document.createElement("div");
    htmlBadge.style.cssText =
      "padding:4px 8px;border-radius:999px;background:#7c3aed;color:#fff;font:12px system-ui";
    htmlBadge.textContent = "HTML";
    map.addMarker({
      position: { lat: center.lat + 0.006, lng: center.lng - 0.008 },
      content: htmlBadge,
      popup: "Marker — HTML content mode"
    });
    
    // CircleMarker (Standard) — fixed pixel radius; good for stations / events.
    circleMarker(
      { lat: center.lat - 0.005, lng: center.lng - 0.006 },
      { radiusPixels: 10, fill: "#dc2626", fillOpacity: 0.95, stroke: "#fff", strokeWidth: 2 }
    )
      .bindPopup("CircleMarker — pixel-sized point (this was easy to miss: bind a popup)")
      .bindTooltip("CircleMarker")
      .addTo(map);
    
    // Circle (Standard) — geographic radius in metres.
    circle(
      { lat: center.lat + 0.002, lng: center.lng - 0.014 },
      { radiusMeters: 350 },
      { fill: "#f59e0b", fillOpacity: 0.2, stroke: "#d97706", strokeWidth: 2 }
    )
      .bindPopup("Circle — 350 m radius")
      .addTo(map);
    
    // Polyline (Easy) — a path / route.
    map.addPolyline({
      points: [
        { lat: center.lat - 0.008, lng: center.lng - 0.012 },
        { lat: center.lat - 0.002, lng: center.lng - 0.004 },
        { lat: center.lat + 0.006, lng: center.lng + 0.01 }
      ],
      style: { stroke: "#2563eb", strokeWidth: 4 },
      popup: "Polyline — a route sample"
    });
    
    // Polygon (Easy) — a filled area.
    map.addPolygon({
      rings: [
        { lat: center.lat + 0.004, lng: center.lng + 0.006 },
        { lat: center.lat + 0.004, lng: center.lng + 0.014 },
        { lat: center.lat - 0.002, lng: center.lng + 0.014 },
        { lat: center.lat - 0.002, lng: center.lng + 0.006 }
      ],
      style: { fill: "#0f766e", fillOpacity: 0.25, stroke: "#0f766e", strokeWidth: 2 },
      popup: "Polygon — an area sample"
    });
    
    // Rectangle (Standard) — bounds instead of an arbitrary ring.
    rectangle(
      [
        { lat: center.lat - 0.01, lng: center.lng + 0.002 },
        { lat: center.lat - 0.004, lng: center.lng + 0.012 }
      ],
      { fill: "#0891b2", fillOpacity: 0.15, stroke: "#0e7490", strokeWidth: 2 }
    )
      .bindPopup("Rectangle — LatLngBounds sample")
      .addTo(map);
    
    // GeoJSON (Easy) — Point / LineString / Polygon from a FeatureCollection.
    // Without pointToLayer, points become a default circle with no popup (easy to think it is "broken").
    map.addGeoJSON({
      data: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { name: "GeoJSON Point" },
            geometry: {
              type: "Point",
              coordinates: [center.lng - 0.01, center.lat + 0.006]
            }
          },
          {
            type: "Feature",
            properties: { name: "GeoJSON LineString" },
            geometry: {
              type: "LineString",
              coordinates: [
                [center.lng + 0.008, center.lat + 0.008],
                [center.lng + 0.016, center.lat + 0.004],
                [center.lng + 0.012, center.lat - 0.002]
              ]
            }
          },
          {
            type: "Feature",
            properties: { name: "GeoJSON Polygon" },
            geometry: {
              type: "Polygon",
              coordinates: [[
                [center.lng - 0.016, center.lat - 0.002],
                [center.lng - 0.01, center.lat - 0.002],
                [center.lng - 0.01, center.lat - 0.008],
                [center.lng - 0.016, center.lat - 0.008],
                [center.lng - 0.016, center.lat - 0.002]
              ]]
            }
          }
        ]
      },
      pointToLayer: (_feature, position) =>
        marker(position, { shape: "pin", color: "#b45309", title: "GeoJSON Point" }),
      onEachFeature: (feature, layer) => {
        layer.bindPopup(feature.properties?.name ?? "GeoJSON feature");
      },
      style: { stroke: "#b45309", strokeWidth: 3, fill: "#fbbf24", fillOpacity: 0.25 }
    });
    
    // FeatureGroup (Standard) — group layers so you can show/hide them together.
    featureGroup([
      marker(
        { lat: center.lat + 0.01, lng: center.lng + 0.004 },
        { shape: "circle", color: "#4f46e5" }
      ).bindPopup("FeatureGroup child A"),
      marker(
        { lat: center.lat + 0.012, lng: center.lng + 0.008 },
        { shape: "circle", color: "#4f46e5" }
      ).bindPopup("FeatureGroup child B")
    ]).addTo(map);
    
    // TextLayer (Standard) — canvas labels at geographic points.
    textLayer(
      [
        {
          type: "Feature",
          properties: { label: "TextLayer" },
          geometry: { type: "Point", coordinates: [center.lng + 0.002, center.lat + 0.011] }
        }
      ],
      {
        text: (feature) => feature.properties.label,
        font: "bold 13px system-ui",
        fill: "#111827",
        halo: "#ffffff",
        haloWidth: 3
      }
    ).addTo(map);
    
    // ImageOverlay (Standard) — stretch an image over geographic bounds (plan, scan, logo).
    // Self-contained SVG data URL: no CDN, nothing to expire.
    const overlaySvg =
      "data:image/svg+xml," +
      encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200">
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#7dd3fc"/>
          <stop offset="100%" stop-color="#e0f2fe"/>
        </linearGradient>
      </defs>
      <rect width="320" height="200" fill="url(#sky)"/>
      <circle cx="260" cy="48" r="22" fill="#fde68a"/>
      <path d="M0 140 C60 110 100 160 160 130 C210 108 250 150 320 128 L320 200 L0 200 Z" fill="#16a34a"/>
      <path d="M0 158 C80 148 140 170 200 150 C250 136 280 160 320 148 L320 200 L0 200 Z" fill="#15803d"/>
      <rect x="24" y="118" width="36" height="42" fill="#78716c"/>
      <polygon points="24,118 42,96 60,118" fill="#b91c1c"/>
      <text x="160" y="28" text-anchor="middle" fill="#0f172a" font-family="system-ui,sans-serif" font-size="16" font-weight="700">ImageOverlay</text>
    </svg>`);
    imageOverlay(
      overlaySvg,
      [
        { lat: center.lat - 0.014, lng: center.lng - 0.004 },
        { lat: center.lat - 0.008, lng: center.lng + 0.006 }
      ],
      { opacity: 0.95, interactive: true }
    )
      .bindPopup("ImageOverlay — inline SVG (no external URL to break)")
      .addTo(map);
    
    // VideoOverlay (Standard) — video fitted to bounds.
    // MDN CC0 sample hosted by Mozilla — a long-lived public demo asset.
    videoOverlay(
      [
        "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.webm",
        "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4"
      ],
      [
        { lat: center.lat + 0.008, lng: center.lng - 0.018 },
        { lat: center.lat + 0.014, lng: center.lng - 0.008 }
      ],
      {
        opacity: 0.95,
        interactive: true,
        autoplay: true,
        loop: true,
        muted: true,
        playsInline: true
      }
    )
      .bindPopup("VideoOverlay — MDN CC0 flower sample")
      .addTo(map);
    
    // TileLayer (Easy) — extra raster overlay (radar, labels, cadastre). Not a second basemap.
    // Delete if you only need one tile set.
    map.addTileLayer({
      url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      opacity: 0.12,
      attribution: "© OpenStreetMap contributors"
    });


    return () => map.destroy();
  }, []);

  return <div ref={host} className="orihon-map" />;
}
