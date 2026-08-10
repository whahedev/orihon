import {
  createMap,
  geoJSON,
  heatIsolineLayer,
  marker,
  markerCollection,
  objectManager,
  tileLayer,
  webglHeatLayer,
  webglPointLayer,
  webglTileLayer
} from "/dist/index.js";
import { createMapLibreRawPoints } from "./maplibre-raw.js";

const CENTER = [50.1, 14.4];
const ZOOM = 5;
const HEAT_ZOOM = 6;
const OSM = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const MARKERS_MAX = 5000;
/** Chart popups are DOM-heavy — same hard cap as the Markers scenario; count comes from Points. */
const POPUP_MARKERS_MAX = MARKERS_MAX;
/** Even with thousands of markers, only hop this many times (spread across the set). */
const POPUP_SWITCH_MAX = 40;

/** City-ish hotspots for realistic heat / isoline benches (Europe + near). */
const HEAT_HUBS = [
  [50.08, 14.42, 1.0], // Prague
  [52.52, 13.405, 0.95], // Berlin
  [48.21, 16.37, 0.7], // Vienna
  [47.5, 19.04, 0.65], // Budapest
  [52.23, 21.01, 0.8], // Warsaw
  [50.06, 19.94, 0.55], // Krakow
  [48.86, 2.35, 0.9], // Paris
  [51.51, -0.12, 1.0], // London
  [41.9, 12.5, 0.75], // Rome
  [40.42, -3.7, 0.7], // Madrid
  [52.37, 4.9, 0.72], // Amsterdam
  [50.85, 4.35, 0.5], // Brussels
  [55.75, 37.62, 0.85], // Moscow
  [59.93, 30.33, 0.6], // Saint Petersburg
  [45.46, 9.19, 0.58], // Milan
  [48.14, 11.58, 0.62] // Munich
];

/** Shared heatmap look: cooler mid-tones visible, red only at peaks. */
const HEAT_GRADIENT = {
  0.0: "rgba(0,0,255,0)",
  0.15: "blue",
  0.35: "cyan",
  0.55: "lime",
  0.75: "yellow",
  0.9: "orange",
  1.0: "red"
};

/**
 * Fair cross-engine heat paint. Engines expose different knobs, but these keep
 * visual weight / color ramp in the same ballpark on the shared dataset.
 */
const HEAT_BENCH = {
  zoom: HEAT_ZOOM,
  /** Kernel radius in screen px (Orihon / Leaflet / OL). */
  radius: 20,
  blur: 18,
  /** Orihon global multiplier. */
  intensity: 0.32,
  opacity: 0.75,
  /** Leaflet.heat: higher maxZoom → less zoom-out boost (avoids solid red). */
  leafletMaxZoom: 16,
  /** OpenLayers gradient (CSS color stops, cold → hot). */
  olGradient: ["#0000ff", "#00ffff", "#00ff00", "#ffff00", "#ff8c00", "#ff0000"],
  /** Leaflet.heat rejects fully-transparent first stop — start slightly opaque. */
  leafletGradient: {
    0.15: "blue",
    0.35: "cyan",
    0.55: "lime",
    0.75: "yellow",
    0.9: "orange",
    1.0: "red"
  }
};

function mapLibreRasterStyle() {
  return {
    version: 8,
    // MapLibre ≥5.11: omit glyphs → local/CSS fonts for symbol text (cluster counts).
    sources: {
      osm: { type: "raster", tiles: [OSM], tileSize: 256, attribution: "© OpenStreetMap" }
    },
    layers: [{ id: "osm", type: "raster", source: "osm" }]
  };
}
const STRESS_MS = 3000;
const LIVE_MS = 3000;
const PICK_SAMPLES = 200;
const FRAME_BUDGET_MS = 1000 / 55; // ~18.2ms — ignore normal vsync jitter around 16.7–16.9
const POINT_CACHE = new Map();

const PRESETS = {
  marketing: { scenario: "points", count: "50000", runs: "3" },
  stress: { scenario: "points", count: "250000", runs: "1" },
  objects: { scenario: "clusters", count: "50000", runs: "3" },
  live: { scenario: "live", count: "50000", runs: "1" },
  pick: { scenario: "pick", count: "50000", runs: "3" },
  heatmap: { scenario: "heatmap", count: "50000", runs: "3" },
  isolines: { scenario: "isolines", count: "25000", runs: "3" },
  geojson: { scenario: "geojson", count: "5000", runs: "3" },
  markers: { scenario: "markers", count: "5000", runs: "3" },
  filter: { scenario: "filter", count: "50000", runs: "3" },
  popup: { scenario: "popup", count: "100", runs: "3" },
  basemap: { scenario: "basemap", count: "1000", runs: "3" }
};

const SCENARIO_NOTES = {
  points:
    "WebGL points (Orihon + MapLibre raw buffer), Leaflet canvas markers, OpenLayers vector. Camera = zigzag+zoom ~3s. FPS 60≈ means vsync-capped — prefer p95 / drop% (budget ~18 ms).",
  clusters:
    "Orihon ObjectManager (hierarchical greedy radius clusters + WebGL + worker index), Leaflet.markercluster, OL Cluster, MapLibre GeoJSON cluster. Camera = discrete view steps; Orihon does not rebuild clusters on pan-only moves.",
  live:
    "Each frame moves ~20% of points for ~3s. Measures update FPS / p95 / drop%. Shows realtime fleet-style cost.",
  pick:
    "Same O(n) screen-space nearest scan via each engine’s project() — fair across stacks. Samples are projected from real points (guaranteed on-feature).",
  heatmap:
    "One shared hub-weighted dataset + HEAT_BENCH paint. Heap = absolute tab usedJSHeapSize with that engine live; previous engine is destroyed and heap is allowed to reclaim before each run.",
  isolines:
    "Orihon only: heatIsolineLayer builds density field + marching-squares isolines on moveend/zoomend (discrete camera). Leaflet / OpenLayers / MapLibre have no built-in heat→isolines API — rows marked n/a (plugins/Turf/DEM contours are a different feature).",
  geojson:
    "N LineString features (4 vertices each). Orihon DOM tiles + geoJSON WebGL lines (one GL overlay; dual GL basemap+lines waits on shared runtime). Leaflet/OL/MapLibre as before.",
  markers:
    "DOM markers hard-capped at 5,000. Orihon MarkerCollection (viewport-culled DOM). For 50k+ use Points (WebGL) or markerCollection({ renderer: 'auto'|'webgl' }).",
  filter:
    "Clustered collection with setFilter / equivalent toggled every discrete camera step (~half of points). Stresses reclustering under filter churn.",
  popup:
    "Markers count = Points control (capped at 5,000). All markers load with chart popups; stress only hops ≤40 times (spread across the set) with zoom ~9–13. Open p50/p95 = view+open per hop.",
  basemap:
    "Tiles only — no overlay data. Orihon uses webglTileLayer; others keep their native raster path. Continuous camera stress.",
};

const COLUMNS = {
  points: ["Engine", "Init", "Load", "FPS", "p95", "max", "drop%", "Heap"],
  clusters: ["Engine", "Init", "Load", "FPS", "p95", "drop%", "Markers", "Heap"],
  live: ["Engine", "Init", "Load", "FPS", "p95", "max", "drop%", "Heap"],
  pick: ["Engine", "Init", "Load", "Pick p50", "Pick p95", "Heap"],
  heatmap: ["Engine", "Init", "Load", "FPS", "p95", "max", "drop%", "Heap"],
  isolines: ["Engine", "Init", "Load", "FPS", "p95", "max", "drop%", "Rings", "Heap"],
  geojson: ["Engine", "Init", "Load", "FPS", "p95", "max", "drop%", "Heap"],
  markers: ["Engine", "Init", "Load", "FPS", "p95", "max", "drop%", "Heap"],
  filter: ["Engine", "Init", "Load", "FPS", "p95", "drop%", "Markers", "Heap"],
  popup: ["Engine", "Init", "Load", "Open p50", "Open p95", "Heap"],
  basemap: ["Engine", "Init", "Load", "FPS", "p95", "max", "drop%", "Heap"]
};

const els = {
  stage: document.getElementById("stage"),
  scenario: document.getElementById("scenario"),
  count: document.getElementById("count"),
  countLabel: document.getElementById("count-label"),
  runs: document.getElementById("runs"),
  preset: document.getElementById("preset"),
  run: document.getElementById("run"),
  exportBtn: document.getElementById("export"),
  resultsHead: document.getElementById("results-head"),
  results: document.querySelector("#results tbody"),
  methodNote: document.getElementById("method-note"),
  sizeList: document.getElementById("size-list"),
  hudEngine: document.getElementById("hud-engine"),
  hudStatus: document.getElementById("hud-status"),
  checks: {
    orihon: document.getElementById("engines-orihon"),
    leaflet: document.getElementById("engines-leaflet"),
    ol: document.getElementById("engines-ol"),
    maplibre: document.getElementById("engines-maplibre")
  }
};

/** @type {null | { destroy: () => void }} */
let active = null;
let busy = false;
/** @type {null | object} */
let lastExport = null;

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function createPoints(count) {
  const cached = POINT_CACHE.get(count);
  if (cached) return cached;
  const rand = mulberry32(count ^ 0x9e3779b9);
  const points = new Array(count);
  for (let i = 0; i < count; i++) {
    points[i] = [35 + rand() * 28, -15 + rand() * 55];
  }
  POINT_CACHE.set(count, points);
  return points;
}

/**
 * Weighted heat-like distribution: most mass in city gaussians, light rural noise.
 * Returns [lat, lng, weight]. Cached & frozen — one shared master per count for all engines.
 */
function createHeatPoints(count) {
  const key = `heat:${count}`;
  const cached = POINT_CACHE.get(key);
  if (cached) return cached;
  const rand = mulberry32(count ^ 0x51f5a11);
  const points = new Array(count);
  const clustered = Math.floor(count * 0.78);
  for (let i = 0; i < clustered; i++) {
    const hub = HEAT_HUBS[(rand() * HEAT_HUBS.length) | 0];
    // Mix tight cores and softer suburbs (degrees).
    const sigma = 0.08 + rand() * rand() * 0.7;
    const u = Math.max(1e-9, rand());
    const v = rand();
    const r = Math.sqrt(-2 * Math.log(u));
    const ang = 2 * Math.PI * v;
    const lat = hub[0] + r * Math.cos(ang) * sigma;
    const lng = hub[1] + r * Math.sin(ang) * sigma * 1.35;
    const weight = hub[2] * (0.2 + rand() * 0.8);
    points[i] = Object.freeze([lat, lng, weight]);
  }
  for (let i = clustered; i < count; i++) {
    points[i] = Object.freeze([36 + rand() * 26, -12 + rand() * 50, 0.04 + rand() * 0.18]);
  }
  Object.freeze(points);
  POINT_CACHE.set(key, points);
  return points;
}

function clonePoints(points) {
  return points.map((pair) => (pair.length > 2 ? [pair[0], pair[1], pair[2]] : [pair[0], pair[1]]));
}

function formatMs(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value < 1) return `${value.toFixed(2)} ms`;
  return `${value.toFixed(value >= 100 ? 0 : 1)} ms`;
}

function formatFps(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value >= 58) return `${value.toFixed(0)}≈`;
  return value.toFixed(1);
}

