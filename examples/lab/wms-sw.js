/* Orihon Lab — static WMS mock for GitHub Pages / plain static hosts. */
const BOUNDS = { west: 11.569201, south: 52.104289, east: 11.679201, north: 52.154289 };
const ZONES = [
  {
    name: "A-101",
    color: "#f59e0b",
    coordinates: [[11.587201, 52.116289], [11.605201, 52.111289], [11.620201, 52.117289], [11.614201, 52.128289], [11.594201, 52.130289]]
  },
  {
    name: "B-204",
    color: "#8b5cf6",
    coordinates: [[11.621201, 52.119289], [11.640201, 52.115289], [11.651201, 52.124289], [11.643201, 52.137289], [11.625201, 52.134289]]
  },
  {
    name: "C-307",
    color: "#10b981",
    coordinates: [[11.648201, 52.126289], [11.668201, 52.123289], [11.675201, 52.135289], [11.660201, 52.146289], [11.646201, 52.138289]]
  }
];
const RIVER = [
  [11.569201, 52.113289], [11.588201, 52.116289], [11.607201, 52.112289], [11.626201, 52.113289],
  [11.643201, 52.120289], [11.660201, 52.126289], [11.679201, 52.128289]
];
const ROUTE = [
  [11.578201, 52.141289], [11.598201, 52.135289], [11.619201, 52.139289], [11.641201, 52.144289], [11.669201, 52.140289]
];
const PLACES = [
  { name: "West gate", coordinates: [11.583201, 52.120289] },
  { name: "Central hub", coordinates: [11.632201, 52.127289] },
  { name: "East gate", coordinates: [11.666201, 52.134289] }
];

function mercatorCoordinate([lng, lat]) {
  const radius = 6378137;
  const limitedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  return [
    radius * lng * Math.PI / 180,
    radius * Math.log(Math.tan(Math.PI / 4 + limitedLat * Math.PI / 360))
  ];
}

function parseWmsBbox(value, version, crs) {
  const values = String(value).split(",").map(Number);
  if (values.length !== 4 || values.some((entry) => !Number.isFinite(entry))) return null;
  if (crs === "EPSG:4326" && Number.parseFloat(version) >= 1.3) {
    const normalized = [values[1], values[0], values[3], values[2]];
    return normalized[2] > normalized[0] && normalized[3] > normalized[1] ? normalized : null;
  }
  return values[2] > values[0] && values[3] > values[1] ? values : null;
}

function transparentSvg(width, height) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"/>`;
}

function renderWms(url) {
  const get = (name, fallback = "") =>
    url.searchParams.get(name) ?? url.searchParams.get(name.toUpperCase()) ?? fallback;
  const layers = get("layers", "demo:central-magdeburg");
  const version = get("version", "1.3.0");
  const crs = get("crs", get("srs", "EPSG:3857")).toUpperCase();
  const width = Math.max(1, Math.min(1024, Number(get("width", "256")) || 256));
  const height = Math.max(1, Math.min(1024, Number(get("height", "256")) || 256));
  const bbox = parseWmsBbox(get("bbox"), version, crs);
  if (!bbox || (crs !== "EPSG:3857" && crs !== "EPSG:4326")) {
    return new Response("Invalid WMS bbox or CRS", { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  const convert = crs === "EPSG:3857" ? mercatorCoordinate : (coordinate) => coordinate;
  const coverageSouthWest = convert([BOUNDS.west, BOUNDS.south]);
  const coverageNorthEast = convert([BOUNDS.east, BOUNDS.north]);
  const overlaps = bbox[2] >= coverageSouthWest[0] && bbox[0] <= coverageNorthEast[0]
    && bbox[3] >= coverageSouthWest[1] && bbox[1] <= coverageNorthEast[1];
  if (!overlaps) {
    return new Response(transparentSvg(width, height), {
      headers: { "Cache-Control": "no-store", "Content-Type": "image/svg+xml; charset=utf-8" }
    });
  }

  const toPixel = (coordinate) => {
    const projected = convert(coordinate);
    return [
      (projected[0] - bbox[0]) / (bbox[2] - bbox[0]) * width,
      (bbox[3] - projected[1]) / (bbox[3] - bbox[1]) * height
    ];
  };
  const path = (coordinates, close = false) => coordinates.map((coordinate, index) => {
    const [x, y] = toPixel(coordinate);
    return `${index ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(" ") + (close ? " Z" : "");
  const selected = new Set(layers.split(",").map((entry) => entry.trim().toLowerCase()));
  const showAll = selected.has("demo:central-magdeburg") || selected.size === 0;
  const showZones = showAll || selected.has("demo:planning-zones");
  const showWater = showAll || selected.has("demo:water");
  const showTransport = showAll || selected.has("demo:transport");
  const coveragePath = path([
    [BOUNDS.west, BOUNDS.south],
    [BOUNDS.east, BOUNDS.south],
    [BOUNDS.east, BOUNDS.north],
    [BOUNDS.west, BOUNDS.north]
  ], true);
  const zoneMarkup = showZones ? ZONES.map((zone) => {
    const [labelX, labelY] = toPixel(zone.coordinates.reduce((center, coordinate) => [
      center[0] + coordinate[0] / zone.coordinates.length,
      center[1] + coordinate[1] / zone.coordinates.length
    ], [0, 0]));
    return `<path d="${path(zone.coordinates, true)}" fill="${zone.color}" fill-opacity=".3" stroke="${zone.color}" stroke-width="2"/>
      <text x="${labelX.toFixed(2)}" y="${labelY.toFixed(2)}">${zone.name}</text>`;
  }).join("") : "";
  const riverMarkup = showWater
    ? `<path d="${path(RIVER)}" fill="none" stroke="#ffffff" stroke-opacity=".9" stroke-width="9"/>
       <path d="${path(RIVER)}" fill="none" stroke="#0284c7" stroke-opacity=".86" stroke-width="6"/>`
    : "";
  const routeMarkup = showTransport
    ? `<path d="${path(ROUTE)}" fill="none" stroke="#ffffff" stroke-opacity=".9" stroke-width="7"/>
       <path d="${path(ROUTE)}" fill="none" stroke="#e11d48" stroke-width="4" stroke-dasharray="10 5"/>`
    : "";
  const placesMarkup = showAll ? PLACES.map((place) => {
    const [x, y] = toPixel(place.coordinates);
    return `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="5" fill="#172026" stroke="#ffffff" stroke-width="2"/>
      <text x="${(x + 8).toFixed(2)}" y="${(y - 7).toFixed(2)}">${place.name}</text>`;
  }).join("") : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs><clipPath id="coverage"><path d="${coveragePath}"/></clipPath></defs>
    <g clip-path="url(#coverage)">${zoneMarkup}${riverMarkup}${routeMarkup}</g>
    <path d="${coveragePath}" fill="none" stroke="#172026" stroke-opacity=".72" stroke-width="2" stroke-dasharray="6 4"/>
    <g fill="#172026" font-family="system-ui,sans-serif" font-size="11" font-weight="700" paint-order="stroke" stroke="#ffffff" stroke-width="3" stroke-linejoin="round">${placesMarkup}</g>
  </svg>`;
  return new Response(svg, {
    headers: { "Cache-Control": "no-store", "Content-Type": "image/svg+xml; charset=utf-8" }
  });
}

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (!/\/wms\/?$/i.test(url.pathname)) return;
  event.respondWith(renderWms(url));
});
