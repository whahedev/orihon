import {
  EARTH_RADIUS,
  MAX_LAT,
  TILE_SIZE,
  Evented,
  Renderer,
  attributionControl,
  bounds,
  canvasBaseLayer,
  circle,
  circleMarker,
  clampLat,
  createMap,
  createArraySearchProvider,
  createStraightLineRoutingProvider,
  defineOrihonElement,
  customControl,
  decodeMVT,
  createSuggestProvider,
  createSuggestWidget,
  distance,
  divIcon,
  extendBounds,
  featureGroup,
  geoJSON,
  geolocationControl,
  icon,
  imageOverlay,
  latLng,
  latLngBounds,
  layersControl,
  marker,
  metersToPixels,
  objectManager,
  offlineTileCache,
  performanceInspector,
  point,
  pointBounds,
  polygon,
  polyline,
  preparePointBatch,
  project,
  remoteObjectManager,
  routingLayer,
  scale,
  scaleControl,
  rectangle,
  tileLayer,
  trafficLayer,
  unproject,
  vectorTileLayer,
  svgOverlay,
  videoOverlay,
  webglPointLayer,
  heatLayer,
  wmsTileLayer,
  wrapLng,
  zoomControl,
  zoomForBounds
} from "https://cdn.jsdelivr.net/npm/orihon@1.0.2/dist/orihon.esm.js";

const ORIHON_CDN = "https://cdn.jsdelivr.net/npm/orihon@1.0.2";

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register(new URL("./wms-sw.js", import.meta.url)).catch(() => {});
}

const byId = (id) => document.getElementById(id);
const eventLog = byId("event-log");
const mapOutput = byId("map-output");
const healthDot = byId("health-dot");
const runtimeStatus = byId("runtime-status");
const mapReadout = byId("map-readout");
let paused = false;
let lastMoveLog = 0;
let eventedAttached = true;
let suggestionRequest = 0;
let bulkGeneration = 0;
let objectOperation = "ready";
let lastTrafficEvent = "idle";
let lastBehaviorEvent = "ready";
let lastRouteWaypoints = [];
const LOW_ZOOM_DECLUTTER_ZOOM = 8;
const PUBLIC_HLS_STREAM = "https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_4x3/bipbop_4x3_variant.m3u8";
const PUBLIC_MP4_STREAM = "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4";
let lowZoomCleanEnabled = true;

const behaviorLabels = {
  drag: "Pointer pan",
  scrollZoom: "Wheel zoom",
  pinchZoom: "Touch pinch",
  dblClick: "Double click zoom",
  boxZoom: "Shift drag zoom"
};

function formatNumber(value, digits = 4) {
  return Number(value).toFixed(digits);
}

function cleanObject(value) {
  return JSON.stringify(value, null, 2);
}

function makeMarkerPng(alternate = false) {
  const canvas = document.createElement("canvas");
  canvas.width = 72;
  canvas.height = 88;
  const context = canvas.getContext("2d");
  context.fillStyle = "rgba(23,32,38,.22)";
  context.beginPath();
  context.ellipse(38, 78, 18, 6, 0, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = alternate ? "#0f766e" : "#172026";
  context.beginPath();
  context.moveTo(36, 80);
  context.lineTo(16, 40);
  context.arc(36, 36, 20, Math.PI, 0);
  context.closePath();
  context.fill();
  context.fillStyle = alternate ? "#ffffff" : "#f2c94c";
  context.beginPath();
  context.arc(36, 36, 8, 0, Math.PI * 2);
  context.fill();
  return canvas.toDataURL("image/png");
}

function makeOverlayPng(alternate = false) {
  const canvas = document.createElement("canvas");
  canvas.width = 720;
  canvas.height = 420;
  const context = canvas.getContext("2d");
  const primary = alternate ? "rgba(192,38,211,.34)" : "rgba(242,201,76,.34)";
  const accent = alternate ? "rgba(8,145,178,.75)" : "rgba(193,72,34,.7)";
  context.fillStyle = primary;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = accent;
  context.lineWidth = 10;
  context.strokeRect(12, 12, canvas.width - 24, canvas.height - 24);
  context.lineWidth = 4;
  for (let x = -canvas.height; x < canvas.width; x += 72) {
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x + canvas.height, canvas.height);
    context.stroke();
  }
  return canvas.toDataURL("image/png");
}

const popupWidgetStats = { mounted: 0, disposed: 0, active: 0 };

function updatePopupLifecycleStatus() {
  const output = byId("popup-lifecycle-status");
  if (output) output.textContent = `${popupWidgetStats.active} active · ${popupWidgetStats.disposed} disposed`;
}

function popupPanel(title, subtitle = "") {
  const root = document.createElement("section");
  root.className = "demo-popup-panel";
  const heading = document.createElement("strong");
  heading.className = "demo-popup-title";
  heading.textContent = title;
  root.appendChild(heading);
  if (subtitle) {
    const caption = document.createElement("span");
    caption.className = "demo-popup-caption";
    caption.textContent = subtitle;
    root.appendChild(caption);
  }
  return root;
}

function textPopup(title, text) {
  const root = popupPanel(title, "DOM content");
  const body = document.createElement("p");
  body.textContent = text;
  root.appendChild(body);
  return root;
}

function imagePopup(title) {
  const root = popupPanel(title, "HTMLImageElement");
  const image = document.createElement("img");
  image.className = "demo-popup-media";
  image.src = makeOverlayPng(true);
  image.alt = title;
  root.appendChild(image);
  return root;
}

function videoPopup(title) {
  const root = popupPanel(title, "HTMLVideoElement");
  const video = document.createElement("video");
  video.className = "demo-popup-media";
  video.controls = true;
  video.muted = true;
  video.playsInline = true;
  video.preload = "metadata";
  video.poster = makeOverlayPng();
  video.src = PUBLIC_MP4_STREAM;
  root.appendChild(video);
  return root;
}

function chartPopup(title, values, detail = "Mountable chart object") {
  return {
    mount(container, context) {
      popupWidgetStats.mounted += 1;
      popupWidgetStats.active += 1;
      updatePopupLifecycleStatus();
      const root = popupPanel(title, detail);
      const canvas = document.createElement("canvas");
      canvas.className = "demo-popup-chart";
      canvas.width = 300;
      canvas.height = 126;
      root.appendChild(canvas);
      const coordinate = document.createElement("small");
      coordinate.textContent = context.latlng
        ? `${context.latlng.lat.toFixed(4)}, ${context.latlng.lng.toFixed(4)}`
        : "No geographic anchor";
      root.appendChild(coordinate);
      container.appendChild(root);

      const drawing = canvas.getContext("2d");
      const maximum = Math.max(1, ...values);
      drawing.clearRect(0, 0, canvas.width, canvas.height);
      drawing.strokeStyle = "#cbd5e1";
      drawing.beginPath();
      drawing.moveTo(24, 102);
      drawing.lineTo(286, 102);
      drawing.stroke();
      values.forEach((value, index) => {
        const width = 34;
        const x = 34 + index * 50;
        const height = Math.max(3, value / maximum * 78);
        drawing.fillStyle = index % 2 ? "#0f766e" : "#e11d48";
        drawing.fillRect(x, 102 - height, width, height);
        drawing.fillStyle = "#52616c";
        drawing.font = "11px system-ui";
        drawing.textAlign = "center";
        drawing.fillText(String(value), x + width / 2, 118);
      });

      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        popupWidgetStats.active -= 1;
        popupWidgetStats.disposed += 1;
        updatePopupLifecycleStatus();
      };
    }
  };
}

function makeOverlaySvg() {
  return `
    <svg viewBox="0 0 100 70" xmlns="http://www.w3.org/2000/svg">
      <rect width="100" height="70" rx="4" fill="rgba(13,136,121,.2)" />
      <path d="M6 56 C24 22 38 62 54 27 S84 19 94 44" fill="none" stroke="#0d8879" stroke-width="4" stroke-linecap="round" />
      <circle cx="25" cy="29" r="6" fill="#d97706" />
      <circle cx="74" cy="35" r="6" fill="#e11d48" />
    </svg>
  `;
}

function drawDemoVideoFrame(context, width, height, frame, totalFrames) {
  const progress = frame / totalFrames;
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#eef6f8";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#b9d9e8";
  context.beginPath();
  context.ellipse(width * 0.55, height * 0.55, width * 0.5, height * 0.22, -0.18, 0, Math.PI * 2);
  context.fill();
  context.strokeStyle = "#ffffff";
  context.lineWidth = 12;
  context.beginPath();
  context.moveTo(24, height * 0.65);
  context.bezierCurveTo(width * 0.28, height * 0.52, width * 0.54, height * 0.86, width - 24, height * 0.5);
  context.stroke();
  context.strokeStyle = "#0d8879";
  context.lineWidth = 5;
  context.beginPath();
  context.moveTo(36, height * 0.42);
  context.bezierCurveTo(width * 0.28, height * 0.22, width * 0.58, height * 0.28, width - 52, height * 0.36);
  context.stroke();
  const x = 52 + (width - 104) * progress;
  const y = height * 0.42 + Math.sin(progress * Math.PI * 2) * 34;
  context.fillStyle = "#e11d48";
  context.beginPath();
  context.arc(x, y, 18, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#ffffff";
  context.font = "700 24px system-ui, sans-serif";
  context.fillText("Orihon VideoOverlay", 28, 42);
  context.font = "500 16px system-ui, sans-serif";
  context.fillText(`generated local WebM frame ${frame + 1}`, 28, height - 24);
}

async function makeDemoVideoUrl() {
  if (!("MediaRecorder" in window) || !HTMLCanvasElement.prototype.captureStream) return null;
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 360;
  const context = canvas.getContext("2d");
  const stream = canvas.captureStream(24);
  const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
    ? "video/webm;codecs=vp9"
    : MediaRecorder.isTypeSupported("video/webm;codecs=vp8")
      ? "video/webm;codecs=vp8"
      : "video/webm";
  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    recorder.ondataavailable = (event) => {
      if (event.data?.size) chunks.push(event.data);
    };
    recorder.onerror = () => reject(recorder.error || new Error("MediaRecorder failed"));
    recorder.onstop = resolve;
  });
  const totalFrames = 72;
  let frame = 0;
  recorder.start();
  const render = () => {
    drawDemoVideoFrame(context, canvas.width, canvas.height, frame, totalFrames);
    frame += 1;
    if (frame <= totalFrames) requestAnimationFrame(render);
    else {
      recorder.stop();
      for (const track of stream.getTracks()) track.stop();
    }
  };
  render();
  await done;
  return URL.createObjectURL(new Blob(chunks, { type: mimeType }));
}

