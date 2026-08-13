const HEAT_GRADIENT = {
  0.0: "rgba(0,0,255,0)",
  0.15: "blue",
  0.35: "cyan",
  0.55: "lime",
  0.75: "yellow",
  0.9: "orange",
  1.0: "red"
};

const EUROPE = { center: [50.1, 10.5], zoom: 5 };
const METRO = { center: [52.52, 13.405], zoom: 11 };
const WIDE = { center: [48.5, 8.5], zoom: 4 };

const SCENARIOS = {
  vehicles: {
    copy: "<strong>City fleet</strong> · 100,000 vehicles",
    view: { center: [50.8, 8.2], zoom: 6 },
    count: 100_000
  },
  iot: {
    copy: "<strong>IoT mesh</strong> · 250,000 devices",
    view: { center: METRO.center, zoom: 10 },
    count: 250_000
  },
  fleet: {
    copy: "<strong>Real-time delivery</strong> · 12,000 couriers",
    view: { center: METRO.center, zoom: 12 },
    count: 12_000
  },
  properties: {
    copy: "<strong>Property inventory</strong> · 50,000 clustered lots",
    view: { center: METRO.center, zoom: 11 },
    count: 50_000
  },
  aircraft: {
    copy: "<strong>Live aircraft</strong> · 8,000 positions",
    view: WIDE,
    count: 8_000
  },
  incidents: {
    copy: "<strong>Large incident map</strong> · 80,000 weighted events",
    view: { center: METRO.center, zoom: 10 },
    count: 80_000
  }
};

const TIER_HASH = new Set(["core", "standard", "advanced"]);
const SCENARIO_HASH = new Set(Object.keys(SCENARIOS));

const cache = new Map();
const els = {
  fps: document.getElementById("metric-fps"),
  frame: document.getElementById("metric-frame"),
  objects: document.getElementById("metric-objects"),
  renderer: document.getElementById("metric-renderer"),
  status: document.getElementById("status"),
  struggle: document.getElementById("struggle"),
  rail: document.getElementById("scenario-rail"),
  copy: document.getElementById("scenario-copy"),
  heatToggle: document.getElementById("heat-toggle"),
  isolines: document.getElementById("isolines"),
  bench: document.getElementById("bench-link"),
  tiers: [...document.querySelectorAll(".tier")],
  scenarios: [...document.querySelectorAll("[data-scenario]")]
};

let createMap;
let tileLayer;
let marker;
let polyline;
let polygon;
let geoJSON;
let zoomControl;
let webglPointLayer;
let webglHeatLayer;
let heatIsolineLayer;
let objectManager;
let performanceInspector;
let featureGroup;

const state = {
  tier: "advanced",
  scenario: "vehicles",
  busy: false,
  layers: [],
  motion: null,
  objectCount: 0,
  renderer: "—",
  pointsLayer: null,
  heatLayer: null,
  isolineLayer: null,
  manager: null,
  routes: null,
  motionData: null
};

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}

function setStatus(text, tone = "ok") {
  els.status.textContent = text;
  els.status.dataset.tone = tone;
}

async function loadOrihon() {
  const ORIHON_CDN = "https://cdn.jsdelivr.net/npm/orihon@1.0.2/dist/orihon.esm.js";
  const ORIHON_CDN_CSS = "https://cdn.jsdelivr.net/npm/orihon@1.0.2/dist/orihon.css";
  const link = document.getElementById("orihon-css");
  els.bench.href = location.pathname.includes("/examples/showcase")
    ? "/examples/bench-compare/"
    : "../bench/";
  try {
    const mod = await import("/dist/orihon.esm.js");
    if (link) link.href = "/dist/orihon.css";
    return mod;
  } catch {
    if (link) link.href = ORIHON_CDN_CSS;
    return import(ORIHON_CDN);
  }
}

