import type { LatLngBoundsLike } from "../geo.js";
import type { ObjectId } from "./object-manager.js";
import { AbortableOperation, abortError, isAbortError } from "./abortable-operation.js";
import { assertManagedCoordinateFormat } from "./object-geometry.js";
import { nonNegativeFinite } from "../units.js";
import {
  ObjectManager,
  type ManagedObject,
  type ObjectManagerOptions
} from "./object-manager.js";

export interface RemoteObjectLoadContext {
  bounds: LatLngBoundsLike;
  zoom: number;
  signal: AbortSignal;
  reason: "add" | "move" | "reload";
}

export type RemoteObjectLoader = (
  context: RemoteObjectLoadContext
) => Promise<ManagedObject[] | null | undefined> | ManagedObject[] | null | undefined;

export interface RemoteObjectManagerOptions extends ObjectManagerOptions {
  loader: RemoteObjectLoader;
  /** Delay for automatic viewport loads only, in milliseconds. Default 120. */
  debounceMs?: number;
  replace?: boolean;
}

export interface RemoteObjectReloadOptions {
  /** Cancellation rejects reload() with AbortError; the loader receives a linked signal. */
  signal?: AbortSignal;
}

type RemoteObjectMap = NonNullable<ObjectManager["map"]>;

export class RemoteObjectManager extends ObjectManager {
  readonly loader: RemoteObjectLoader;
  readonly debounceMs: number;
  readonly replace: boolean;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #operation: AbortableOperation | null = null;
  #generation = 0;
  #destroyed = false;
  readonly #remoteRender = (): void => this.#schedule("move");
  readonly #mapUnload = (): void => { this.remove(); };

  constructor(options: RemoteObjectManagerOptions) {
    if (typeof options.loader !== "function") throw new TypeError("RemoteObjectManager loader is required");
    const debounceMs = nonNegativeFinite(options.debounceMs ?? 120, "debounceMs");
    super(options);
    this.loader = options.loader;
    this.debounceMs = debounceMs;
    this.replace = options.replace !== false;
  }

  get loading(): boolean {
    return this.#operation !== null;
  }

  override addTo(map: RemoteObjectMap): this {
    this.#assertAlive();
    if ("_destroyed" in map && map._destroyed === true) throw abortError("Cannot attach RemoteObjectManager to a destroyed map");
    if (this.map === map) return this;
    super.addTo(map);
    map.on("moveend", this.#remoteRender);
    map.on("zoomend", this.#remoteRender);
    map.on("resize", this.#remoteRender);
    map.on("unload", this.#mapUnload);
    this.#schedule("add");
    return this;
  }

  override remove(): this;
  override remove(ids: ObjectId | ObjectId[]): this;
  override remove(ids?: ObjectId | ObjectId[]): this {
    if (ids !== undefined) return super.remove(ids);
    const map = this.map;
    if (map) {
      map.off("moveend", this.#remoteRender);
      map.off("zoomend", this.#remoteRender);
      map.off("resize", this.#remoteRender);
      map.off("unload", this.#mapUnload);
    }
    super.remove();
    this.cancel();
    return this;
  }

  override destroy(): this {
    if (this.#destroyed) return this;
    this.#destroyed = true;
    this.cancel();
    return super.destroy();
  }

  /** Immediately loads the attached viewport. Rejects on cancellation, failure or detached use. */
  reload(options: RemoteObjectReloadOptions = {}): Promise<ManagedObject[]> {
    return this.#load("reload", options.signal);
  }

  cancel(): this {
    this.#generation++;
    this.#clearTimer();
    const operation = this.#operation;
    this.#operation = null;
    operation?.cancel();
    return this;
  }

  #schedule(reason: RemoteObjectLoadContext["reason"]): void {
    if (this.#destroyed || !this.map) return;
    const generation = this.#generation + 1;
    // Invalidate now, not after debounce: a late response belongs to the old viewport.
    this.cancel();
    if (this.#destroyed || !this.map || this.#generation !== generation) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      // Automatic viewport requests report outcomes through load/error/abort events.
      void this.#load(reason).catch(() => {});
    }, this.debounceMs);
  }

  async #load(reason: RemoteObjectLoadContext["reason"], signal?: AbortSignal): Promise<ManagedObject[]> {
    this.#assertAlive();
    const map = this.map;
    if (!map) throw new Error("RemoteObjectManager.reload requires an attached map. Call addTo(map) first.");
    const bounds = map.getBounds();
    const zoom = map.zoom;
    const operation = new AbortableOperation("RemoteObjectManager load", signal);
    const context: RemoteObjectLoadContext = {
      bounds,
      zoom,
      signal: operation.signal,
      reason
    };
    this.#generation++;
    this.#clearTimer();
    const previous = this.#operation;
    this.#operation = operation;
    previous?.cancel();
    try {
      const result = await operation.run(() => {
        this.emit("loading", { context });
        operation.throwIfAborted();
        return this.loader(context);
      });
      operation.throwIfAborted();
      const objects = result ?? [];
      if (!Array.isArray(objects)) throw new TypeError("RemoteObjectManager loader must return an array of objects, null or undefined.");
      for (const object of objects) {
        if (!object || typeof object !== "object") throw new TypeError("RemoteObjectManager loader returned an invalid object.");
        assertManagedCoordinateFormat(object);
      }
      if (this.replace) super.clear();
      super.add(objects);
      if (this.#operation === operation) this.#operation = null;
      this.emit("load", { context, objects, stats: this.getStats() });
      return objects;
    } catch (error) {
      if (this.#operation === operation) this.#operation = null;
      if (!this.#destroyed) this.emit(isAbortError(error) ? "abort" : "error", { context, error });
      throw error;
    } finally {
      operation.dispose();
      if (this.#operation === operation) this.#operation = null;
    }
  }

  #clearTimer(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #assertAlive(): void {
    if (this.#destroyed) throw abortError("RemoteObjectManager was destroyed");
  }
}

export function remoteObjectManager(options: RemoteObjectManagerOptions): RemoteObjectManager {
  return new RemoteObjectManager(options);
}
