import { AIError, toAIError } from "./errors.js";
import type {
  AICommand,
  AICollectionCommand,
  AIEngineCommand,
  AIEngineCommandSuccess,
  AIEngineEvent,
  AIEngineExecuteOptions,
  AIEngineMutationEvent,
  AIEngineSnapshot,
  AIEngineTransactionOptions,
  AIEngineTransactionPreview,
  AIEngineTransactionSuccess,
  AIEngineViewport,
  AIObjectFeature,
  AIPointSpec,
  AIPosition,
  AIResult,
  AIRoutePlanCommand,
  AIRoutePlanState,
  AICameraSpec,
  AISceneSpec
} from "./types.js";
import { validateEngineCommand, validateObjectCommand } from "./engine-validation.js";
import { pointCommandFeatures } from "./points.js";
import { planAIRoute } from "./routes.js";
import { validateLayer, validateScene } from "./validation.js";

export interface AICommandEngineInitialState {
  scene?: unknown;
  collections?: Record<string, unknown>;
}

export type AIEngineListener = (event: AIEngineEvent) => void;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepMerge(target: unknown, patch: unknown): unknown {
  if (!target || typeof target !== "object" || Array.isArray(target)
    || !patch || typeof patch !== "object" || Array.isArray(patch)) return clone(patch);
  const result = { ...(target as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    result[key] = key in result ? deepMerge(result[key], value) : clone(value);
  }
  return result;
}

function featureMap(features: readonly AIObjectFeature[]): Map<string | number, AIObjectFeature> {
  return new Map(features.map((feature) => [feature.id, clone(feature)]));
}

/** Approximate camera for headless viewport recovery without a live map size. */
export function cameraFromPositions(positions: readonly AIPosition[], paddingHint = 44): AICameraSpec {
  if (positions.length === 0) return { center: { lat: 0, lng: 0 }, zoom: 2 };
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const position of positions) {
    minLat = Math.min(minLat, position.lat);
    maxLat = Math.max(maxLat, position.lat);
    minLng = Math.min(minLng, position.lng);
    maxLng = Math.max(maxLng, position.lng);
  }
  const center = { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 };
  const latSpan = Math.max(maxLat - minLat, 1e-6);
  const lngSpan = Math.max(maxLng - minLng, 1e-6);
  const span = Math.max(latSpan, lngSpan * Math.max(0.2, Math.cos((center.lat * Math.PI) / 180)));
  const padFactor = 1 + Math.min(1.5, Math.max(0, paddingHint) / 200);
  const zoom = Math.max(1, Math.min(18, Math.floor(Math.log2(360 / (span * padFactor))) - 1));
  return { center, zoom };
}

function cameraFromPointSpecs(points: readonly AIPointSpec[], padding?: number): AICameraSpec {
  return cameraFromPositions(points.map(({ position }) => position), padding ?? 44);
}

/**
 * Transport-independent, headless command engine.
 *
 * It owns canonical JSON state and emits monotonically revisioned events. HTTP,
 * WebSocket and SSE belong in host adapters, while browser projections subscribe
 * to the same events and render object deltas through FeatureSource/ObjectManager.
 */
export class AICommandEngine {
  #revision = 0;
  #scene: AISceneSpec;
  #viewport?: AIEngineViewport;
  readonly #collections = new Map<string, Map<string | number, AIObjectFeature>>();
  readonly #routes = new Map<string, AIRoutePlanState>();
  readonly #listeners = new Set<AIEngineListener>();

  constructor(initial: AICommandEngineInitialState = {}) {
    this.#scene = initial.scene === undefined
      ? { version: 1, layers: [] }
      : validateScene(initial.scene, "$initial.scene");
    if (initial.collections !== undefined) {
      if (!initial.collections || typeof initial.collections !== "object" || Array.isArray(initial.collections)) {
        throw new AIError("INVALID_TYPE", "$initial.collections", "Expected an object keyed by collection name", initial.collections);
      }
      for (const [collection, objects] of Object.entries(initial.collections)) {
        const command = validateObjectCommand({ op: "objects.replace", collection, objects }, `$initial.collections.${collection}`);
        if (command.op !== "objects.replace") throw new Error("Unexpected validated object command");
        this.#collections.set(collection, featureMap(command.objects));
      }
    }
  }