function gaussianAround(rand, hubs, count, {
  clusteredRatio = 0.8,
  sigmaMin = 0.04,
  sigmaSpan = 0.55,
  lngStretch = 1.35,
  weight = false,
  scatter
} = {}) {
  const points = new Array(count);
  const clustered = Math.floor(count * clusteredRatio);
  for (let i = 0; i < clustered; i++) {
    const hub = hubs[(rand() * hubs.length) | 0];
    const sigma = sigmaMin + rand() * rand() * sigmaSpan;
    const u = Math.max(1e-9, rand());
    const v = rand();
    const r = Math.sqrt(-2 * Math.log(u));
    const ang = 2 * Math.PI * v;
    const lat = hub[0] + r * Math.cos(ang) * sigma;
    const lng = hub[1] + r * Math.sin(ang) * sigma * lngStretch;
    points[i] = weight
      ? [lat, lng, (hub[2] ?? 1) * (0.2 + rand() * 0.8)]
      : [lat, lng];
  }
  for (let i = clustered; i < count; i++) {
    if (scatter) {
      points[i] = weight
        ? [scatter.lat0 + rand() * scatter.latSpan, scatter.lng0 + rand() * scatter.lngSpan, 0.05 + rand() * 0.2]
        : [scatter.lat0 + rand() * scatter.latSpan, scatter.lng0 + rand() * scatter.lngSpan];
    } else {
      const hub = hubs[(rand() * hubs.length) | 0];
      points[i] = weight
        ? [hub[0] + (rand() - 0.5) * 0.3, hub[1] + (rand() - 0.5) * 0.4, 0.08 + rand() * 0.2]
        : [hub[0] + (rand() - 0.5) * 0.3, hub[1] + (rand() - 0.5) * 0.4];
    }
  }
  return points;
}

function getDataset(key, factory) {
  const cached = cache.get(key);
  if (cached) return cached;
  const value = factory();
  cache.set(key, value);
  return value;
}

function stopMotion() {
  if (state.motion != null) {
    cancelAnimationFrame(state.motion);
    state.motion = null;
  }
  state.motionData = null;
}

function clearOverlayLayers() {
  stopMotion();
  for (const layer of state.layers) {
    try {
      layer.remove();
    } catch {
      /* ignore */
    }
  }
  state.layers = [];
  state.pointsLayer = null;
  state.heatLayer = null;
  state.isolineLayer = null;
  state.manager = null;
  state.routes = null;
}

function track(layer) {
  state.layers.push(layer);
  return layer;
}

function setObjectMetrics(count, renderer) {
  state.objectCount = count;
  state.renderer = renderer;
  els.objects.textContent = formatNumber(count);
  els.renderer.textContent = renderer;
}

function scheduleMotion(tick) {
  stopMotion();
  let last = performance.now();
  const loop = (now) => {
    state.motion = requestAnimationFrame(loop);
    tick(now, now - last);
    last = now;
  };
  state.motion = requestAnimationFrame(loop);
}

function europeHubs(rand) {
  const hubs = [
    [52.52, 13.405, 1],
    [48.8566, 2.3522, 0.95],
    [51.5074, -0.1278, 0.9],
    [52.3676, 4.9041, 0.8],
    [50.1109, 8.6821, 0.75],
    [41.0082, 28.9784, 0.7],
    [40.4168, -3.7038, 0.65],
    [45.4642, 9.19, 0.6]
  ];
  return hubs.map((hub) => [hub[0] + (rand() - 0.5) * 0.02, hub[1] + (rand() - 0.5) * 0.02, hub[2]]);
}

function metroHubs(seedExtra = 0) {
  const rand = mulberry32(0x51f5a11 ^ seedExtra);
  return [
    [52.52, 13.405, 1],
    [52.53, 13.38, 0.85],
    [52.49, 13.43, 0.75],
    [52.54, 13.45, 0.65],
    [52.48, 13.36, 0.55]
  ].map((hub) => [hub[0] + (rand() - 0.5) * 0.01, hub[1] + (rand() - 0.5) * 0.01, hub[2]]);
}

function showAdvancedChrome(on) {
  els.rail.classList.toggle("is-on", on);
  els.struggle.classList.toggle("is-on", on);
  els.copy.style.display = on ? "" : "none";
}

function syncTierButtons() {
  for (const button of els.tiers) {
    button.setAttribute("aria-pressed", String(button.dataset.tier === state.tier));
  }
}

