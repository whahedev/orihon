import { createMap } from "../../src/easy-entry.js";
import {
  AI_COMMAND_SCHEMA,
  AI_ENGINE_COMMAND_SCHEMA,
  AI_ENGINE_COMMAND_SCHEMAS,
  AI_INTENT_SCHEMA,
  ORIHON_AI_ENGINE_SYSTEM_PROMPT,
  ORIHON_AI_AGENT_SYSTEM_PROMPT,
  ORIHON_AI_INTENT_SYSTEM_PROMPT,
  ORIHON_AI_SYSTEM_PROMPT,
  createAIAgentRuntime,
  createAILLMAgent,
  createAICommandEngine,
  createAIEngineTool,
  createAIHTTPHandler,
  createAIIntentTool,
  createAIPlaceSearchTool,
  executeAIPlaceSearch,
  createAIMapProjection,
  createOpenAICompatibleAdapter,
  createAISession,
  createAITool,
  type AICommand,
  type AILLMAdapter,
  type AIEngineCommand,
  type AIEngineToolSuccess,
  type AICreateVisitRouteIntent,
  type AIVisualizationStressIntent,
  type AIPointsReplaceCommand,
  type AIRoutePlanCommand,
  type AIResult,
  type AISceneSpec
} from "../../src/ai-entry.js";

const map = createMap("map");
const session = createAISession(map);
const tool = createAITool(session);
const engine = createAICommandEngine();
const runtime = createAIAgentRuntime(engine);
const intentTool = createAIIntentTool(runtime);
const llmAdapter: AILLMAdapter = createOpenAICompatibleAdapter({
  baseURL: "http://127.0.0.1:1234/v1",
  model: "local-model"
});
const placeTool = createAIPlaceSearchTool({
  async search() { return []; }
});
void executeAIPlaceSearch({ async search() { return []; } }, { queries: ["Perm"] });
const llmAgent = createAILLMAgent({
  adapter: llmAdapter,
  tools: [placeTool, intentTool],
  systemPrompt: `${ORIHON_AI_AGENT_SYSTEM_PROMPT}\n${intentTool.systemPrompt}`
});
const engineTool = createAIEngineTool(engine);
const projection = createAIMapProjection(map);
const handler = createAIHTTPHandler(engine);
const toolName: string = tool.definition.name;
const prompt: string = ORIHON_AI_SYSTEM_PROMPT;
const schemaTitle: unknown = AI_COMMAND_SCHEMA.title;
const engineSchemaTitle: unknown = AI_ENGINE_COMMAND_SCHEMA.title;
const pointsSchemaTitle: unknown = AI_ENGINE_COMMAND_SCHEMAS.points.title;
const enginePrompt: string = ORIHON_AI_ENGINE_SYSTEM_PROMPT;
const intentPrompt: string = ORIHON_AI_INTENT_SYSTEM_PROMPT;
const intentSchemaTitle: unknown = AI_INTENT_SCHEMA.title;
const scene: AISceneSpec = {
  version: 1,
  camera: { center: { lat: 55.7558, lng: 37.6176 }, zoom: 11 },
  layers: [{
    id: "moscow",
    type: "marker",
    position: { lat: 55.7558, lng: 37.6176 },
    popup: { text: "Moscow" }
  }]
};
const result: AIResult = session.applyScene(scene);
const command: AICommand = {
  op: "add",
  id: "route",
  layer: {
    type: "polyline",
    coordinates: [{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }]
  }
};
session.execute(command);
const objectCommand: AIEngineCommand = {
  op: "objects.add",
  collection: "vehicles",
  objects: [{ type: "Feature", id: "bus-1", geometry: { type: "Point", coordinates: [37.61, 55.75] } }]
};
engineTool.execute(objectCommand);
const pointsCommand: AIPointsReplaceCommand = {
  op: "points.replace",
  collection: "places",
  clearMap: true,
  viewport: { mode: "fit", padding: 32 },
  points: [{
    id: "kremlin",
    position: { lat: 55.752, lng: 37.6175 },
    title: "Kremlin",
    visual: {
      image: { url: "/images/kremlin-thumb.jpg", shape: "circle", fit: "cover", borderWidth: 3 },
      label: { text: "Kremlin", display: "hover", fontSize: 13, fontWeight: 700, offset: { x: 0, y: -38 } },
      size: 56,
      collisionMode: "auto"
    },
    popup: {
      text: "Historic complex",
      image: { url: "/images/kremlin.jpg", alt: "Kremlin", caption: "View from the river" }
    }
  }]
};
const compactPointResult: AIResult<AIEngineToolSuccess> = createAIEngineTool(engine, { profile: "points" }).execute(pointsCommand);
const routeCommand: AIRoutePlanCommand = {
  op: "route.plan",
  routeId: "places-route",
  collection: "places",
  optimize: "shortest",
  startId: "kremlin"
};
const compactRouteResult: AIResult<AIEngineToolSuccess> = createAIEngineTool(engine, { profile: "routes" }).execute(routeCommand);
const visitIntent: AICreateVisitRouteIntent = {
  goal: "create_visit_route",
  collection: "places",
  routeId: "places-route",
  points: [
    { id: "a", position: { lat: 1, lng: 2 } },
    { id: "b", position: { lat: 3, lng: 4 } }
  ],
  route: { optimize: "shortest", reactive: true }
};
intentTool.execute(visitIntent);
const stressIntent: AIVisualizationStressIntent = {
  goal: "create_visualization_stress_test",
  collection: "load-vehicles",
  routeId: "load-route",
  center: { lat: 55.7558, lng: 37.6176 },
  objectCount: 10_000,
  routeStops: 60,
  seed: 42
};
intentTool.execute(stressIntent);

const invalidCoordinateArray: AISceneSpec = {
  version: 1,
  layers: [{
    id: "invalid",
    type: "marker",
    // @ts-expect-error AI coordinates must be named objects, never ambiguous arrays.
    position: [55.7558, 37.6176]
  }]
};

const invalidCallback: AISceneSpec = {
  version: 1,
  layers: [{
    id: "invalid-callback",
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
    // @ts-expect-error AI styles are JSON-only and cannot contain callback functions.
    style: () => ({ stroke: "red" })
  }]
};

void [result, invalidCoordinateArray, invalidCallback, toolName, prompt, schemaTitle, engineSchemaTitle, pointsSchemaTitle, enginePrompt, intentPrompt, intentSchemaTitle, projection, handler, compactPointResult, compactRouteResult, llmAgent];
