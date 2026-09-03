import { AICapabilityRegistry, createDefaultAICapabilityRegistry } from "./capabilities.js";
import type { AICommandEngine } from "./engine.js";
import { AIError, toAIError } from "./errors.js";
import { validatePointPatches, validatePointsReplaceCommand, validateRoutePlanCommand } from "./engine-validation.js";
import type {
  AIAgentContext,
  AICapabilityDescription,
  AICreateVisitRouteIntent,
  AIEngineCommand,
  AIEngineExecuteOptions,
  AIEngineSnapshot,
  AIIntent,
  AIObjectFeature,
  AIPlan,
  AIPlanExecution,
  AIPlanStep,
  AIPointPatch,
  AIResourceReference,
  AIResult,
  AIUpdatePointsIntent,
  AIVisualizationStressIntent,
  AIVisualizationStressUpdateIntent
} from "./types.js";

export interface AIPlanPreviewResult {
  plan: AIPlan;
  revision: number;
  resources: AIResourceReference[];
  context: AIAgentContext;
}

const CONTEXT_ID_LIMIT = 64;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AIError("INVALID_TYPE", path, "Expected an object", value);
  }
  return value as Record<string, unknown>;
}

function keys(source: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const valid = new Set(allowed);
  for (const key of Object.keys(source)) {
    if (!valid.has(key)) throw new AIError("UNKNOWN_PROPERTY", `${path}.${key}`, `Unknown property "${key}"`, source[key]);
  }
}

function requiredString(source: Record<string, unknown>, key: string, path: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new AIError(value === undefined ? "REQUIRED_PROPERTY" : "INVALID_TYPE", `${path}.${key}`, `Expected non-empty string "${key}"`, value);
  }
  return value;
}

function finiteNumber(source: Record<string, unknown>, key: string, path: string): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AIError(value === undefined ? "REQUIRED_PROPERTY" : "INVALID_TYPE", `${path}.${key}`, `Expected finite number "${key}"`, value);
  }
  return value;
}

function safeInteger(source: Record<string, unknown>, key: string, path: string, minimum: number, maximum: number): number {
  const value = source[key];
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new AIError(value === undefined ? "REQUIRED_PROPERTY" : "INVALID_VALUE", `${path}.${key}`, `Expected an integer from ${minimum} to ${maximum}`, value);
  }
  return Number(value);
}

function center(value: unknown, path: string): { lat: number; lng: number } {
  const source = record(value, path);
  keys(source, ["lat", "lng"], path);
  const lat = finiteNumber(source, "lat", path);
  const lng = finiteNumber(source, "lng", path);
  if (lat < -90 || lat > 90) throw new AIError("INVALID_COORDINATE", `${path}.lat`, "Latitude must be between -90 and 90", lat);
  if (lng < -180 || lng > 180) throw new AIError("INVALID_COORDINATE", `${path}.lng`, "Longitude must be between -180 and 180", lng);
  return { lat, lng };
}

function optionalStressParameters(source: Record<string, unknown>, path: string): { seed?: number; spreadKm?: number } {
  const result: { seed?: number; spreadKm?: number } = {};
  if (source.seed !== undefined) result.seed = safeInteger(source, "seed", path, 0, 0x7fff_ffff);
  if (source.spreadKm !== undefined) {
    const spreadKm = finiteNumber(source, "spreadKm", path);
    if (spreadKm < 1 || spreadKm > 100) throw new AIError("INVALID_VALUE", `${path}.spreadKm`, "Expected 1 to 100 km", spreadKm);
    result.spreadKm = spreadKm;
  }
  return result;
}

function validateVisualizationStressIntent(value: unknown, path: string): AIVisualizationStressIntent {
  const source = record(value, path);
  keys(source, ["goal", "collection", "routeId", "center", "objectCount", "routeStops", "seed", "spreadKm"], path);
  return {
    goal: "create_visualization_stress_test",
    collection: requiredString(source, "collection", path),
    routeId: requiredString(source, "routeId", path),
    center: center(source.center, `${path}.center`),
    objectCount: safeInteger(source, "objectCount", path, 100, 25_000),
    routeStops: safeInteger(source, "routeStops", path, 2, 100),
    ...optionalStressParameters(source, path)
  };
}