function syncScenarioButtons() {
  for (const button of els.scenarios) {
    button.setAttribute("aria-pressed", String(button.dataset.scenario === state.scenario));
  }
}

function writeHash() {
  const next = state.tier === "advanced" ? state.scenario : state.tier;
  const hash = `#${next}`;
  if (location.hash !== hash) history.replaceState(null, "", hash);
}

function parseHash() {
  const raw = location.hash.replace(/^#/, "").trim().toLowerCase();
  if (SCENARIO_HASH.has(raw)) return { tier: "advanced", scenario: raw };
  if (TIER_HASH.has(raw)) return { tier: raw, scenario: state.scenario };
  return { tier: "advanced", scenario: "vehicles" };
}

async function loadCore(map) {
  clearOverlayLayers();
  showAdvancedChrome(false);
  els.heatToggle.classList.remove("is-on");
  map.setView(EUROPE.center, EUROPE.zoom);
  track(marker(EUROPE.center, { title: "Core" }).bindPopup("Core surface · map + tiles").addTo(map));
  track(marker([48.8566, 2.3522]).bindPopup("Paris").addTo(map));
  track(marker([41.0082, 28.9784]).bindPopup("Istanbul").addTo(map));
  setObjectMetrics(3, "dom");
  els.copy.innerHTML = "<strong>Core</strong> · map, tiles, events";
  setStatus("Core surface ready", "ok");
}

async function loadStandard(map) {
  clearOverlayLayers();
  showAdvancedChrome(false);
  els.heatToggle.classList.remove("is-on");
  map.setView(METRO.center, 11);
  const group = featureGroup([
    marker(METRO.center).bindPopup("Standard · markers + vectors"),
    polyline(
      [
        [52.54, 13.35],
        [52.52, 13.405],
        [52.49, 13.45]
      ],
      { stroke: "#0f766e", strokeWidth: 4, strokeOpacity: 0.9 }
    ),
    polygon(
      [
        [52.53, 13.39],
        [52.53, 13.43],
        [52.505, 13.43],
        [52.505, 13.39]
      ],
      { stroke: "#0f766e", fill: "#0f766e", fillOpacity: 0.18, strokeWidth: 2 }
    ),
    geoJSON({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { name: "Depot" },
          geometry: { type: "Point", coordinates: [13.37, 52.51] }
        },
        {
          type: "Feature",
          properties: { name: "Corridor" },
          geometry: {
            type: "LineString",
            coordinates: [
              [13.34, 52.55],
              [13.41, 52.53],
              [13.46, 52.5]
            ]
          }
        }
      ]
    }, {
      pointToLayer: (_feature, latlng) => marker(latlng),
      style: () => ({ stroke: "#b45309", strokeWidth: 3 })
    })
  ]).addTo(map);
  track(group);
  if (!map._showcaseZoom) {
    map._showcaseZoom = zoomControl({ position: "top-right" }).addTo(map);
  }
  setObjectMetrics(6, "svg");
  els.copy.innerHTML = "<strong>Standard</strong> · everyday GIS, no WebGL";
  setStatus("Standard surface ready", "ok");
}

async function loadVehicles(map) {
  const points = getDataset("vehicles", () => {
    const rand = mulberry32(0x100001);
    return gaussianAround(rand, europeHubs(rand), 100_000, {
      sigmaMin: 0.08,
      sigmaSpan: 0.9,
      scatter: { lat0: 36, latSpan: 22, lng0: -10, lngSpan: 45 }
    });
  });
  // Mutable working copy for drift.
  const live = points.map((pair) => [pair[0], pair[1]]);
  const layer = webglPointLayer(live, {
    pointSize: 2.4,
    color: "#0f766e",
    opacity: 0.72,
    maxDpr: 1.5,
    interactive: false
  }).addTo(map);
  track(layer);
  state.pointsLayer = layer;
  state.motionData = { live, rand: mulberry32(0xabc123), acc: 0 };
  setObjectMetrics(live.length, "webgl");
  scheduleMotion((_now, dt) => {
    const data = state.motionData;
    if (!data || !state.pointsLayer) return;
    data.acc += dt;
    if (data.acc < 280) return;
    data.acc = 0;
    const { live: pts, rand } = data;
    const n = Math.min(8000, pts.length);
    for (let i = 0; i < n; i++) {
      const idx = (rand() * pts.length) | 0;
      pts[idx][0] += (rand() - 0.5) * 0.01;
      pts[idx][1] += (rand() - 0.5) * 0.014;
    }
    state.pointsLayer.setData(pts);
  });
}