function makeTinyMVT() {
  const value = pbfMessage([pbfFieldBytes(1, new TextEncoder().encode("Demo MVT"))]);
  const feature = pbfMessage([
    pbfFieldVarint(1, 1),
    pbfFieldBytes(2, pbfPacked([0, 0])),
    pbfFieldVarint(3, 1),
    pbfFieldBytes(4, pbfPacked([9, 4096, 4096]))
  ]);
  const layer = pbfMessage([
    pbfFieldVarint(15, 2),
    pbfFieldBytes(1, new TextEncoder().encode("demo")),
    pbfFieldBytes(2, feature),
    pbfFieldBytes(3, new TextEncoder().encode("name")),
    pbfFieldBytes(4, value),
    pbfFieldVarint(5, 4096)
  ]);
  return pbfMessage([pbfFieldBytes(3, layer)]);
}

function pbfMessage(parts) {
  return new Uint8Array(parts.flatMap((part) => [...part]));
}

function pbfFieldVarint(field, value) {
  return new Uint8Array([...pbfVarint((field << 3) | 0), ...pbfVarint(value)]);
}

function pbfFieldBytes(field, bytes) {
  return new Uint8Array([...pbfVarint((field << 3) | 2), ...pbfVarint(bytes.length), ...bytes]);
}

function pbfPacked(values) {
  return new Uint8Array(values.flatMap((value) => [...pbfVarint(value)]));
}

function pbfVarint(value) {
  const result = [];
  let next = value;
  while (next > 0x7f) {
    result.push((next & 0x7f) | 0x80);
    next = Math.floor(next / 128);
  }
  result.push(next);
  return result;
}

function eventSummary(event) {
  const parts = [];
  if (typeof event.zoom === "number") parts.push(`z=${event.zoom.toFixed(2)}`);
  if (event.center) parts.push(`${formatNumber(event.center.lat)}, ${formatNumber(event.center.lng)}`);
  if (event.latlng) parts.push(`${formatNumber(event.latlng.lat)}, ${formatNumber(event.latlng.lng)}`);
  if (event.layer) parts.push(event.layer.constructor?.name || "Layer");
  if (event.popup) parts.push(event.popup.constructor?.name || "Popup");
  if (event.tooltip) parts.push(event.tooltip.constructor?.name || "Tooltip");
  if (event.containerPoint) parts.push(`px=${Math.round(event.containerPoint.x)},${Math.round(event.containerPoint.y)}`);
  if (event.objectId !== undefined) parts.push(`id=${event.objectId}`);
  if (event.count !== undefined) parts.push(`count=${event.count}`);
  if (event.stats) parts.push(`rendered=${event.stats.renderedMarkers}`);
  if (event.name !== undefined && event.enabled !== undefined) parts.push(`${event.name}=${event.enabled}`);
  if (event.routes) parts.push(`routes=${event.routes.length}`);
  if (event.accuracy !== undefined) parts.push(`accuracy=${Math.round(event.accuracy)}m`);
  if (event.error) parts.push(event.error.message || String(event.error));
  if (event.attributions) parts.push(event.attributions.join(" | "));
  if (event.value !== undefined) parts.push(`value=${event.value}`);
  return parts.join(" · ") || "ok";
}

function logEvent(type, event = {}) {
  if (paused) return;
  const item = document.createElement("li");
  const now = new Date();
  item.innerHTML = `<time>${now.toLocaleTimeString("ru-RU", { hour12: false })}</time><strong></strong><span></span>`;
  item.querySelector("strong").textContent = type;
  item.querySelector("span").textContent = eventSummary(event);
  eventLog.prepend(item);
  while (eventLog.children.length > 120) eventLog.lastElementChild.remove();
}

function setHealth(state) {
  healthDot.className = `health-dot${state === "busy" ? " is-busy" : state === "error" ? " is-error" : ""}`;
}

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    for (const candidate of document.querySelectorAll(".tab")) candidate.classList.toggle("is-active", candidate === tab);
    for (const panel of document.querySelectorAll("[data-panel]")) {
      const active = panel.dataset.panel === tab.dataset.tab;
      panel.hidden = !active;
      panel.classList.toggle("is-active", active);
    }
  });
}

const map = createMap("map", {
  center: [55.751244, 37.618423],
  zoom: 10,
  zoomSnap: 0.25,
  wheelZoomStep: 0.35,
  locale: "ru",
  ariaLabel: "Демонстрационная карта Orihon",
  controls: false
});
window.map = map;

const canvasLayer = canvasBaseLayer();
const osmAttribution = "© OpenStreetMap contributors";
const basemapOptions = {
  osm: {
    label: "OSM Standard",
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: osmAttribution,
    maxNativeZoom: 19
  },
  hot: {
    label: "OSM Humanitarian",
    url: "https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png",
    attribution: `${osmAttribution}, Tiles style by Humanitarian OpenStreetMap Team`,
    subdomains: "abc",
    maxNativeZoom: 19
  },
  osmfr: {
    label: "OSM France",
    url: "https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png",
    attribution: `${osmAttribution}, Tiles © OpenStreetMap France`,
    subdomains: "abc",
    maxNativeZoom: 20
  },
  topo: {
    label: "OpenTopoMap",
    url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    attribution: `${osmAttribution}, © OpenTopoMap (CC-BY-SA)`,
    subdomains: "abc",
    maxNativeZoom: 17
  },
  voyager: {
    label: "Carto Voyager",
    url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
    attribution: `${osmAttribution}, © CARTO`,
    subdomains: "abcd",
    maxNativeZoom: 20
  },
  positron: {
    label: "Carto Positron",
    url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
    attribution: `${osmAttribution}, © CARTO`,
    subdomains: "abcd",
    maxNativeZoom: 20
  },
  dark: {
    label: "Carto Dark Matter",
    url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    attribution: `${osmAttribution}, © CARTO`,
    subdomains: "abcd",
    maxNativeZoom: 20
  }
};

const basemapLayers = Object.fromEntries(
  Object.entries(basemapOptions).map(([key, option]) => [
    key,
    tileLayer(option.url, {
      attribution: option.attribution,
      opacity: 0.98,
      cacheSize: 128,
      maxNativeZoom: option.maxNativeZoom,
      subdomains: option.subdomains
    })
  ])
);

const canvasOnly = canvasBaseLayer({
  background: "#eef3f6",
  water: "#b9d9e8",
  road: "#ffffff"
});

let activeBasemapKey = "osm";
function getActiveBasemap() {
  return activeBasemapKey === "canvas" ? canvasOnly : basemapLayers[activeBasemapKey];
}

function setBasemap(key, { syncSelect = true } = {}) {
  const nextKey = key in basemapOptions || key === "canvas" ? key : "osm";
  const previous = getActiveBasemap();
  if (map.hasLayer(previous)) previous.remove();
  activeBasemapKey = nextKey;
  const next = getActiveBasemap();
  if (!map.hasLayer(next)) next.addTo(map);
  if (syncSelect) byId("basemap-style").value = nextKey;
  const opacity = Number(byId("tile-opacity").value) / 100;
  for (const layer of Object.values(basemapLayers)) {
    layer.options.opacity = opacity;
    if (layer.container) layer.container.style.opacity = String(opacity);
  }
  updateMapOutput();
}

canvasLayer.addTo(map);
basemapLayers.osm.addTo(map);

const traffic = trafficLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "TrafficLayer test",
  opacity: 0.34,
  maxNativeZoom: 19
});
const wmsDemoBounds = latLngBounds([[55.735, 37.56], [55.785, 37.67]]);
const wmsLayer = wmsTileLayer(new URL("./wms", location.href).href, {
  layers: "demo:central-moscow",
  format: "image/svg+xml",
  transparent: true,
  version: "1.3.0",
  crs: "EPSG:3857",
  bounds: wmsDemoBounds,
  minZoom: 9,
  opacity: 0.72,
  cacheSize: 64,
  attribution: "Orihon demo WMS"
});

class CenterRenderer extends Renderer {
  render() {
    const container = this.getContainer();
    if (!this.map || !(container instanceof HTMLElement)) return;
    const center = this.map.latLngToLayerPoint(this.map.getCenter());
    container.style.left = `${center.x}px`;
    container.style.top = `${center.y}px`;
  }
}

map.createPane("debug").style.zIndex = "18";
const centerRenderer = new CenterRenderer({ pane: "debug", className: "oh-test-renderer" }).addTo(map);

const mainMarker = marker([55.751244, 37.618423], {
  title: "Москва",
  ariaLabel: "Маркер Москвы",
  draggable: true
});
const route = polyline([
  [55.75, 37.55],
  [55.79, 37.6],
  [55.76, 37.69]
], { stroke: "#0f766e", strokeWidth: 4 });
const district = polygon([
  [55.71, 37.56],
  [55.73, 37.63],
  [55.69, 37.68],
  [55.67, 37.59]
], { stroke: "#7c3aed", fill: "#7c3aed", fillOpacity: 0.18 });
const radius = circle([55.79, 37.64], 900, {
  stroke: "#ea580c",
  fill: "#ea580c"
});
const testRectangle = rectangle([[55.74, 37.72], [55.79, 37.79]], {
  stroke: "#c026d3",
  fill: "#c026d3",
  fillOpacity: 0.12
});
const testCircleMarker = circleMarker([55.72, 37.52], {
  radius: 12,
  stroke: "#0891b2",
  fill: "#0891b2",
  fillOpacity: 0.7
});
const imageMarkerIcon = icon({
  iconUrl: makeMarkerPng(),
  iconSize: [36, 44],
  iconAnchor: [18, 40],
  alt: "PNG icon marker"
});
const alternateMarkerIcon = icon({
  iconUrl: makeMarkerPng(true),
  iconSize: [36, 44],
  iconAnchor: [18, 40],
  alt: "Alternate PNG icon marker"
});
const letterMarkerIcon = divIcon({
  content: "D",
  iconSize: [34, 34],
  className: "lab-div-icon"
});
const iconMarker = marker([55.775, 37.54], { title: "Icon", icon: imageMarkerIcon });
const divMarker = marker([55.72, 37.73], { title: "DivIcon", icon: letterMarkerIcon });
const vectorGroup = featureGroup([
  mainMarker,
  route,
  district,
  radius,
  testRectangle,
  testCircleMarker,
  iconMarker,
  divMarker
]).addTo(map);