function formatPct(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(0)}%`;
}

function formatHeap(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(2)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
}

function readHeap() {
  return performance.memory?.usedJSHeapSize ?? NaN;
}

/** Drop previous map, then wait until usedJSHeapSize stops falling (GC settled). */
async function reclaimHeap({ rounds = 18, pauseMs = 45 } = {}) {
  if (typeof globalThis.gc === "function") {
    try {
      globalThis.gc();
    } catch {
      /* ignore */
    }
  }
  let last = readHeap();
  let stable = 0;
  for (let i = 0; i < rounds; i++) {
    await sleep(pauseMs);
    await waitFrames(1);
    if (typeof globalThis.gc === "function") {
      try {
        globalThis.gc();
      } catch {
        /* ignore */
      }
    }
    const now = readHeap();
    if (!Number.isFinite(now) || !Number.isFinite(last)) {
      last = now;
      continue;
    }
    // Treat as settled when heap is no longer dropping by >250KB.
    if (last - now < 250e3) {
      stable += 1;
      if (stable >= 3) break;
    } else {
      stable = 0;
    }
    last = now;
  }
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank];
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function medianRow(rows) {
  const keys = ["initMs", "loadMs", "fps", "p95Ms", "maxMs", "dropPct", "pickP50", "pickP95", "heap", "markers"];
  const out = { ...rows[0], runs: rows.length, median: true };
  for (const key of keys) {
    const values = rows.map((row) => row[key]).filter((value) => Number.isFinite(value));
    out[key] = values.length ? median(values) : rows[0][key];
  }
  return out;
}

function setHud(engine, status) {
  els.hudEngine.textContent = engine;
  els.hudStatus.textContent = status;
}

async function clearStage({ settleMs = 160 } = {}) {
  if (active) {
    try {
      active.destroy();
    } catch {
      /* ignore */
    }
    active = null;
  }
  els.stage.replaceChildren();
  // Let detach + WebGL loseContext settle before the next engine allocates again.
  await waitFrames(4);
  await sleep(settleMs);
  // Chrome only with --js-flags=--expose-gc; harmless no-op otherwise.
  if (typeof globalThis.gc === "function") {
    try {
      globalThis.gc();
    } catch {
      /* ignore */
    }
  }
  await waitFrames(2);
}

function waitFrames(count = 2) {
  return new Promise((resolve) => {
    let left = count;
    const step = () => {
      left -= 1;
      if (left <= 0) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Shared canvas bar chart for popup open/close bench (no Chart.js dependency). */
function mountBenchChart(container, values, title = "Metrics") {
  const root = document.createElement("div");
  root.className = "bench-popup-chart";
  const heading = document.createElement("strong");
  heading.textContent = title;
  root.appendChild(heading);
  const canvas = document.createElement("canvas");
  canvas.width = 280;
  canvas.height = 110;
  root.appendChild(canvas);
  container.appendChild(root);

  const drawing = canvas.getContext("2d");
  if (!drawing) return () => {};
  const maximum = Math.max(1, ...values);
  drawing.clearRect(0, 0, canvas.width, canvas.height);
  drawing.strokeStyle = "#94a3b8";
  drawing.beginPath();
  drawing.moveTo(20, 88);
  drawing.lineTo(260, 88);
  drawing.stroke();
  values.forEach((value, index) => {
    const width = 24;
    const x = 28 + index * 30;
    const height = Math.max(3, (value / maximum) * 68);
    drawing.fillStyle = index % 2 ? "#2dd4bf" : "#fb7185";
    drawing.fillRect(x, 88 - height, width, height);
  });
  return () => {
    root.remove();
  };
}

function benchChartSeries(seed = 1) {
  const rand = mulberry32(seed ^ 0xc4a71);
  return Array.from({ length: 8 }, () => 12 + Math.floor(rand() * 88));
}

async function stressPopupSwitch(points, openAtIndex, applyView, baseZoom = 11) {
  const n = points.length;
  const hops = Math.max(1, Math.min(n, POPUP_SWITCH_MAX));
  const times = [];
  for (let h = 0; h < hops; h++) {
    // Spread samples across the full marker set (not only the first N).
    const index = hops === 1 ? 0 : Math.round((h / (hops - 1)) * (n - 1));
    const [lat, lng] = points[index];
    const phase = (h / Math.max(1, hops - 1)) * Math.PI * 2;
    // Zoom in/out while hopping between markers (≈9–13).
    const zoom = Math.max(9, Math.min(13.5, baseZoom + Math.sin(phase * 1.15) * 2.25));
    const start = performance.now();
    applyView(lat, lng, zoom);
    openAtIndex(index);
    await waitFrames(1);
    times.push(performance.now() - start);
  }
  return {
    pickP50: percentile(times, 50),
    pickP95: percentile(times, 95),
    hops
  };
}

function createPopupPoints(count) {
  const key = `popup:${count}`;
  const cached = POINT_CACHE.get(key);
  if (cached) return cached;
  const rand = mulberry32(count ^ 0x90b11);
  const points = new Array(count);
  for (let i = 0; i < count; i++) {
    points[i] = Object.freeze([
      CENTER[0] + (rand() - 0.5) * 0.32,
      CENTER[1] + (rand() - 0.5) * 0.5,
      i
    ]);
  }
  Object.freeze(points);
  POINT_CACHE.set(key, points);
  return points;
}

function summarizeFrames(deltas) {
  if (!deltas.length) {
    return { fps: null, frameMs: null, p95Ms: null, maxMs: null, dropPct: null, frames: 0 };
  }
  const average = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
  const over = deltas.filter((value) => value > FRAME_BUDGET_MS).length;
  return {
    fps: average ? 1000 / average : null,
    frameMs: average || null,
    p95Ms: percentile(deltas, 95),
    maxMs: Math.max(...deltas),
    dropPct: (over / deltas.length) * 100,
    frames: deltas.length
  };
}

async function stressCamera(applyView, durationMs = STRESS_MS, baseZoom = ZOOM) {
  const deltas = [];
  let last = 0;
  const start = performance.now();
  await new Promise((resolve) => {
    const step = (time) => {
      if (last) deltas.push(time - last);
      last = time;
      const elapsed = time - start;
      const phase = elapsed / 70;
      applyView(
        CENTER[0] + Math.sin(phase) * 5,
        CENTER[1] + Math.cos(phase * 1.35) * 14,
        baseZoom + Math.sin(phase * 0.55) * 1.8
      );
      if (elapsed < durationMs) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
  return summarizeFrames(deltas);
}

/** Discrete camera steps — fair for cluster engines that rebuild on moveend/zoomend. */
async function stressClusters(applyView, steps = 16, durationMs = STRESS_MS, baseZoom = ZOOM) {
  const deltas = [];
  const slice = durationMs / steps;
  for (let i = 0; i < steps; i++) {
    const phase = (i / Math.max(1, steps - 1)) * Math.PI * 2;
    applyView(
      CENTER[0] + Math.sin(phase) * 5,
      CENTER[1] + Math.cos(phase * 1.35) * 14,
      Math.max(3, baseZoom + Math.sin(phase * 0.55) * 1.5)
    );
    let last = 0;
    const sliceStart = performance.now();
    await new Promise((resolve) => {
      const step = (time) => {
        if (last) deltas.push(time - last);
        last = time;
        if (time - sliceStart < slice) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
  }
  return summarizeFrames(deltas);
}

async function measureLive(update, durationMs = LIVE_MS) {
  const deltas = [];
  let last = 0;
  const start = performance.now();
  await new Promise((resolve) => {
    const step = (time) => {
      if (last) deltas.push(time - last);
      last = time;
      update(time - start);
      if (time - start < durationMs) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
  return summarizeFrames(deltas);
}

function blankHost() {
  const host = document.createElement("div");
  host.style.width = "100%";
  host.style.height = "100%";
  els.stage.appendChild(host);
  return host;
}

function makeObjects(points) {
  return points.map((coordinates, index) => ({
    id: index,
    coordinates,
    properties: { title: `P${index}`, active: index % 3 !== 0 }
  }));
}

function createLineFeatureCollection(points) {
  return {
    type: "FeatureCollection",
    features: points.map(([lat, lng], index) => ({
      type: "Feature",
      properties: { id: index },
      geometry: {
        type: "LineString",
        coordinates: [
          [lng, lat],
          [lng + 0.12, lat + 0.06],
          [lng + 0.24, lat - 0.04],
          [lng + 0.36, lat + 0.02]
        ]
      }
    }))
  };
}

/** Discrete camera + alternating filter predicate (even steps = active-only). */
async function stressFilterCamera(applyView, applyFilter, steps = 16, durationMs = STRESS_MS) {
  const deltas = [];
  const slice = durationMs / steps;
  for (let i = 0; i < steps; i++) {
    applyFilter(i % 2 === 0);
    const phase = (i / Math.max(1, steps - 1)) * Math.PI * 2;
    applyView(
      CENTER[0] + Math.sin(phase) * 5,
      CENTER[1] + Math.cos(phase * 1.35) * 14,
      Math.max(3, ZOOM + Math.sin(phase * 0.55) * 1.5)
    );
    let last = 0;
    const sliceStart = performance.now();
    await new Promise((resolve) => {
      const step = (time) => {
        if (last) deltas.push(time - last);
        last = time;
        if (time - sliceStart < slice) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
  }
  return summarizeFrames(deltas);
}

function jitterPoints(points, t, fraction = 0.2, target = null) {
  const next = target || clonePoints(points);
  const stride = Math.max(1, Math.floor(1 / fraction));
  const phase = t / 180;
  for (let i = 0; i < points.length; i++) {
    if (i % stride === 0) {
      next[i][0] = points[i][0] + Math.sin(phase + i * 0.01) * 0.35;
      next[i][1] = points[i][1] + Math.cos(phase + i * 0.013) * 0.45;
    } else if (target) {
      next[i][0] = points[i][0];
      next[i][1] = points[i][1];
    }
  }
  return next;
}

/** Project random real points to screen so picks land on features. */
function pickSamplesFromPoints(points, project, count) {
  const rand = mulberry32(0x51feed ^ points.length ^ count);
  const samples = [];
  let guard = 0;
  while (samples.length < count && guard < count * 8) {
    guard += 1;
    const idx = Math.floor(rand() * points.length);
    const projected = project(points[idx]);
    if (!projected || !Number.isFinite(projected.x) || !Number.isFinite(projected.y)) continue;
    samples.push({ lx: projected.x, ly: projected.y, index: idx });
  }
  return samples;
}

function measureProjectScan(points, project, samples) {
  const times = [];
  for (const sample of samples) {
    const t0 = performance.now();
    nearestLatLng(points, project, sample.lx, sample.ly, 16);
    times.push(performance.now() - t0);
  }
  return times;
}

function nearestLatLng(points, mapProject, x, y, tolerance = 12) {
  let best = -1;
  let bestDist = tolerance;
  for (let i = 0; i < points.length; i++) {
    const projected = mapProject(points[i]);
    if (!projected) continue;
    const dx = projected.x - x;
    const dy = projected.y - y;
    const dist = Math.hypot(dx, dy);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

/* -------------------- engines: points -------------------- */

async function pointsOrihon(points) {
  const host = blankHost();
  const initStart = performance.now();
  const map = createMap(host, {
    center: CENTER,
    zoom: ZOOM,
    minZoom: 2,
    maxZoom: 12,
    controls: false
  });
  tileLayer(OSM, { attribution: "© OpenStreetMap", maxZoom: 19 }).addTo(map);
  await waitFrames(3);
  const initMs = performance.now() - initStart;

  const layer = webglPointLayer([], {
    pointSize: 2.5,
    color: "#2dd4bf",
    opacity: 0.78,
    maxDpr: 1.5,
    interactive: false
  }).addTo(map);

  const loadStart = performance.now();
  layer.setData(points);
  await waitFrames(4);
  const loadMs = performance.now() - loadStart;

  const pan = await stressCamera((lat, lng, zoom) => map.setView([lat, lng], zoom));
  await waitFrames(2);
  const heap = readHeap();
  active = { destroy: () => map.remove() };
  return {
    name: "Orihon (WebGL)",
    initMs,
    loadMs,
    ...pan,
    heap
  };
}

async function pointsLeaflet(points) {
  const host = blankHost();
  const initStart = performance.now();
  const map = L.map(host, {
    center: CENTER,
    zoom: ZOOM,
    zoomControl: false,
    preferCanvas: true,
    fadeAnimation: false,
    zoomAnimation: false,
    markerZoomAnimation: false
  });
  L.tileLayer(OSM, { attribution: "© OpenStreetMap", maxZoom: 19 }).addTo(map);
  map.invalidateSize();
  await waitFrames(3);
  const initMs = performance.now() - initStart;

  const group = L.layerGroup().addTo(map);
  const renderer = L.canvas({ padding: 0.5 });
  const loadStart = performance.now();
  for (let i = 0; i < points.length; i++) {
    L.circleMarker(points[i], {
      radius: 2,
      stroke: false,
      fillColor: "#2dd4bf",
      fillOpacity: 0.78,
      renderer
    }).addTo(group);
  }
  await waitFrames(4);
  const loadMs = performance.now() - loadStart;

  const pan = await stressCamera((lat, lng, zoom) => map.setView([lat, lng], zoom, { animate: false }));
  await waitFrames(2);
  const heap = readHeap();
  active = { destroy: () => map.remove() };
  return { name: "Leaflet (canvas)", initMs, loadMs, ...pan, heap };
}

async function pointsOpenLayers(points) {
  const host = blankHost();
  const initStart = performance.now();
  const map = new ol.Map({
    target: host,
    layers: [
      new ol.layer.Tile({
        source: new ol.source.XYZ({ url: OSM, attributions: "© OpenStreetMap" })
      })
    ],
    view: new ol.View({
      center: ol.proj.fromLonLat([CENTER[1], CENTER[0]]),
      zoom: ZOOM
    }),
    controls: []
  });
  await waitFrames(3);
  const initMs = performance.now() - initStart;

  const source = new ol.source.Vector({ wrapX: false });
  map.addLayer(
    new ol.layer.Vector({
      source,
      style: new ol.style.Style({
        image: new ol.style.Circle({
          radius: 2,
          fill: new ol.style.Fill({ color: "rgba(45, 212, 191, 0.78)" })
        })
      }),
      updateWhileAnimating: true,
      updateWhileInteracting: true
    })
  );

  const loadStart = performance.now();
  const features = points.map(
    ([lat, lng]) => new ol.Feature({ geometry: new ol.geom.Point(ol.proj.fromLonLat([lng, lat])) })
  );
  source.addFeatures(features);
  await waitFrames(4);
  const loadMs = performance.now() - loadStart;

  const view = map.getView();
  const pan = await stressCamera((lat, lng, zoom) => {
    view.setCenter(ol.proj.fromLonLat([lng, lat]));
    view.setZoom(zoom);
  });
  await waitFrames(2);
  const heap = readHeap();
  active = {
    destroy() {
      map.setTarget(null);
      map.dispose();
    }
  };
  return { name: "OpenLayers (vector)", initMs, loadMs, ...pan, heap };
}

async function pointsMapLibre(points) {
  const host = blankHost();
  const initStart = performance.now();
  const map = new maplibregl.Map({
    container: host,
    style: mapLibreRasterStyle(),
    center: [CENTER[1], CENTER[0]],
    zoom: ZOOM,
    attributionControl: false,
    fadeDuration: 0
  });
  await new Promise((resolve, reject) => {
    map.once("load", resolve);
    map.once("error", (event) => reject(event.error || new Error("MapLibre load failed")));
  });
  const initMs = performance.now() - initStart;

  const loadStart = performance.now();
  const raw = createMapLibreRawPoints(map, points);
  await waitFrames(4);
  const loadMs = performance.now() - loadStart;

  const pan = await stressCamera((lat, lng, zoom) => map.jumpTo({ center: [lng, lat], zoom }));
  await waitFrames(2);
  const heap = readHeap();
  active = {
    destroy() {
      raw.remove();
      map.remove();
    }
  };
  return { name: "MapLibre (raw GL)", initMs, loadMs, ...pan, heap };
}

/* -------------------- engines: clusters -------------------- */

async function clustersOrihon(points) {
  const host = blankHost();
  const initStart = performance.now();
  const map = createMap(host, { center: CENTER, zoom: ZOOM, controls: false });
  tileLayer(OSM, { attribution: "© OpenStreetMap", maxZoom: 19 }).addTo(map);
  await waitFrames(3);
  const initMs = performance.now() - initStart;

  const manager = objectManager({
    clusterize: true,
    clusterGridSize: 50,
    clusterMinPoints: 2,
    clusterMaxZoom: 14,
    clusterRenderer: "webgl",
    layoutWorker: "auto",
    marker: { interactive: false }
  });

  const loadStart = performance.now();
  manager.add(makeObjects(points));
  await manager.prepareLayout(ZOOM);
  manager.addTo(map);
  await waitFrames(4);
  const loadMs = performance.now() - loadStart;
  const stats = manager.getStats();

  const pan = await stressClusters((lat, lng, zoom) => map.setView([lat, lng], zoom));
  await waitFrames(2);
  const heap = readHeap();
  active = {
    destroy() {
      manager.destroy();
      map.remove();
    }
  };
  return {
    name: `Orihon OM (${stats.renderer})`,
    initMs,
    loadMs,
    ...pan,
    markers: stats.renderedMarkers,
    heap
  };
}

async function clustersLeaflet(points) {
  if (typeof L.markerClusterGroup !== "function") {
    throw new Error("leaflet.markercluster failed to load");
  }
  const host = blankHost();
  const initStart = performance.now();
  const map = L.map(host, {
    center: CENTER,
    zoom: ZOOM,
    zoomControl: false,
    preferCanvas: true,
    fadeAnimation: false,
    zoomAnimation: false
  });
  L.tileLayer(OSM, { attribution: "© OpenStreetMap", maxZoom: 19 }).addTo(map);
  map.invalidateSize();
  await waitFrames(3);
  const initMs = performance.now() - initStart;

  const cluster = L.markerClusterGroup({
    showCoverageOnHover: false,
    animate: false,
    chunkedLoading: true,
    maxClusterRadius: 50
  });
  const loadStart = performance.now();
  const markers = points.map((latlng) => L.circleMarker(latlng, { radius: 4, stroke: false, fillColor: "#2dd4bf", fillOpacity: 0.85 }));
  cluster.addLayers(markers);
  map.addLayer(cluster);
  await waitFrames(4);
  const loadMs = performance.now() - loadStart;

  const pan = await stressClusters((lat, lng, zoom) => map.setView([lat, lng], zoom, { animate: false }));
  await waitFrames(2);
  const heap = readHeap();
  active = { destroy: () => map.remove() };
  return {
    name: "Leaflet.markercluster",
    initMs,
    loadMs,
    ...pan,
    markers: cluster.getLayers().length,
    heap
  };
}

async function clustersOpenLayers(points) {
  const host = blankHost();
  const initStart = performance.now();
  const map = new ol.Map({
    target: host,
    layers: [
      new ol.layer.Tile({
        source: new ol.source.XYZ({ url: OSM, attributions: "© OpenStreetMap" })
      })
    ],
    view: new ol.View({
      center: ol.proj.fromLonLat([CENTER[1], CENTER[0]]),
      zoom: ZOOM
    }),
    controls: []
  });
  await waitFrames(3);
  const initMs = performance.now() - initStart;

  const source = new ol.source.Vector({
    features: points.map(
      ([lat, lng]) => new ol.Feature({ geometry: new ol.geom.Point(ol.proj.fromLonLat([lng, lat])) })
    )
  });
  const clusterSource = new ol.source.Cluster({ distance: 48, source });
  const layer = new ol.layer.Vector({
    source: clusterSource,
    style(feature) {
      const size = feature.get("features").length;
      return new ol.style.Style({
        image: new ol.style.Circle({
          radius: size > 1 ? 12 : 4,
          fill: new ol.style.Fill({ color: size > 1 ? "#0f766e" : "#2dd4bf" })
        }),
        text:
          size > 1
            ? new ol.style.Text({
                text: String(size),
                fill: new ol.style.Fill({ color: "#fff" })
              })
            : undefined
      });
    }
  });

  const loadStart = performance.now();
  map.addLayer(layer);
  await waitFrames(4);
  const loadMs = performance.now() - loadStart;

  const view = map.getView();
  const pan = await stressClusters((lat, lng, zoom) => {
    view.setCenter(ol.proj.fromLonLat([lng, lat]));
    view.setZoom(zoom);
  });
  await waitFrames(2);
  const heap = readHeap();
  active = {
    destroy() {
      map.setTarget(null);
      map.dispose();
    }
  };
  return {
    name: "OpenLayers Cluster",
    initMs,
    loadMs,
    ...pan,
    markers: clusterSource.getFeatures().length,
    heap
  };
}

async function clustersMapLibre(points) {
  const host = blankHost();
  const initStart = performance.now();
  const map = new maplibregl.Map({
    container: host,
    style: mapLibreRasterStyle(),
    center: [CENTER[1], CENTER[0]],
    zoom: ZOOM,
    attributionControl: false,
    fadeDuration: 0
  });
  await new Promise((resolve, reject) => {
    let settled = false;
    map.once("load", () => {
      settled = true;
      resolve();
    });
    map.once("error", (event) => {
      if (settled) return;
      reject(event.error || new Error("MapLibre load failed"));
    });
  });
  const initMs = performance.now() - initStart;

  const features = points.map(([lat, lng]) => ({
    type: "Feature",
    properties: {},
    geometry: { type: "Point", coordinates: [lng, lat] }
  }));

  const loadStart = performance.now();
  map.addSource("clusters", {
    type: "geojson",
    data: { type: "FeatureCollection", features },
    cluster: true,
    clusterMaxZoom: 14,
    clusterRadius: 50
  });
  map.addLayer({
    id: "clusters",
    type: "circle",
    source: "clusters",
    filter: ["has", "point_count"],
    paint: {
      "circle-color": [
        "step",
        ["get", "point_count"],
        "#14b8a6",
        10,
        "#0f766e",
        100,
        "#c2410c"
      ],
      "circle-radius": ["step", ["get", "point_count"], 16, 10, 20, 100, 26]
    }
  });
  map.addLayer({
    id: "cluster-count",
    type: "symbol",
    source: "clusters",
    filter: ["has", "point_count"],
    layout: {
      "text-field": ["to-string", ["get", "point_count"]],
      "text-font": ["system-ui", "Segoe UI", "sans-serif"],
      "text-size": 12,
      "text-allow-overlap": true,
      "text-ignore-placement": true
    },
    paint: {
      "text-color": "#ffffff",
      "text-halo-color": "rgba(0,0,0,0.35)",
      "text-halo-width": 1
    }
  });
  map.addLayer({
    id: "unclustered",
    type: "circle",
    source: "clusters",
    filter: ["!", ["has", "point_count"]],
    paint: {
      "circle-color": "#2dd4bf",
      "circle-radius": 3,
      "circle-opacity": 0.85
    }
  });
  await new Promise((resolve) => {
    if (map.isSourceLoaded("clusters")) {
      resolve();
      return;
    }
    const onSource = (event) => {
      if (event.sourceId !== "clusters" || !map.isSourceLoaded("clusters")) return;
      map.off("sourcedata", onSource);
      resolve();
    };
    map.on("sourcedata", onSource);
  });
  await waitFrames(2);
  const loadMs = performance.now() - loadStart;

  const pan = await stressClusters((lat, lng, zoom) => map.jumpTo({ center: [lng, lat], zoom }));
  await waitFrames(2);
  let markers = NaN;
  try {
    markers = map.querySourceFeatures("clusters").length;
  } catch {
    markers = NaN;
  }
  const heap = readHeap();
  active = { destroy: () => map.remove() };
  return {
    name: "MapLibre cluster",
    initMs,
    loadMs,
    ...pan,
    markers,
    heap
  };
}

/* -------------------- engines: live -------------------- */

async function liveOrihon(points) {
  const host = blankHost();
  const initStart = performance.now();
  const map = createMap(host, { center: CENTER, zoom: ZOOM, controls: false });
  tileLayer(OSM, { attribution: "© OpenStreetMap", maxZoom: 19 }).addTo(map);
  await waitFrames(3);
  const initMs = performance.now() - initStart;
  const layer = webglPointLayer(points, {
    pointSize: 2.5,
    color: "#2dd4bf",
    opacity: 0.78,
    maxDpr: 1.5,
    interactive: false
  }).addTo(map);
  await waitFrames(2);
  const loadMs = 0;
  const scratch = clonePoints(points);
  const live = await measureLive((t) => layer.setData(jitterPoints(points, t, 0.2, scratch)));
  await waitFrames(2);
  const heap = readHeap();
  active = {
    destroy() {
      layer.remove();
      map.remove();
    }
  };
  return { name: "Orihon (WebGL)", initMs, loadMs, ...live, heap };
}

async function liveLeaflet(points) {
  const host = blankHost();
  const initStart = performance.now();
  const map = L.map(host, {
    center: CENTER,
    zoom: ZOOM,
    zoomControl: false,
    preferCanvas: true,
    fadeAnimation: false,
    zoomAnimation: false
  });
  L.tileLayer(OSM, { attribution: "© OpenStreetMap", maxZoom: 19 }).addTo(map);
  map.invalidateSize();
  await waitFrames(3);
  const initMs = performance.now() - initStart;
  const renderer = L.canvas({ padding: 0.5 });
  const markers = points.map((latlng) =>
    L.circleMarker(latlng, {
      radius: 2,
      stroke: false,
      fillColor: "#2dd4bf",
      fillOpacity: 0.78,
      renderer
    }).addTo(map)
  );
  await waitFrames(2);
  const stride = Math.max(1, Math.floor(1 / 0.2));
  const live = await measureLive((t) => {
    const phase = t / 180;
    for (let i = 0; i < markers.length; i += stride) {
      markers[i].setLatLng([
        points[i][0] + Math.sin(phase + i * 0.01) * 0.35,
        points[i][1] + Math.cos(phase + i * 0.013) * 0.45
      ]);
    }
  });
  await waitFrames(2);
  const heap = readHeap();
  active = { destroy: () => map.remove() };
  return { name: "Leaflet (canvas)", initMs, loadMs: 0, ...live, heap };
}

async function liveOpenLayers(points) {
  const host = blankHost();
  const initStart = performance.now();
  const features = points.map(
    ([lat, lng]) => new ol.Feature({ geometry: new ol.geom.Point(ol.proj.fromLonLat([lng, lat])) })
  );
  const source = new ol.source.Vector({ features });
  const map = new ol.Map({
    target: host,
    layers: [
      new ol.layer.Tile({
        source: new ol.source.XYZ({ url: OSM, attributions: "© OpenStreetMap" })
      }),
      new ol.layer.Vector({
        source,
        style: new ol.style.Style({
          image: new ol.style.Circle({
            radius: 2,
            fill: new ol.style.Fill({ color: "rgba(45, 212, 191, 0.78)" })
          })
        }),
        updateWhileAnimating: true,
        updateWhileInteracting: true
      })
    ],
    view: new ol.View({
      center: ol.proj.fromLonLat([CENTER[1], CENTER[0]]),
      zoom: ZOOM
    }),
    controls: []
  });
  await waitFrames(3);
  const initMs = performance.now() - initStart;
  const stride = Math.max(1, Math.floor(1 / 0.2));
  const live = await measureLive((t) => {
    const phase = t / 180;
    for (let i = 0; i < features.length; i += stride) {
      features[i]
        .getGeometry()
        .setCoordinates(
          ol.proj.fromLonLat([
            points[i][1] + Math.cos(phase + i * 0.013) * 0.45,
            points[i][0] + Math.sin(phase + i * 0.01) * 0.35
          ])
        );
    }
  });
  await waitFrames(2);
  const heap = readHeap();
  active = {
    destroy() {
      map.setTarget(null);
      map.dispose();
    }
  };
  return { name: "OpenLayers (vector)", initMs, loadMs: 0, ...live, heap };
}

async function liveMapLibre(points) {
  const host = blankHost();
  const initStart = performance.now();
  const map = new maplibregl.Map({
    container: host,
    style: mapLibreRasterStyle(),
    center: [CENTER[1], CENTER[0]],
    zoom: ZOOM,
    attributionControl: false,
    fadeDuration: 0
  });
  await new Promise((resolve, reject) => {
    map.once("load", resolve);
    map.once("error", (event) => reject(event.error || new Error("MapLibre load failed")));
  });
  const initMs = performance.now() - initStart;
  const raw = createMapLibreRawPoints(map, points);
  await waitFrames(2);
  const scratch = clonePoints(points);
  const live = await measureLive((t) => raw.updatePoints(jitterPoints(points, t, 0.2, scratch)));
  await waitFrames(2);
  const heap = readHeap();
  active = {
    destroy() {
      raw.remove();
      map.remove();
    }
  };
  return { name: "MapLibre (raw GL)", initMs, loadMs: 0, ...live, heap };
}

/* -------------------- engines: pick -------------------- */

async function pickOrihon(points) {
  const host = blankHost();
  const initStart = performance.now();
  const map = createMap(host, { center: CENTER, zoom: ZOOM, controls: false });
  tileLayer(OSM, { attribution: "© OpenStreetMap", maxZoom: 19 }).addTo(map);
  await waitFrames(3);
  const initMs = performance.now() - initStart;

  const loadStart = performance.now();
  webglPointLayer(points, {
    pointSize: 3,
    color: "#2dd4bf",
    interactive: false
  }).addTo(map);
  await waitFrames(3);
  const loadMs = performance.now() - loadStart;

  const project = (ll) => map.latLngToContainerPoint(ll);
  const samples = pickSamplesFromPoints(points, project, PICK_SAMPLES);
  const times = measureProjectScan(points, project, samples);
  await waitFrames(1);
  const heap = readHeap();
  active = { destroy: () => map.remove() };
  return {
    name: "Orihon (project scan)",
    initMs,
    loadMs,
    pickP50: percentile(times, 50),
    pickP95: percentile(times, 95),
    heap
  };
}

async function pickLeaflet(points) {
  const host = blankHost();
  const initStart = performance.now();
  const map = L.map(host, {
    center: CENTER,
    zoom: ZOOM,
    zoomControl: false,
    preferCanvas: true,
    fadeAnimation: false,
    zoomAnimation: false
  });
  L.tileLayer(OSM, { attribution: "© OpenStreetMap", maxZoom: 19 }).addTo(map);
  map.invalidateSize();
  await waitFrames(3);
  const initMs = performance.now() - initStart;

  const loadStart = performance.now();
  const renderer = L.canvas({ padding: 0.5 });
  for (const latlng of points) {
    L.circleMarker(latlng, {
      radius: 3,
      stroke: false,
      fillColor: "#2dd4bf",
      fillOpacity: 0.8,
      renderer
    }).addTo(map);
  }
  await waitFrames(3);
  const loadMs = performance.now() - loadStart;

  const project = (ll) => map.latLngToContainerPoint(ll);
  const samples = pickSamplesFromPoints(points, project, PICK_SAMPLES);
  const times = measureProjectScan(points, project, samples);
  const heap = readHeap();
  active = { destroy: () => map.remove() };
  return {
    name: "Leaflet (project scan)",
    initMs,
    loadMs,
    pickP50: percentile(times, 50),
    pickP95: percentile(times, 95),
    heap
  };
}

async function pickOpenLayers(points) {
  const host = blankHost();
  const initStart = performance.now();
  const source = new ol.source.Vector({ wrapX: false });
  const map = new ol.Map({
    target: host,
    layers: [
      new ol.layer.Tile({
        source: new ol.source.XYZ({ url: OSM, attributions: "© OpenStreetMap" })
      }),
      new ol.layer.Vector({
        source,
        style: new ol.style.Style({
          image: new ol.style.Circle({
            radius: 3,
            fill: new ol.style.Fill({ color: "rgba(45, 212, 191, 0.8)" })
          })
        })
      })
    ],
    view: new ol.View({
      center: ol.proj.fromLonLat([CENTER[1], CENTER[0]]),
      zoom: ZOOM
    }),
    controls: []
  });
  await waitFrames(3);
  const initMs = performance.now() - initStart;

  const loadStart = performance.now();
  source.addFeatures(
    points.map(
      ([lat, lng]) => new ol.Feature({ geometry: new ol.geom.Point(ol.proj.fromLonLat([lng, lat])) })
    )
  );
  await waitFrames(3);
  const loadMs = performance.now() - loadStart;

  const project = ([lat, lng]) => {
    const pixel = map.getPixelFromCoordinate(ol.proj.fromLonLat([lng, lat]));
    return pixel ? { x: pixel[0], y: pixel[1] } : null;
  };
  const samples = pickSamplesFromPoints(points, project, PICK_SAMPLES);
  const times = measureProjectScan(points, project, samples);
  const heap = readHeap();
  active = {
    destroy() {
      map.setTarget(null);
      map.dispose();
    }
  };
  return {
    name: "OpenLayers (project scan)",
    initMs,
    loadMs,
    pickP50: percentile(times, 50),
    pickP95: percentile(times, 95),
    heap
  };
}

async function pickMapLibre(points) {
  const host = blankHost();
  const initStart = performance.now();
  const map = new maplibregl.Map({
    container: host,
    style: mapLibreRasterStyle(),
    center: [CENTER[1], CENTER[0]],
    zoom: ZOOM,
    attributionControl: false,
    fadeDuration: 0
  });
  await new Promise((resolve, reject) => {
    map.once("load", resolve);
    map.once("error", (event) => reject(event.error || new Error("MapLibre load failed")));
  });
  const initMs = performance.now() - initStart;

  const loadStart = performance.now();
  const features = points.map(([lat, lng], id) => ({
    type: "Feature",
    properties: { id },
    geometry: { type: "Point", coordinates: [lng, lat] }
  }));
  map.addSource("pick", { type: "geojson", data: { type: "FeatureCollection", features } });
  map.addLayer({
    id: "pick",
    type: "circle",
    source: "pick",
    paint: { "circle-radius": 4, "circle-color": "#2dd4bf", "circle-opacity": 0.85 }
  });
  await waitFrames(4);
  const loadMs = performance.now() - loadStart;

  const project = ([lat, lng]) => {
    const pt = map.project([lng, lat]);
    return { x: pt.x, y: pt.y };
  };
  const samples = pickSamplesFromPoints(points, project, PICK_SAMPLES);
  const times = measureProjectScan(points, project, samples);
  const heap = readHeap();
  active = { destroy: () => map.remove() };
  return {
    name: "MapLibre (project scan)",
    initMs,
    loadMs,
    pickP50: percentile(times, 50),
    pickP95: percentile(times, 95),
    heap
  };
}

/* -------------------- engines: heatmap -------------------- */

async function heatmapOrihon(points) {
  const host = blankHost();
  const initStart = performance.now();
  const map = createMap(host, { center: CENTER, zoom: HEAT_BENCH.zoom, controls: false });
  tileLayer(OSM, { attribution: "© OpenStreetMap", maxZoom: 19 }).addTo(map);
  await waitFrames(3);
  const initMs = performance.now() - initStart;

  const loadStart = performance.now();
  const layer = webglHeatLayer(points, {
    radius: HEAT_BENCH.radius,
    blur: HEAT_BENCH.blur,
    scaleZoom: HEAT_BENCH.zoom,
    intensity: HEAT_BENCH.intensity,
    opacity: HEAT_BENCH.opacity,
    maxDpr: 1.5,
    gradient: HEAT_GRADIENT
  }).addTo(map);
  await waitFrames(4);
  const loadMs = performance.now() - loadStart;

  const pan = await stressCamera(
    (lat, lng, zoom) => map.setView([lat, lng], zoom),
    STRESS_MS,
    HEAT_BENCH.zoom
  );
  map.setView(CENTER, HEAT_BENCH.zoom);
  await waitFrames(3);
  const stats = layer.getStats();
  active = {
    destroy() {
      try {
        layer.clear();
        map.removeLayer(layer);
      } catch {
        /* ignore */
      }
      map.remove();
    }
  };
  const tag =
    layer.renderer === "webgl"
      ? ` · drawn ${stats.drawn}/${stats.aggregated}`
      : " fallback";
  // heap filled by runOne probe (peak Δ)
  return { name: `Orihon (WebGL heat${tag})`, initMs, loadMs, ...pan, heap: NaN };
}

async function heatmapLeaflet(points) {
  if (typeof L.heatLayer !== "function") {
    throw new Error("leaflet.heat failed to load");
  }
  const host = blankHost();
  const initStart = performance.now();
  const map = L.map(host, {
    center: CENTER,
    zoom: HEAT_BENCH.zoom,
    zoomControl: false,
    fadeAnimation: false,
    zoomAnimation: false
  });
  L.tileLayer(OSM, { attribution: "© OpenStreetMap", maxZoom: 19 }).addTo(map);
  map.invalidateSize();
  await waitFrames(3);
  const initMs = performance.now() - initStart;

  const loadStart = performance.now();
  L.heatLayer(points, {
    radius: HEAT_BENCH.radius,
    blur: HEAT_BENCH.blur,
    maxZoom: HEAT_BENCH.leafletMaxZoom,
    max: 1.0,
    minOpacity: 0.05,
    gradient: HEAT_BENCH.leafletGradient
  }).addTo(map);
  await waitFrames(4);
  const loadMs = performance.now() - loadStart;

  const pan = await stressCamera(
    (lat, lng, zoom) => map.setView([lat, lng], zoom, { animate: false }),
    STRESS_MS,
    HEAT_BENCH.zoom
  );
  map.setView(CENTER, HEAT_BENCH.zoom, { animate: false });
  await waitFrames(3);
  active = {
    destroy() {
      map.eachLayer((layer) => {
        try {
          map.removeLayer(layer);
        } catch {
          /* ignore */
        }
      });
      map.remove();
    }
  };
  return { name: "Leaflet (heat)", initMs, loadMs, ...pan, heap: NaN };
}

async function heatmapOpenLayers(points) {
  const host = blankHost();
  const initStart = performance.now();
  const map = new ol.Map({
    target: host,
    layers: [
      new ol.layer.Tile({
        source: new ol.source.XYZ({ url: OSM, attributions: "© OpenStreetMap" })
      })
    ],
    view: new ol.View({
      center: ol.proj.fromLonLat([CENTER[1], CENTER[0]]),
      zoom: HEAT_BENCH.zoom
    }),
    controls: []
  });
  await waitFrames(3);
  const initMs = performance.now() - initStart;

  const source = new ol.source.Vector({ wrapX: false });
  map.addLayer(
    new ol.layer.Heatmap({
      source,
      // OL final kernel ≈ radius + blur — keep same numbers as Orihon/Leaflet.
      radius: HEAT_BENCH.radius,
      blur: HEAT_BENCH.blur,
      opacity: HEAT_BENCH.opacity,
      weight: "weight",
      gradient: HEAT_BENCH.olGradient
    })
  );

  const loadStart = performance.now();
  source.addFeatures(
    points.map(([lat, lng, weight = 1]) =>
      new ol.Feature({
        geometry: new ol.geom.Point(ol.proj.fromLonLat([lng, lat])),
        weight
      })
    )
  );
  await waitFrames(4);
  const loadMs = performance.now() - loadStart;

  const view = map.getView();
  const pan = await stressCamera((lat, lng, zoom) => {
    view.setCenter(ol.proj.fromLonLat([lng, lat]));
    view.setZoom(zoom);
  }, STRESS_MS, HEAT_BENCH.zoom);
  view.setCenter(ol.proj.fromLonLat([CENTER[1], CENTER[0]]));
  view.setZoom(HEAT_BENCH.zoom);
  await waitFrames(3);
  active = {
    destroy() {
      try {
        source.clear(true);
      } catch {
        /* ignore */
      }
      map.setTarget(null);
      map.dispose();
    }
  };
  return { name: "OpenLayers (heatmap)", initMs, loadMs, ...pan, heap: NaN };
}

async function heatmapMapLibre(points) {
  const host = blankHost();
  const initStart = performance.now();
  const map = new maplibregl.Map({
    container: host,
    style: mapLibreRasterStyle(),
    center: [CENTER[1], CENTER[0]],
    zoom: HEAT_BENCH.zoom,
    attributionControl: false,
    fadeDuration: 0
  });
  await new Promise((resolve, reject) => {
    map.once("load", resolve);
    map.once("error", (event) => reject(event.error || new Error("MapLibre load failed")));
  });
  map.resize();
  const initMs = performance.now() - initStart;

  const loadStart = performance.now();
  // MapLibre keeps a reference to this FeatureCollection — never mutate `features` while live
  // (features.length = 0 wiped the heat off-screen). Empty only in destroy().
  const heatData = {
    type: "FeatureCollection",
    features: points.map(([lat, lng, weight = 1]) => ({
      type: "Feature",
      properties: { weight },
      geometry: { type: "Point", coordinates: [lng, lat] }
    }))
  };
  map.addSource("heat", { type: "geojson", data: heatData });
  map.addLayer({
    id: "heat",
    type: "heatmap",
    source: "heat",
    paint: {
      "heatmap-weight": ["interpolate", ["linear"], ["get", "weight"], 0, 0, 1, 1],
      "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 4, 0.45, 6, 0.7, 10, 1.0],
      "heatmap-radius": [
        "interpolate",
        ["linear"],
        ["zoom"],
        4,
        HEAT_BENCH.radius * 0.85,
        6,
        HEAT_BENCH.radius + HEAT_BENCH.blur * 0.35,
        10,
        HEAT_BENCH.radius + HEAT_BENCH.blur * 0.6
      ],
      "heatmap-opacity": HEAT_BENCH.opacity,
      "heatmap-color": [
        "interpolate",
        ["linear"],
        ["heatmap-density"],
        0,
        "rgba(0,0,255,0)",
        0.15,
        "rgb(0,0,255)",
        0.35,
        "rgb(0,255,255)",
        0.55,
        "rgb(0,255,0)",
        0.75,
        "rgb(255,255,0)",
        0.9,
        "rgb(255,140,0)",
        1,
        "rgb(255,0,0)"
      ]
    }
  });
  await waitFrames(4);
  const loadMs = performance.now() - loadStart;

  const pan = await stressCamera(
    (lat, lng, zoom) => map.jumpTo({ center: [lng, lat], zoom }),
    STRESS_MS,
    HEAT_BENCH.zoom
  );
  map.jumpTo({ center: [CENTER[1], CENTER[0]], zoom: HEAT_BENCH.zoom });
  await waitFrames(3);
  active = {
    destroy() {
      try {
        const src = map.getSource("heat");
        // Release 50k Feature objects before tearing down the GL map.
        if (src && typeof src.setData === "function") {
          src.setData({ type: "FeatureCollection", features: [] });
        }
        if (map.getLayer("heat")) map.removeLayer("heat");
        if (map.getSource("heat")) map.removeSource("heat");
      } catch {
        /* ignore */
      }
      heatData.features = [];
      map.remove();
    }
  };
  return { name: "MapLibre (heatmap)", initMs, loadMs, ...pan, heap: NaN };
}

/* -------------------- engines: isolines (heat → contours) -------------------- */

async function isolinesOrihon(points) {
  const host = blankHost();
  const initStart = performance.now();
  const map = createMap(host, { center: CENTER, zoom: HEAT_ZOOM, controls: false });
  tileLayer(OSM, { attribution: "© OpenStreetMap", maxZoom: 19 }).addTo(map);
  await waitFrames(3);
  const initMs = performance.now() - initStart;

  const loadStart = performance.now();
  const layer = heatIsolineLayer(points, {
    levels: 5,
    radius: 20,
    blur: 18,
    scaleZoom: HEAT_ZOOM,
    gradient: HEAT_GRADIENT,
    colorByLevel: true,
    strokeWidth: 1.6,
    opacity: 0.9,
    labels: true,
    labelFont: "700 14px ui-sans-serif, system-ui, sans-serif",
    labelColor: "#0f172a"
  }).addTo(map);
  await waitFrames(4);
  const loadMs = performance.now() - loadStart;

  // Discrete camera: isolines rebuild on moveend/zoomend (same fairness as clusters).
  const pan = await stressClusters((lat, lng, zoom) => map.setView([lat, lng], zoom), 16, STRESS_MS, HEAT_ZOOM);
  // Settle back to center so labels are readable on the final frame.
  map.setView(CENTER, HEAT_ZOOM);
  layer.rebuild();
  await waitFrames(3);
  const heap = readHeap();
  const stats = layer.getStats();
  active = {
    destroy() {
      layer.remove();
      map.remove();
    }
  };
  return {
    name: `Orihon (heat isolines · ${stats.rings} rings)`,
    initMs,
    loadMs,
    ...pan,
    markers: stats.rings,
    heap
  };
}

function isolinesUnsupported(label, reason) {
  return async () => ({
    name: `${label} — n/a`,
    unsupported: true,
    unsupportedReason: reason,
    initMs: null,
    loadMs: null,
    fps: null,
    p95Ms: null,
    maxMs: null,
    dropPct: null,
    markers: NaN,
    heap: NaN
  });
}

const isolinesLeaflet = isolinesUnsupported(
  "Leaflet",
  "No built-in heat→isolines (only 3rd-party contour plugins / Turf on a prebuilt grid)."
);
const isolinesOpenLayers = isolinesUnsupported(
  "OpenLayers",
  "No built-in heat→isolines (DEM/raster contour examples ≠ point-heat isolines)."
);
const isolinesMapLibre = isolinesUnsupported(
  "MapLibre",
  "No built-in heat→isolines (maplibre-contour is DEM elevation, not heatmap density)."
);

/* -------------------- engines: geojson lines -------------------- */

async function geojsonOrihon(points) {
  const host = blankHost();
  const initStart = performance.now();
  const map = createMap(host, { center: CENTER, zoom: ZOOM, controls: false });
  // DOM basemap + one GL overlay — two WebGL contexts (tiles+lines) regress drop% until shared runtime.
  tileLayer(OSM, { attribution: "© OpenStreetMap", maxZoom: 19 }).addTo(map);
  await waitFrames(3);
  const initMs = performance.now() - initStart;

  const fc = createLineFeatureCollection(points);
  const loadStart = performance.now();
  const layer = geoJSON(fc, {
    renderer: "webgl",
    interactive: false,
    style: { stroke: "#0f766e", strokeWidth: 1.5, strokeOpacity: 0.7 }
  }).addTo(map);
  await waitFrames(4);
  const loadMs = performance.now() - loadStart;

  const pan = await stressCamera((lat, lng, zoom) => map.setView([lat, lng], zoom));
  await waitFrames(2);
  const heap = readHeap();
  const batch = layer.getLayers()[0];
  const backend =
    batch && typeof batch === "object" && "renderer" in batch ? String(batch.renderer) : layer.rendererMode;
  active = {
    destroy() {
      layer.remove();
      map.remove();
    }
  };
  return { name: `Orihon (GeoJSON ${layer.rendererMode}/${backend})`, initMs, loadMs, ...pan, heap };
}

async function geojsonLeaflet(points) {
  const host = blankHost();
  const initStart = performance.now();
  const map = L.map(host, {
    center: CENTER,
    zoom: ZOOM,
    zoomControl: false,
    preferCanvas: true,
    fadeAnimation: false,
    zoomAnimation: false
  });
  L.tileLayer(OSM, { attribution: "© OpenStreetMap", maxZoom: 19 }).addTo(map);
  map.invalidateSize();
  await waitFrames(3);
  const initMs = performance.now() - initStart;

  const fc = createLineFeatureCollection(points);
  const loadStart = performance.now();
  L.geoJSON(fc, {
    style: { color: "#0f766e", weight: 1.5, opacity: 0.7 },
    renderer: L.canvas({ padding: 0.5 })
  }).addTo(map);
  await waitFrames(4);
  const loadMs = performance.now() - loadStart;

  const pan = await stressCamera((lat, lng, zoom) => map.setView([lat, lng], zoom, { animate: false }));
  await waitFrames(2);
  const heap = readHeap();
  active = { destroy: () => map.remove() };
  return { name: "Leaflet (GeoJSON)", initMs, loadMs, ...pan, heap };
}

async function geojsonOpenLayers(points) {
  const host = blankHost();
  const initStart = performance.now();
  const map = new ol.Map({
    target: host,
    layers: [
      new ol.layer.Tile({
        source: new ol.source.XYZ({ url: OSM, attributions: "© OpenStreetMap" })
      })
    ],
    view: new ol.View({
      center: ol.proj.fromLonLat([CENTER[1], CENTER[0]]),
      zoom: ZOOM
    }),
    controls: []
  });
  await waitFrames(3);
  const initMs = performance.now() - initStart;

  const source = new ol.source.Vector({ wrapX: false });
  map.addLayer(
    new ol.layer.Vector({
      source,
      style: new ol.style.Style({
        stroke: new ol.style.Stroke({ color: "rgba(15, 118, 110, 0.7)", width: 1.5 })
      }),
      updateWhileAnimating: true,
      updateWhileInteracting: true
    })
  );

  const fc = createLineFeatureCollection(points);
  const loadStart = performance.now();
  const format = new ol.format.GeoJSON();
  source.addFeatures(
    format.readFeatures(fc, {
      dataProjection: "EPSG:4326",
      featureProjection: "EPSG:3857"
    })
  );
  await waitFrames(4);
  const loadMs = performance.now() - loadStart;

  const view = map.getView();
  const pan = await stressCamera((lat, lng, zoom) => {
    view.setCenter(ol.proj.fromLonLat([lng, lat]));
    view.setZoom(zoom);
  });
  await waitFrames(2);
  const heap = readHeap();
  active = {
    destroy() {
      map.setTarget(null);
      map.dispose();
    }
  };
  return { name: "OpenLayers (GeoJSON)", initMs, loadMs, ...pan, heap };
}

async function geojsonMapLibre(points) {
  const host = blankHost();
  const initStart = performance.now();
  const map = new maplibregl.Map({
    container: host,
    style: mapLibreRasterStyle(),
    center: [CENTER[1], CENTER[0]],
    zoom: ZOOM,
    attributionControl: false,
    fadeDuration: 0
  });
  await new Promise((resolve, reject) => {
    map.once("load", resolve);
    map.once("error", (event) => reject(event.error || new Error("MapLibre load failed")));
  });
  const initMs = performance.now() - initStart;

  const fc = createLineFeatureCollection(points);
  const loadStart = performance.now();
  map.addSource("lines", { type: "geojson", data: fc });
  map.addLayer({
    id: "lines",
    type: "line",
    source: "lines",
    paint: { "line-color": "#0f766e", "line-width": 1.5, "line-opacity": 0.7 }
  });
  await waitFrames(4);
  const loadMs = performance.now() - loadStart;

  const pan = await stressCamera((lat, lng, zoom) => map.jumpTo({ center: [lng, lat], zoom }));
  await waitFrames(2);
  const heap = readHeap();
  active = { destroy: () => map.remove() };
  return { name: "MapLibre (line)", initMs, loadMs, ...pan, heap };
}

/* -------------------- engines: DOM markers -------------------- */

async function markersOrihon(points) {
  const host = blankHost();
  const initStart = performance.now();
  const map = createMap(host, { center: CENTER, zoom: ZOOM, controls: false });
  tileLayer(OSM, { attribution: "© OpenStreetMap", maxZoom: 19 }).addTo(map);
  await waitFrames(3);
  const initMs = performance.now() - initStart;

  const loadStart = performance.now();
  const layer = markerCollection(points, {
    renderer: "dom",
    viewportCull: true,
    marker: { keyboard: false },
    pointSize: 8,
    color: "#0f766e"
  }).addTo(map);
  await waitFrames(4);
  const loadMs = performance.now() - loadStart;

  const pan = await stressCamera((lat, lng, zoom) => map.setView([lat, lng], zoom));
  await waitFrames(2);
  const heap = readHeap();
  active = {
    destroy() {
      layer.remove();
      map.remove();
    }
  };
  return { name: "Orihon (MarkerCollection DOM)", initMs, loadMs, ...pan, heap };
}

async function markersLeaflet(points) {
  const host = blankHost();
  const initStart = performance.now();
  const map = L.map(host, {
    center: CENTER,
    zoom: ZOOM,
    zoomControl: false,
    fadeAnimation: false,
    zoomAnimation: false,
    markerZoomAnimation: false
  });
  L.tileLayer(OSM, { attribution: "© OpenStreetMap", maxZoom: 19 }).addTo(map);
  map.invalidateSize();
  await waitFrames(3);
  const initMs = performance.now() - initStart;

  const icon = L.divIcon({
    className: "bench-dot",
    html: "",
    iconSize: [8, 8],
    iconAnchor: [4, 4]
  });
  const loadStart = performance.now();
  const group = L.layerGroup();
  for (let i = 0; i < points.length; i++) {
    L.marker(points[i], { icon, interactive: false, keyboard: false }).addTo(group);
  }
  group.addTo(map);
  await waitFrames(4);
  const loadMs = performance.now() - loadStart;

  const pan = await stressCamera((lat, lng, zoom) => map.setView([lat, lng], zoom, { animate: false }));
  await waitFrames(2);
  const heap = readHeap();
  active = { destroy: () => map.remove() };
  return { name: "Leaflet (Marker)", initMs, loadMs, ...pan, heap };
}

async function markersOpenLayers(points) {
  const host = blankHost();
  const initStart = performance.now();
  const map = new ol.Map({
    target: host,
    layers: [
      new ol.layer.Tile({
        source: new ol.source.XYZ({ url: OSM, attributions: "© OpenStreetMap" })
      })
    ],
    view: new ol.View({
      center: ol.proj.fromLonLat([CENTER[1], CENTER[0]]),
      zoom: ZOOM
    }),
    controls: []
  });
  await waitFrames(3);
  const initMs = performance.now() - initStart;

  const source = new ol.source.Vector({ wrapX: false });
  map.addLayer(
    new ol.layer.Vector({
      source,
      style: new ol.style.Style({
        image: new ol.style.Circle({
          radius: 4,
          fill: new ol.style.Fill({ color: "#0f766e" })
        })
      }),
      updateWhileAnimating: true,
      updateWhileInteracting: true
    })
  );

  const loadStart = performance.now();
  source.addFeatures(
    points.map(([lat, lng]) => new ol.Feature({ geometry: new ol.geom.Point(ol.proj.fromLonLat([lng, lat])) }))
  );
  await waitFrames(4);
  const loadMs = performance.now() - loadStart;

  const view = map.getView();
  const pan = await stressCamera((lat, lng, zoom) => {
    view.setCenter(ol.proj.fromLonLat([lng, lat]));
    view.setZoom(zoom);
  });
  await waitFrames(2);
  const heap = readHeap();
  active = {
    destroy() {
      map.setTarget(null);
      map.dispose();
    }
  };
  return { name: "OpenLayers (vector pts)", initMs, loadMs, ...pan, heap };
}

async function markersMapLibre(points) {
  const host = blankHost();
  const initStart = performance.now();
  const map = new maplibregl.Map({
    container: host,
    style: mapLibreRasterStyle(),
    center: [CENTER[1], CENTER[0]],
    zoom: ZOOM,
    attributionControl: false,
    fadeDuration: 0
  });
  await new Promise((resolve, reject) => {
    map.once("load", resolve);
    map.once("error", (event) => reject(event.error || new Error("MapLibre load failed")));
  });
  const initMs = performance.now() - initStart;

  // HTML markers stay capped — full DOM at 5k is already heavy; rest use GL circles.
  const DOM_CAP = Math.min(points.length, 500);
  const loadStart = performance.now();
  const htmlMarkers = [];
  for (let i = 0; i < DOM_CAP; i++) {
    const el = document.createElement("div");
    el.className = "bench-dot";
    htmlMarkers.push(new maplibregl.Marker({ element: el }).setLngLat([points[i][1], points[i][0]]).addTo(map));
  }
  if (points.length > DOM_CAP) {
    const features = points.slice(DOM_CAP).map(([lat, lng], id) => ({
      type: "Feature",
      properties: { id },
      geometry: { type: "Point", coordinates: [lng, lat] }
    }));
    map.addSource("rest", { type: "geojson", data: { type: "FeatureCollection", features } });
    map.addLayer({
      id: "rest",
      type: "circle",
      source: "rest",
      paint: { "circle-radius": 3, "circle-color": "#0f766e", "circle-opacity": 0.8 }
    });
  }
  await waitFrames(4);
  const loadMs = performance.now() - loadStart;

  const pan = await stressCamera((lat, lng, zoom) => map.jumpTo({ center: [lng, lat], zoom }));
  await waitFrames(2);
  const heap = readHeap();
  active = {
    destroy() {
      for (const m of htmlMarkers) m.remove();
      map.remove();
    }
  };
  return { name: `MapLibre (HTML≤${DOM_CAP}+circle)`, initMs, loadMs, ...pan, heap };
}

/* -------------------- engines: filter + clusters -------------------- */

async function filterOrihon(points) {
  const host = blankHost();
  const initStart = performance.now();
  const map = createMap(host, { center: CENTER, zoom: ZOOM, controls: false });
  tileLayer(OSM, { attribution: "© OpenStreetMap", maxZoom: 19 }).addTo(map);
  await waitFrames(3);
  const initMs = performance.now() - initStart;

  const manager = objectManager({
    clusterize: true,
    clusterGridSize: 50,
    clusterMinPoints: 2,
    clusterMaxZoom: 14,
    clusterRenderer: "webgl",
    layoutWorker: "auto",
    marker: { interactive: false }
  });

  const loadStart = performance.now();
  manager.add(makeObjects(points));
  await manager.prepareLayout(ZOOM);
  manager.addTo(map);
  await waitFrames(4);
  const loadMs = performance.now() - loadStart;
  const stats = manager.getStats();

  const pan = await stressFilterCamera(
    (lat, lng, zoom) => map.setView([lat, lng], zoom),
    (activeOnly) => {
      manager.setFilter(activeOnly ? (obj) => obj.properties?.active !== false : null);
    }
  );
  await waitFrames(2);
  const heap = readHeap();
  active = {
    destroy() {
      manager.destroy();
      map.remove();
    }
  };
  return {
    name: `Orihon OM filter (${stats.renderer})`,
    initMs,
    loadMs,
    ...pan,
    markers: manager.getStats().renderedMarkers,
    heap
  };
}

async function filterLeaflet(points) {
  if (typeof L.markerClusterGroup !== "function") {
    throw new Error("leaflet.markercluster failed to load");
  }
  const host = blankHost();
  const initStart = performance.now();
  const map = L.map(host, {
    center: CENTER,
    zoom: ZOOM,
    zoomControl: false,
    preferCanvas: true,
    fadeAnimation: false,
    zoomAnimation: false
  });
  L.tileLayer(OSM, { attribution: "© OpenStreetMap", maxZoom: 19 }).addTo(map);
  map.invalidateSize();
  await waitFrames(3);
  const initMs = performance.now() - initStart;

  const all = points.map((latlng, index) => {
    const m = L.circleMarker(latlng, {
      radius: 4,
      stroke: false,
      fillColor: "#2dd4bf",
      fillOpacity: 0.85
    });
    m._benchActive = index % 3 !== 0;
    return m;
  });
  const cluster = L.markerClusterGroup({
    showCoverageOnHover: false,
    animate: false,
    chunkedLoading: true,
    maxClusterRadius: 50
  });

  const loadStart = performance.now();
  cluster.addLayers(all);
  map.addLayer(cluster);
  await waitFrames(4);
  const loadMs = performance.now() - loadStart;

  const pan = await stressFilterCamera(
    (lat, lng, zoom) => map.setView([lat, lng], zoom, { animate: false }),
    (activeOnly) => {
      cluster.clearLayers();
      cluster.addLayers(activeOnly ? all.filter((m) => m._benchActive) : all);
    }
  );
  await waitFrames(2);
  const heap = readHeap();
  active = { destroy: () => map.remove() };
  return {
    name: "Leaflet.markercluster filter",
    initMs,
    loadMs,
    ...pan,
    markers: cluster.getLayers().length,
    heap
  };
}

async function filterOpenLayers(points) {
  const host = blankHost();
  const initStart = performance.now();
  const map = new ol.Map({
    target: host,
    layers: [
      new ol.layer.Tile({
        source: new ol.source.XYZ({ url: OSM, attributions: "© OpenStreetMap" })
      })
    ],
    view: new ol.View({
      center: ol.proj.fromLonLat([CENTER[1], CENTER[0]]),
      zoom: ZOOM
    }),
    controls: []
  });
  await waitFrames(3);
  const initMs = performance.now() - initStart;

  const features = points.map(([lat, lng], index) => {
    const feature = new ol.Feature({
      geometry: new ol.geom.Point(ol.proj.fromLonLat([lng, lat])),
      active: index % 3 !== 0
    });
    return feature;
  });
  const source = new ol.source.Vector({ features, wrapX: false });
  const clusterSource = new ol.source.Cluster({ distance: 50, source, minDistance: 20 });
  map.addLayer(
    new ol.layer.Vector({
      source: clusterSource,
      style(feature) {
        const size = feature.get("features")?.length || 1;
        return new ol.style.Style({
          image: new ol.style.Circle({
            radius: size > 1 ? 12 : 4,
            fill: new ol.style.Fill({ color: size > 1 ? "#1d4ed8" : "#2dd4bf" })
          }),
          text:
            size > 1
              ? new ol.style.Text({
                  text: String(size),
                  fill: new ol.style.Fill({ color: "#fff" })
                })
              : undefined
        });
      }
    })
  );

  const loadStart = performance.now();
  await waitFrames(4);
  const loadMs = performance.now() - loadStart;

  const view = map.getView();
  const pan = await stressFilterCamera(
    (lat, lng, zoom) => {
      view.setCenter(ol.proj.fromLonLat([lng, lat]));
      view.setZoom(zoom);
    },
    (activeOnly) => {
      source.clear(true);
      source.addFeatures(activeOnly ? features.filter((f) => f.get("active")) : features);
    }
  );
  await waitFrames(2);
  const heap = readHeap();
  active = {
    destroy() {
      map.setTarget(null);
      map.dispose();
    }
  };
  return {
    name: "OpenLayers Cluster filter",
    initMs,
    loadMs,
    ...pan,
    markers: clusterSource.getFeatures().length,
    heap
  };
}

async function filterMapLibre(points) {
  const host = blankHost();
  const initStart = performance.now();
  const map = new maplibregl.Map({
    container: host,
    style: mapLibreRasterStyle(),
    center: [CENTER[1], CENTER[0]],
    zoom: ZOOM,
    attributionControl: false,
    fadeDuration: 0
  });
  await new Promise((resolve, reject) => {
    map.once("load", resolve);
    map.once("error", (event) => reject(event.error || new Error("MapLibre load failed")));
  });
  const initMs = performance.now() - initStart;

  const features = points.map(([lat, lng], id) => ({
    type: "Feature",
    properties: { id, active: id % 3 !== 0 ? 1 : 0 },
    geometry: { type: "Point", coordinates: [lng, lat] }
  }));

  const loadStart = performance.now();
  map.addSource("flt", {
    type: "geojson",
    data: { type: "FeatureCollection", features },
    cluster: true,
    clusterRadius: 50,
    clusterMaxZoom: 14
  });
  map.addLayer({
    id: "clusters",
    type: "circle",
    source: "flt",
    filter: ["has", "point_count"],
    paint: {
      "circle-color": "#1d4ed8",
      "circle-radius": ["step", ["get", "point_count"], 14, 100, 18, 750, 24]
    }
  });
  map.addLayer({
    id: "cluster-count",
    type: "symbol",
    source: "flt",
    filter: ["has", "point_count"],
    layout: {
      "text-field": ["get", "point_count_abbreviated"],
      "text-size": 12
    },
    paint: { "text-color": "#ffffff" }
  });
  map.addLayer({
    id: "unclustered",
    type: "circle",
    source: "flt",
    filter: ["!", ["has", "point_count"]],
    paint: { "circle-color": "#2dd4bf", "circle-radius": 4 }
  });
  await waitFrames(4);
  const loadMs = performance.now() - loadStart;

  const pan = await stressFilterCamera(
    (lat, lng, zoom) => map.jumpTo({ center: [lng, lat], zoom }),
    (activeOnly) => {
      map.setFilter("unclustered", activeOnly
        ? ["all", ["!", ["has", "point_count"]], ["==", ["get", "active"], 1]]
        : ["!", ["has", "point_count"]]);
      // Rebuild clustered subset via data swap (cluster filter is limited on point_count layers).
      map.getSource("flt").setData({
        type: "FeatureCollection",
        features: activeOnly ? features.filter((f) => f.properties.active === 1) : features
      });
    }
  );
  await waitFrames(2);
  const heap = readHeap();
  let markers = 0;
  try {
    markers = map.querySourceFeatures("flt").length;
  } catch {
    markers = NaN;
  }
  active = { destroy: () => map.remove() };
  return {
    name: "MapLibre cluster filter",
    initMs,
    loadMs,
    ...pan,
    markers,
    heap
  };
}

/* -------------------- engines: basemap only -------------------- */

async function basemapOrihon(_points) {
  const host = blankHost();
  const initStart = performance.now();
  const map = createMap(host, { center: CENTER, zoom: ZOOM, controls: false });
  const layer = webglTileLayer(OSM, { attribution: "© OpenStreetMap", maxZoom: 19 }).addTo(map);
  await waitFrames(4);
  const initMs = performance.now() - initStart;
  const loadMs = 0;
  const pan = await stressCamera((lat, lng, zoom) => map.setView([lat, lng], zoom));
  await waitFrames(2);
  const heap = readHeap();
  active = { destroy: () => map.remove() };
  return { name: `Orihon (webgl tiles · ${layer.renderer})`, initMs, loadMs, ...pan, heap };
}

async function basemapLeaflet(_points) {
  const host = blankHost();
  const initStart = performance.now();
  const map = L.map(host, {
    center: CENTER,
    zoom: ZOOM,
    zoomControl: false,
    fadeAnimation: false,
    zoomAnimation: false
  });
  L.tileLayer(OSM, { attribution: "© OpenStreetMap", maxZoom: 19 }).addTo(map);
  map.invalidateSize();
  await waitFrames(4);
  const initMs = performance.now() - initStart;
  const loadMs = 0;
  const pan = await stressCamera((lat, lng, zoom) => map.setView([lat, lng], zoom, { animate: false }));
  await waitFrames(2);
  const heap = readHeap();
  active = { destroy: () => map.remove() };
  return { name: "Leaflet (tiles)", initMs, loadMs, ...pan, heap };
}

async function basemapOpenLayers(_points) {
  const host = blankHost();
  const initStart = performance.now();
  const map = new ol.Map({
    target: host,
    layers: [
      new ol.layer.Tile({
        source: new ol.source.XYZ({ url: OSM, attributions: "© OpenStreetMap" })
      })
    ],
    view: new ol.View({
      center: ol.proj.fromLonLat([CENTER[1], CENTER[0]]),
      zoom: ZOOM
    }),
    controls: []
  });
  await waitFrames(4);
  const initMs = performance.now() - initStart;
  const loadMs = 0;
  const view = map.getView();
  const pan = await stressCamera((lat, lng, zoom) => {
    view.setCenter(ol.proj.fromLonLat([lng, lat]));
    view.setZoom(zoom);
  });
  await waitFrames(2);
  const heap = readHeap();
  active = {
    destroy() {
      map.setTarget(null);
      map.dispose();
    }
  };
  return { name: "OpenLayers (tiles)", initMs, loadMs, ...pan, heap };
}

async function basemapMapLibre(_points) {
  const host = blankHost();
  const initStart = performance.now();
  const map = new maplibregl.Map({
    container: host,
    style: mapLibreRasterStyle(),
    center: [CENTER[1], CENTER[0]],
    zoom: ZOOM,
    attributionControl: false,
    fadeDuration: 0
  });
  await new Promise((resolve, reject) => {
    map.once("load", resolve);
    map.once("error", (event) => reject(event.error || new Error("MapLibre load failed")));
  });
  await waitFrames(2);
  const initMs = performance.now() - initStart;
  const loadMs = 0;
  const pan = await stressCamera((lat, lng, zoom) => map.jumpTo({ center: [lng, lat], zoom }));
  await waitFrames(2);
  const heap = readHeap();
  active = { destroy: () => map.remove() };
  return { name: "MapLibre (tiles)", initMs, loadMs, ...pan, heap };
}

/* -------------------- engines: chart popup open/close -------------------- */

async function popupOrihon(points) {
  const host = blankHost();
  const initStart = performance.now();
  const map = createMap(host, { center: CENTER, zoom: 11, controls: false });
  tileLayer(OSM, { attribution: "© OpenStreetMap", maxZoom: 19 }).addTo(map);
  await waitFrames(3);
  const initMs = performance.now() - initStart;

  const loadStart = performance.now();
  const layers = points.map(([lat, lng], index) => {
    const series = benchChartSeries(index + 1);
    return marker([lat, lng], { title: `P${index}`, keyboard: false })
      .bindPopup(
        () => ({
          mount(container) {
            return mountBenchChart(container, series, `Orihon #${index}`);
          }
        }),
        {
          autoPan: false,
          closeOnClick: false,
          closeButton: false,
          autoClose: true,
          className: "bench-analytics-popup"
        }
      )
      .addTo(map);
  });
  await waitFrames(2);
  const loadMs = performance.now() - loadStart;

  const opens = await stressPopupSwitch(
    points,
    (index) => layers[index].openPopup(),
    (lat, lng, zoom) => map.setView([lat, lng], zoom)
  );
  map.setView(CENTER, 11);
  await waitFrames(2);
  const heap = readHeap();
  active = {
    destroy() {
      for (const layer of layers) {
        try {
          layer.closePopup();
          layer.remove();
        } catch {
          /* ignore */
        }
      }
      map.remove();
    }
  };
  return { name: `Orihon (mountable ×${layers.length} · ${opens.hops} hops)`, initMs, loadMs, ...opens, heap };
}