async function loadIot(map) {
  const points = getDataset("iot", () => {
    const rand = mulberry32(0x200002);
    return gaussianAround(rand, metroHubs(2), 250_000, {
      clusteredRatio: 0.88,
      sigmaMin: 0.008,
      sigmaSpan: 0.06,
      lngStretch: 1.5,
      scatter: { lat0: 52.35, latSpan: 0.35, lng0: 13.15, lngSpan: 0.55 }
    });
  });
  const layer = webglPointLayer(points, {
    pointSize: 1.6,
    color: "#0369a1",
    opacity: 0.55,
    maxDpr: 1.25,
    interactive: false
  }).addTo(map);
  track(layer);
  state.pointsLayer = layer;
  state.motionData = { base: points, pulse: points.map((p) => [p[0], p[1]]), t: 0 };
  setObjectMetrics(points.length, "webgl");
  scheduleMotion((now) => {
    const data = state.motionData;
    if (!data || !state.pointsLayer) return;
    if (now - data.t < 900) return;
    data.t = now;
    const rand = mulberry32(((now / 16) | 0) ^ 0x55);
    const { base, pulse } = data;
    for (let i = 0; i < pulse.length; i += 17) {
      const jitter = (rand() - 0.5) * 0.0015;
      pulse[i][0] = base[i][0] + jitter;
      pulse[i][1] = base[i][1] + jitter;
    }
    state.pointsLayer.setData(pulse);
  });
}

async function loadFleet(map) {
  const rand = mulberry32(0x300003);
  const hubs = metroHubs(3);
  const points = getDataset("fleet", () =>
    gaussianAround(rand, hubs, 12_000, {
      clusteredRatio: 0.7,
      sigmaMin: 0.01,
      sigmaSpan: 0.05,
      lngStretch: 1.4
    })
  );
  const live = points.map((pair) => [pair[0], pair[1]]);
  const headings = Float32Array.from({ length: live.length }, () => rand() * Math.PI * 2);
  const speeds = Float32Array.from({ length: live.length }, () => 0.000015 + rand() * 0.00004);

  const routes = [];
  for (let i = 0; i < 28; i++) {
    const a = hubs[i % hubs.length];
    const b = hubs[(i + 2) % hubs.length];
    const mid = [
      (a[0] + b[0]) / 2 + (rand() - 0.5) * 0.03,
      (a[1] + b[1]) / 2 + (rand() - 0.5) * 0.04
    ];
    const line = polyline([a, mid, b], {
      stroke: i % 3 ? "#0f766e" : "#b45309",
      strokeWidth: 2,
      strokeOpacity: 0.45
    }).addTo(map);
    track(line);
    routes.push(line);
  }

  const layer = webglPointLayer(live, {
    pointSize: 3.2,
    color: "#c2410c",
    opacity: 0.8,
    maxDpr: 1.5,
    interactive: false
  }).addTo(map);
  track(layer);
  state.pointsLayer = layer;
  state.routes = routes;
  state.motionData = { live, headings, speeds };
  setObjectMetrics(live.length, "webgl");

  scheduleMotion((_now, dt) => {
    const data = state.motionData;
    if (!data || !state.pointsLayer) return;
    const step = Math.min(dt, 48);
    const { live: pts, headings: h, speeds: s } = data;
    for (let i = 0; i < pts.length; i++) {
      pts[i][0] += Math.cos(h[i]) * s[i] * step;
      pts[i][1] += Math.sin(h[i]) * s[i] * step * 1.4;
      if (rand() < 0.002) h[i] += (rand() - 0.5) * 0.6;
      if (pts[i][0] > 52.62 || pts[i][0] < 52.42) h[i] = Math.PI - h[i];
      if (pts[i][1] > 13.55 || pts[i][1] < 13.25) h[i] = -h[i];
    }
    state.pointsLayer.setData(pts);
  });
}

