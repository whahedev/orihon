import type { AIAgentRuntime } from "./runtime.js";
import { AI_ENGINE_COMMAND_SCHEMAS, type AIJSONSchema } from "./schema.js";
import type { AIIntent, AIResourceReference, AIResult } from "./types.js";

const pointDefinitions = AI_ENGINE_COMMAND_SCHEMAS.points.$defs as Record<string, unknown>;

const visitRouteDefinition = {
  type: "object",
  required: ["goal", "collection", "routeId", "points"],
  additionalProperties: false,
  properties: {
    goal: { const: "create_visit_route" },
    collection: { type: "string", minLength: 1 },
    routeId: { type: "string", minLength: 1 },
    points: { type: "array", minItems: 2, items: { $ref: "#/$defs/pointItem" } },
    route: {
      type: "object",
      additionalProperties: false,
      properties: {
        ids: { type: "array", items: { $ref: "#/$defs/objectId" } },
        startId: { $ref: "#/$defs/objectId" },
        endId: { $ref: "#/$defs/objectId" },
        optimize: { const: "shortest" },
        closeLoop: { type: "boolean" },
        annotateStops: { type: "boolean" },
        reactive: { type: "boolean" }
      }
    },
    presentation: {
      type: "object",
      additionalProperties: false,
      properties: {
        clearMap: { type: "boolean" },
        defaults: { $ref: "#/$defs/pointDefaults" },
        viewport: { $ref: "#/$defs/pointViewport" }
      }
    }
  }
} as const;

const updatePointsDefinition = {
  type: "object",
  required: ["goal", "collection", "points"],
  additionalProperties: false,
  properties: {
    goal: { const: "update_points" },
    collection: { type: "string", minLength: 1 },
    points: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["id"],
        additionalProperties: false,
        properties: {
          id: { $ref: "#/$defs/objectId" },
          position: { $ref: "#/$defs/position" },
          title: { type: "string" },
          popup: { $ref: "#/$defs/pointPopup" },
          visual: { $ref: "#/$defs/pointVisual" },
          category: { $ref: "#/$defs/pointCategory" }
        }
      }
    },
    presentation: {
      type: "object",
      additionalProperties: false,
      properties: {
        viewport: { $ref: "#/$defs/pointViewport" }
      }
    }
  }
} as const;

const createStressDefinition = {
  type: "object",
  required: ["goal", "collection", "routeId", "center", "objectCount", "routeStops"],
  additionalProperties: false,
  properties: {
    goal: { const: "create_visualization_stress_test" },
    collection: { type: "string", minLength: 1 },
    routeId: { type: "string", minLength: 1 },
    center: { $ref: "#/$defs/position" },
    objectCount: { type: "integer", minimum: 100, maximum: 25000 },
    routeStops: { type: "integer", minimum: 2, maximum: 100 },
    seed: { type: "integer", minimum: 0, maximum: 2147483647 },
    spreadKm: { type: "number", minimum: 1, maximum: 100 }
  }
} as const;

const updateStressDefinition = {
  type: "object",
  required: ["goal", "collection", "center", "updateCount", "tick"],
  additionalProperties: false,
  properties: {
    goal: { const: "update_visualization_stress_test" },
    collection: { type: "string", minLength: 1 },
    center: { $ref: "#/$defs/position" },
    updateCount: { type: "integer", minimum: 1, maximum: 5000 },
    tick: { type: "integer", minimum: 1, maximum: 1000000 },
    seed: { type: "integer", minimum: 0, maximum: 2147483647 },
    spreadKm: { type: "number", minimum: 1, maximum: 100 }
  }
} as const;

function freezeIntentSchema(defs: Record<string, unknown>, oneOf: unknown[]): AIJSONSchema {
  return Object.freeze({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Orihon AI Semantic Intent v1",
    $defs: Object.freeze({ ...pointDefinitions, ...defs }),
    oneOf: Object.freeze(oneOf)
  });
}

export type AIIntentSchemaProfile = "visit" | "stress" | "full";

/** Visit-route focused schema (default for agents — omits stress-test goals). */
export const AI_INTENT_SCHEMA_VISIT: AIJSONSchema = freezeIntentSchema({
  createVisitRoute: visitRouteDefinition,
  updatePoints: updatePointsDefinition
}, [
  { $ref: "#/$defs/createVisitRoute" },
  { $ref: "#/$defs/updatePoints" }
]);