async function popupLeaflet(points) {
  const host = blankHost();
  const initStart = performance.now();
  const map = L.map(host, {
    center: CENTER,
    zoom: 11,
    zoomControl: false,
    fadeAnimation: false,
    zoomAnimation: false
  });
  L.tileLayer(OSM, { attribution: "© OpenStreetMap", maxZoom: 19 }).addTo(map);
  map.invalidateSize();
  await waitFrames(3);
  const initMs = performance.now() - initStart;

  const icon = L.divIcon({
    className: "bench-dot",
    html: "",
    iconSize: [8, 8],
    iconAnchor: [4, 4]
  });
  const loadStart = performance.now();
  const layers = points.map(([lat, lng], index) => {
    const series = benchChartSeries(index + 1);
    return L.marker([lat, lng], { icon, keyboard: false })
      .bindPopup(
        () => {
          const wrap = document.createElement("div");
          mountBenchChart(wrap, series, `Leaflet #${index}`);
          return wrap;
        },
        {
          autoPan: false,
          closeButton: false,
          closeOnClick: false,
          className: "bench-analytics-popup"
        }
      )
      .addTo(map);
  });
  await waitFrames(2);
  const loadMs = performance.now() - loadStart;

  const opens = await stressPopupSwitch(
    points,
    (index) => layers[index].openPopup(),
    (lat, lng, zoom) => map.setView([lat, lng], zoom, { animate: false })
  );
  map.setView(CENTER, 11, { animate: false });
  await waitFrames(2);
  const heap = readHeap();
  active = { destroy: () => map.remove() };
  return { name: `Leaflet (DOM chart ×${layers.length} · ${opens.hops} hops)`, initMs, loadMs, ...opens, heap };
}