mainMarker.bindPopup(() => chartPopup("Москва", [18, 42, 31, 56, 47]), {
  autoPan: true,
  autoPanPadding: [28, 28],
  keepInView: true,
  className: "oh-rich-popup",
  ariaLabel: "Информация о маркере"
}).bindTooltip("Marker tooltip");
route.bindPopup(() => textPopup("Polyline", "Текстовый DOM-узел, привязанный к линии.")).bindTooltip("Polyline tooltip");
district.bindPopup(() => imagePopup("Polygon image")).bindTooltip("Polygon tooltip");
radius.bindPopup(() => videoPopup("Circle video"), { className: "oh-rich-popup" }).bindTooltip("Circle tooltip");
testRectangle.bindPopup(() => chartPopup("Rectangle metrics", [12, 28, 43, 35, 51]), { className: "oh-rich-popup" }).bindTooltip("Rectangle tooltip");
testCircleMarker.bindPopup(async () => textPopup("CircleMarker", "Асинхронная фабрика popup завершена.")).bindTooltip("CircleMarker tooltip");
iconMarker.bindPopup(() => imagePopup("Icon marker")).bindTooltip("Icon tooltip");
divMarker.bindPopup(() => textPopup("DivIcon", "Произвольный HTML-компонент внутри popup.")).bindTooltip("DivIcon tooltip");

const geoData = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", id: "point", properties: { kind: "point", color: "#c2410c" }, geometry: { type: "Point", coordinates: [37.59, 55.7] } },
    { type: "Feature", id: "multi-point", properties: { kind: "multi-point", color: "#0891b2" }, geometry: { type: "MultiPoint", coordinates: [[37.45, 55.78], [37.47, 55.81]] } },
    { type: "Feature", id: "line", properties: { kind: "line", color: "#2563eb" }, geometry: { type: "LineString", coordinates: [[37.48, 55.74], [37.52, 55.8], [37.58, 55.83]] } },
    { type: "Feature", id: "polygon-hole", properties: { kind: "polygon", color: "#7c3aed" }, geometry: { type: "Polygon", coordinates: [[[37.7, 55.76], [37.8, 55.76], [37.79, 55.83], [37.7, 55.76]], [[37.73, 55.775], [37.765, 55.78], [37.75, 55.805], [37.73, 55.775]]] } },
    { type: "Feature", id: "multi-line", properties: { kind: "multi-line", color: "#0f766e" }, geometry: { type: "MultiLineString", coordinates: [[[37.5, 55.69], [37.55, 55.71]], [[37.7, 55.84], [37.76, 55.86]]] } },
    { type: "Feature", id: "multi-polygon", properties: { kind: "multi-polygon", color: "#be123c" }, geometry: { type: "MultiPolygon", coordinates: [[[[37.82, 55.72], [37.86, 55.72], [37.85, 55.75], [37.82, 55.72]]]] } },
    { type: "Feature", id: "collection", properties: { kind: "geometry-collection", color: "#4d7c0f" }, geometry: { type: "GeometryCollection", geometries: [{ type: "Point", coordinates: [37.67, 55.86] }, { type: "LineString", coordinates: [[37.62, 55.84], [37.67, 55.86]] }] } },
    { type: "Feature", id: "filtered", properties: { kind: "filtered", hidden: true }, geometry: { type: "Point", coordinates: [37.62, 55.75] } }
  ]
};
const geoLayer = geoJSON(geoData, {
  filter: (feature) => feature.properties?.hidden !== true,
  pointToLayer: (feature, position) => circleMarker(position, {
    radius: feature.properties?.kind === "point" ? 9 : 7,
    stroke: String(feature.properties?.color || "#2563eb"),
    fill: String(feature.properties?.color || "#2563eb"),
    fillOpacity: 0.78
  }),
  style: (feature) => ({
    stroke: String(feature.properties?.color || "#2563eb"),
    strokeWidth: 3,
    fill: String(feature.properties?.color || "#2563eb"),
    fillOpacity: 0.16
  }),
  popup: (feature) => chartPopup(`GeoJSON: ${feature.properties?.kind || "geometry"}`, [9, 22, 17, 34, 29]),
  popupOptions: { className: "oh-rich-popup" }
}).addTo(map);
let geoFeatureSequence = 0;

let overlayVariant = false;
let markerIconVariant = false;
let videoDemoStatus = "generating local WebM";
const rasterOverlay = imageOverlay(makeOverlayPng(), [[55.68, 37.47], [55.83, 37.82]], {
  opacity: 0.32,
  interactive: true,
  zIndex: 0,
  alt: "Raster overlay test"
}).addTo(map).bringToBack();
rasterOverlay.bindPopup(() => imagePopup("ImageOverlay"));
const videoDemoOverlay = videoOverlay("", [[55.705, 37.505], [55.75, 37.605]], {
  opacity: 0.82,
  interactive: true,
  zIndex: 1,
  controls: true,
  poster: makeOverlayPng(true)
});
videoDemoOverlay.bindPopup(() => textPopup("VideoOverlay", "Клик обработан поверх интерактивного видеооверлея."));
makeDemoVideoUrl().then((url) => {
  if (!url) {
    videoDemoStatus = "poster fallback";
    updateVideoSourceStatus();
    updateMapOutput();
    return;
  }
  videoDemoStatus = "generated local WebM";
  videoDemoOverlay.setUrl(url);
  videoDemoOverlay.getElement()?.play().catch(() => {});
  updateVideoSourceStatus();
  updateMapOutput();
}).catch((error) => {
  videoDemoStatus = error?.message || "video generation failed";
  updateVideoSourceStatus();
  updateMapOutput();
});
const svgDemoOverlay = svgOverlay(makeOverlaySvg(), [[55.765, 37.675], [55.825, 37.795]], {
  opacity: 0.86,
  interactive: true,
  zIndex: 2
});
svgDemoOverlay.bindPopup(() => chartPopup("SVGOverlay", [15, 33, 25, 48, 39]), { className: "oh-rich-popup" });

const layerSwitcher = layersControl({
  "OSM Standard": basemapLayers.osm,
  "OSM Humanitarian": basemapLayers.hot,
  "OSM France": basemapLayers.osmfr,
  OpenTopoMap: basemapLayers.topo,
  "Carto Voyager": basemapLayers.voyager,
  "Carto Positron": basemapLayers.positron,
  "Carto Dark Matter": basemapLayers.dark,
  "Canvas only": canvasOnly
}, {
  "Canvas base": canvasLayer,
  "Vector group": vectorGroup,
  GeoJSON: geoLayer,
  "WMS: центр Москвы": wmsLayer,
  ImageOverlay: rasterOverlay,
  VideoOverlay: videoDemoOverlay,
  SVGOverlay: svgDemoOverlay
}, { position: "top-right", collapsed: true });

const controls = {
  zoom: zoomControl({ position: "top-right" }).addTo(map),
  scale: scaleControl({ position: "bottom-left", units: "both", maxWidth: 110 }).addTo(map),
  geolocation: geolocationControl({ position: "top-right" }).addTo(map),
  attribution: attributionControl({ position: "bottom-right" }).addTo(map),
  layers: layerSwitcher.addTo(map),
  custom: customControl(() => `z${map.getZoom().toFixed(2)} · ${map.getCenter().lat.toFixed(3)}, ${map.getCenter().lng.toFixed(3)}`, {
    position: "bottom-left",
    className: "oh-lab-custom-control",
    ariaLabel: "Текущее положение карты"
  }).addTo(map)
};

const sampleObjects = [
  { id: "obj-1", coordinates: [55.748, 37.58], properties: { title: "Объект 1", side: "west" } },
  { id: "obj-2", geometry: { coordinates: [37.66, 55.77] }, properties: { title: "Объект 2", side: "east" } },
  { id: "obj-3", coordinates: { lat: 55.72, lng: 37.61 }, properties: { title: "Объект 3", side: "west" } },
  { id: "obj-4", coordinates: [55.81, 37.68], properties: { title: "Объект 4", side: "east" } }
];
const objects = objectManager({
  minZoom: 2,
  marker: { className: "oh-object-marker" },
  clusterize: true,
  clusterGridSize: 50,
  clusterMaxZoom: 16,
  indexCellSize: 0.5
}).addTo(map);
objects.add(sampleObjects);
objects.bindPopup((object, id) => chartPopup(
  String(object.properties?.title || id),
  [12, 24, String(id).length * 7, 31, 18],
  `ObjectManager · ${id}`
), { className: "oh-rich-popup" });
objects.bindClusterPopup((items, ids) => chartPopup(
  `Cluster: ${items.length} objects`,
  [ids.length, ids.length * 2, ids.length * 3, ids.length * 2, ids.length],
  "ObjectManager cluster"
), { className: "oh-rich-popup" });

const cities = [
  { name: "Москва", lat: 55.751244, lng: 37.618423, zoom: 10 },
  { name: "Санкт-Петербург", lat: 59.93863, lng: 30.31413, zoom: 10 },
  { name: "Казань", lat: 55.796127, lng: 49.106405, zoom: 11 },
  { name: "Екатеринбург", lat: 56.838011, lng: 60.597465, zoom: 11 },
  { name: "Новосибирск", lat: 55.030204, lng: 82.92043, zoom: 11 },
  { name: "Владивосток", lat: 43.115536, lng: 131.885485, zoom: 11 }
];

async function fetchSuggestions(query, context) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 160);
    context.signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
  const normalized = query.toLocaleLowerCase("ru-RU");
  return cities.filter((city) => city.name.toLocaleLowerCase("ru-RU").includes(normalized)).slice(0, context.limit);
}

let suggestions = createSuggestProvider(fetchSuggestions, { debounceMs: 120, minLength: 1, limit: 5 });
const citySearch = createArraySearchProvider(cities.map((city) => ({
  name: city.name,
  center: [city.lat, city.lng],
  properties: city
})), { limit: 5 });
const suggestUi = createSuggestWidget({
  input: byId("suggest-ui-input"),
  list: byId("suggest-ui-list"),
  provider: createSuggestProvider(async (query, context) => {
    const result = await citySearch.search(query, context);
    return result.map((item) => item.properties);
  }, { debounceMs: 120, minLength: 1, limit: 5 }),
  label: (city) => `${city.name} · ${city.lat.toFixed(3)}, ${city.lng.toFixed(3)}`,
  onSelect: (city) => map.setView([city.lat, city.lng], city.zoom),
  context: () => ({ center: map.getCenter().toArray() }),
  emptyText: "Нет результатов"
});