function validateVisualizationStressUpdateIntent(value: unknown, path: string): AIVisualizationStressUpdateIntent {
  const source = record(value, path);
  keys(source, ["goal", "collection", "center", "updateCount", "tick", "seed", "spreadKm"], path);
  return {
    goal: "update_visualization_stress_test",
    collection: requiredString(source, "collection", path),
    center: center(source.center, `${path}.center`),
    updateCount: safeInteger(source, "updateCount", path, 1, 5_000),
    tick: safeInteger(source, "tick", path, 1, 1_000_000),
    ...optionalStressParameters(source, path)
  };
}

function validateCreateVisitRouteIntent(value: unknown, path = "$intent"): AICreateVisitRouteIntent {
  const source = record(value, path);
  keys(source, ["goal", "collection", "routeId", "points", "route", "presentation"], path);
  if (source.goal !== "create_visit_route") {
    throw new AIError("INVALID_VALUE", `${path}.goal`, "Expected create_visit_route", source.goal);
  }
  const collection = requiredString(source, "collection", path);
  const routeId = requiredString(source, "routeId", path);
  const presentation = source.presentation === undefined ? {} : record(source.presentation, `${path}.presentation`);
  keys(presentation, ["clearMap", "viewport", "defaults"], `${path}.presentation`);
  const pointsCommand = validatePointsReplaceCommand({
    op: "points.replace",
    collection,
    points: source.points,
    ...presentation
  }, `${path}.pointsAction`);
  const route = source.route === undefined ? {} : record(source.route, `${path}.route`);
  keys(route, ["ids", "startId", "endId", "optimize", "closeLoop", "annotateStops", "reactive"], `${path}.route`);
  const routeCommand = validateRoutePlanCommand({
    op: "route.plan",
    routeId,
    collection,
    ...route,
    reactive: route.reactive ?? true
  }, `${path}.routeAction`);
  return {
    goal: "create_visit_route",
    collection,
    routeId,
    points: clone(pointsCommand.points),
    route: {
      ...(routeCommand.ids ? { ids: clone(routeCommand.ids) } : {}),
      ...(routeCommand.startId !== undefined ? { startId: routeCommand.startId } : {}),
      ...(routeCommand.endId !== undefined ? { endId: routeCommand.endId } : {}),
      ...(routeCommand.optimize ? { optimize: routeCommand.optimize } : {}),
      ...(routeCommand.closeLoop !== undefined ? { closeLoop: routeCommand.closeLoop } : {}),
      ...(routeCommand.annotateStops !== undefined ? { annotateStops: routeCommand.annotateStops } : {}),
      reactive: routeCommand.reactive
    },
    presentation: {
      ...(pointsCommand.clearMap !== undefined ? { clearMap: pointsCommand.clearMap } : {}),
      ...(pointsCommand.defaults ? { defaults: clone(pointsCommand.defaults) } : {}),
      ...(pointsCommand.viewport ? { viewport: clone(pointsCommand.viewport) } : {})
    }
  };
}

function validateUpdatePointsIntent(value: unknown, path = "$intent"): AIUpdatePointsIntent {
  const source = record(value, path);
  keys(source, ["goal", "collection", "points", "presentation"], path);
  if (source.goal !== "update_points") {
    throw new AIError("INVALID_VALUE", `${path}.goal`, "Expected update_points", source.goal);
  }
  const presentation = source.presentation === undefined ? {} : record(source.presentation, `${path}.presentation`);
  keys(presentation, ["viewport"], `${path}.presentation`);
  const intent: AIUpdatePointsIntent = {
    goal: "update_points",
    collection: requiredString(source, "collection", path),
    points: validatePointPatches(source.points, `${path}.points`)
  };
  if (presentation.viewport !== undefined) {
    const pointsCommand = validatePointsReplaceCommand({
      op: "points.replace",
      collection: intent.collection,
      points: intent.points.map((patch) => ({
        id: patch.id,
        position: patch.position ?? { lat: 0, lng: 0 }
      })),
      viewport: presentation.viewport
    }, `${path}.presentation`);
    intent.presentation = { viewport: clone(pointsCommand.viewport) };
  }
  return intent;
}