async function popupOpenLayers(points) {
  const host = blankHost();
  const initStart = performance.now();
  const map = new ol.Map({
    target: host,
    layers: [
      new ol.layer.Tile({
        source: new ol.source.XYZ({ url: OSM, attributions: "© OpenStreetMap" })
      })
    ],
    view: new ol.View({
      center: ol.proj.fromLonLat([CENTER[1], CENTER[0]]),
      zoom: 11
    }),
    controls: []
  });
  await waitFrames(3);
  const initMs = performance.now() - initStart;

  const loadStart = performance.now();
  const source = new ol.source.Vector({ wrapX: false });
  const seriesByIndex = points.map((_, index) => benchChartSeries(index + 1));
  source.addFeatures(
    points.map(([lat, lng], index) => {
      const feature = new ol.Feature({
        geometry: new ol.geom.Point(ol.proj.fromLonLat([lng, lat]))
      });
      feature.set("index", index);
      return feature;
    })
  );
  map.addLayer(
    new ol.layer.Vector({
      source,
      style: new ol.style.Style({
        image: new ol.style.Circle({
          radius: 5,
          fill: new ol.style.Fill({ color: "#2dd4bf" }),
          stroke: new ol.style.Stroke({ color: "#0f766e", width: 1 })
        })
      })
    })
  );
  const element = document.createElement("div");
  element.className = "bench-ol-popup";
  const overlay = new ol.Overlay({
    element,
    positioning: "bottom-center",
    offset: [0, -10],
    stopEvent: false
  });
  map.addOverlay(overlay);
  await waitFrames(2);
  const loadMs = performance.now() - loadStart;

  const view = map.getView();
  const opens = await stressPopupSwitch(
    points,
    (index) => {
      const [lat, lng] = points[index];
      element.replaceChildren();
      mountBenchChart(element, seriesByIndex[index], `OpenLayers #${index}`);
      overlay.setPosition(ol.proj.fromLonLat([lng, lat]));
    },
    (lat, lng, zoom) => {
      view.setCenter(ol.proj.fromLonLat([lng, lat]));
      view.setZoom(zoom);
    }
  );
  view.setCenter(ol.proj.fromLonLat([CENTER[1], CENTER[0]]));
  view.setZoom(11);
  await waitFrames(2);
  const heap = readHeap();
  active = {
    destroy() {
      map.setTarget(null);
      map.dispose();
    }
  };
  return { name: `OpenLayers (overlay ×${points.length} · ${opens.hops} hops)`, initMs, loadMs, ...opens, heap };
}

