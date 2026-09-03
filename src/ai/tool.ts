import type { AICommandEngine } from "./engine.js";
import {
  AI_COMMAND_SCHEMA,
  AI_ENGINE_COMMAND_SCHEMA,
  AI_ENGINE_COMMAND_SCHEMAS,
  getAIEngineCommandSchema,
  type AIEngineSchemaProfile,
  type AIJSONSchema
} from "./schema.js";
import type { AISession } from "./session.js";
import type { AICommandSuccess, AIEngineCommandSuccess, AIEngineToolSuccess, AIResult } from "./types.js";

export { AI_COMMAND_SCHEMA, AI_ENGINE_COMMAND_SCHEMA, AI_ENGINE_COMMAND_SCHEMAS, getAIEngineCommandSchema } from "./schema.js";
export type { AIEngineSchemaProfile, AIJSONSchema } from "./schema.js";

export const ORIHON_AI_SYSTEM_PROMPT = `You control an Orihon map through the orihon_execute tool.

Rules:
- Send exactly one valid Orihon AI command per tool call.
- Ordinary coordinates must be objects: {"lat": number, "lng": number}.
- Never use coordinate arrays outside GeoJSON.
- GeoJSON coordinates remain [longitude, latitude].
- Every added layer must have a stable, descriptive, unique ID.
- Reuse the same ID for update, remove and fit operations.
- Never send functions, JavaScript, HTML, DOM values or undefined.
- Popup and tooltip content must use {"text": "..."}.
- Use query before updating or removing an object whose ID is unknown.
- After adding several related objects, use fit with their IDs.
- Do not remove layers that were not created by the AI session.
- If a command returns ok:false, inspect error.code and error.path, correct only the invalid field, and retry once.
- Prefer apply_scene when creating or replacing a complete map.
- Prefer add, update and remove for incremental changes.`;

export const ORIHON_AI_ENGINE_SYSTEM_PROMPT = `${ORIHON_AI_SYSTEM_PROMPT}
- Prefer points.replace for a point collection with titles or plain-text popups; viewport.mode="fit" removes the need for a separate fit call.
- Set clearMap:true only when the user explicitly asks to clear or replace the complete AI-owned map.
- Use objects.add/update/remove/batch for live or large object collections rendered by ObjectManager.
- Object geometries are GeoJSON and therefore use [longitude, latitude].
- Every object must have a stable string or numeric feature.id.
- Group related changes in one objects.batch command so clients render one coherent update.
- Use route.plan to let the engine order an existing point collection and render it through RoutingLayer; do not resend coordinates already stored in the collection.
- Use layer commands for presentation layers; use object commands for domain entities that change over time.`;

export const ORIHON_AI_POINTS_SYSTEM_PROMPT = `You control point collections on an Orihon map through orihon_execute.

Rules:
- Send one points.replace command with stable unique point IDs.
- Coordinates are named objects: {"lat":number,"lng":number}.
- title and popup are safe plain text; never send HTML or JavaScript.
- Use defaults.category when all points share alpha, beta, gamma or alert styling.
- Use viewport:{"mode":"fit","padding":number} to show every point without a second command.
- Set clearMap:true only when the user explicitly asks to clear or replace the complete AI-owned map.
- If ok:false, correct error.path and retry once.`;

const ORIHON_AI_OBJECTS_SYSTEM_PROMPT = `You control live Orihon ObjectManager collections through orihon_execute.

Use objects.add/update/remove/replace/clear/batch. Object geometries are GeoJSON and use [longitude, latitude]. Every feature needs a stable string or numeric id. Group related changes in objects.batch. If ok:false, correct error.path and retry once.`;

const ORIHON_AI_ROUTES_SYSTEM_PROMPT = `You plan routes through existing Orihon point collections using orihon_execute.

Use route.plan with a stable routeId and collection name. Omit ids to visit every point, or provide ids for a subset. Use startId/endId only when requested. The engine computes waypoint order and distance through the existing routing model; never resend coordinates already stored in the collection.`;