function makeRemoteObjects(bounds, zoom) {
  const south = Math.max(-85, bounds.south);
  const north = Math.min(85, bounds.north);
  const west = bounds.west;
  const east = bounds.east;
  const count = Math.max(24, Math.min(180, Math.round(zoom * 10)));
  const seedBase = Math.round((south + north + west + east + zoom) * 1000);
  let seed = seedBase >>> 0;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  return Array.from({ length: count }, (_, index) => ({
    id: `remote-${zoom.toFixed(2)}-${seedBase}-${index}`,
    coordinates: [
      south + random() * Math.max(0.0001, north - south),
      west + random() * Math.max(0.0001, east - west)
    ],
    properties: { title: `Remote ${index + 1}` }
  }));
}

const remoteObjects = remoteObjectManager({
  debounceMs: 120,
  clusterize: true,
  clusterGridSize: 50,
  clusterMaxZoom: 14,
  indexCellSize: 0.25,
  marker: { className: "oh-remote-marker" },
  loader: async ({ bounds, zoom, signal }) => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 180);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    });
    return makeRemoteObjects(bounds, zoom);
  }
});
remoteObjects.bindPopup((object, id) => textPopup(
  String(object.properties?.title || id),
  `RemoteObjectManager viewport object · ${id}`
));
remoteObjects.bindClusterPopup((items) => chartPopup(
  `Remote cluster: ${items.length}`,
  [items.length, items.length * 2, items.length * 3, items.length * 2, items.length]
), { className: "oh-rich-popup" });

const demoRouting = routingLayer({
  provider: createStraightLineRoutingProvider(),
  alternatives: true,
  routeStyle: (route, index) => ({
    stroke: index === 0 ? "#0f766e" : "#64748b",
    strokeWidth: index === 0 ? 5 : 3,
    strokeOpacity: index === 0 ? 0.9 : 0.6
  }),
  selectedStyle: { stroke: "#d97706", strokeWidth: 6, strokeOpacity: 0.95 }
});
const webglPoints = webglPointLayer([], {
  pointSize: 4,
  color: "#e11d48",
  opacity: 0.74
});
const heatDemo = heatLayer([], {
  radius: 28,
  blur: 18,
  scaleZoom: 12,
  max: 3,
  minOpacity: 0.08
});
webglPoints.bindPopup((context) => chartPopup(
  `WebGL point #${Number(context.event?.index ?? 0) + 1}`,
  [8, 19, 14, 27, 21],
  "Nearest-point hit testing"
), { className: "oh-rich-popup" });
const vectorTiles = vectorTileLayer({
  minZoom: 8,
  maxZoom: 14,
  buffer: 0,
  provider: ({ x, y, z, bounds }) => [{
    type: "Feature",
    id: `vt-${z}-${x}-${y}`,
    properties: { tile: `${z}/${x}/${y}`, color: x % 2 ? "#0f766e" : "#d97706" },
    geometry: { type: "Point", coordinates: [bounds.getCenter ? bounds.getCenter().lng : (bounds.west + bounds.east) / 2, bounds.getCenter ? bounds.getCenter().lat : (bounds.south + bounds.north) / 2] }
  }],
  pointToLayer: (feature, position) => circleMarker(position, {
    radius: 6,
    stroke: String(feature.properties?.color || "#0f766e"),
    fill: String(feature.properties?.color || "#0f766e"),
    fillOpacity: 0.75
  }),
  popup: (feature) => textPopup("Vector tile", String(feature.properties?.tile || "unknown tile"))
});
const perfInspector = performanceInspector(map, { sampleFrames: 20 });
const offlineCache = offlineTileCache({ cacheName: "orihon-demo-tiles-v1" });
let stageEightMessage = "ready";

function updateMapReadout() {
  const center = map.getCenter();
  mapReadout.textContent = `${formatNumber(center.lat)}  ${formatNumber(center.lng)}  ·  z${map.getZoom().toFixed(2)}`;
  controls.custom.setContent(`z${map.getZoom().toFixed(2)} · ${center.lat.toFixed(3)}, ${center.lng.toFixed(3)}`);
}

function updateLowZoomClean() {
  const active = lowZoomCleanEnabled && map.getZoom() < LOW_ZOOM_DECLUTTER_ZOOM;
  map.getContainer().classList.toggle("is-low-zoom-decluttered", active);
  byId("low-zoom-status").textContent = active
    ? `on < z${LOW_ZOOM_DECLUTTER_ZOOM}`
    : `off < z${LOW_ZOOM_DECLUTTER_ZOOM}`;
  return active;
}

function updateVideoSourceStatus() {
  byId("video-source-status").textContent = videoDemoStatus;
}

function loadVideoOverlayUrl(url, label = "custom URL") {
  const trimmed = String(url || "").trim();
  if (!trimmed) return;
  const element = videoDemoOverlay.getElement();
  const hls = /\.m3u8($|\?)/i.test(trimmed);
  const nativeHls = Boolean(element?.canPlayType("application/vnd.apple.mpegurl") || element?.canPlayType("application/x-mpegURL"));
  videoDemoStatus = hls && !nativeHls ? `${label}: HLS needs native browser support` : label;
  videoDemoOverlay.setUrl(trimmed);
  if (!map.hasLayer(videoDemoOverlay)) videoDemoOverlay.addTo(map);
  byId("layer-video").checked = true;
  updateVideoSourceStatus();
  updateMapOutput();
  videoDemoOverlay.getElement()?.play().catch(() => {});
}

function updateMapOutput(extra = {}) {
  const center = map.getCenter();
  const visible = map.getBounds();
  const layerNames = [];
  map.eachLayer((layer) => layerNames.push(layer.constructor.name));
  mapOutput.textContent = cleanObject({
    center: center.toArray(),
    zoom: map.getZoom(),
    size: map.getSize().toArray(),
    bounds: visible.toBBoxString(),
    pixelOrigin: map.pixelOrigin.toArray(),
    panes: Object.keys(map.getPanes()),
    layers: layerNames,
    attributions: map.getAttributions(),
    hasBasemap: map.hasLayer(getActiveBasemap()),
    basemap: activeBasemapKey,
    container: map.getContainer().id,
    rendererContainer: centerRenderer.getContainer()?.className || null,
    tileUrl: activeBasemapKey === "canvas" ? null : getActiveBasemap().getTileUrl(1, 2, 3),
    wmsParams: wmsLayer.getParams(),
    wmsUrl: wmsLayer.getTileUrl(1, 2, 3),
    lowZoomClean: {
      enabled: lowZoomCleanEnabled,
      active: map.getContainer().classList.contains("is-low-zoom-decluttered"),
      threshold: LOW_ZOOM_DECLUTTER_ZOOM
    },
    marker: mainMarker.getLatLng().toArray(),
    markerOpacity: mainMarker.options.opacity,
    markerZIndexOffset: mainMarker.options.zIndexOffset,
    routePoints: route.getLatLngs().length,
    routeBounds: route.getBounds().toBBoxString(),
    circleRadius: radius.getRadius(),
    rectangleBounds: testRectangle.getBounds().toBBoxString(),
    circleMarkerRadius: testCircleMarker.getRadius(),
    imageBounds: rasterOverlay.getBounds().toBBoxString(),
    imageOpacity: rasterOverlay.options.opacity,
    videoBounds: videoDemoOverlay.getBounds().toBBoxString(),
    videoDemo: {
      status: videoDemoStatus,
      source: videoDemoOverlay.urls[0]?.startsWith("blob:") ? "blob:webm" : videoDemoOverlay.urls[0] || "pending",
      visible: map.hasLayer(videoDemoOverlay)
    },
    svgBounds: svgDemoOverlay.getBounds().toBBoxString(),
    maxBounds: map.getMaxBounds()?.toBBoxString() || null,
    popupOpen: mainMarker.isPopupOpen(),
    tooltipOpen: mainMarker.isTooltipOpen(),
    iconClass: iconMarker.getIcon()?.constructor.name || null,
    groupLayers: vectorGroup.getLayers().length,
    geoJSONFeatures: geoLayer.toGeoJSON().features.length,
    objectManager: objects.getStats(),
    remoteObjectManager: remoteObjects.getStats(),
    traffic: {
      state: traffic.getState(),
      dataTime: traffic.getDataTime()?.toISOString() || null
    },
    routing: {
      routes: demoRouting.getRoutes().length,
      selectedIndex: demoRouting.selectedIndex
    },
    behaviors: map.behaviors.getEnabled(),
    accessibility: {
      role: map.getContainer().getAttribute("role"),
      ariaLabel: map.getContainer().getAttribute("aria-label"),
      localeLayers: map.locale.layers,
      customControlPosition: controls.custom.getPosition()
    },
    ...extra
  });
}

function syncViewInputs() {
  const center = map.getCenter();
  byId("center-lat").value = center.lat.toFixed(4);
  byId("center-lng").value = center.lng.toFixed(4);
  byId("center-zoom").value = map.getZoom().toFixed(2);
}

function updateObjectCount() {
  const stats = objects.getStats();
  byId("object-count").textContent = `${stats.objects} / ${stats.visibleObjects}`;
  byId("object-render-count").textContent = `${stats.objectMarkers} / ${stats.clusters}`;
  byId("object-index-count").textContent = String(stats.indexCells);
  byId("object-stats").textContent = cleanObject({ ...stats, operation: objectOperation });
}

function updateRemoteCount(message = "ready") {
  const stats = remoteObjects.getStats();
  byId("remote-count").textContent = `${stats.objects} / ${stats.visibleObjects}`;
  byId("remote-output").textContent = cleanObject({ ...stats, loading: remoteObjects.loading, message });
}

function updateTrafficStatus() {
  byId("traffic-state").textContent = traffic.getState();
  byId("traffic-time").textContent = traffic.getDataTime()?.toLocaleTimeString("ru-RU", { hour12: false }) || "-";
  byId("traffic-tiles").textContent = `${traffic.tiles.size} / ${traffic.previousTiles.size}`;
  byId("traffic-last").textContent = lastTrafficEvent;
}