export const AI_INTENT_SCHEMA_STRESS: AIJSONSchema = freezeIntentSchema({
  createVisualizationStressTest: createStressDefinition,
  updateVisualizationStressTest: updateStressDefinition
}, [
  { $ref: "#/$defs/createVisualizationStressTest" },
  { $ref: "#/$defs/updateVisualizationStressTest" }
]);

export const AI_INTENT_SCHEMA_FULL: AIJSONSchema = freezeIntentSchema({
  createVisitRoute: visitRouteDefinition,
  updatePoints: updatePointsDefinition,
  createVisualizationStressTest: createStressDefinition,
  updateVisualizationStressTest: updateStressDefinition
}, [
  { $ref: "#/$defs/createVisitRoute" },
  { $ref: "#/$defs/updatePoints" },
  { $ref: "#/$defs/createVisualizationStressTest" },
  { $ref: "#/$defs/updateVisualizationStressTest" }
]);

/** Default model-facing schema: visit + patch, without stress-test overhead. */
export const AI_INTENT_SCHEMA: AIJSONSchema = AI_INTENT_SCHEMA_VISIT;

export const AI_INTENT_SCHEMAS = Object.freeze({
  visit: AI_INTENT_SCHEMA_VISIT,
  stress: AI_INTENT_SCHEMA_STRESS,
  full: AI_INTENT_SCHEMA_FULL
});

export function getAIIntentSchema(profile: AIIntentSchemaProfile = "visit"): AIJSONSchema {
  return AI_INTENT_SCHEMAS[profile] ?? AI_INTENT_SCHEMA_VISIT;
}

export const ORIHON_AI_INTENT_SYSTEM_PROMPT = `You collaborate with Orihon through the orihon_plan tool.

Express the user's map goal as one semantic intent. Orihon discovers its model capabilities, validates a dependency plan, and commits it atomically. Supply stable place IDs and safe titles. A popup may be plain text or declarative {text,image:{url,alt,caption}} content. Prefer plain-text popups when visual.image is set — the map popup reuses that photo automatically. Use visual.image for a circular photo and visual.label for its hover label; omit label.display unless the user asks for persistent text (display:"always"). Put repeated chrome in presentation.defaults.visual (shape, fit, border, size). Do not emulate photos or labels with HTML. Image URLs must be verified HTTPS or local URLs. Use update_points to patch existing ids without resending the whole collection. Let the route model calculate order and geometry; never repeat route coordinates. Semantic routes are reactive by default. For visualization load tests, send only counts, center, seed and update tick.`;

export interface AIIntentToolSuccess {
  goal: AIIntent["goal"];
  revision: number;
  resources: AIResourceReference[];
}

export interface AIIntentToolOptions {
  /** Default visit. Use full when the agent must also drive stress-test intents. */
  profile?: AIIntentSchemaProfile;
}

export interface AIIntentToolBridge {
  readonly definition: {
    name: "orihon_plan";
    description: string;
    inputSchema: AIJSONSchema;
  };
  readonly systemPrompt: string;
  execute(input: unknown): AIResult<AIIntentToolSuccess>;
}

export function createAIIntentTool(runtime: AIAgentRuntime, options: AIIntentToolOptions = {}): AIIntentToolBridge {
  if (!runtime || typeof runtime.execute !== "function") {
    throw new TypeError("createAIIntentTool(runtime) requires an AIAgentRuntime");
  }
  const profile = options.profile ?? "visit";
  return Object.freeze({
    definition: Object.freeze({
      name: "orihon_plan" as const,
      description: "Plan and atomically execute one semantic goal through native Orihon model capabilities.",
      inputSchema: getAIIntentSchema(profile)
    }),
    systemPrompt: ORIHON_AI_INTENT_SYSTEM_PROMPT,
    execute(input: unknown): AIResult<AIIntentToolSuccess> {
      const result = runtime.execute(input);
      if (!result.ok) return result;
      return {
        ok: true,
        value: {
          goal: result.value.plan.goal,
          revision: result.value.revision,
          resources: result.value.resources
        }
      };
    }
  });
}