export function validateAIIntent(value: unknown, path = "$intent"): AIIntent {
  const source = record(value, path);
  if (source.goal === "create_visit_route") return validateCreateVisitRouteIntent(value, path);
  if (source.goal === "update_points") return validateUpdatePointsIntent(value, path);
  if (source.goal === "create_visualization_stress_test") return validateVisualizationStressIntent(value, path);
  if (source.goal === "update_visualization_stress_test") return validateVisualizationStressUpdateIntent(value, path);
  throw new AIError("INVALID_VALUE", `${path}.goal`, "Unknown semantic goal", source.goal);
}

function resources(plan: AIPlan, revision: number): AIResourceReference[] {
  return plan.steps.flatMap((step) => step.produces ?? []).map((resource) => ({ ...clone(resource), revision }));
}

function applyPointPatch(feature: AIObjectFeature, patch: AIPointPatch): AIObjectFeature {
  const next: AIObjectFeature = {
    type: "Feature",
    id: feature.id,
    geometry: patch.position
      ? { type: "Point", coordinates: [patch.position.lng, patch.position.lat] }
      : clone(feature.geometry),
    properties: { ...(feature.properties ?? {}) }
  };
  if (patch.title !== undefined) next.properties!.title = patch.title;
  if (patch.popup !== undefined) next.properties!.popup = patch.popup;
  if (patch.visual !== undefined) next.properties!.visual = patch.visual;
  if (patch.category !== undefined) next.properties!.category = patch.category;
  return next;
}

/** Strip bulky step inputs before returning plans to models/HTTP clients. */
export function compactAIPlan(plan: AIPlan): AIPlan {
  return {
    version: plan.version,
    id: plan.id,
    goal: plan.goal,
    baseRevision: plan.baseRevision,
    steps: plan.steps.map(({ id, capability, operation, dependsOn, produces }) => ({
      id,
      capability,
      operation,
      dependsOn: [...dependsOn],
      ...(produces ? { produces: clone(produces) } : {}),
      input: {}
    }))
  };
}

/** Model-neutral semantic runtime layered over the revisioned command engine. */
export class AIAgentRuntime {
  readonly engine: AICommandEngine;
  readonly registry: AICapabilityRegistry;

  constructor(engine: AICommandEngine, registry = createDefaultAICapabilityRegistry()) {
    this.engine = engine;
    this.registry = registry;
  }

  describeCapabilities(): AICapabilityDescription[] {
    return this.registry.list();
  }

  getContext(snapshot = this.engine.getSnapshot()): AIAgentContext {
    const capabilities = this.registry.list();
    return {
      version: 1,
      revision: snapshot.revision,
      scene: {
        layers: snapshot.scene.layers.length,
        hasBasemap: snapshot.scene.basemap !== undefined && snapshot.scene.basemap !== null,
        hasCamera: snapshot.scene.camera !== undefined
      },
      collections: Object.entries(snapshot.collections).map(([id, objects]) => ({
        ref: { kind: "collection", id, revision: snapshot.revision },
        count: objects.length,
        geometryTypes: [...new Set(objects.map(({ geometry }) => geometry.type))],
        ids: objects.slice(0, CONTEXT_ID_LIMIT).map(({ id: objectId }) => objectId)
      })),
      routes: Object.values(snapshot.routes ?? {}).map((route) => {
        const selected = route.routes[route.selectedIndex];
        return {
          id: route.id,
          ref: { kind: "route", id: route.id, revision: snapshot.revision },
          collection: route.collection,
          stops: route.waypointIds.length,
          ...(selected?.distance !== undefined ? { distance: selected.distance } : {}),
          ...(selected?.durationMs !== undefined ? { durationMs: selected.durationMs } : {}),
          reactive: route.request?.reactive === true
        };
      }),
      capabilities: capabilities.map(({ id, operations }) => ({ id, operations: operations.map(({ name }) => name) }))
    };
  }