function updateRouteOutput(message = "ready") {
  const routes = demoRouting.getRoutes();
  const selected = routes[demoRouting.selectedIndex];
  const enabledBehaviors = map.behaviors.getEnabled();
  byId("route-count").textContent = String(routes.length);
  byId("route-selected").textContent = selected
    ? `${selected.name || demoRouting.selectedIndex} · ${formatDistance(selected.distance || 0)} · ${formatDuration(selected.duration || 0)}`
    : "-";
  byId("behavior-enabled").textContent = enabledBehaviors.join(", ") || "none";
  byId("behavior-last").textContent = lastBehaviorEvent;
  renderBehaviorDetails();
  byId("route-output").textContent = cleanObject({
    message,
    waypoints: lastRouteWaypoints.map((point) => point.map((value) => Number(value.toFixed(5)))),
    routes: routes.map((route, index) => ({
      index,
      name: route.name,
      points: route.coordinates.length,
      distanceMeters: Math.round(route.distance || 0),
      durationSeconds: Math.round(route.duration || 0),
      selected: index === demoRouting.selectedIndex,
      kind: route.properties?.kind
    })),
    selectedIndex: demoRouting.selectedIndex,
    traffic: {
      state: traffic.getState(),
      dataTime: traffic.getDataTime()?.toISOString() || null,
      activeTiles: traffic.tiles.size,
      retainedTiles: traffic.previousTiles.size,
      visible: map.hasLayer(traffic)
    },
    behaviors: Object.fromEntries(Object.keys(behaviorLabels).map((name) => [
      name,
      { enabled: map.behaviors.isEnabled(name), label: behaviorLabels[name] }
    ]))
  });
}

function formatDistance(meters) {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}

function formatDuration(seconds) {
  if (!seconds) return "0 min";
  return seconds >= 3600
    ? `${Math.floor(seconds / 3600)} h ${Math.round((seconds % 3600) / 60)} min`
    : `${Math.round(seconds / 60)} min`;
}

function renderBehaviorDetails() {
  const container = byId("behavior-detail");
  container.textContent = "";
  for (const [name, label] of Object.entries(behaviorLabels)) {
    const item = document.createElement("div");
    item.className = `detail-pill${map.behaviors.isEnabled(name) ? " is-on" : ""}`;
    const title = document.createElement("strong");
    title.textContent = name;
    const value = document.createElement("span");
    value.textContent = `${label} · ${map.behaviors.isEnabled(name) ? "on" : "off"}`;
    item.append(title, value);
    container.appendChild(item);
  }
}

function updateGeoJSONStatus(message = "Готов") {
  const exported = geoLayer.toGeoJSON();
  byId("geojson-count").textContent = String(exported.features.length);
  byId("geojson-output").textContent = `${message}\n${cleanObject(exported)}`;
}

function updateWMSOutput(message = "Готов") {
  byId("wms-output").textContent = `${message}\nПокрытие: ${wmsDemoBounds.toBBoxString()}\n${wmsLayer.getTileUrl(1, 2, 3)}`;
}

function updateStageEightOutput(extra = {}) {
  const webglStats = webglPoints.getStats();
  byId("webgl-count").textContent = `${webglStats.points} · ${webglStats.renderer}`;
  byId("heat-count").textContent = map.hasLayer(heatDemo) ? "on" : "off";
  byId("perf-summary").textContent = stageEightMessage;
  byId("stage-eight-output").textContent = cleanObject({
    message: stageEightMessage,
    webgl: webglStats,
    webglTransform: {
      rotation: webglPoints.options.rotation,
      pitch: webglPoints.options.pitch
    },
    heatmap: {
      enabled: map.hasLayer(heatDemo),
      scaleZoom: heatDemo.options.scaleZoom
    },
    vectorTiles: {
      enabled: map.hasLayer(vectorTiles),
      activeTiles: vectorTiles.tiles.size
    },
    performance: perfInspector.snapshot(),
    offline: offlineCache.getStats(),
    webComponent: {
      customElements: typeof customElements !== "undefined",
      defined: typeof customElements !== "undefined" ? Boolean(customElements.get("aero-map")) : false
    },
    ...extra
  });
}

function syncLayerToggles() {
  const activeKey = Object.entries(basemapLayers).find(([, layer]) => map.hasLayer(layer))?.[0]
    ?? (map.hasLayer(canvasOnly) ? "canvas" : activeBasemapKey);
  if (activeKey && activeKey !== activeBasemapKey) activeBasemapKey = activeKey;
  byId("basemap-style").value = activeBasemapKey;
  const layerStates = new Map([
    ["layer-canvas", map.hasLayer(canvasLayer)],
    ["layer-wms", map.hasLayer(wmsLayer)],
    ["layer-traffic", map.hasLayer(traffic)],
    ["layer-renderer", map.hasLayer(centerRenderer)],
    ["layer-marker", map.hasLayer(mainMarker)],
    ["layer-polyline", map.hasLayer(route)],
    ["layer-polygon", map.hasLayer(district)],
    ["layer-circle", map.hasLayer(radius)],
    ["layer-rectangle", map.hasLayer(testRectangle)],
    ["layer-circle-marker", map.hasLayer(testCircleMarker)],
    ["layer-icon-marker", map.hasLayer(iconMarker)],
    ["layer-div-marker", map.hasLayer(divMarker)],
    ["layer-geojson", map.hasLayer(geoLayer)],
    ["layer-image", map.hasLayer(rasterOverlay)],
    ["layer-video", map.hasLayer(videoDemoOverlay)],
    ["layer-svg", map.hasLayer(svgDemoOverlay)]
  ]);
  for (const [id, enabled] of layerStates) byId(id).checked = enabled;
}

const mapEvents = [
  "movestart", "move", "moveend", "zoomstart", "zoom", "zoomend", "resize",
  "click", "layeradd", "layerremove", "attributionchange",
  "popupopen", "popupclose", "tooltipopen", "tooltipclose", "locationfound", "locationerror",
  "behaviorchange"
];
for (const type of mapEvents) {
  map.on(type, (event) => {
    updateMapReadout();
    if (type === "layeradd" || type === "layerremove") syncLayerToggles();
    if (type === "move") {
      const now = performance.now();
      if (now - lastMoveLog < 140) return;
      lastMoveLog = now;
    }
    if (type === "moveend" || type === "zoomend") {
      syncViewInputs();
      updateLowZoomClean();
      updateMapOutput();
      queueMicrotask(updateObjectCount);
    }
    if (type === "behaviorchange") {
      lastBehaviorEvent = `${event.name}:${event.enabled ? "on" : "off"}`;
      updateRouteOutput("behaviorchange");
    }
    logEvent(type, event);
  });
}

vectorGroup.on("click", (event) => logEvent("FeatureGroup.click", event));
vectorGroup.on("dragstart", (event) => logEvent("FeatureGroup.dragstart", event));
vectorGroup.on("drag", (event) => logEvent("FeatureGroup.drag", event));
vectorGroup.on("dragend", (event) => logEvent("FeatureGroup.dragend", event));
for (const layer of Object.values(basemapLayers)) {
  layer.on("tileloadstart", () => setHealth("busy"));
  layer.on("load", (event) => {
    setHealth("ok");
    logEvent("TileLayer.load", event);
  });
  layer.on("tileerror", (event) => {
    setHealth("error");
    logEvent("TileLayer.tileerror", event);
  });
  layer.on("tileabort", (event) => logEvent("TileLayer.tileabort", event));
}
wmsLayer.on("load", (event) => logEvent("WMSTileLayer.load", event));
wmsLayer.on("tileerror", (event) => logEvent("WMSTileLayer.tileerror", event));
geoLayer.on("click", (event) => logEvent("GeoJSON.click", event));
traffic.on("statechange", (event) => {
  lastTrafficEvent = event.state;
  updateTrafficStatus();
  updateRouteOutput("traffic");
  logEvent("TrafficLayer.state", event);
});
traffic.on("datatimechange", () => {
  lastTrafficEvent = "dataTime";
  updateTrafficStatus();
  updateRouteOutput("traffic-time");
});
remoteObjects.on("loading", () => updateRemoteCount("loading"));
remoteObjects.on("load", (event) => {
  updateRemoteCount("load");
  logEvent("RemoteObjectManager.load", { value: event.objects.length });
});
remoteObjects.on("error", (event) => {
  updateRemoteCount(event.error?.message || "error");
  logEvent("RemoteObjectManager.error", event);
});
demoRouting.on("load", (event) => {
  updateRouteOutput("load");
  logEvent("RoutingLayer.load", event);
});
demoRouting.on("select", () => updateRouteOutput("select"));

function toggleGroupLayer(group, layer, enabled) {
  if (enabled) {
    if (group) group.addLayer(layer);
    else layer.addTo(map);
  } else if (group) {
    group.removeLayer(layer);
  } else {
    layer.remove();
  }
  updateMapOutput();
}

byId("basemap-style").addEventListener("change", (event) => {
  setBasemap(event.target.value);
});
byId("layer-canvas").addEventListener("change", (event) => {
  if (event.target.checked) canvasLayer.addTo(map);
  else canvasLayer.remove();
  updateMapOutput();
});
byId("layer-wms").addEventListener("change", (event) => {
  if (event.target.checked) wmsLayer.addTo(map);
  else wmsLayer.remove();
  updateWMSOutput(event.target.checked ? "WMS добавлен на карту" : "WMS скрыт");
  updateMapOutput();
});
byId("layer-traffic").addEventListener("change", (event) => {
  if (event.target.checked) traffic.addTo(map);
  else traffic.remove();
  updateTrafficStatus();
  updateMapOutput();
});
byId("layer-renderer").addEventListener("change", (event) => {
  if (event.target.checked) {
    const pane = map.getPane("debug") || map.createPane("debug");
    pane.style.zIndex = "18";
    centerRenderer.addTo(map);
  } else {
    centerRenderer.remove();
    map.removePane("debug");
  }
  updateMapOutput();
});
byId("low-zoom-clean").addEventListener("change", (event) => {
  lowZoomCleanEnabled = event.target.checked;
  updateLowZoomClean();
  updateMapOutput();
});

