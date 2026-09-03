import { createMap } from "/dist/easy-entry.js";
import {
  AI_ENGINE_COMMAND_SCHEMA,
  AI_ENGINE_COMMAND_SCHEMAS,
  ORIHON_AI_ENGINE_SYSTEM_PROMPT,
  createAIMapProjection
} from "/dist/ai-entry.js";
import { createCommandJournal, createPendingCommandTracker } from "./journal.js";

const OPENSTREETMAP_BASEMAP = {
  url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  attribution: "© OpenStreetMap contributors",
  maxNativeZoom: 19,
  maxZoom: 19
};

const map = createMap("map", {
  center: { lat: 55.7558, lng: 37.6176 },
  zoom: 10,
  controls: true,
  basemap: OPENSTREETMAP_BASEMAP,
  ariaLabel: "Демонстрационная карта Orihon AI"
});
const projection = createAIMapProjection(map, { objectManager: { declutter: true } });
const pendingCommands = createPendingCommandTracker();

const elements = {
  form: document.querySelector("#prompt-form"),
  prompt: document.querySelector("#prompt"),
  status: document.querySelector("#status"),
  layerCount: document.querySelector("#layer-count"),
  objectCount: document.querySelector("#object-count"),
  routeCount: document.querySelector("#route-count"),
  revision: document.querySelector("#revision"),
  lastOp: document.querySelector("#last-op"),
  modelStatus: document.querySelector("#model-status"),
  modelTokens: document.querySelector("#model-tokens"),
  runModel: document.querySelector("#run-model"),
  log: document.querySelector("#log"),
  command: document.querySelector("#command-input")
};
const journal = createCommandJournal(elements.log);

const sceneCommand = {
  op: "apply_scene",
  scene: {
    version: 1,
    camera: { center: { lat: 55.7558, lng: 37.6176 }, zoom: 11 },
    layers: [
      {
        id: "kremlin",
        type: "marker",
        position: { lat: 55.752, lng: 37.6175 },
        appearance: { shape: "pin", color: "#d6533f", size: 34 },
        popup: { text: "Московский Кремль" }
      },
      {
        id: "moscow-route",
        type: "polyline",
        coordinates: [
          { lat: 55.7468, lng: 37.5706 },
          { lat: 55.752, lng: 37.6175 },
          { lat: 55.7601, lng: 37.6187 },
          { lat: 55.7714, lng: 37.6209 }
        ],
        style: { stroke: "#176f5e", strokeWidth: 6, arrow: "end" },
        tooltip: { text: "Демонстрационный маршрут" }
      },
      {
        id: "center-zone",
        type: "polygon",
        rings: [
          { lat: 55.744, lng: 37.594 },
          { lat: 55.744, lng: 37.638 },
          { lat: 55.767, lng: 37.638 },
          { lat: 55.767, lng: 37.594 }
        ],
        style: { stroke: "#1d806c", strokeWidth: 2, fill: "#49b79e", fillOpacity: 0.14 }
      }
    ]
  }
};

const moscowPlaces = [
  ["red-square", "Красная площадь", 55.7539, 37.6208, "Главная площадь Москвы рядом с Кремлём, ГУМом и Историческим музеем."],
  ["kremlin", "Московский Кремль", 55.7520, 37.6175, "Историческая крепость и музейный ансамбль с соборами и Оружейной палатой."],
  ["st-basil", "Собор Василия Блаженного", 55.7525, 37.6231, "Знаменитый храм XVI века с яркими куполами."],
  ["zaryadye", "Парк Зарядье", 55.7510, 37.6286, "Современный парк с природными зонами и Парящим мостом."],
  ["bolshoi", "Большой театр", 55.7601, 37.6187, "Главная театральная сцена страны, известная оперой и балетом."],
  ["tretyakov", "Третьяковская галерея", 55.7415, 37.6208, "Ключевая коллекция русского искусства от икон до начала XX века."],
  ["pushkin-museum", "ГМИИ имени Пушкина", 55.7473, 37.6051, "Музей зарубежного искусства с античной коллекцией и европейской живописью."],
  ["old-arbat", "Старый Арбат", 55.7522, 37.5923, "Историческая пешеходная улица с архитектурой, театрами и музыкантами."],
  ["gorky-park", "Парк Горького", 55.7297, 37.6015, "Городской парк для прогулок, выставок и отдыха у Москвы-реки."],
  ["sparrow-hills", "Воробьёвы горы", 55.7105, 37.5427, "Смотровая площадка с панорамой Лужников, центра и Москва-Сити."],
  ["novodevichy", "Новодевичий монастырь", 55.7261, 37.5557, "Архитектурный ансамбль XVI–XVII веков рядом с живописным прудом."],
  ["moscow-city", "Москва-Сити", 55.7499, 37.5373, "Деловой квартал с небоскрёбами и высотными смотровыми площадками."],
  ["vdnkh", "ВДНХ", 55.8263, 37.6377, "Выставочный парк с павильонами, фонтанами и музеями."],
  ["ostankino", "Останкинская телебашня", 55.8197, 37.6117, "Телебашня высотой 540 метров с круговой панорамой Москвы."],
  ["kolomenskoye", "Коломенское", 55.6677, 37.6708, "Музей-заповедник с храмом Вознесения, садами и царской усадьбой."]
];

