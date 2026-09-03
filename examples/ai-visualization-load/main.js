import { createMap } from "/dist/easy-entry.js";
import { createAIMapProjection } from "/dist/ai-entry.js";

const CENTER = { lat: 55.7558, lng: 37.6176 };
const COLLECTION = "stress-vehicles";
const ROUTE_ID = "stress-control-route";
const SEED = 42;
const SPREAD_KM = 18;
const TOKEN_MEASUREMENTS = Object.freeze({
  encoding: "o200k_base",
  schemaPrompt: 1053,
  createUserPrompt: 38,
  updateUserPrompt: 13,
  create: Object.freeze({
    1000: { intent: 59, raw: 78965 },
    5000: { intent: 59, raw: 386896 },
    10000: { intent: 59, raw: 771835 },
    25000: { intent: 59, raw: 1926624 }
  }),
  update: Object.freeze({
    250: { intent: 50, raw: 19013 },
    1000: { intent: 51, raw: 76008 },
    2500: { intent: 51, raw: 191491 },
    5000: { intent: 51, raw: 383967 }
  })
});

const map = createMap("map", {
  center: CENTER,
  zoom: 10,
  controls: true,
  basemap: {
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "© OpenStreetMap contributors",
    maxNativeZoom: 19,
    maxZoom: 19
  },
  ariaLabel: "Нагрузочная карта Orihon AI"
});
const projection = createAIMapProjection(map, {
  collectionOptions: (name) => ({
    clusterize: name === COLLECTION,
    renderer: name === COLLECTION ? "auto" : "dom"
  })
});

const elements = Object.fromEntries([
  "status", "revision", "objects", "route", "renderer", "fps", "commit-ms", "updates-rate",
  "intent-tokens", "schema-tokens", "raw-tokens", "token-saving", "log"
].map((id) => [id, document.getElementById(id)]));
const objectCount = document.getElementById("object-count");
const routeStops = document.getElementById("route-stops");
const updateCount = document.getElementById("update-count");
const startLive = document.getElementById("start-live");
const stopLive = document.getElementById("stop-live");
let live = false;
let tick = 0;
let appliedUpdates = 0;
let rateStartedAt = performance.now();

function formatTokens(value) {
  return value.toLocaleString("ru-RU");
}