const vectorToggles = new Map([
  ["layer-marker", mainMarker],
  ["layer-polyline", route],
  ["layer-polygon", district],
  ["layer-circle", radius],
  ["layer-rectangle", testRectangle],
  ["layer-circle-marker", testCircleMarker],
  ["layer-icon-marker", iconMarker],
  ["layer-div-marker", divMarker]
]);
for (const [id, layer] of vectorToggles) {
  byId(id).addEventListener("change", (event) => toggleGroupLayer(vectorGroup, layer, event.target.checked));
}
byId("layer-geojson").addEventListener("change", (event) => {
  if (event.target.checked) geoLayer.addTo(map);
  else geoLayer.remove();
  updateMapOutput();
});
byId("layer-image").addEventListener("change", (event) => {
  if (event.target.checked) rasterOverlay.addTo(map);
  else rasterOverlay.remove();
  updateMapOutput();
});
byId("layer-video").addEventListener("change", (event) => {
  if (event.target.checked) {
    videoDemoOverlay.addTo(map);
    videoDemoOverlay.getElement()?.play().catch(() => {});
  } else {
    videoDemoOverlay.remove();
  }
  updateMapOutput();
});
byId("layer-svg").addEventListener("change", (event) => {
  if (event.target.checked) svgDemoOverlay.addTo(map);
  else svgDemoOverlay.remove();
  updateMapOutput();
});

byId("tile-opacity").addEventListener("input", (event) => {
  const opacity = Number(event.target.value) / 100;
  for (const layer of Object.values(basemapLayers)) {
    layer.options.opacity = opacity;
    if (layer.container) layer.container.style.opacity = String(opacity);
  }
  byId("tile-opacity-value").textContent = `${event.target.value}%`;
});

byId("apply-style").addEventListener("click", () => {
  const stroke = byId("vector-stroke").value;
  const fill = byId("vector-fill").value;
  vectorGroup.setStyle({ stroke, fill }).invoke("render");
  geoLayer.setStyle({ stroke, fill, fillOpacity: 0.18 });
  logEvent("FeatureGroup.setStyle", { value: `${stroke}/${fill}` });
});

byId("geo-add-data").addEventListener("click", () => {
  const center = map.getCenter();
  geoFeatureSequence++;
  geoLayer.addData({
    type: "Feature",
    id: `dynamic-${geoFeatureSequence}`,
    properties: { kind: `dynamic-${geoFeatureSequence}`, color: "#d97706" },
    geometry: {
      type: "Point",
      coordinates: [center.lng + geoFeatureSequence * 0.012, center.lat + geoFeatureSequence * 0.006]
    }
  });
  updateGeoJSONStatus("addData: добавлена точка");
  logEvent("GeoJSON.addData", { count: geoLayer.toGeoJSON().features.length });
});
byId("geo-style").addEventListener("click", () => {
  geoLayer.setStyle((feature) => ({
    stroke: feature.properties?.kind === "polygon" ? "#dc2626" : "#111827",
    strokeWidth: 5,
    fill: "#facc15",
    fillOpacity: 0.32
  }));
  updateGeoJSONStatus("setStyle: контрастный стиль");
});
byId("geo-reset-style").addEventListener("click", () => {
  geoLayer.resetStyle();
  updateGeoJSONStatus("resetStyle: исходный стиль");
});
byId("geo-export").addEventListener("click", () => updateGeoJSONStatus("toGeoJSON: экспорт текущего состояния"));
byId("geo-clear").addEventListener("click", () => {
  geoLayer.clearLayers();
  updateGeoJSONStatus("clearLayers: слой очищен");
});
byId("geo-restore").addEventListener("click", () => {
  geoLayer.clearLayers().addData(geoData);
  updateGeoJSONStatus("addData: исходный набор восстановлен");
});

byId("wms-apply").addEventListener("click", () => {
  wmsLayer.setParams({
    layers: byId("wms-layers").value,
    version: byId("wms-version").value,
    crs: byId("wms-crs").value
  });
  updateWMSOutput("setParams: запросы обновлены");
  updateMapOutput();
});
byId("wms-fit").addEventListener("click", () => {
  if (!map.hasLayer(wmsLayer)) wmsLayer.addTo(map);
  vectorGroup.remove();
  geoLayer.remove();
  rasterOverlay.remove();
  objects.remove();
  centerRenderer.remove();
  byId("layer-wms").checked = true;
  byId("objects-enabled").checked = false;
  map.fitBounds(wmsDemoBounds, { padding: 54 });
  updateWMSOutput("Открыта ограниченная область WMS");
});
byId("wms-url").addEventListener("click", () => updateWMSOutput("getTileUrl(1, 2, 3)"));
byId("wms-opacity").addEventListener("input", (event) => {
  const opacity = Number(event.target.value) / 100;
  wmsLayer.options.opacity = opacity;
  if (wmsLayer.container) wmsLayer.container.style.opacity = String(opacity);
  byId("wms-opacity-value").textContent = `${event.target.value}%`;
});

byId("reverse-line").addEventListener("click", () => {
  route.setLatLngs(route.getLatLngs().reverse());
  logEvent("Polyline.setLatLngs", { value: route.getLatLngs().length });
  updateMapOutput();
});

byId("circle-radius").addEventListener("input", (event) => {
  radius.setRadius(Number(event.target.value));
  byId("circle-radius-value").textContent = `${event.target.value} м`;
  updateMapOutput();
});

byId("popup-content").addEventListener("input", (event) => {
  mainMarker.getPopup()?.setContent(event.target.value);
  mainMarker.getTooltip()?.setContent(event.target.value);
  updateMapOutput();
});
byId("open-popup").addEventListener("click", () => {
  mainMarker.openPopup();
  updateMapOutput();
});
byId("toggle-popup").addEventListener("click", () => {
  mainMarker.togglePopup();
  updateMapOutput();
});
byId("close-popup").addEventListener("click", () => {
  mainMarker.closePopup();
  updateMapOutput();
});
byId("open-tooltip").addEventListener("click", () => {
  mainMarker.openTooltip();
  updateMapOutput();
});
byId("close-tooltip").addEventListener("click", () => {
  mainMarker.closeTooltip();
  updateMapOutput();
});
byId("auto-pan-popup").addEventListener("click", () => {
  const edge = map.containerPointToLatLng([map.getSize().x - 10, 18]);
  mainMarker.setLatLng(edge).openPopup();
  logEvent("Popup.autoPan", { latlng: edge });
  updateMapOutput({ autoPanTest: "opened at top-right edge" });
});
byId("swap-marker-icon").addEventListener("click", () => {
  markerIconVariant = !markerIconVariant;
  iconMarker.setIcon(markerIconVariant ? alternateMarkerIcon : imageMarkerIcon);
  updateMapOutput({ markerIconVariant: markerIconVariant ? "alternate" : "default" });
});
byId("marker-opacity").addEventListener("input", (event) => {
  mainMarker.setOpacity(Number(event.target.value) / 100);
  byId("marker-opacity-value").textContent = `${event.target.value}%`;
  updateMapOutput();
});
byId("marker-z-index").addEventListener("input", (event) => {
  mainMarker.setZIndexOffset(Number(event.target.value));
  byId("marker-z-index-value").textContent = event.target.value;
  updateMapOutput();
});

byId("image-opacity").addEventListener("input", (event) => {
  const opacity = Number(event.target.value) / 100;
  rasterOverlay.setOpacity(opacity);
  byId("image-opacity-value").textContent = `${event.target.value}%`;
  updateMapOutput();
});
byId("image-front").addEventListener("click", () => {
  rasterOverlay.bringToFront();
  updateMapOutput({ imageOrder: "front" });
});
byId("image-back").addEventListener("click", () => {
  rasterOverlay.bringToBack();
  updateMapOutput({ imageOrder: "back" });
});
byId("image-change").addEventListener("click", () => {
  overlayVariant = !overlayVariant;
  rasterOverlay.setUrl(makeOverlayPng(overlayVariant));
  updateMapOutput({ imageVariant: overlayVariant ? "alternate" : "default" });
});
byId("video-generated").addEventListener("click", async () => {
  videoDemoStatus = "generating local WebM";
  updateVideoSourceStatus();
  const url = await makeDemoVideoUrl();
  if (url) loadVideoOverlayUrl(url, "generated local WebM");
  else {
    videoDemoStatus = "poster fallback";
    updateVideoSourceStatus();
    updateMapOutput();
  }
});
byId("video-public-hls").addEventListener("click", () => {
  byId("video-stream-url").value = PUBLIC_HLS_STREAM;
  loadVideoOverlayUrl(PUBLIC_HLS_STREAM, "Apple public HLS");
});
byId("video-public-mp4").addEventListener("click", () => {
  byId("video-stream-url").value = PUBLIC_MP4_STREAM;
  loadVideoOverlayUrl(PUBLIC_MP4_STREAM, "public MP4");
});
byId("video-load-url").addEventListener("click", () => {
  loadVideoOverlayUrl(byId("video-stream-url").value, "custom stream");
});

byId("hide-vectors").addEventListener("click", () => {
  vectorGroup.clearLayers();
  geoLayer.remove();
  for (const id of vectorToggles.keys()) byId(id).checked = false;
  byId("layer-geojson").checked = false;
  updateMapOutput();
});

byId("restore-vectors").addEventListener("click", () => {
  for (const [id, layer] of vectorToggles) {
    vectorGroup.addLayer(layer);
    byId(id).checked = true;
  }
  geoLayer.addTo(map);
  byId("layer-geojson").checked = true;
  updateMapOutput();
});

function inputView() {
  return {
    center: [Number(byId("center-lat").value), Number(byId("center-lng").value)],
    zoom: Number(byId("center-zoom").value)
  };
}

byId("set-view").addEventListener("click", () => {
  const value = inputView();
  map.setView(value.center, value.zoom);
});
byId("pan-to").addEventListener("click", () => map.panTo(inputView().center));
byId("zoom-around").addEventListener("click", () => {
  const nextZoom = inputView().zoom;
  map.setZoomAround(map.getSize().divideBy(2), nextZoom);
});

const presets = {
  moscow: { center: [55.751244, 37.618423], zoom: 10 },
  petersburg: { center: [59.93863, 30.31413], zoom: 10 },
  world: { center: [20, 10], zoom: 2 }
};
for (const button of document.querySelectorAll("[data-preset]")) {
  button.addEventListener("click", () => {
    const preset = presets[button.dataset.preset];
    map.setView(preset.center, preset.zoom);
  });
}