async function popupMapLibre(points) {
  const host = blankHost();
  const initStart = performance.now();
  const map = new maplibregl.Map({
    container: host,
    style: mapLibreRasterStyle(),
    center: [CENTER[1], CENTER[0]],
    zoom: 11,
    attributionControl: false,
    fadeDuration: 0
  });
  await new Promise((resolve, reject) => {
    map.once("load", resolve);
    map.once("error", (event) => reject(event.error || new Error("MapLibre load failed")));
  });
  map.resize();
  const initMs = performance.now() - initStart;

  const loadStart = performance.now();
  const seriesByIndex = points.map((_, index) => benchChartSeries(index + 1));
  const markers = points.map(([lat, lng]) => {
    const el = document.createElement("div");
    el.className = "bench-ml-marker";
    return new maplibregl.Marker({ element: el }).setLngLat([lng, lat]).addTo(map);
  });
  let popup = null;
  await waitFrames(2);
  const loadMs = performance.now() - loadStart;

  const opens = await stressPopupSwitch(
    points,
    (index) => {
      const [lat, lng] = points[index];
      const content = document.createElement("div");
      mountBenchChart(content, seriesByIndex[index], `MapLibre #${index}`);
      popup?.remove();
      popup = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
        offset: 12,
        className: "bench-analytics-popup"
      })
        .setLngLat([lng, lat])
        .setDOMContent(content)
        .addTo(map);
    },
    (lat, lng, zoom) => map.jumpTo({ center: [lng, lat], zoom })
  );
  map.jumpTo({ center: [CENTER[1], CENTER[0]], zoom: 11 });
  await waitFrames(2);
  const heap = readHeap();
  active = {
    destroy() {
      popup?.remove();
      for (const item of markers) item.remove();
      map.remove();
    }
  };
  return { name: `MapLibre (Popup ×${points.length} · ${opens.hops} hops)`, initMs, loadMs, ...opens, heap };
}