  plan(input: unknown, options: AIEngineExecuteOptions = {}): AIResult<AIPlan> {
    try {
      const intent = validateAIIntent(input);
      const baseRevision = options.baseRevision ?? this.engine.revision;
      if (baseRevision !== this.engine.revision) {
        throw new AIError("REVISION_CONFLICT", "$options.baseRevision", `Expected revision ${baseRevision}, current revision is ${this.engine.revision}`, baseRevision);
      }
      if (intent.goal === "create_visualization_stress_test") {
        const resources: AIResourceReference[] = [
          { kind: "collection", id: intent.collection },
          { kind: "collection", id: `${intent.collection}-route-stops` },
          { kind: "route", id: intent.routeId }
        ];
        return {
          ok: true,
          value: {
            version: 1,
            id: `${intent.collection}-stress@${baseRevision + 1}`,
            goal: intent.goal,
            baseRevision,
            steps: [{
              id: "visualization",
              capability: "orihon.visualization-model",
              operation: "create_stress_scene",
              dependsOn: [],
              input: clone(intent) as unknown as Record<string, unknown>,
              produces: resources
            }]
          }
        };
      }
      if (intent.goal === "update_visualization_stress_test") {
        return {
          ok: true,
          value: {
            version: 1,
            id: `${intent.collection}-tick-${intent.tick}@${baseRevision + 1}`,
            goal: intent.goal,
            baseRevision,
            steps: [{
              id: "visualization-update",
              capability: "orihon.visualization-model",
              operation: "update_stress_scene",
              dependsOn: [],
              input: clone(intent) as unknown as Record<string, unknown>,
              produces: [{ kind: "collection", id: intent.collection }]
            }]
          }
        };
      }
      if (intent.goal === "update_points") {
        const snapshot = this.engine.getSnapshot();
        const current = snapshot.collections[intent.collection];
        if (!current) {
          throw new AIError("NOT_FOUND", "$intent.collection", `Collection "${intent.collection}" does not exist`, intent.collection);
        }
        const byId = new Map(current.map((feature) => [feature.id, feature]));
        const patchedById = new Map<string | number, AIObjectFeature>();
        for (let index = 0; index < intent.points.length; index++) {
          const patch = intent.points[index];
          const existing = byId.get(patch.id);
          if (!existing) {
            throw new AIError("NOT_FOUND", `$intent.points[${index}].id`, `Object "${String(patch.id)}" does not exist`, patch.id);
          }
          patchedById.set(patch.id, applyPointPatch(existing, patch));
        }
        const collectionRef: AIResourceReference = { kind: "collection", id: intent.collection };
        if (intent.presentation?.viewport) {
          const points = current.map((feature) => {
            const patched = patchedById.get(feature.id) ?? feature;
            const [lng, lat] = patched.geometry.type === "Point" ? patched.geometry.coordinates : [0, 0];
            return {
              id: patched.id,
              position: { lat: Number(lat), lng: Number(lng) },
              ...(patched.properties?.title !== undefined ? { title: patched.properties.title } : {}),
              ...(patched.properties?.popup !== undefined ? { popup: patched.properties.popup } : {}),
              ...(patched.properties?.visual !== undefined ? { visual: patched.properties.visual } : {}),
              ...(patched.properties?.category !== undefined ? { category: patched.properties.category } : {})
            };
          });
          return {
            ok: true,
            value: {
              version: 1,
              id: `${intent.collection}-update@${baseRevision + 1}`,
              goal: intent.goal,
              baseRevision,
              steps: [{
                id: "points",
                capability: "orihon.object-manager",
                operation: "replace_points",
                dependsOn: [],
                input: {
                  collection: intent.collection,
                  points: clone(points),
                  viewport: clone(intent.presentation.viewport)
                },
                produces: [collectionRef]
              }]
            }
          };
        }
        return {
          ok: true,
          value: {
            version: 1,
            id: `${intent.collection}-update@${baseRevision + 1}`,
            goal: intent.goal,
            baseRevision,
            steps: [{
              id: "points",
              capability: "orihon.object-manager",
              operation: "update_points",
              dependsOn: [],
              input: { collection: intent.collection, objects: clone([...patchedById.values()]) },
              produces: [collectionRef]
            }]
          }
        };
      }
      const collectionRef: AIResourceReference = { kind: "collection", id: intent.collection };
      const routeRef: AIResourceReference = { kind: "route", id: intent.routeId };
      const steps: AIPlanStep[] = [{
        id: "places",
        capability: "orihon.object-manager",
        operation: "replace_points",
        dependsOn: [],
        input: {
          collection: intent.collection,
          points: clone(intent.points),
          ...(intent.presentation?.clearMap !== undefined ? { clearMap: intent.presentation.clearMap } : {}),
          ...(intent.presentation?.defaults ? { defaults: clone(intent.presentation.defaults) } : {}),
          ...(intent.presentation?.viewport ? { viewport: clone(intent.presentation.viewport) } : {})
        },
        produces: [collectionRef]
      }, {
        id: "route",
        capability: "orihon.route-model",
        operation: "plan",
        dependsOn: ["places"],
        input: {
          routeId: intent.routeId,
          source: collectionRef,
          ...clone(intent.route ?? { reactive: true })
        },
        produces: [routeRef]
      }];
      return {
        ok: true,
        value: {
          version: 1,
          id: `${intent.routeId}@${baseRevision + 1}`,
          goal: intent.goal,
          baseRevision,
          steps
        }
      };
    } catch (error) {
      return { ok: false, error: toAIError(error).toJSON() };
    }
  }