function tokenSaving(semantic, raw) {
  return (100 * (1 - semantic / raw)).toLocaleString("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function updateTokenMetrics() {
  const create = TOKEN_MEASUREMENTS.create[Number(objectCount.value)];
  const update = TOKEN_MEASUREMENTS.update[Number(updateCount.value)];
  const createSemantic = TOKEN_MEASUREMENTS.schemaPrompt + TOKEN_MEASUREMENTS.createUserPrompt + create.intent;
  const updateSemantic = TOKEN_MEASUREMENTS.schemaPrompt + TOKEN_MEASUREMENTS.updateUserPrompt + update.intent;
  elements["intent-tokens"].textContent = formatTokens(create.intent);
  elements["schema-tokens"].textContent = formatTokens(TOKEN_MEASUREMENTS.schemaPrompt);
  elements["raw-tokens"].textContent = formatTokens(create.raw);
  elements["token-saving"].textContent =
    `Создание: −${tokenSaving(createSemantic, create.raw)}%. ` +
    `Тик: ${formatTokens(update.intent)} вместо ${formatTokens(update.raw)} токенов ` +
    `(−${tokenSaving(updateSemantic, update.raw)}%; system, schema и user prompt учтены без cache discount).`;
}

function log(message, value) {
  const line = `[${new Date().toLocaleTimeString()}] ${message}${value === undefined ? "" : ` ${JSON.stringify(value)}`}`;
  elements.log.textContent = `${line}\n${elements.log.textContent}`.slice(0, 6000);
}

function updateMetrics(commitMs) {
  const manager = projection.getCollectionManager(COLLECTION);
  const stats = manager?.getStats();
  const route = projection.getRouteLayer(ROUTE_ID)?.getSelectedRoute();
  elements.revision.textContent = String(projection.revision);
  elements.objects.textContent = (stats?.objects ?? 0).toLocaleString("ru-RU");
  elements.route.textContent = `${route?.coordinates?.length ?? 0} остановок`;
  elements.renderer.textContent = stats ? `${stats.renderer} · ${stats.clusterStrategy}` : "—";
  if (commitMs !== undefined) elements["commit-ms"].textContent = `${Math.round(commitMs)} мс`;
  const elapsedSeconds = Math.max(0.001, (performance.now() - rateStartedAt) / 1000);
  elements["updates-rate"].textContent = `${Math.round(appliedUpdates / elapsedSeconds).toLocaleString("ru-RU")} объектов/с`;
}

async function waitForRevision(revision, timeoutMs = 15_000) {
  const started = performance.now();
  while (projection.revision < revision) {
    if (performance.now() - started > timeoutMs) throw new Error(`Проекция не достигла ревизии ${revision}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function postIntent(intent) {
  const started = performance.now();
  const response = await fetch("/api/orihon/intents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ intent, baseRevision: projection.revision })
  });
  const result = await response.json();
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  await waitForRevision(result.value.revision);
  const duration = performance.now() - started;
  updateMetrics(duration);
  return { result, duration };
}

async function createScene() {
  live = false;
  startLive.disabled = false;
  stopLive.disabled = true;
  elements.status.textContent = "Генерация и атомарный commit…";
  tick = 0;
  appliedUpdates = 0;
  rateStartedAt = performance.now();
  try {
    const intent = {
      goal: "create_visualization_stress_test",
      collection: COLLECTION,
      routeId: ROUTE_ID,
      center: CENTER,
      objectCount: Number(objectCount.value),
      routeStops: Number(routeStops.value),
      seed: SEED,
      spreadKm: SPREAD_KM
    };
    const { result, duration } = await postIntent(intent);
    elements.status.textContent = "Сцена готова";
    log("semantic create committed", {
      revision: result.value.revision,
      objects: intent.objectCount,
      stops: intent.routeStops,
      ms: Math.round(duration)
    });
  } catch (error) {
    elements.status.textContent = "Ошибка";
    log("create failed", { message: error.message });
  }
}

async function liveLoop() {
  if (!live) return;
  tick++;
  const count = Number(updateCount.value);
  try {
    const { duration } = await postIntent({
      goal: "update_visualization_stress_test",
      collection: COLLECTION,
      center: CENTER,
      updateCount: count,
      tick,
      seed: SEED,
      spreadKm: SPREAD_KM
    });
    appliedUpdates += count;
    elements.status.textContent = `Поток · тик ${tick}`;
    updateMetrics(duration);
    log("semantic update committed", { tick, objects: count, ms: Math.round(duration) });
  } catch (error) {
    live = false;
    elements.status.textContent = "Поток остановлен ошибкой";
    log("update failed", { message: error.message });
  }
  if (live) setTimeout(liveLoop, 250);
}

document.getElementById("load-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void createScene();
});
objectCount.addEventListener("change", updateTokenMetrics);
updateCount.addEventListener("change", updateTokenMetrics);
startLive.addEventListener("click", () => {
  if (live) return;
  live = true;
  startLive.disabled = true;
  stopLive.disabled = false;
  appliedUpdates = 0;
  rateStartedAt = performance.now();
  void liveLoop();
});
stopLive.addEventListener("click", () => {
  live = false;
  startLive.disabled = false;
  stopLive.disabled = true;
  elements.status.textContent = "Поток остановлен";
});

let frames = 0;
let fpsStarted = performance.now();
function measureFps(now) {
  frames++;
  const elapsed = now - fpsStarted;
  if (elapsed >= 1000) {
    elements.fps.textContent = String(Math.round(frames * 1000 / elapsed));
    frames = 0;
    fpsStarted = now;
  }
  requestAnimationFrame(measureFps);
}
requestAnimationFrame(measureFps);

const events = new EventSource("/api/orihon/events");
events.addEventListener("command", (message) => {
  const event = JSON.parse(message.data);
  if (event.revision <= projection.revision) return;
  const result = projection.applyEvent(event);
  if (!result.ok && result.error.code === "REVISION_CONFLICT") {
    log("SSE revision gap → snapshot resync", result.error);
    void syncSnapshot();
  } else if (!result.ok) log("projection error", result.error);
  updateMetrics();
});
events.addEventListener("ready", (message) => {
  const server = JSON.parse(message.data);
  if (server.revision === projection.revision) return;
  log("SSE revision reset/change → snapshot resync", {
    browserRevision: projection.revision,
    serverRevision: server.revision
  });
  void syncSnapshot();
});
events.onerror = () => { elements.status.textContent = "Переподключение SSE…"; };

async function syncSnapshot() {
  const snapshot = await fetch("/api/orihon/snapshot", { cache: "no-store" }).then((response) => response.json());
  const result = projection.applySnapshot(snapshot);
  if (!result.ok) log("snapshot projection error", result.error);
  updateMetrics();
  return snapshot;
}

const snapshot = await syncSnapshot();
updateTokenMetrics();
log("ready", { revision: snapshot.revision });

window.orihonLoadTest = Object.freeze({ map, projection, createScene, tokenMeasurements: TOKEN_MEASUREMENTS });