const pointsCommand = {
  op: "points.replace",
  collection: "moscow-places",
  clearMap: true,
  defaults: { category: "alpha" },
  viewport: { mode: "fit", padding: 48, animation: "fly", durationMs: 700 },
  points: moscowPlaces.map(([id, title, lat, lng, popup], index) => ({
    id, position: { lat, lng }, title, popup,
    visual: {
      ...(index === 0 ? {
        image: {
          url: "https://upload.wikimedia.org/wikipedia/commons/thumb/2/26/Moscow%27s_Red_Square%2C_Moscow%2C_Russia.jpg/330px-Moscow%27s_Red_Square%2C_Moscow%2C_Russia.jpg",
          alt: "Красная площадь",
          shape: "circle",
          fit: "cover",
          borderColor: "#ffffff",
          borderWidth: 3
        },
        size: 58
      } : {}),
      label: {
        text: title,
        display: "hover"
      },
      collisionMode: "auto"
    },
    category: index < 4 ? "alert" : index < 8 ? "beta" : index < 12 ? "alpha" : "gamma"
  }))
};

const visitRouteIntent = {
  goal: "create_visit_route",
  collection: "moscow-places",
  routeId: "moscow-visit-route",
  points: pointsCommand.points,
  route: {
    startId: "red-square",
    endId: "kolomenskoye",
    optimize: "shortest",
    reactive: true
  },
  presentation: {
    clearMap: true,
    defaults: pointsCommand.defaults,
    viewport: pointsCommand.viewport
  }
};

const scenarios = {
  scene: () => [sceneCommand],
  places: () => [pointsCommand],
  route: () => [pointsCommand, {
    op: "route.plan",
    routeId: "moscow-visit-route",
    collection: "moscow-places",
    optimize: "shortest"
  }],
  move: () => [{
    op: "update",
    id: "kremlin",
    patch: { position: { lat: 55.761, lng: 37.6175 }, popup: { text: "Кремль — новая позиция" } }
  }],
  repair: () => [
    {
      op: "add",
      id: "repair-demo",
      layer: { type: "marker", position: { lat: 137.6, lng: 37.61 }, popup: { text: "Невалидная точка" } }
    },
    {
      op: "add",
      id: "repair-demo",
      layer: { type: "marker", position: { lat: 55.765, lng: 37.61 }, appearance: { color: "#e39b27" }, popup: { text: "Ошибка исправлена" } }
    }
  ],
  live: () => [
    { op: "fly_to", center: { lat: 52.52, lng: 13.405 }, zoom: 11, durationMs: 650 },
    {
      op: "objects.replace",
      collection: "vehicles",
      objects: [
        { type: "Feature", id: "bus-17", geometry: { type: "Point", coordinates: [13.3777, 52.5163] }, properties: { title: "Bus 17", category: "beta" } },
        { type: "Feature", id: "bus-24", geometry: { type: "Point", coordinates: [13.4132, 52.5219] }, properties: { title: "Bus 24", category: "alert" } }
      ]
    },
    {
      op: "objects.batch",
      collection: "vehicles",
      changes: [
        { type: "update", objects: [{ type: "Feature", id: "bus-17", geometry: { type: "Point", coordinates: [13.3977, 52.518] }, properties: { title: "Bus 17 · moved", category: "beta" } }] },
        { type: "add", objects: [{ type: "Feature", id: "bus-31", geometry: { type: "Point", coordinates: [13.4286, 52.523] }, properties: { title: "Bus 31", category: "alpha" } }] },
        { type: "remove", ids: ["bus-24"] }
      ]
    }
  ]
};

function inferScenario(prompt) {
  const normalized = prompt.toLowerCase();
  if (normalized.includes("ai-модел") || normalized.includes("глубок")) return "deep";
  if (normalized.includes("маршрут") || normalized.includes("поряд")) return "route";
  if (normalized.includes("15") || normalized.includes("мест")) return "places";
  if (normalized.includes("ошиб") || normalized.includes("исправ")) return "repair";
  if (normalized.includes("онлайн") || normalized.includes("объект") || normalized.includes("берлин")) return "live";
  if (normalized.includes("передвин") || normalized.includes("север")) return "move";
  return "scene";
}