const ENGINE_RUNNERS = {
  points: {
    orihon: pointsOrihon,
    leaflet: pointsLeaflet,
    ol: pointsOpenLayers,
    maplibre: pointsMapLibre
  },
  clusters: {
    orihon: clustersOrihon,
    leaflet: clustersLeaflet,
    ol: clustersOpenLayers,
    maplibre: clustersMapLibre
  },
  live: {
    orihon: liveOrihon,
    leaflet: liveLeaflet,
    ol: liveOpenLayers,
    maplibre: liveMapLibre
  },
  pick: {
    orihon: pickOrihon,
    leaflet: pickLeaflet,
    ol: pickOpenLayers,
    maplibre: pickMapLibre
  },
  heatmap: {
    orihon: heatmapOrihon,
    leaflet: heatmapLeaflet,
    ol: heatmapOpenLayers,
    maplibre: heatmapMapLibre
  },
  isolines: {
    orihon: isolinesOrihon,
    leaflet: isolinesLeaflet,
    ol: isolinesOpenLayers,
    maplibre: isolinesMapLibre
  },
  geojson: {
    orihon: geojsonOrihon,
    leaflet: geojsonLeaflet,
    ol: geojsonOpenLayers,
    maplibre: geojsonMapLibre
  },
  markers: {
    orihon: markersOrihon,
    leaflet: markersLeaflet,
    ol: markersOpenLayers,
    maplibre: markersMapLibre
  },
  filter: {
    orihon: filterOrihon,
    leaflet: filterLeaflet,
    ol: filterOpenLayers,
    maplibre: filterMapLibre
  },
  popup: {
    orihon: popupOrihon,
    leaflet: popupLeaflet,
    ol: popupOpenLayers,
    maplibre: popupMapLibre
  },
  basemap: {
    orihon: basemapOrihon,
    leaflet: basemapLeaflet,
    ol: basemapOpenLayers,
    maplibre: basemapMapLibre
  }
};