byId("fit-vectors").addEventListener("click", () => {
  const target = vectorGroup.getBounds();
  if (target.isValid()) map.fitBounds(target, { padding: 48 });
});
byId("center-marker").addEventListener("click", () => {
  mainMarker.setLatLng(map.getCenter());
  updateMapOutput();
});
byId("zoom-in-api").addEventListener("click", () => {
  map.zoomIn();
  updateMapOutput({ navigation: "zoomIn" });
});
byId("zoom-out-api").addEventListener("click", () => {
  map.zoomOut();
  updateMapOutput({ navigation: "zoomOut" });
});
byId("fit-world-api").addEventListener("click", () => {
  map.fitWorld({ padding: 0 });
  updateMapOutput({ navigation: "fitWorld" });
});
byId("fly-to-api").addEventListener("click", () => {
  map.flyTo(inputView().center, inputView().zoom, { duration: 0.45 });
  updateMapOutput({ navigation: "flyTo" });
});
byId("fly-bounds-api").addEventListener("click", () => {
  map.flyToBounds(vectorGroup.getBounds(), { padding: 56, duration: 0.45 });
  updateMapOutput({ navigation: "flyToBounds" });
});
byId("stop-map-api").addEventListener("click", () => {
  map.stop();
  updateMapOutput({ navigation: "stop" });
});
byId("max-bounds-api").addEventListener("change", (event) => {
  map.setMaxBounds(event.target.checked ? [[55.55, 37.25], [55.95, 38.05]] : null);
  updateMapOutput({ navigation: event.target.checked ? "setMaxBounds" : "clearMaxBounds" });
});
byId("invalidate-size").addEventListener("click", () => {
  map.invalidateSize();
  updateMapOutput({ invalidated: true });
});
byId("list-layers").addEventListener("click", () => updateMapOutput({ eachLayerCalled: true }));
byId("custom-pane").addEventListener("change", (event) => {
  if (event.target.checked) {
    const pane = map.createPane("labels");
    pane.style.zIndex = "25";
    pane.dataset.testPane = "active";
  } else {
    map.removePane("labels");
  }
  updateMapOutput();
});

for (const [name, control] of Object.entries(controls)) {
  byId(`control-${name}`).addEventListener("change", (event) => {
    if (event.target.checked) control.addTo(map);
    else control.remove();
    updateMapOutput();
  });
}

byId("restart-map").addEventListener("click", () => {
  logEvent("Map.remove");
  map.remove();
  setTimeout(() => location.reload(), 80);
});

function calculatePoints() {
  const a = point(Number(byId("point-ax").value), Number(byId("point-ay").value));
  const b = point([Number(byId("point-bx").value), Number(byId("point-by").value)]);
  const box = pointBounds(a, b);
  const comparison = pointBounds([b.subtract([5, 5]), b.add([20, 20])]);
  byId("point-output").textContent = cleanObject({
    Point: {
      a: a.toArray(),
      clone: a.clone().toArray(),
      add: a.add(b).toArray(),
      subtract: a.subtract(b).toArray(),
      multiplyBy: a.multiplyBy(2.5).toArray(),
      divideBy: b.divideBy(2).toArray(),
      round: point([10.4, 20.6]).round().toArray(),
      floor: point([10.9, 20.9]).floor().toArray(),
      ceil: point([10.1, 20.1]).ceil().toArray(),
      distanceTo: a.distanceTo(b),
      equalsClone: a.equals(a.clone())
    },
    Bounds: {
      min: box.min.toArray(),
      max: box.max.toArray(),
      center: box.getCenter().toArray(),
      size: box.getSize().toArray(),
      containsA: box.contains(a),
      intersects: box.intersects(comparison),
      valid: box.isValid(),
      viaFactory: pointBounds(a, b).getSize().toArray()
    }
  });
}

function calculateGeo() {
  const a = latLng(Number(byId("geo-alat").value), Number(byId("geo-alng").value));
  const b = latLng([Number(byId("geo-blat").value), Number(byId("geo-blng").value)]);
  const projected = project(a, map.getZoom());
  const geographic = latLngBounds(a, b);
  const extended = extendBounds(extendBounds(null, a), b);
  const overlap = latLngBounds([a.lat - 1, a.lng - 1], [a.lat + 1, a.lng + 1]);
  const centerPoint = map.latLngToContainerPoint(a);
  byId("geo-output").textContent = cleanObject({
    LatLng: {
      a: a.toArray(),
      clone: a.clone().toArray(),
      equalsClone: a.equals(a.clone()),
      distanceTo: Math.round(a.distanceTo(b)),
      distanceFunction: Math.round(distance(a, b)),
      wrap: latLng(a.lat, a.lng + 360).wrap().toArray(),
      string: a.toString()
    },
    LatLngBounds: {
      bbox: geographic.toBBoxString(),
      center: geographic.getCenter().toArray(),
      southWest: geographic.getSouthWest().toArray(),
      northEast: geographic.getNorthEast().toArray(),
      northWest: geographic.getNorthWest().toArray(),
      southEast: geographic.getSouthEast().toArray(),
      containsA: geographic.contains(a),
      intersects: geographic.intersects(overlap),
      padded: geographic.pad(0.1).toBBoxString(),
      equalsExtended: geographic.equals(extended),
      valid: geographic.isValid(),
      boundsFactory: bounds(a, b).toBBoxString()
    },
    Projection: {
      project: projected.toArray(),
      unproject: unproject(projected, map.getZoom()).toArray(),
      scale: scale(map.getZoom()),
      zoomForBounds: zoomForBounds(map.getSize(), geographic, 32, map.options.maxZoom),
      metersToPixels: metersToPixels(1000, a.lat, map.getZoom()),
      clampLat: clampLat(100),
      wrapLng: wrapLng(a.lng + 360),
      constants: { TILE_SIZE, MAX_LAT, EARTH_RADIUS }
    },
    MapConversion: {
      layerPoint: map.latLngToLayerPoint(a).toArray(),
      containerPoint: centerPoint.toArray(),
      roundtrip: map.containerPointToLatLng(centerPoint).toArray()
    }
  });
}

byId("calculate-points").addEventListener("click", calculatePoints);
byId("calculate-geo").addEventListener("click", calculateGeo);

function renderSuggestions(items) {
  const list = byId("suggestions");
  list.textContent = "";
  for (const city of items) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `${city.name} · ${city.lat.toFixed(3)}, ${city.lng.toFixed(3)}`;
    button.addEventListener("click", () => map.setView([city.lat, city.lng], city.zoom));
    item.appendChild(button);
    list.appendChild(item);
  }
}

byId("search-run").addEventListener("click", async () => {
  const query = byId("suggest-ui-input").value || "М";
  const result = await citySearch.search(query, { center: map.getCenter().toArray() });
  byId("search-output").textContent = cleanObject({ mode: "search", query, result });
});
byId("geocode-run").addEventListener("click", async () => {
  const query = byId("suggest-ui-input").value || "Москва";
  const result = await citySearch.geocode(query, { center: map.getCenter().toArray() });
  byId("search-output").textContent = cleanObject({ mode: "geocode", query, result });
  const city = result?.properties;
  if (city) map.setView([city.lat, city.lng], city.zoom);
});
byId("suggest-ui-cancel").addEventListener("click", () => {
  suggestUi.cancel();
  byId("search-output").textContent = cleanObject({ mode: "suggest-ui", cancelled: true });
});

byId("suggest-input").addEventListener("input", async (event) => {
  const request = ++suggestionRequest;
  byId("suggest-status").textContent = "Поиск";
  const result = await suggestions.suggest(event.target.value, { center: map.getCenter().toArray() });
  if (request !== suggestionRequest) return;
  renderSuggestions(result);
  byId("suggest-status").textContent = result.length ? `Найдено: ${result.length}` : "Нет результатов";
  logEvent("SuggestProvider.suggest", { value: result.length });
});
byId("suggest-cancel").addEventListener("click", () => {
  suggestionRequest++;
  suggestions.cancel();
  byId("suggest-status").textContent = "Отменено";
  renderSuggestions([]);
});
byId("suggest-reset").addEventListener("click", () => {
  suggestions.destroy();
  suggestions = createSuggestProvider(fetchSuggestions, { debounceMs: 120, minLength: 1, limit: 5 });
  byId("suggest-status").textContent = "Создан новый provider";
});
byId("suggest-destroy").addEventListener("click", () => {
  suggestions.destroy();
  byId("suggest-status").textContent = "Provider уничтожен";
  renderSuggestions([]);
});

byId("objects-enabled").addEventListener("change", (event) => {
  if (event.target.checked) objects.addTo(map);
  else objects.remove();
  updateObjectCount();
});
byId("objects-cluster").addEventListener("change", (event) => {
  objects.setClusterize(event.target.checked);
  objectOperation = event.target.checked ? "clusterize:on" : "clusterize:off";
  updateObjectCount();
});
byId("objects-filter").addEventListener("change", (event) => {
  objects.setFilter(event.target.checked ? (item) => item.properties?.side === "west" : null);
  objectOperation = event.target.checked ? "filter:west" : "filter:off";
  updateObjectCount();
});
byId("cluster-grid").addEventListener("input", (event) => {
  objects.setClusterGridSize(Number(event.target.value));
  byId("cluster-grid-value").textContent = `${event.target.value} px`;
  objectOperation = `grid:${event.target.value}`;
  updateObjectCount();
});
byId("objects-add").addEventListener("click", () => {
  const center = map.getCenter();
  const lng = center.lng + (Math.random() - 0.5) * 0.16;
  objects.add({
    id: `random-${Date.now()}`,
    coordinates: [center.lat + (Math.random() - 0.5) * 0.1, lng],
    properties: { title: "Случайный объект", side: lng < center.lng ? "west" : "east" }
  });
  objectOperation = "add:1";
  updateObjectCount();
});
byId("objects-bulk").addEventListener("click", () => {
  const center = map.getCenter();
  const generation = ++bulkGeneration;
  let seed = (generation * 2654435761) >>> 0;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const batch = Array.from({ length: 5000 }, (_, index) => {
    const lat = center.lat + (random() - 0.5) * 0.9;
    const lng = center.lng + (random() - 0.5) * 1.5;
    return {
      id: `bulk-${generation}-${index}`,
      coordinates: [lat, lng],
      properties: { title: `Bulk ${generation}/${index}`, side: lng < center.lng ? "west" : "east" }
    };
  });
  const started = performance.now();
  objects.add(batch);
  objectOperation = `add:5000 in ${(performance.now() - started).toFixed(1)} ms`;
  updateObjectCount();
});
byId("objects-sample").addEventListener("click", () => {
  objects.add(sampleObjects);
  objectOperation = "sample:4";
  updateObjectCount();
});
byId("objects-remove").addEventListener("click", () => {
  const ids = [...objects.items.keys()].filter((id) => String(id).startsWith("bulk-")).slice(0, 1000);
  objects.remove(ids);
  objectOperation = `remove:${ids.length}`;
  updateObjectCount();
});
byId("objects-clear").addEventListener("click", () => {
  objects.clear();
  objectOperation = "clear";
  updateObjectCount();
});

