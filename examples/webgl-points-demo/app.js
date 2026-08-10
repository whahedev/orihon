import {
  createMap,
  performanceInspector,
  tileLayer,
  webglPointLayer
} from "/dist/index.js";

const COUNTS = [100_000, 500_000, 1_000_000];
const cache = new Map();

const map = createMap("map", {
  center: [50.1, 14.4],
  zoom: 5,
  minZoom: 2,
  maxZoom: 12
});

tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "© OpenStreetMap contributors",
  maxZoom: 19
}).addTo(map);

const pointsLayer = webglPointLayer([], {
  pointSize: 2.5,
  color: "#0f766e",
  opacity: 0.72,
  maxDpr: 1.5,
  interactive: false
}).addTo(map);

const inspector = performanceInspector(map, {
  sampleFrames: 24,
  includeMemory: true
});

const els = {
  fps: document.getElementById("metric-fps"),
  frame: document.getElementById("metric-frame"),
  memory: document.getElementById("metric-memory"),
  source: document.getElementById("metric-source"),
  visible: document.getElementById("metric-visible"),
  rendered: document.getElementById("metric-rendered"),
  status: document.getElementById("status"),
  buttons: [...document.querySelectorAll(".counts button")]
};

let currentCount = 100_000;
let busy = false;

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
  const cached = cache.get(count);
  if (cached) return cached;
  const rand = mulberry32(count ^ 0x9e3779b9);
  const points = new Array(count);
  for (let i = 0; i < count; i++) {
    points[i] = [35 + rand() * 28, -15 + rand() * 55];
  }
  cache.set(count, points);
  return points;
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}

function formatMemory(bytes) {
  if (!Number.isFinite(bytes)) return "n/a";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
}

function setStatus(text, tone = "ok") {
  els.status.textContent = text;
  els.status.dataset.tone = tone;
}

function setBusy(next) {
  busy = next;
  for (const button of els.buttons) button.disabled = next;
}

function updateLayerMetrics() {
  const layerStats = pointsLayer.getStats();
  els.source.textContent = formatNumber(currentCount);
  // WebGL submits all points; GPU clips. Canvas path may still cull.
  els.visible.textContent = formatNumber(layerStats.rendered);
  els.rendered.textContent = formatNumber(layerStats.rendered);
}

function applySnapshot(snapshot) {
  els.fps.textContent = snapshot.fps == null ? "—" : snapshot.fps.toFixed(1);
  els.frame.textContent = snapshot.frameMs == null ? "—" : `${snapshot.frameMs.toFixed(2)} ms`;
  els.memory.textContent = formatMemory(snapshot.memory?.usedJSHeapSize);
  updateLayerMetrics();
}

async function loadCount(count) {
  if (busy) return;
  setBusy(true);
  setStatus(`Building ${formatNumber(count)} points…`, "busy");
  await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 16)));

  const started = performance.now();
  const points = createPoints(count);
  currentCount = count;
  pointsLayer.setData(points);
  const buildMs = performance.now() - started;

  for (const button of els.buttons) {
    button.setAttribute("aria-pressed", String(Number(button.dataset.count) === count));
  }

  updateLayerMetrics();
  setStatus(
    `Loaded ${formatNumber(count)} points in ${buildMs.toFixed(0)} ms · ${pointsLayer.getStats().renderer.toUpperCase()}`,
    "ok"
  );
  setBusy(false);
}

for (const button of els.buttons) {
  button.addEventListener("click", () => {
    const count = Number(button.dataset.count);
    if (!COUNTS.includes(count) || count === currentCount) return;
    void loadCount(count);
  });
}

map.on("moveend", () => {
  if (busy) return;
  pointsLayer.render();
  updateLayerMetrics();
});

inspector.on("sample", ({ snapshot }) => {
  if (busy) return;
  applySnapshot(snapshot);
});

await loadCount(100_000);
inspector.start(1200);