function appendLog(kind, title, payload) {
  journal.append(kind, title, payload);
}

function updateState(result, operation) {
  const snapshot = projection.session.query();
  elements.layerCount.textContent = String(snapshot.layers.length);
  elements.objectCount.textContent = String(projection.getCollectionNames().reduce(
    (total, name) => total + (projection.getCollectionSource(name)?.size ?? 0),
    0
  ));
  elements.routeCount.textContent = String(projection.getRouteNames().length);
  elements.revision.textContent = String(projection.revision);
  elements.lastOp.textContent = operation;
  elements.status.textContent = result.ok ? "Команда выполнена" : result.error.code;
}

async function executeCommand(command, label = "LLM → orihon_execute") {
  appendLog("", label, command);
  pendingCommands.mark(command, 1);
  let result;
  try {
    const response = await fetch("/api/orihon/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command, baseRevision: projection.revision })
    });
    result = await response.json();
    if (result.ok && result.value.event) applyServerEvent(result.value.event, "response");
  } catch (error) {
    result = { ok: false, error: { code: "NETWORK_ERROR", path: "$request", message: error.message } };
  } finally {
    pendingCommands.mark(command, -1);
  }
  appendLog(result.ok ? "success" : "error", result.ok ? "Server engine → success" : "Server engine → repairable error", result);
  updateState(result, command.op ?? "unknown");
  await new Promise((resolve) => setTimeout(resolve, 180));
  return result;
}

async function syncSnapshot() {
  const response = await fetch("/api/orihon/snapshot", { cache: "no-store" });
  const snapshot = await response.json();
  const result = projection.applySnapshot(snapshot);
  if (!result.ok) appendLog("error", "Snapshot projection error", result);
  updateState(result, "snapshot");
  return snapshot;
}

function applyServerEvent(event, source = "sse") {
  if (event.revision <= projection.revision) return;
  const result = projection.applyEvent(event);
  if (!result.ok && result.error.code === "REVISION_CONFLICT") {
    appendLog("error", "SSE revision gap → snapshot resync", { event, error: result.error });
    void syncSnapshot();
  }
  else if (!result.ok) appendLog("error", "Browser projection error", result);
  else {
    const operation = event.type === "transaction" ? event.operation : event.command.op;
    updateState(result, operation);
    if (source === "sse" && (event.type === "transaction" || !pendingCommands.has(event.command))) {
      appendLog("success", `SSE → browser · revision ${event.revision}`, event.type === "transaction" ? {
        transactionId: event.transactionId,
        operation: event.operation,
        commands: event.commands.map(({ op }) => op)
      } : event.command);
    }
  }
}

async function runIntent(intent) {
  elements.status.textContent = "Agent Runtime формирует план…";
  appendLog("", "LLM → semantic intent", intent);
  let result;
  try {
    const response = await fetch("/api/orihon/intents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent, baseRevision: projection.revision })
    });
    result = await response.json();
    if (result.ok) {
      appendLog("", "Capability Registry → AIPlan", result.value.plan ?? {
        goal: result.value.goal,
        note: "compact HTTP result (no echoed points)"
      });
      appendLog("success", "Plan Executor → atomic commit", {
        revision: result.value.revision,
        resources: result.value.resources,
        context: result.value.context,
        goal: result.value.goal ?? result.value.plan?.goal
      });
      await new Promise((resolve) => setTimeout(resolve, 180));
      if (projection.revision < result.value.revision) await syncSnapshot();
    }
  } catch (error) {
    result = { ok: false, error: { code: "NETWORK_ERROR", path: "$request", message: error.message } };
  }
  if (!result.ok) appendLog("error", "Plan Executor → rejected", result);
  updateState(result, intent.goal ?? result.value?.goal ?? "intent");
  return result;
}

async function runScenario(name) {
  if (name === "deep") return runIntent(visitRouteIntent);
  const commands = scenarios[name]();
  elements.status.textContent = "Агент формирует команду…";
  for (let index = 0; index < commands.length; index++) {
    const result = await executeCommand(commands[index], index === 0 ? "LLM → orihon_execute" : "LLM retry → orihon_execute");
    if (!result.ok && index + 1 < commands.length) elements.status.textContent = "LLM исправляет error.path…";
  }
}

