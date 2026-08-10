import type { LatLngBoundsLike } from "../geo.js";
import type { ObjectId } from "./object-manager.js";
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
  debounceMs?: number;
  replace?: boolean;
}

type RemoteObjectMap = NonNullable<ObjectManager["map"]>;

export class RemoteObjectManager extends ObjectManager {
  readonly loader: RemoteObjectLoader;
  readonly debounceMs: number;
  readonly replace: boolean;
  _timer: ReturnType<typeof setTimeout> | null = null;
  _controller: AbortController | null = null;
  _requestId = 0;
  _loading = false;
  readonly _remoteRender: () => void;

  constructor(options: RemoteObjectManagerOptions) {
    super(options);
    if (typeof options.loader !== "function") throw new TypeError("RemoteObjectManager loader is required");
    this.loader = options.loader;
    this.debounceMs = Math.max(0, Number(options.debounceMs ?? 120));
    this.replace = options.replace !== false;
    this._remoteRender = () => this.#schedule("move");
  }

  get loading(): boolean {
    return this._loading;
  }

  override addTo(map: RemoteObjectMap): this {
    if (this.map === map) return this;
    super.addTo(map);
    map.on("moveend", this._remoteRender);
    map.on("zoomend", this._remoteRender);
    map.on("resize", this._remoteRender);
    this.#schedule("add");
    return this;
  }

  override remove(): this;
  override remove(ids: ObjectId | ObjectId[]): this;
  override remove(ids?: ObjectId | ObjectId[]): this {
    if (ids !== undefined) return super.remove(ids);
    this.cancel();
    const map = this.map;
    if (map) {
      map.off("moveend", this._remoteRender);
      map.off("zoomend", this._remoteRender);
      map.off("resize", this._remoteRender);
    }
    return super.remove();
  }

  override destroy(): this {
    this.cancel();
    return super.destroy();
  }

  reload(): this {
    return this.#schedule("reload");
  }

  cancel(): this {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    this._controller?.abort();
    this._controller = null;
    this._loading = false;
    return this;
  }

  #schedule(reason: RemoteObjectLoadContext["reason"]): this {
    if (!this.map) return this;
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => void this.#load(reason), this.debounceMs);
    return this;
  }

  async #load(reason: RemoteObjectLoadContext["reason"]): Promise<void> {
    const map = this.map;
    if (!map) return;
    this._timer = null;
    this._controller?.abort();
    const controller = new AbortController();
    const requestId = ++this._requestId;
    this._controller = controller;
    this._loading = true;
    const context: RemoteObjectLoadContext = {
      bounds: map.getBounds(),
      zoom: map.zoom,
      signal: controller.signal,
      reason
    };
    this.emit("loading", { context });
    try {
      const result = await this.loader(context);
      if (controller.signal.aborted || requestId !== this._requestId) return;
      if (this.replace) super.clear();
      super.add(result || []);
      this._loading = false;
      this.emit("load", { context, objects: result || [], stats: this.getStats() });
    } catch (error) {
      if (controller.signal.aborted) {
        this.emit("abort", { context });
      } else {
        this.emit("error", { context, error });
      }
    } finally {
      if (this._controller === controller) this._controller = null;
      if (requestId === this._requestId) this._loading = false;
    }
  }
}

export function remoteObjectManager(options: RemoteObjectManagerOptions): RemoteObjectManager {
  return new RemoteObjectManager(options);
}