byId("remote-enabled").addEventListener("change", (event) => {
  if (event.target.checked) remoteObjects.addTo(map);
  else remoteObjects.remove();
  updateRemoteCount(event.target.checked ? "enabled" : "disabled");
});
byId("remote-reload").addEventListener("click", () => remoteObjects.reload());
byId("remote-cancel").addEventListener("click", () => {
  remoteObjects.cancel();
  updateRemoteCount("cancelled");
});

byId("traffic-refresh").addEventListener("click", () => {
  if (!map.hasLayer(traffic)) {
    traffic.addTo(map);
    byId("layer-traffic").checked = true;
  }
  lastTrafficEvent = "manual-refresh";
  traffic.refresh();
  updateTrafficStatus();
  updateRouteOutput("traffic-refresh");
  updateMapOutput();
});
byId("route-build").addEventListener("click", async () => {
  if (!map.hasLayer(demoRouting)) demoRouting.addTo(map);
  const center = map.getCenter();
  lastRouteWaypoints = [
    [center.lat - 0.045, center.lng - 0.08],
    [center.lat + 0.055, center.lng + 0.1]
  ];
  updateRouteOutput("routing");
  const routes = await demoRouting.route(lastRouteWaypoints);
  updateRouteOutput(`routes:${routes.length}`);
  updateMapOutput();
});
byId("route-alt").addEventListener("click", () => {
  demoRouting.select(demoRouting.selectedIndex === 0 ? 1 : 0);
  updateRouteOutput("alternative");
  updateMapOutput();
});
for (const name of ["drag", "scrollZoom", "pinchZoom", "dblClick", "boxZoom"]) {
  byId(`behavior-${name}`).addEventListener("change", (event) => {
    map.behaviors.toggle(name, event.target.checked);
    updateRouteOutput("behavior");
    updateMapOutput();
  });
}

function generateHeatPoints() {
  const center = map.getCenter();
  const points = [];
  for (let i = 0; i < 400; i++) {
    points.push([
      center.lat + (Math.random() - 0.5) * 0.14,
      center.lng + (Math.random() - 0.5) * 0.2,
      Math.random() * 0.8 + 0.2
    ]);
  }
  for (let i = 0; i < 30; i++) {
    points.push([
      center.lat + 0.02 + (Math.random() - 0.5) * 0.01,
      center.lng - 0.01 + (Math.random() - 0.5) * 0.01,
      1
    ]);
    points.push([
      center.lat - 0.015 + (Math.random() - 0.5) * 0.01,
      center.lng - 0.02 + (Math.random() - 0.5) * 0.01,
      1
    ]);
  }
  return points;
}

function generatePointCloud(count) {
  const center = map.getCenter();
  let seed = 0x9e3779b9;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  return Array.from({ length: count }, () => [
    center.lat + (random() - 0.5) * 1.4,
    center.lng + (random() - 0.5) * 2.2
  ]);
}

byId("webgl-100k").addEventListener("click", () => {
  const started = performance.now();
  webglPoints.setData(generatePointCloud(100000));
  if (!map.hasLayer(webglPoints)) webglPoints.addTo(map);
  stageEightMessage = `100k in ${(performance.now() - started).toFixed(1)} ms`;
  updateStageEightOutput();
});
byId("webgl-toggle").addEventListener("click", () => {
  if (map.hasLayer(webglPoints)) webglPoints.remove();
  else webglPoints.addTo(map);
  stageEightMessage = map.hasLayer(webglPoints) ? "webgl:on" : "webgl:off";
  updateStageEightOutput();
});
byId("heat-toggle").addEventListener("click", () => {
  if (map.hasLayer(heatDemo)) heatDemo.remove();
  else {
    if (!heatDemo.options.scaleZoom) heatDemo.options.scaleZoom = map.getZoom();
    heatDemo.setLatLngs(generateHeatPoints()).addTo(map);
  }
  stageEightMessage = map.hasLayer(heatDemo) ? "heat:on" : "heat:off";
  updateStageEightOutput();
});
byId("heat-regenerate").addEventListener("click", () => {
  const started = performance.now();
  heatDemo.setLatLngs(generateHeatPoints());
  if (!map.hasLayer(heatDemo)) heatDemo.addTo(map);
  stageEightMessage = `heat ${heatDemo.options.scaleZoom ? "regenerated" : "ready"} in ${(performance.now() - started).toFixed(1)} ms`;
  updateStageEightOutput();
});
byId("vector-tiles-toggle").addEventListener("click", () => {
  if (map.hasLayer(vectorTiles)) vectorTiles.remove();
  else vectorTiles.addTo(map);
  stageEightMessage = map.hasLayer(vectorTiles) ? "vector-tiles:on" : "vector-tiles:off";
  updateStageEightOutput();
});
byId("perf-measure").addEventListener("click", async () => {
  stageEightMessage = "measuring";
  updateStageEightOutput();
  const snapshot = await perfInspector.measureFrames(30);
  stageEightMessage = snapshot.fps ? `${snapshot.fps.toFixed(1)} FPS` : "snapshot";
  updateStageEightOutput({ measured: snapshot });
});
byId("worker-prepare").addEventListener("click", () => {
  const started = performance.now();
  const prepared = preparePointBatch(generatePointCloud(10000));
  stageEightMessage = `prepared ${prepared.count} in ${(performance.now() - started).toFixed(1)} ms`;
  updateStageEightOutput({ prepared: { count: prepared.count, skipped: prepared.skipped, bytes: prepared.points.byteLength } });
});
byId("offline-prefetch").addEventListener("click", async () => {
  stageEightMessage = "offline-prefetch";
  const activeTiles = getActiveBasemap();
  const stats = await offlineCache.prefetch([
    activeBasemapKey === "canvas" ? basemapLayers.osm.getTileUrl(0, 0, 0) : activeTiles.getTileUrl(0, 0, 0)
  ]);
  updateStageEightOutput({ offline: stats });
});
byId("mvt-decode").addEventListener("click", () => {
  const features = decodeMVT(makeTinyMVT(), { x: 0, y: 0, z: 0 }, { layer: "demo" });
  stageEightMessage = `mvt:${features.length}`;
  updateStageEightOutput({ mvt: features });
});
byId("webgl-transform").addEventListener("click", () => {
  webglPoints.setViewTransform({
    rotation: webglPoints.options.rotation ? 0 : 28,
    pitch: webglPoints.options.pitch ? 0 : 38
  });
  if (!map.hasLayer(webglPoints)) webglPoints.addTo(map);
  stageEightMessage = `webgl transform r${webglPoints.options.rotation}/p${webglPoints.options.pitch}`;
  updateStageEightOutput();
});
byId("offline-sw").addEventListener("click", () => {
  const script = offlineCache.createServiceWorkerScript();
  stageEightMessage = "service-worker script";
  updateStageEightOutput({ serviceWorker: { bytes: script.length, preview: script.slice(0, 180) } });
});
byId("release-manifest").addEventListener("click", async () => {
  const pkg = await fetch(`${ORIHON_CDN}/package.json`).then((response) => response.json());
  stageEightMessage = `release ${pkg.version}`;
  updateStageEightOutput({
    package: {
      name: pkg.name,
      version: pkg.version,
      description: pkg.description,
      cdn: ORIHON_CDN
    }
  });
});
byId("define-map-element").addEventListener("click", () => {
  const element = defineOrihonElement();
  stageEightMessage = element ? "aero-map defined" : "customElements unavailable";
  updateStageEightOutput();
});

objects.on("render", () => updateObjectCount());
objects.on("click", (event) => logEvent("ObjectManager.click", event));
objects.on("clusterclick", (event) => logEvent("ObjectManager.clusterclick", event));

const probe = new Evented();
const probeParent = new Evented();
const probeHandler = (event) => logEvent("Evented.probe", event);
const parentHandler = (event) => logEvent("Evented.parent", event);
probe.on("probe", probeHandler).addEventParent(probeParent);
probeParent.on("probe", parentHandler);

function updateEventedState() {
  byId("evented-listens").textContent = String(probe.listens("probe", true));
  byId("evented-toggle").textContent = eventedAttached ? "off" : "on";
}

byId("evented-emit").addEventListener("click", () => probe.emit("probe", { value: Date.now() % 1000 }));
byId("evented-once").addEventListener("click", () => {
  probe.once("once-probe", (event) => logEvent("Evented.once", event));
  probe.emit("once-probe", { value: 1 });
  probe.emit("once-probe", { value: 2 });
});
byId("evented-toggle").addEventListener("click", () => {
  if (eventedAttached) {
    probe.off("probe", probeHandler).removeEventParent(probeParent);
  } else {
    probe.on("probe", probeHandler).addEventParent(probeParent);
  }
  eventedAttached = !eventedAttached;
  updateEventedState();
});

byId("pause-events").addEventListener("change", (event) => { paused = event.target.checked; });
byId("clear-events").addEventListener("click", () => { eventLog.textContent = ""; });

runtimeStatus.textContent = "v1.0.1 · ESM · TypeScript";
byId("map-aria-label").textContent = map.getContainer().getAttribute("aria-label") || "";
updateMapReadout();
syncViewInputs();
updateLowZoomClean();
updateVideoSourceStatus();
updateMapOutput();
updateObjectCount();
updateRemoteCount();
updateTrafficStatus();
updateRouteOutput();
updateStageEightOutput();
updateGeoJSONStatus();
updateWMSOutput();
updateEventedState();
calculatePoints();
calculateGeo();
logEvent("Orihon.ready", { value: map.layers.size });