const ORIHON_AI_READONLY_SYSTEM_PROMPT = `Use orihon_execute with op:"query" to read the current Orihon AI scene. Do not invent IDs.`;

export function getAIEngineSystemPrompt(profile: AIEngineSchemaProfile = "full"): string {
  if (profile === "scene") return ORIHON_AI_SYSTEM_PROMPT;
  if (profile === "objects") return ORIHON_AI_OBJECTS_SYSTEM_PROMPT;
  if (profile === "points") return ORIHON_AI_POINTS_SYSTEM_PROMPT;
  if (profile === "routes") return ORIHON_AI_ROUTES_SYSTEM_PROMPT;
  if (profile === "readonly") return ORIHON_AI_READONLY_SYSTEM_PROMPT;
  return ORIHON_AI_ENGINE_SYSTEM_PROMPT;
}

export interface AIToolDefinition {
  name: string;
  description: string;
  inputSchema: AIJSONSchema;
}

export interface AIToolBridge {
  readonly definition: AIToolDefinition;
  readonly systemPrompt: string;
  execute(input: unknown): AIResult<AICommandSuccess>;
}

export interface AIEngineToolBridge<TSuccess = AIEngineToolSuccess> {
  readonly definition: AIToolDefinition;
  readonly systemPrompt: string;
  execute(input: unknown): AIResult<TSuccess>;
}

export interface AIToolOptions {
  description?: string;
}

export interface AIEngineToolOptions extends AIToolOptions {
  /** Select only the command family needed by this agent. Default: full. */
  profile?: AIEngineSchemaProfile;
  /** Compact omits echoed events while preserving query snapshots. Default: compact. */
  resultMode?: "compact" | "full";
}

/** Bind one provider-neutral function tool to an existing live AI session. */
export function createAITool(session: AISession, options: AIToolOptions = {}): AIToolBridge {
  if (!session || typeof session.execute !== "function") {
    throw new TypeError("createAITool(session) requires an AISession");
  }
  const definition: AIToolDefinition = Object.freeze({
    name: "orihon_execute",
    description: options.description ?? "Apply one validated command to the current Orihon map and return structured success or error JSON.",
    inputSchema: AI_COMMAND_SCHEMA
  });
  return Object.freeze({
    definition,
    systemPrompt: ORIHON_AI_SYSTEM_PROMPT,
    execute(input: unknown): AIResult<AICommandSuccess> {
      return session.execute(input);
    }
  });
}

/** Bind the provider-neutral tool schema to a headless, server-side command engine. */
export function createAIEngineTool(engine: AICommandEngine, options: AIEngineToolOptions & { resultMode: "full" }): AIEngineToolBridge<AIEngineCommandSuccess>;
export function createAIEngineTool(engine: AICommandEngine, options?: AIEngineToolOptions & { resultMode?: "compact" }): AIEngineToolBridge<AIEngineToolSuccess>;
export function createAIEngineTool(engine: AICommandEngine, options: AIEngineToolOptions = {}): AIEngineToolBridge<AIEngineToolSuccess | AIEngineCommandSuccess> {
  if (!engine || typeof engine.execute !== "function") {
    throw new TypeError("createAIEngineTool(engine) requires an AICommandEngine");
  }
  const profile = options.profile ?? "full";
  const resultMode = options.resultMode ?? "compact";
  const definition: AIToolDefinition = Object.freeze({
    name: "orihon_execute",
    description: options.description ?? "Apply one validated, revisioned command to an Orihon map state and return structured JSON.",
    inputSchema: getAIEngineCommandSchema(profile)
  });
  return Object.freeze({
    definition,
    systemPrompt: getAIEngineSystemPrompt(profile),
    execute(input: unknown): AIResult<AIEngineToolSuccess | AIEngineCommandSuccess> {
      const result = engine.execute(input);
      if (!result.ok || resultMode === "full") return result;
      const value: AIEngineToolSuccess = { op: result.value.op, revision: result.value.revision };
      if (result.value.snapshot !== undefined) value.snapshot = result.value.snapshot;
      if (result.value.route !== undefined) value.route = result.value.route;
      return { ok: true, value };
    }
  });
}