async function loadProperties(map) {
  const objects = getDataset("properties", () => {
    const rand = mulberry32(0x400004);
    const coords = gaussianAround(rand, metroHubs(4), 50_000, {
      clusteredRatio: 0.86,
      sigmaMin: 0.006,
      sigmaSpan: 0.05,
      lngStretch: 1.5,
      scatter: { lat0: 52.4, latSpan: 0.25, lng0: 13.2, lngSpan: 0.45 }
    });
    return coords.map((pair, index) => ({
      id: `prop-${index}`,
      coordinates: pair,
      properties: { title: `Lot ${index}` }
    }));
  });

  const manager = objectManager({
    clusterize: true,
    clusterGridSize: 56,
    clusterMaxZoom: 16,
    indexCellSize: 0.25,
    marker: { className: "oh-showcase-property" }
  }).addTo(map);
  manager.add(objects);
  track(manager);
  state.manager = manager;
  setObjectMetrics(objects.length, "clusters");
}

async function loadAircraft(map) {
  const rand = mulberry32(0x500005);
  const points = getDataset("aircraft", () =>
    gaussianAround(rand, europeHubs(rand), 8_000, {
      clusteredRatio: 0.55,
      sigmaMin: 0.2,
      sigmaSpan: 1.2,
      scatter: { lat0: 35, latSpan: 25, lng0: -12, lngSpan: 50 }
    })
  );
  const live = points.map((pair) => [pair[0], pair[1]]);
  const headings = Float32Array.from({ length: live.length }, () => rand() * Math.PI * 2);
  const speeds = Float32Array.from({ length: live.length }, () => 0.00004 + rand() * 0.00012);

  const layer = webglPointLayer(live, {
    pointSize: 2.8,
    color: "#1d4ed8",
    opacity: 0.78,
    maxDpr: 1.5,
    interactive: false
  }).addTo(map);
  track(layer);
  state.pointsLayer = layer;
  state.motionData = { live, headings, speeds, rand };
  setObjectMetrics(live.length, "webgl");

  scheduleMotion((_now, dt) => {
    const data = state.motionData;
    if (!data || !state.pointsLayer) return;
    const step = Math.min(dt, 48);
    const { live: pts, headings: h, speeds: s, rand: r } = data;
    for (let i = 0; i < pts.length; i++) {
      pts[i][0] += Math.cos(h[i]) * s[i] * step;
      pts[i][1] += Math.sin(h[i]) * s[i] * step * 1.35;
      if (r() < 0.0015) h[i] += (r() - 0.5) * 0.35;
      if (pts[i][0] > 62) pts[i][0] = 36;
      if (pts[i][0] < 35) pts[i][0] = 61;
      if (pts[i][1] > 40) pts[i][1] = -12;
      if (pts[i][1] < -15) pts[i][1] = 38;
    }
    state.pointsLayer.setData(pts);
  });
}

async function loadIncidents(map) {
  const points = getDataset("incidents", () => {
    const rand = mulberry32(0x600006);
    return gaussianAround(rand, metroHubs(6), 80_000, {
      clusteredRatio: 0.84,
      sigmaMin: 0.01,
      sigmaSpan: 0.07,
      lngStretch: 1.45,
      weight: true,
      scatter: { lat0: 52.4, latSpan: 0.28, lng0: 13.2, lngSpan: 0.5 }
    });
  });

  const heat = webglHeatLayer(points, {
    radius: 20,
    blur: 18,
    scaleZoom: 10,
    intensity: 0.32,
    opacity: 0.75,
    maxDpr: 1.5,
    gradient: HEAT_GRADIENT
  }).addTo(map);
  track(heat);
  state.heatLayer = heat;

  const isolines = heatIsolineLayer(points, {
    levels: 5,
    radius: 20,
    blur: 18,
    scaleZoom: 10,
    gradient: HEAT_GRADIENT,
    colorByLevel: true,
    strokeWidth: 1.5,
    opacity: 0.9,
    labels: true,
    labelFont: "700 13px IBM Plex Sans, system-ui, sans-serif",
    labelColor: "#0f172a"
  });
  state.isolineLayer = isolines;
  els.heatToggle.classList.add("is-on");
  els.isolines.checked = false;
  setObjectMetrics(points.length, "webgl-heat");
}