  preview(plan: AIPlan): AIResult<AIPlanPreviewResult> {
    try {
      const commands = this.#commands(plan);
      const preview = this.engine.previewTransaction(commands, { baseRevision: plan.baseRevision });
      if (!preview.ok) return preview;
      return {
        ok: true,
        value: {
          plan: compactAIPlan(plan),
          revision: preview.value.revision,
          resources: resources(plan, preview.value.revision),
          context: this.getContext(preview.value.snapshot)
        }
      };
    } catch (error) {
      return { ok: false, error: toAIError(error).toJSON() };
    }
  }

  commit(plan: AIPlan): AIResult<AIPlanExecution> {
    try {
      const commands = this.#commands(plan);
      const result = this.engine.executeTransaction(commands, {
        baseRevision: plan.baseRevision,
        transactionId: plan.id,
        operation: plan.goal
      });
      if (!result.ok) return result;
      return {
        ok: true,
        value: {
          plan: compactAIPlan(plan),
          revision: result.value.revision,
          resources: resources(plan, result.value.revision),
          context: this.getContext(result.value.snapshot)
        }
      };
    } catch (error) {
      return { ok: false, error: toAIError(error).toJSON() };
    }
  }

  execute(intent: unknown, options: AIEngineExecuteOptions = {}): AIResult<AIPlanExecution> {
    const planned = this.plan(intent, options);
    return planned.ok ? this.commit(planned.value) : planned;
  }

  #commands(plan: AIPlan): AIEngineCommand[] {
    if (!plan || plan.version !== 1 || !Array.isArray(plan.steps) || plan.steps.length === 0) {
      throw new AIError("INVALID_TYPE", "$plan", "Expected a non-empty AIPlan v1", plan);
    }
    const pending = new Map(plan.steps.map((step, index) => [step.id, { step, index }]));
    if (pending.size !== plan.steps.length) throw new AIError("DUPLICATE_ID", "$plan.steps", "Plan step IDs must be unique");
    const complete = new Set<string>();
    const commands: AIEngineCommand[] = [];
    while (pending.size > 0) {
      const ready = [...pending.values()].find(({ step }) => step.dependsOn.every((id) => complete.has(id)));
      if (!ready) throw new AIError("INVALID_VALUE", "$plan.steps", "Plan dependencies contain a cycle or unknown step");
      commands.push(...this.registry.compile(ready.step, `$plan.steps[${ready.index}]`));
      pending.delete(ready.step.id);
      complete.add(ready.step.id);
    }
    return commands;
  }
}

export function createAIAgentRuntime(
  engine: AICommandEngine,
  registry?: AICapabilityRegistry
): AIAgentRuntime {
  return new AIAgentRuntime(engine, registry);
}