async function runModel(message) {
  elements.runModel.disabled = true;
  elements.status.textContent = "Модель планирует действия…";
  appendLog("", "User → model agent", { message });
  try {
    const response = await fetch("/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message })
    });
    const result = await response.json();
    if (!result.ok) {
      appendLog("error", "Model agent → error", result.error);
      elements.status.textContent = result.error.message;
      return result;
    }
    for (const trace of result.value.toolCalls) {
      appendLog("", `LLM tool → ${trace.name}`, { turn: trace.turn, arguments: trace.arguments });
      appendLog(trace.result?.ok === false ? "error" : "success", `${trace.name} → result`, trace.result);
    }
    const usage = result.value.usage;
    const total = usage.inputTokens + usage.outputTokens;
    elements.modelTokens.textContent = `${total.toLocaleString("ru-RU")} (${usage.inputTokens.toLocaleString("ru-RU")} + ${usage.outputTokens.toLocaleString("ru-RU")})`;
    elements.modelStatus.textContent = `${result.value.provider} · ${result.value.model}`;
    elements.status.textContent = result.value.message;
    elements.lastOp.textContent = "model agent";
    appendLog("success", "Model agent → final", {
      message: result.value.message,
      turns: result.value.turns,
      usage
    });
    const mapTrace = [...result.value.toolCalls].reverse().find(({ name, result }) => name === "orihon_plan" && result?.ok);
    const revision = mapTrace?.result?.value?.revision;
    if (typeof revision === "number" && projection.revision < revision) await syncSnapshot();
    return result;
  } catch (error) {
    const result = { ok: false, error: { code: "NETWORK_ERROR", path: "$request", message: error.message } };
    appendLog("error", "Model agent → network error", result.error);
    elements.status.textContent = result.error.message;
    return result;
  } finally {
    elements.runModel.disabled = false;
  }
}

async function loadModelConfig() {
  try {
    const config = await fetch("/api/agent/config", { cache: "no-store" }).then((response) => response.json());
    elements.runModel.disabled = !config.configured;
    elements.modelStatus.textContent = config.configured
      ? `${config.provider} · ${config.model}`
      : "не настроена";
    if (!config.configured) elements.runModel.title = `Задайте: ${config.requiredEnvironment.join(", ")}`;
    appendLog(config.configured ? "success" : "", "Model adapter", config);
    return config;
  } catch (error) {
    elements.runModel.disabled = true;
    elements.modelStatus.textContent = "недоступна";
    appendLog("error", "Model adapter config error", { message: error.message });
    return undefined;
  }
}

elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  void runScenario(inferScenario(elements.prompt.value));
});
elements.runModel.addEventListener("click", () => { void runModel(elements.prompt.value); });

for (const button of document.querySelectorAll("[data-prompt]")) {
  button.addEventListener("click", () => {
    elements.prompt.value = button.textContent;
    void runScenario(button.dataset.prompt);
  });
}

document.querySelector("#execute-json").addEventListener("click", () => {
  try {
    void executeCommand(JSON.parse(elements.command.value), "Manual JSON → orihon_execute");
  } catch (error) {
    appendLog("error", "JSON parse error", { message: error.message });
    elements.status.textContent = "Некорректный JSON";
  }
});

document.querySelector("#clear-log").addEventListener("click", () => {
  journal.clear();
});

Object.defineProperty(window, "orihonAgentDemo", {
  value: Object.freeze({
    map,
    projection,
    executeCommand,
    runIntent,
    systemPrompt: ORIHON_AI_ENGINE_SYSTEM_PROMPT,
    commandSchema: AI_ENGINE_COMMAND_SCHEMA,
    commandSchemas: AI_ENGINE_COMMAND_SCHEMAS
  }),
  configurable: false,
  writable: false
});

appendLog("success", "Server tool registered", {
  name: "orihon_execute",
  schema: AI_ENGINE_COMMAND_SCHEMA.title,
  commandVariants: AI_ENGINE_COMMAND_SCHEMA.oneOf.length,
  pointProfileVariants: AI_ENGINE_COMMAND_SCHEMAS.points.oneOf.length
});
// Snapshot first, then SSE — otherwise ready can race and fly from a stale camera twice.
const initialSnapshot = await syncSnapshot();
await loadModelConfig();

const events = new EventSource("/api/orihon/events");
events.addEventListener("command", (event) => applyServerEvent(JSON.parse(event.data), "sse"));
events.addEventListener("ready", (event) => {
  const server = JSON.parse(event.data);
  appendLog("success", "SSE connected", server);
  if (server.revision !== projection.revision) {
    appendLog("", "SSE revision reset/change → snapshot resync", {
      browserRevision: projection.revision,
      serverRevision: server.revision
    });
    void syncSnapshot();
  }
});
events.onerror = () => { elements.status.textContent = "Переподключение к событиям…"; };

if (initialSnapshot.revision === 0
  && initialSnapshot.scene.layers.length === 0
  && Object.keys(initialSnapshot.collections).length === 0) {
  void runScenario("scene");
}