  get revision(): number { return this.#revision; }

  subscribe(listener: AIEngineListener): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  getSnapshot(): AIEngineSnapshot {
    const collections: Record<string, AIObjectFeature[]> = {};
    for (const [name, objects] of this.#collections) collections[name] = [...objects.values()].map(clone);
    const routes: Record<string, AIRoutePlanState> = {};
    for (const [id, route] of this.#routes) routes[id] = clone(route);
    return clone({
      version: 1,
      revision: this.#revision,
      scene: this.#scene,
      collections,
      ...(this.#routes.size > 0 ? { routes } : {}),
      ...(this.#viewport?.revision === this.#revision ? { viewport: this.#viewport } : {})
    });
  }

  /** Validate an ordered command set against a private fork without mutating live state. */
  previewTransaction(
    commands: readonly unknown[],
    options: AIEngineExecuteOptions = {}
  ): AIResult<AIEngineTransactionPreview> {
    try {
      this.#assertBaseRevision(options.baseRevision);
      const { engine: staged } = this.#stageCommands(commands);
      const revision = this.#revision + 1;
      staged.#revision = revision;
      if (staged.#viewport) staged.#viewport.revision = revision;
      return {
        ok: true,
        value: {
          revision,
          commands: commands.map((command) => validateEngineCommand(command)),
          snapshot: staged.getSnapshot()
        }
      };
    } catch (error) {
      return { ok: false, error: toAIError(error).toJSON() };
    }
  }

  /** Atomically commit a plan as one revision and one projection event. */
  executeTransaction(
    commands: readonly unknown[],
    options: AIEngineTransactionOptions = {}
  ): AIResult<AIEngineTransactionSuccess> {
    try {
      this.#assertBaseRevision(options.baseRevision);
      const { engine: staged, events } = this.#stageCommands(commands);
      const normalized = commands.map((command) => validateEngineCommand(command));
      const revision = this.#revision + 1;
      this.#scene = clone(staged.#scene);
      this.#collections.clear();
      for (const [name, objects] of staged.#collections) this.#collections.set(name, featureMap([...objects.values()]));
      this.#routes.clear();
      for (const [id, route] of staged.#routes) this.#routes.set(id, clone(route));
      this.#viewport = staged.#viewport ? { ...clone(staged.#viewport), revision } : undefined;
      this.#revision = revision;
      const snapshot = this.getSnapshot();
      const event = {
        type: "transaction" as const,
        revision,
        transactionId: options.transactionId ?? `transaction-${revision}`,
        operation: options.operation ?? "plan.commit",
        commands: normalized,
        events,
        ...(events.length === 1 ? {} : { snapshot })
      };
      for (const listener of this.#listeners) {
        try { listener(clone(event)); } catch { /* listeners cannot roll back an accepted transaction */ }
      }
      return { ok: true, value: { op: "transaction", revision, event: clone(event), snapshot } };
    } catch (error) {
      return { ok: false, error: toAIError(error).toJSON() };
    }
  }

  /** Validate and atomically execute an untrusted JSON command. */
  execute(input: unknown, options: AIEngineExecuteOptions = {}): AIResult<AIEngineCommandSuccess> {
    try {
      this.#assertBaseRevision(options.baseRevision);
      const command = validateEngineCommand(input);
      if (command.op === "query") {
        const snapshot = this.getSnapshot();
        if (command.ids !== undefined) {
          const byId = new Map(snapshot.scene.layers.map((layer) => [layer.id, layer]));
          snapshot.scene.layers = command.ids.map((id) => {
            const layer = byId.get(id);
            if (!layer) throw new AIError("NOT_FOUND", "$command.ids", `No AI layer has ID "${id}"`, id);
            return layer;
          });
        }
        return { ok: true, value: { op: command.op, revision: this.#revision, snapshot } };
      }
      const event = command.op === "route.plan"
        ? this.#executeRouteCommand(command)
        : command.op.startsWith("objects.") || command.op === "points.replace"
          ? this.#executeCollectionCommand(command as AICollectionCommand)
          : this.#executeSceneCommand(command as Exclude<AICommand, { op: "query" }>);
      for (const listener of this.#listeners) {
        try { listener(clone(event)); } catch { /* listeners cannot roll back an accepted command */ }
      }
      const value: AIEngineCommandSuccess = { op: command.op, revision: this.#revision, event: clone(event) };
      if (event.type === "route") {
        const selected = event.route.routes[event.route.selectedIndex];
        value.route = {
          id: event.route.id,
          stops: event.route.waypointIds.length,
          ...(selected?.distance !== undefined ? { distance: selected.distance } : {}),
          ...(selected?.durationMs !== undefined ? { durationMs: selected.durationMs } : {})
        };
      }
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: toAIError(error).toJSON() };
    }
  }

  #executeSceneCommand(command: Exclude<AICommand, { op: "query" }>): AIEngineEvent {
    const next = clone(this.#scene);
    if (command.op === "set_view") next.camera = { center: clone(command.center), zoom: command.zoom };
    else if (command.op === "fly_to") {
      next.camera = { center: clone(command.center), zoom: command.zoom ?? next.camera?.zoom ?? 0 };
    } else if (command.op === "add") {
      if (next.layers.some(({ id }) => id === command.id)) {
        throw new AIError("DUPLICATE_ID", "$command.id", `AI layer "${command.id}" already exists`, command.id);
      }
      next.layers.push(validateLayer({ id: command.id, ...command.layer }, "$command.layer"));
    } else if (command.op === "update") {
      const index = next.layers.findIndex(({ id }) => id === command.id);
      if (index < 0) throw new AIError("NOT_FOUND", "$command.id", `No AI layer has ID "${command.id}"`, command.id);
      next.layers[index] = validateLayer(deepMerge(next.layers[index], command.patch), "$command.patch");
    } else if (command.op === "remove") {
      const index = next.layers.findIndex(({ id }) => id === command.id);
      if (index < 0) throw new AIError("NOT_FOUND", "$command.id", `No AI layer has ID "${command.id}"`, command.id);
      next.layers.splice(index, 1);
    } else if (command.op === "clear") {
      if (command.ids === undefined) {
        next.layers = [];
        this.#routes.clear();
      }
      else {
        const selected = new Set(command.ids);
        for (const id of selected) {
          if (!next.layers.some((layer) => layer.id === id)) throw new AIError("NOT_FOUND", "$command.ids", `No AI layer has ID "${id}"`, id);
        }
        next.layers = next.layers.filter(({ id }) => !selected.has(id));
      }
    } else if (command.op === "fit") {
      const ids = command.ids ?? next.layers.map(({ id }) => id);
      if (ids.length === 0) throw new AIError("EMPTY_SELECTION", "$command.ids", "No layers are available to fit", ids);
      for (const id of ids) {
        if (!next.layers.some((layer) => layer.id === id)) throw new AIError("NOT_FOUND", "$command.ids", `No AI layer has ID "${id}"`, id);
      }
      // Fit is viewport-dependent, so it is intentionally an event-only command.
    } else {
      next.layers = clone(command.scene.layers);
      if (command.scene.camera !== undefined) next.camera = clone(command.scene.camera);
      if (command.scene.basemap !== undefined) next.basemap = clone(command.scene.basemap);
    }
    this.#scene = validateScene(next);
    this.#revision++;
    return { type: "scene", revision: this.#revision, command: clone(command) };
  }

  #executeCollectionCommand(command: AICollectionCommand): AIEngineEvent {
    const replaceMap = command.op === "points.replace" && command.clearMap === true;
    const affectedRoutes = replaceMap
      ? []
      : [...this.#routes.values()].filter((route) => route.collection === command.collection).map(clone);
    const current = replaceMap ? undefined : this.#collections.get(command.collection);
    const next = new Map<string | number, AIObjectFeature>();
    for (const [id, feature] of current ?? []) next.set(id, clone(feature));

    const add = (objects: readonly AIObjectFeature[], path: string): void => {
      for (const object of objects) {
        if (next.has(object.id)) throw new AIError("DUPLICATE_ID", path, `Object "${String(object.id)}" already exists`, object.id);
        next.set(object.id, clone(object));
      }
    };
    const update = (objects: readonly AIObjectFeature[], path: string): void => {
      for (const object of objects) {
        if (!next.has(object.id)) throw new AIError("NOT_FOUND", path, `Object "${String(object.id)}" does not exist`, object.id);
        next.set(object.id, clone(object));
      }
    };
    const remove = (ids: readonly (string | number)[], path: string): void => {
      for (const id of ids) {
        if (!next.has(id)) throw new AIError("NOT_FOUND", path, `Object "${String(id)}" does not exist`, id);
        next.delete(id);
      }
    };

    if (command.op === "points.replace") {
      add(pointCommandFeatures(command), "$command.points");
    } else if (command.op === "objects.add") add(command.objects, "$command.objects");
    else if (command.op === "objects.update") update(command.objects, "$command.objects");
    else if (command.op === "objects.remove") remove(command.ids, "$command.ids");
    else if (command.op === "objects.replace") {
      next.clear();
      add(command.objects, "$command.objects");
    } else if (command.op === "objects.clear") next.clear();
    else {
      command.changes.forEach((change, index) => {
        if (change.type === "add") add(change.objects, `$command.changes[${index}].objects`);
        else if (change.type === "update") update(change.objects, `$command.changes[${index}].objects`);
        else remove(change.ids, `$command.changes[${index}].ids`);
      });
    }

    if (replaceMap) {
      const scene = clone(this.#scene);
      scene.layers = [];
      this.#scene = validateScene(scene);
      this.#collections.clear();
      this.#routes.clear();
    }
    const invalidatedRouteIds = new Set(affectedRoutes.map(({ id }) => id));
    for (const routeId of invalidatedRouteIds) this.#routes.delete(routeId);
    if (invalidatedRouteIds.size > 0) {
      for (const [id, feature] of next) {
        const properties = feature.properties ?? {};
        if (typeof properties.routeId !== "string" || !invalidatedRouteIds.has(properties.routeId)) continue;
        const cleaned = { ...properties };
        delete cleaned.routeId;
        delete cleaned.visitOrder;
        next.set(id, { ...feature, properties: cleaned });
      }
    }
    const replannedRoutes: AIRoutePlanState[] = [];
    for (const previous of affectedRoutes) {
      if (previous.request?.reactive !== true) continue;
      const availableIds = new Set(next.keys());
      const request = clone(previous.request);
      if (request.ids) request.ids = request.ids.filter((id) => availableIds.has(id));
      if (request.startId !== undefined && !availableIds.has(request.startId)) delete request.startId;
      if (request.endId !== undefined && !availableIds.has(request.endId)) delete request.endId;
      try {
        const planned = planAIRoute(request, [...next.values()]);
        next.clear();
        for (const [id, feature] of featureMap(planned.objects)) next.set(id, feature);
        this.#routes.set(previous.id, clone(planned.state));
        replannedRoutes.push(clone(planned.state));
        invalidatedRouteIds.delete(previous.id);
      } catch {
        // A collection mutation remains valid even when fewer than two usable stops remain.
      }
    }
    this.#collections.set(command.collection, next);
    this.#revision++;
    if (command.op === "points.replace" && command.viewport) {
      this.#viewport = {
        collection: command.collection,
        revision: this.#revision,
        ...clone(command.viewport)
      };
      const scene = clone(this.#scene);
      scene.camera = cameraFromPointSpecs(command.points, command.viewport.padding);
      this.#scene = validateScene(scene);
    }
    return {
      type: "objects",
      revision: this.#revision,
      collection: command.collection,
      command: clone(command),
      ...(replannedRoutes.length > 0 ? { routes: replannedRoutes } : {}),
      ...(invalidatedRouteIds.size > 0 ? { removedRouteIds: [...invalidatedRouteIds] } : {})
    };
  }

  #executeRouteCommand(command: AIRoutePlanCommand): AIEngineEvent {
    const collection = this.#collections.get(command.collection);
    if (!collection) {
      throw new AIError("NOT_FOUND", "$command.collection", `Collection "${command.collection}" does not exist`, command.collection);
    }
    const planned = planAIRoute(command, [...collection.values()]);
    const inheritedViewport = this.#viewport?.collection === command.collection
      ? clone(this.#viewport)
      : undefined;
    this.#collections.set(command.collection, featureMap(planned.objects));
    this.#routes.set(command.routeId, clone(planned.state));
    this.#revision++;
    if (inheritedViewport) this.#viewport = { ...inheritedViewport, revision: this.#revision };
    return { type: "route", revision: this.#revision, route: clone(planned.state), command: clone(command) };
  }

  #assertBaseRevision(baseRevision: number | undefined): void {
    if (baseRevision === undefined) return;
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) {
      throw new AIError("INVALID_VALUE", "$options.baseRevision", "baseRevision must be a non-negative safe integer", baseRevision);
    }
    if (baseRevision !== this.#revision) {
      throw new AIError(
        "REVISION_CONFLICT",
        "$options.baseRevision",
        `Expected revision ${baseRevision}, current revision is ${this.#revision}`,
        baseRevision
      );
    }
  }

  #fork(): AICommandEngine {
    const staged = new AICommandEngine();
    staged.#revision = this.#revision;
    staged.#scene = clone(this.#scene);
    staged.#viewport = this.#viewport ? clone(this.#viewport) : undefined;
    for (const [name, objects] of this.#collections) staged.#collections.set(name, featureMap([...objects.values()]));
    for (const [id, route] of this.#routes) staged.#routes.set(id, clone(route));
    return staged;
  }

  #stageCommands(commands: readonly unknown[]): { engine: AICommandEngine; events: AIEngineMutationEvent[] } {
    if (!Array.isArray(commands) || commands.length === 0) {
      throw new AIError("EMPTY_SELECTION", "$commands", "A transaction requires at least one command", commands);
    }
    const staged = this.#fork();
    const events: AIEngineMutationEvent[] = [];
    for (let index = 0; index < commands.length; index++) {
      const result = staged.execute(commands[index]);
      if (!result.ok) {
        throw new AIError(result.error.code, `$commands[${index}]${result.error.path.replace(/^\$command/, "")}`, result.error.message, result.error.received);
      }
      if (result.value.event && result.value.event.type !== "transaction") events.push(result.value.event);
    }
    return { engine: staged, events };
  }
}

export function createAICommandEngine(initial?: AICommandEngineInitialState): AICommandEngine {
  return new AICommandEngine(initial);
}