function syncScenarioUi() {
  const scenario = els.scenario.value;
  els.methodNote.textContent = SCENARIO_NOTES[scenario] || "";
  if (els.countLabel) {
    els.countLabel.textContent =
      scenario === "popup" || scenario === "markers" ? "Markers" : "Points";
  }
  const cols = COLUMNS[scenario] || COLUMNS.points;
  els.resultsHead.innerHTML = `<tr>${cols.map((col) => `<th>${col}</th>`).join("")}</tr>`;
  if (!els.results.querySelector("tr:not(.empty)")) {
    els.results.innerHTML = `<tr class="empty"><td colspan="${cols.length}">No runs yet</td></tr>`;
  }
}

function cellFor(scenario, row, key) {
  if (row.unsupported && key !== "name") {
    return key === "markers" && scenario === "isolines" ? "n/a" : "n/a";
  }
  if (row.running && (row[key] == null || (key === "heap" && !Number.isFinite(row.heap)))) return "…";
  switch (key) {
    case "name":
      return row.unsupported && row.unsupportedReason
        ? `${row.name} <span class="muted" title="${escapeAttr(row.unsupportedReason)}">ⓘ</span>`
        : row.name;
    case "initMs":
      return formatMs(row.initMs);
    case "loadMs":
      return formatMs(row.loadMs);
    case "fps":
      return formatFps(row.fps);
    case "p95Ms":
      return formatMs(row.p95Ms);
    case "maxMs":
      return formatMs(row.maxMs);
    case "dropPct":
      return formatPct(row.dropPct);
    case "pickP50":
      return formatMs(row.pickP50);
    case "pickP95":
      return formatMs(row.pickP95);
    case "markers":
      return Number.isFinite(row.markers) ? String(Math.round(row.markers)) : "—";
    case "heap":
      return formatHeap(row.heap);
    default:
      return "—";
  }
}