async function loadScenario(map, scenario) {
  els.heatToggle.classList.remove("is-on");
  const meta = SCENARIOS[scenario];
  map.setView(meta.view.center, meta.view.zoom);
  els.copy.innerHTML = meta.copy;
  if (scenario === "vehicles") await loadVehicles(map);
  else if (scenario === "iot") await loadIot(map);
  else if (scenario === "fleet") await loadFleet(map);
  else if (scenario === "properties") await loadProperties(map);
  else if (scenario === "aircraft") await loadAircraft(map);
  else if (scenario === "incidents") await loadIncidents(map);
}

async function applyState(map, { tier, scenario }, { quiet = false } = {}) {
  if (state.busy) return;
  state.busy = true;
  state.tier = tier;
  state.scenario = scenario;
  syncTierButtons();
  syncScenarioButtons();
  writeHash();
  if (!quiet) setStatus("Unfolding surface…", "busy");
  await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 16)));

  const started = performance.now();
  try {
    if (tier === "core") await loadCore(map);
    else if (tier === "standard") await loadStandard(map);
    else {
      showAdvancedChrome(true);
      clearOverlayLayers();
      await loadScenario(map, scenario);
      setStatus(
        `${SCENARIOS[scenario].copy.replace(/<\/?strong>/g, "")} · ${(performance.now() - started).toFixed(0)} ms`,
        "ok"
      );
    }
  } catch (error) {
    console.error(error);
    setStatus(error?.message || "Failed to load surface", "busy");
  } finally {
    state.busy = false;
  }
}

const orihon = await loadOrihon();
({
  createMap,
  tileLayer,
  marker,
  polyline,
  polygon,
  geoJSON,
  zoomControl,
  webglPointLayer,
  webglHeatLayer,
  heatIsolineLayer,
  objectManager,
  performanceInspector,
  featureGroup
} = orihon);

const map = createMap("map", {
  center: EUROPE.center,
  zoom: EUROPE.zoom,
  minZoom: 2,
  maxZoom: 18,
  controls: false
});

tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "© OpenStreetMap",
  maxZoom: 19
}).addTo(map);

const inspector = performanceInspector(map, {
  sampleFrames: 20,
  includeMemory: false
});

inspector.on("sample", ({ snapshot }) => {
  if (state.busy) return;
  els.fps.textContent = snapshot.fps == null ? "—" : snapshot.fps.toFixed(1);
  els.frame.textContent = snapshot.frameMs == null ? "—" : `${snapshot.frameMs.toFixed(1)} ms`;
  if (state.pointsLayer) {
    const stats = state.pointsLayer.getStats();
    setObjectMetrics(stats.points, stats.renderer);
  } else if (state.heatLayer) {
    const stats = state.heatLayer.getStats();
    setObjectMetrics(stats.points, "webgl-heat");
  } else if (state.manager) {
    const stats = state.manager.getStats();
    setObjectMetrics(stats.objects, stats.renderer === "webgl" ? "clusters" : stats.renderer);
  }
});

for (const button of els.tiers) {
  button.addEventListener("click", () => {
    const tier = button.dataset.tier;
    void applyState(map, {
      tier,
      scenario: tier === "advanced" ? state.scenario : state.scenario
    });
  });
}

for (const button of els.scenarios) {
  button.addEventListener("click", () => {
    void applyState(map, { tier: "advanced", scenario: button.dataset.scenario });
  });
}

els.isolines.addEventListener("change", () => {
  if (!state.isolineLayer) return;
  if (els.isolines.checked) {
    state.isolineLayer.addTo(map);
    if (!state.layers.includes(state.isolineLayer)) state.layers.push(state.isolineLayer);
    state.isolineLayer.rebuild();
  } else {
    state.isolineLayer.remove();
  }
});

window.addEventListener("hashchange", () => {
  const next = parseHash();
  if (next.tier === state.tier && next.scenario === state.scenario) return;
  void applyState(map, next);
});

const initial = parseHash();
await applyState(map, initial, { quiet: true });
inspector.start(1000);
