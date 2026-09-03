import { AIError } from "./errors.js";
import { validateObjectCommand, validatePointsReplaceCommand, validateRoutePlanCommand } from "./engine-validation.js";
import { visualizationStressCommands, visualizationStressUpdateCommands } from "./stress.js";
import type {
  AICapabilityDescription,
  AIEngineCommand,
  AIPlanStep,
  AIResourceReference,
  AIVisualizationStressIntent,
  AIVisualizationStressUpdateIntent
} from "./types.js";

export interface AICapabilityAdapter {
  readonly definition: AICapabilityDescription;
  compile(input: Record<string, unknown>, path: string): AIEngineCommand | AIEngineCommand[];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function resource(value: unknown, path: string): AIResourceReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AIError("INVALID_TYPE", path, "Expected a resource reference", value);
  }
  const source = value as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (key !== "kind" && key !== "id" && key !== "revision") {
      throw new AIError("UNKNOWN_PROPERTY", `${path}.${key}`, `Unknown property "${key}"`, source[key]);
    }
  }
  if (source.kind !== "collection" && source.kind !== "route") {
    throw new AIError("INVALID_VALUE", `${path}.kind`, "Expected collection or route", source.kind);
  }
  if (typeof source.id !== "string" || source.id.trim() === "") {
    throw new AIError("INVALID_TYPE", `${path}.id`, "Expected a non-empty string", source.id);
  }
  if (source.revision !== undefined && (!Number.isSafeInteger(source.revision) || Number(source.revision) < 0)) {
    throw new AIError("INVALID_VALUE", `${path}.revision`, "Expected a non-negative safe integer", source.revision);
  }
  return {
    kind: source.kind,
    id: source.id,
    ...(source.revision !== undefined ? { revision: Number(source.revision) } : {})
  };
}

const objectManagerCapability: AICapabilityAdapter = {
  definition: {
    id: "orihon.object-manager",
    version: 1,
    model: "object-manager",
    description: "Owns revisioned GeoJSON collections and incremental ObjectManager projection.",
    operations: [{
      name: "replace_points",
      description: "Atomically create or replace a named point collection.",
      inputSchema: {
        type: "object",
        required: ["collection", "points"],
        properties: {
          collection: { type: "string" },
          points: { type: "array" },
          clearMap: { type: "boolean" },
          defaults: { type: "object" },
          viewport: { type: "object" }
        }
      }
    }, {
      name: "update_points",
      description: "Patch existing points in a named collection by stable id.",
      inputSchema: {
        type: "object",
        required: ["collection", "objects"],
        properties: {
          collection: { type: "string" },
          objects: { type: "array" }
        }
      }
    }]
  },
  compile(input, path) {
    if (Array.isArray(input.objects)) {
      return validateObjectCommand({ op: "objects.update", collection: input.collection, objects: input.objects }, path);
    }
    return validatePointsReplaceCommand({ op: "points.replace", ...input }, path);
  }
};

const routeModelCapability: AICapabilityAdapter = {
  definition: {
    id: "orihon.route-model",
    version: 1,
    model: "route-model",
    description: "Plans and reactively maintains routes through ObjectManager collections.",
    operations: [{
      name: "plan",
      description: "Optimize a route using a collection resource reference.",
      inputSchema: {
        type: "object",
        required: ["routeId", "source"],
        properties: {
          routeId: { type: "string" },
          source: { type: "object", required: ["kind", "id"] },
          startId: {},
          endId: {},
          optimize: { const: "shortest" },
          reactive: { type: "boolean" }
        }
      }
    }]
  },
  compile(input, path) {
    const source = resource(input.source, `${path}.source`);
    if (source.kind !== "collection") {
      throw new AIError("INVALID_VALUE", `${path}.source.kind`, "Route source must be a collection", source.kind);
    }
    const { source: _source, ...parameters } = input;
    return validateRoutePlanCommand({ op: "route.plan", collection: source.id, ...parameters }, path);
  }
};

const visualizationCapability: AICapabilityAdapter = {
  definition: {
    id: "orihon.visualization-model",
    version: 1,
    model: "spatial-analysis",
    description: "Generates deterministic high-volume visualization data and update batches inside the engine.",
    operations: [{
      name: "create_stress_scene",
      description: "Generate an ObjectManager collection and a control route without model-generated GeoJSON.",
      inputSchema: {
        type: "object",
        required: ["collection", "routeId", "center", "objectCount", "routeStops"],
        properties: {
          collection: { type: "string" }, routeId: { type: "string" }, center: { type: "object" },
          objectCount: { type: "integer" }, routeStops: { type: "integer" }, seed: { type: "integer" },
          spreadKm: { type: "number" }
        }
      }
    }, {
      name: "update_stress_scene",
      description: "Generate a deterministic incremental ObjectManager update batch.",
      inputSchema: {
        type: "object",
        required: ["collection", "center", "updateCount", "tick"],
        properties: {
          collection: { type: "string" }, center: { type: "object" }, updateCount: { type: "integer" },
          tick: { type: "integer" }, seed: { type: "integer" }, spreadKm: { type: "number" }
        }
      }
    }]
  },
  compile(input, path) {
    if (input.goal === "create_visualization_stress_test") {
      return visualizationStressCommands(input as unknown as AIVisualizationStressIntent);
    }
    if (input.goal === "update_visualization_stress_test") {
      return visualizationStressUpdateCommands(input as unknown as AIVisualizationStressUpdateIntent);
    }
    throw new AIError("INVALID_VALUE", `${path}.goal`, "Unknown visualization operation", input.goal);
  }
};

/** Registry used by the agent runtime to discover and compile model-native actions. */
export class AICapabilityRegistry {
  readonly #adapters = new Map<string, AICapabilityAdapter>();

  register(adapter: AICapabilityAdapter): this {
    const id = adapter?.definition?.id;
    if (typeof id !== "string" || id.trim() === "") {
      throw new TypeError("Capability adapter requires a non-empty definition.id");
    }
    if (this.#adapters.has(id)) throw new TypeError(`Capability "${id}" is already registered`);
    this.#adapters.set(id, adapter);
    return this;
  }

  list(): AICapabilityDescription[] {
    return [...this.#adapters.values()].map(({ definition }) => clone(definition));
  }

  compile(step: AIPlanStep, path = "$plan.steps"): AIEngineCommand[] {
    const adapter = this.#adapters.get(step.capability);
    if (!adapter) {
      throw new AIError("NOT_FOUND", `${path}.capability`, `Capability "${step.capability}" is not registered`, step.capability);
    }
    const operation = adapter.definition.operations.find(({ name }) => name === step.operation);
    if (!operation) {
      throw new AIError("NOT_FOUND", `${path}.operation`, `Operation "${step.operation}" is not exposed by ${step.capability}`, step.operation);
    }
    const command = adapter.compile(clone(step.input), `${path}.input`);
    return Array.isArray(command) ? command : [command];
  }
}

export function createDefaultAICapabilityRegistry(): AICapabilityRegistry {
  return new AICapabilityRegistry()
    .register(objectManagerCapability)
    .register(routeModelCapability)
    .register(visualizationCapability);
}