function escapeAttr(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function rowKeys(scenario) {
  if (scenario === "clusters" || scenario === "filter") {
    return ["name", "initMs", "loadMs", "fps", "p95Ms", "dropPct", "markers", "heap"];
  }
  if (scenario === "isolines") {
    return ["name", "initMs", "loadMs", "fps", "p95Ms", "maxMs", "dropPct", "markers", "heap"];
  }
  if (scenario === "pick" || scenario === "popup") {
    return ["name", "initMs", "loadMs", "pickP50", "pickP95", "heap"];
  }
  return ["name", "initMs", "loadMs", "fps", "p95Ms", "maxMs", "dropPct", "heap"];
}

function renderResults(scenario, rows) {
  const keys = rowKeys(scenario);
  if (!rows.length) {
    els.results.innerHTML = `<tr class="empty"><td colspan="${keys.length}">No runs yet</td></tr>`;
    return;
  }

  const bestLoad = Math.min(...rows.map((row) => row.loadMs).filter(Number.isFinite));
  const bestP95 = Math.min(...rows.map((row) => row.p95Ms ?? row.pickP95).filter(Number.isFinite));
  const bestHeap = Math.min(...rows.map((row) => row.heap).filter(Number.isFinite));

  els.results.replaceChildren(
    ...rows.map((row) => {
      const tr = document.createElement("tr");
      if (row.running) tr.classList.add("is-running");
      const score = row.p95Ms ?? row.pickP95;
      const isBest =
        !row.running &&
        ((Number.isFinite(row.loadMs) && row.loadMs === bestLoad) ||
          (Number.isFinite(score) && score === bestP95) ||
          (Number.isFinite(row.heap) && row.heap === bestHeap));
      if (isBest) tr.classList.add("is-best");
      tr.innerHTML = keys.map((key) => `<td>${cellFor(scenario, row, key)}</td>`).join("");
      return tr;
    })
  );
}

function refreshBundleSizes() {
  const patterns = [
    { label: "Orihon bundle", match: /\/dist\/(index|orihon)\./ },
    { label: "Leaflet", match: /leaflet@[^/]+\/dist\/leaflet\.js/ },
    { label: "Leaflet.markercluster", match: /leaflet\.markercluster/ },
    { label: "Leaflet.heat", match: /leaflet\.heat|leaflet-heat/ },
    { label: "OpenLayers", match: /\/ol(@|\/).*\/ol\.js|\/dist\/ol\.js/ },
    { label: "MapLibre GL", match: /maplibre-gl/ }
  ];
  const resources = performance.getEntriesByType("resource");
  els.sizeList.replaceChildren(
    ...patterns.map((pattern) => {
      const entry = resources.find((item) => pattern.match.test(item.name));
      const li = document.createElement("li");
      const size = entry?.encodedBodySize || entry?.transferSize || NaN;
      li.innerHTML = `<span>${pattern.label}</span><strong>${formatBytes(size)}</strong>`;
      return li;
    })
  );
}

function applyPreset(name) {
  const preset = PRESETS[name];
  if (!preset) return;
  els.scenario.value = preset.scenario;
  els.count.value = preset.count;
  els.runs.value = preset.runs;
  syncScenarioUi();
}

async function runOne(engineId, runner, points) {
  // Tear down previous engine, then wait for the tab heap to reclaim before measuring.
  await clearStage({ settleMs: 200 });
  await reclaimHeap();
  // Always clone: engines must not mutate the shared master dataset.
  const result = await runner(clonePoints(points));
  // Absolute tab JS heap with this engine's map still live (after GC settled from the prior one).
  result.heap = readHeap();
  return result;
}

async function runBenchmark() {
  if (busy) return;
  busy = true;
  els.run.disabled = true;
  els.exportBtn.disabled = true;

  const scenario = els.scenario.value;
  const count = Number(els.count.value);
  const runCount = Number(els.runs.value) || 1;
  const runners = ENGINE_RUNNERS[scenario];
  const selected = ["orihon", "leaflet", "ol", "maplibre"].filter((id) => els.checks[id]?.checked);

  if (!selected.length) {
    setHud("Idle", "Select at least one engine.");
    busy = false;
    els.run.disabled = false;
    return;
  }

  if (scenario === "clusters" && count > 100000) {
    setHud("Warning", "Clusters above 100k may freeze Leaflet — consider 50k.");
  }
  if (scenario === "geojson" && count > 25000) {
    setHud("Warning", "GeoJSON lines above 25k can hitch — prefer 5k preset.");
  }

  let pointCount = count;
  if (scenario === "markers" && pointCount > MARKERS_MAX) {
    pointCount = MARKERS_MAX;
    setHud(
      "Markers cap",
      `DOM markers capped at ${MARKERS_MAX.toLocaleString("en-US")} — use Points / markerCollection(auto) for 50k+.`
    );
    await sleep(600);
  }
  if (scenario === "popup" && pointCount > POPUP_MARKERS_MAX) {
    pointCount = POPUP_MARKERS_MAX;
    setHud(
      "Popup cap",
      `Markers capped at ${POPUP_MARKERS_MAX.toLocaleString("en-US")} (same as DOM markers) — set via Points/Markers.`
    );
    await sleep(400);
  }

  setHud("Preparing", scenario === "basemap"
    ? "Basemap-only run (no overlay points)…"
    : scenario === "popup"
      ? `Building ${pointCount.toLocaleString("en-US")} chart-popup markers…`
      : `Building ${pointCount.toLocaleString("en-US")} shared points…`);
  await sleep(20);
  const points =
    scenario === "basemap"
      ? []
      : scenario === "popup"
        ? createPopupPoints(pointCount)
        : scenario === "heatmap" || scenario === "isolines"
          ? createHeatPoints(pointCount)
          : createPoints(pointCount);
  const rows = [];
  renderResults(scenario, rows);

  for (const engineId of selected) {
    const runner = runners[engineId];
    const placeholder = {
      name: engineId,
      initMs: null,
      loadMs: null,
      fps: null,
      p95Ms: null,
      maxMs: null,
      dropPct: null,
      pickP50: null,
      pickP95: null,
      markers: NaN,
      heap: NaN,
      running: true
    };
    rows.push(placeholder);
    renderResults(scenario, rows);

    const attempts = [];
    try {
      for (let run = 1; run <= runCount; run++) {
        setHud(engineId, `Run ${run}/${runCount} · ${scenario} · ${pointCount.toLocaleString("en-US")} pts`);
        const result = await runOne(engineId, runner, points);
        attempts.push(result);
        Object.assign(placeholder, result, {
          name: runCount > 1 ? `${result.name} (run ${run})` : result.name,
          running: true
        });
        renderResults(scenario, rows);
        if (result.unsupported) break;
        await sleep(120);
      }
      const finalRow = attempts[0]?.unsupported
        ? attempts[0]
        : runCount > 1
          ? medianRow(attempts)
          : attempts[0];
      if (runCount > 1 && !finalRow.unsupported) finalRow.name = `${attempts[0].name} · median×${runCount}`;
      Object.assign(placeholder, finalRow, { running: false });
      setHud(
        finalRow.name,
        finalRow.unsupported
          ? finalRow.unsupportedReason || "Not supported in core API"
          : scenario === "pick" || scenario === "popup"
            ? `Open p50 ${formatMs(finalRow.pickP50)} · p95 ${formatMs(finalRow.pickP95)}`
            : `load ${formatMs(finalRow.loadMs)} · ${formatFps(finalRow.fps)} FPS · p95 ${formatMs(finalRow.p95Ms)}`
      );
    } catch (error) {
      Object.assign(placeholder, {
        running: false,
        name: `${engineId} ✕`,
        initMs: NaN,
        loadMs: NaN,
        fps: NaN,
        p95Ms: NaN,
        maxMs: NaN,
        dropPct: NaN,
        pickP50: NaN,
        pickP95: NaN,
        heap: NaN
      });
      setHud(engineId, error?.message || String(error));
      console.error(engineId, error);
    }
    renderResults(scenario, rows);
  }

  await clearStage();
  lastExport = {
    when: new Date().toISOString(),
    scenario,
    count: pointCount,
    runs: runCount,
    userAgent: navigator.userAgent,
    results: rows
  };
  els.exportBtn.disabled = false;
  setHud("Complete", `Compared ${rows.length} engines · ${scenario} · ${pointCount.toLocaleString("en-US")} points.`);
  busy = false;
  els.run.disabled = false;
  refreshBundleSizes();
}

els.run.addEventListener("click", () => {
  void runBenchmark();
});

els.exportBtn.addEventListener("click", () => {
  if (!lastExport) return;
  const blob = new Blob([JSON.stringify(lastExport, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `orihon-bench-${lastExport.scenario}-${lastExport.count}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
});

els.scenario.addEventListener("change", () => {
  els.preset.value = "";
  const scenario = els.scenario.value;
  if (
    (scenario === "popup" || scenario === "markers") &&
    Number(els.count.value) > MARKERS_MAX
  ) {
    els.count.value = scenario === "popup" ? "100" : "5000";
  }
  syncScenarioUi();
});

els.preset.addEventListener("change", () => {
  if (els.preset.value) applyPreset(els.preset.value);
});

syncScenarioUi();
setHud("Idle", "Ready — choose a scenario or preset, then run.");
queueMicrotask(refreshBundleSizes);
setTimeout(refreshBundleSizes, 1200);
